import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPilotAgentApi } from "./agent/pilotAgentApi";
import { summarizeElements, type SceneSummary } from "./agent/tools";
import { createSeedScene } from "./data/seedScenes";
import {
  chooseSeed,
  instructionForTask,
  taskByType,
  taskDefinitions,
  type TaskPhase,
  type TaskType
} from "./data/tasks";
import type {
  CanvasSnapshot,
  InputDevice,
  PhaseTransition,
  PointerModalityEvent,
  SessionExport,
  SessionMetadata,
  ThinkAloudEvent
} from "./data/sessionTypes";
import {
  compactSceneTransition,
  diffSceneSummaries,
  hasSceneChanges,
  sceneActionLabel,
  sceneTargetIds,
  type ArtifactActionDraft,
  type ArtifactActionEntry
} from "./logging/artifactActions";

const actionIdleMs = 700;
const snapshotIntervalMs = 5000;
const recordingTimesliceMs = 10000;

type SessionStatus = "setup" | "active" | "completed";
type RecordedAction = ArtifactActionEntry & {
  phase: TaskPhase;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  seedElementImpacts: string[];
};
type PendingHumanAction = {
  before: SceneSummary;
  after: SceneSummary;
  afterElements: readonly ExcalidrawElement[];
  startedAtMs: number;
  endedAtMs: number;
  phase: TaskPhase;
};
type SttResponse = {
  success: boolean;
  error?: string;
  transcript?: string;
  languageCode?: string;
  segments?: unknown[];
};

const emptySummary: SceneSummary = {
  total: 0,
  byType: {},
  bySemanticRole: {},
  validationWarnings: [],
  warnings: [],
  elements: []
};

function cloneElements(elements: readonly ExcalidrawElement[]) {
  return structuredClone(elements) as readonly ExcalidrawElement[];
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function blobToBase64(blob: Blob) {
  return (await blobToDataUrl(blob)).split(",")[1] ?? "";
}

function preferredAudioMimeType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find(type => MediaRecorder.isTypeSupported(type)) ?? "";
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<SessionStatus>("setup");
  const [participantId, setParticipantId] = useState("");
  const [selectedTaskType, setSelectedTaskType] = useState<TaskType>("free_creation");
  const [selectedSeedId, setSelectedSeedId] = useState(taskDefinitions[0].seeds[0].id);
  const [randomizeSeed, setRandomizeSeed] = useState(true);
  const [inputDevice, setInputDevice] = useState<InputDevice>("unknown");
  const [phase, setPhase] = useState<TaskPhase>("single_phase");
  const [resolvedSeed, setResolvedSeed] = useState(taskDefinitions[0].seeds[0]);
  const [sessionMetadata, setSessionMetadata] = useState<SessionMetadata | null>(null);
  const [summary, setSummary] = useState<SceneSummary>(emptySummary);
  const [actionCount, setActionCount] = useState(0);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [thinkAloudCount, setThinkAloudCount] = useState(0);
  const [elapsedDisplayMs, setElapsedDisplayMs] = useState(0);
  const [noteText, setNoteText] = useState("");
  const [postTaskResponse, setPostTaskResponse] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [message, setMessage] = useState("참가자와 task를 설정하세요.");

  const sessionRef = useRef<SessionMetadata | null>(null);
  const phaseRef = useRef<TaskPhase>("single_phase");
  const sessionStartedPerformanceRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const actionsRef = useRef<RecordedAction[]>([]);
  const snapshotsRef = useRef<CanvasSnapshot[]>([]);
  const thinkAloudRef = useRef<ThinkAloudEvent[]>([]);
  const phaseTransitionsRef = useRef<PhaseTransition[]>([]);
  const pointerEventsRef = useRef<PointerModalityEvent[]>([]);
  const latestElementsRef = useRef<readonly ExcalidrawElement[]>([]);
  const latestFilesRef = useRef<BinaryFiles>({});
  const baselineRef = useRef<SceneSummary>(emptySummary);
  const pendingHumanActionRef = useRef<PendingHumanAction | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSnapshotIdRef = useRef("");
  const initialSeedElementIdsRef = useRef<string[]>([]);
  const suppressHumanChangeUntilRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioChunkIndexRef = useRef(0);
  const previousAudioChunkEndRef = useRef(0);

  const selectedTask = useMemo(() => taskByType(selectedTaskType), [selectedTaskType]);
  const currentInstruction = instructionForTask(selectedTaskType, resolvedSeed.label, phase);

  const elapsedMs = useCallback(() => {
    if (!sessionRef.current) return 0;
    return Math.max(0, Math.round(performance.now() - sessionStartedPerformanceRef.current));
  }, []);

  const timestampAt = useCallback((relativeMs: number) => {
    return new Date(sessionEpochRef.current + relativeMs).toISOString();
  }, []);

  const captureSnapshot = useCallback((
    reason: CanvasSnapshot["reason"],
    elements: readonly ExcalidrawElement[],
    snapshotPhase = phaseRef.current,
    actionSequence?: number
  ) => {
    const session = sessionRef.current;
    if (!session) return "";
    const relative = elapsedMs();
    const sequence = snapshotsRef.current.length + 1;
    const snapshot: CanvasSnapshot = {
      snapshotId: `${session.sessionId}:snapshot:${sequence}`,
      sessionId: session.sessionId,
      sequence,
      timestamp: timestampAt(relative),
      elapsedMs: relative,
      phase: snapshotPhase,
      reason,
      actionSequence,
      elements: cloneElements(elements)
    };
    snapshotsRef.current.push(snapshot);
    currentSnapshotIdRef.current = snapshot.snapshotId;
    setSnapshotCount(snapshotsRef.current.length);
    return snapshot.snapshotId;
  }, [elapsedMs, timestampAt]);

  const appendThinkAloud = useCallback((
    content: string,
    source: ThinkAloudEvent["source"],
    startedAtMs = elapsedMs(),
    endedAtMs = elapsedMs(),
    audio?: ThinkAloudEvent["audio"]
  ) => {
    const session = sessionRef.current;
    const clean = content.trim();
    if (!session || (!clean && source !== "human_audio")) return;
    const event: ThinkAloudEvent = {
      utteranceId: `${session.sessionId}:utterance:${thinkAloudRef.current.length + 1}`,
      sessionId: session.sessionId,
      timestamp: timestampAt(startedAtMs),
      startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      phase: phaseRef.current,
      source,
      content: clean,
      audio
    };
    thinkAloudRef.current.push(event);
    setThinkAloudCount(thinkAloudRef.current.length);
  }, [elapsedMs, timestampAt]);

  const appendAction = useCallback((draft: ArtifactActionDraft, actionPhase: TaskPhase, elements: readonly ExcalidrawElement[]) => {
    const session = sessionRef.current;
    if (!session) return;
    const sequence = actionsRef.current.length + 1;
    const beforeSnapshotId = currentSnapshotIdRef.current;
    const afterSnapshotId = captureSnapshot("action", elements, actionPhase, sequence);
    const targetIds = draft.targetObjectIds;
    const seedElementImpacts = targetIds.filter(id => initialSeedElementIdsRef.current.includes(id));
    const entry: RecordedAction = {
      ...draft,
      eventId: `${session.sessionId}:action:${sequence}`,
      sessionId: session.sessionId,
      sequence,
      timestamp: timestampAt(draft.endedAtMs),
      durationMs: Math.max(0, draft.endedAtMs - draft.startedAtMs),
      tool: "excalidraw",
      phase: actionPhase,
      beforeSnapshotId,
      afterSnapshotId,
      seedElementImpacts
    };
    actionsRef.current.push(entry);
    setActionCount(actionsRef.current.length);
  }, [captureSnapshot, timestampAt]);

  const flushHumanAction = useCallback(() => {
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = null;
    const pending = pendingHumanActionRef.current;
    pendingHumanActionRef.current = null;
    if (!pending) return;
    baselineRef.current = pending.after;
    const artifactDiff = diffSceneSummaries(pending.before, pending.after);
    if (!hasSceneChanges(artifactDiff)) return;
    appendAction({
      startedAtMs: pending.startedAtMs,
      endedAtMs: pending.endedAtMs,
      actorType: "human",
      actorMode: "human_interactive",
      source: "editor_change",
      rawEventType: "excalidraw:onChange_idle_flush",
      normalizedAction: sceneActionLabel(artifactDiff),
      targetObjectIds: sceneTargetIds(artifactDiff),
      ...compactSceneTransition(pending.before, pending.after, artifactDiff),
      success: true
    }, pending.phase, pending.afterElements);
  }, [appendAction]);

  const onCanvasChange = useCallback((
    elements: readonly ExcalidrawElement[],
    _appState: unknown,
    files: BinaryFiles
  ) => {
    latestElementsRef.current = elements;
    latestFilesRef.current = files;
    const nextSummary = summarizeElements(elements);
    setSummary(nextSummary);
    if (status !== "active" || performance.now() < suppressHumanChangeUntilRef.current) {
      baselineRef.current = nextSummary;
      return;
    }
    const now = elapsedMs();
    const pending = pendingHumanActionRef.current;
    pendingHumanActionRef.current = pending
      ? { ...pending, after: nextSummary, afterElements: elements, endedAtMs: now }
      : {
          before: baselineRef.current,
          after: nextSummary,
          afterElements: elements,
          startedAtMs: now,
          endedAtMs: now,
          phase: phaseRef.current
        };
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = setTimeout(flushHumanAction, actionIdleMs);
  }, [elapsedMs, flushHumanAction, status]);

  const startSession = useCallback(() => {
    if (!api || !participantId.trim()) {
      setMessage(api ? "Participant ID를 입력하세요." : "Canvas가 준비되지 않았습니다.");
      return;
    }
    const seed = chooseSeed(selectedTaskType, selectedSeedId, randomizeSeed);
    const initialPhase: TaskPhase = selectedTaskType === "adaptive_reframing" ? "phase_1" : "single_phase";
    const initialElements = selectedTaskType === "open_ended_interpretation" ? createSeedScene(seed.id) : [];
    const sessionId = `drawing-${selectedTaskType}-${crypto.randomUUID()}`;
    const startedAt = new Date();
    const metadata: SessionMetadata = {
      sessionId,
      participantId: participantId.trim(),
      actorType: "human",
      taskType: selectedTaskType,
      taskTitle: selectedTask.title,
      seedId: seed.id,
      seedLabel: seed.label,
      seedSelection: randomizeSeed ? "random" : "manual",
      inputDevice,
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationMs: null
    };

    sessionStartedPerformanceRef.current = performance.now();
    sessionEpochRef.current = startedAt.getTime();
    sessionRef.current = metadata;
    phaseRef.current = initialPhase;
    actionsRef.current = [];
    snapshotsRef.current = [];
    thinkAloudRef.current = [];
    phaseTransitionsRef.current = [];
    pointerEventsRef.current = [];
    audioChunksRef.current = [];
    audioChunkIndexRef.current = 0;
    previousAudioChunkEndRef.current = 0;
    pendingHumanActionRef.current = null;
    initialSeedElementIdsRef.current = initialElements.map(element => element.id);
    latestElementsRef.current = initialElements;
    baselineRef.current = summarizeElements(initialElements);
    suppressHumanChangeUntilRef.current = performance.now() + 800;
    api.updateScene({ elements: initialElements as ExcalidrawElement[] });
    if (initialElements.length > 0) {
      api.scrollToContent(initialElements, { fitToContent: true, animate: false });
    }
    setResolvedSeed(seed);
    setPhase(initialPhase);
    setSessionMetadata(metadata);
    setSummary(baselineRef.current);
    setActionCount(0);
    setSnapshotCount(0);
    setThinkAloudCount(0);
    setElapsedDisplayMs(0);
    setPostTaskResponse("");
    setStatus("active");
    setMessage("Session recording active");
    captureSnapshot("initial", initialElements, initialPhase);
  }, [api, captureSnapshot, inputDevice, participantId, randomizeSeed, selectedSeedId, selectedTask, selectedTaskType]);

  const revealPhaseTwo = useCallback(() => {
    if (status !== "active" || selectedTaskType !== "adaptive_reframing" || phaseRef.current !== "phase_1") return;
    flushHumanAction();
    const elements = latestElementsRef.current;
    const phase1SnapshotId = captureSnapshot("phase_1_end", elements, "phase_1");
    phaseRef.current = "phase_2";
    setPhase("phase_2");
    const phase2SnapshotId = captureSnapshot("phase_2_start", elements, "phase_2");
    const instruction = instructionForTask("adaptive_reframing", resolvedSeed.label, "phase_2");
    phaseTransitionsRef.current.push({
      transitionId: `${sessionRef.current!.sessionId}:phase-transition:1`,
      timestamp: timestampAt(elapsedMs()),
      elapsedMs: elapsedMs(),
      from: "phase_1",
      to: "phase_2",
      phase1SnapshotId,
      phase2SnapshotId,
      revealedInstruction: instruction
    });
    setMessage("Phase 2 constraint revealed");
  }, [captureSnapshot, elapsedMs, flushHumanAction, resolvedSeed.label, selectedTaskType, status, timestampAt]);

  const transcribeChunk = useCallback(async (blob: Blob, startedAtMs: number, endedAtMs: number) => {
    const chunkIndex = audioChunkIndexRef.current + 1;
    audioChunkIndexRef.current = chunkIndex;
    setPendingTranscriptions(count => count + 1);
    try {
      const response = await fetch("/api/google-stt-transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: await blobToBase64(blob),
          mimeType: blob.type,
          chunkIndex,
          chunkStartedAtMs: startedAtMs,
          chunkEndedAtMs: endedAtMs
        })
      });
      const result = await response.json() as SttResponse;
      appendThinkAloud(result.transcript ?? "", "human_audio", startedAtMs, endedAtMs, {
        chunkIndex,
        mimeType: blob.type,
        byteSize: blob.size,
        success: response.ok && result.success,
        error: result.error,
        languageCode: result.languageCode,
        segments: result.segments
      });
      setMessage(response.ok && result.success ? `Audio chunk ${chunkIndex} transcribed` : `Audio chunk ${chunkIndex} saved; STT failed`);
    } catch (error) {
      appendThinkAloud("", "human_audio", startedAtMs, endedAtMs, {
        chunkIndex,
        mimeType: blob.type,
        byteSize: blob.size,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      setMessage(`Audio chunk ${chunkIndex} saved; STT failed`);
    } finally {
      setPendingTranscriptions(count => Math.max(0, count - 1));
    }
  }, [appendThinkAloud]);

  const startRecording = useCallback(async () => {
    if (status !== "active") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("이 브라우저에서는 음성 녹음을 사용할 수 없습니다.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      previousAudioChunkEndRef.current = elapsedMs();
      recorder.ondataavailable = event => {
        if (event.data.size === 0) return;
        audioChunksRef.current.push(event.data);
        const ended = elapsedMs();
        const started = previousAudioChunkEndRef.current;
        previousAudioChunkEndRef.current = ended;
        void transcribeChunk(event.data, started, ended);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        setIsRecording(false);
      };
      recorder.start(recordingTimesliceMs);
      setIsRecording(true);
      setMessage("Continuous think-aloud recording active");
    } catch (error) {
      setMessage(`Microphone access failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [elapsedMs, status, transcribeChunk]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const finishSession = useCallback(() => {
    if (status !== "active" || !sessionRef.current) return;
    if (isRecording) stopRecording();
    flushHumanAction();
    if (postTaskResponse.trim()) appendThinkAloud(postTaskResponse, "post_task_response");
    captureSnapshot("final", latestElementsRef.current);
    const duration = elapsedMs();
    const completed = {
      ...sessionRef.current,
      endedAt: timestampAt(duration),
      durationMs: duration
    };
    sessionRef.current = completed;
    setSessionMetadata(completed);
    setElapsedDisplayMs(duration);
    setStatus("completed");
    setMessage("Session completed. Export data when transcription is finished.");
  }, [appendThinkAloud, captureSnapshot, elapsedMs, flushHumanAction, isRecording, postTaskResponse, status, stopRecording, timestampAt]);

  const exportSession = useCallback(async () => {
    if (!api || !sessionRef.current || status !== "completed" || isRecording || pendingTranscriptions > 0) return;
    const elements = api.getSceneElements();
    const imageBlob = await exportToBlob({
      elements,
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
      files: api.getFiles(),
      mimeType: "image/png",
      exportPadding: 24,
      maxWidthOrHeight: 1800
    });
    const task = taskByType(sessionRef.current.taskType);
    const instructionsByPhase = sessionRef.current.taskType === "adaptive_reframing"
      ? {
          phase_1: instructionForTask(sessionRef.current.taskType, sessionRef.current.seedLabel, "phase_1"),
          phase_2: instructionForTask(sessionRef.current.taskType, sessionRef.current.seedLabel, "phase_2")
        }
      : { single_phase: instructionForTask(sessionRef.current.taskType, sessionRef.current.seedLabel, "single_phase") };
    const audioFileName = audioChunksRef.current.length > 0 ? `${sessionRef.current.sessionId}-think-aloud.webm` : null;
    const payload: SessionExport = {
      schemaVersion: "simeval-drawing-session-v1",
      exportedAt: new Date().toISOString(),
      session: sessionRef.current,
      task: {
        instruction: task.instruction,
        instructionsByPhase,
        seed: {
          id: sessionRef.current.seedId,
          label: sessionRef.current.seedLabel,
          initialElementIds: initialSeedElementIdsRef.current
        }
      },
      phaseTransitions: phaseTransitionsRef.current,
      actions: actionsRef.current,
      thinkAloud: thinkAloudRef.current,
      pointerModalities: pointerEventsRef.current,
      snapshots: snapshotsRef.current,
      finalArtifact: {
        sceneElements: cloneElements(elements),
        image: { mimeType: "image/png", dataUrl: await blobToDataUrl(imageBlob) },
        audioFileName
      }
    };
    downloadBlob(`${sessionRef.current.sessionId}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    setMessage("Session JSON downloaded");
  }, [api, isRecording, pendingTranscriptions, status]);

  const downloadAudio = useCallback(() => {
    if (!sessionRef.current || audioChunksRef.current.length === 0) return;
    const mimeType = audioChunksRef.current[0].type || "audio/webm";
    downloadBlob(`${sessionRef.current.sessionId}-think-aloud.webm`, new Blob(audioChunksRef.current, { type: mimeType }));
  }, []);

  const resetForNextSession = useCallback(() => {
    if (!api) return;
    suppressHumanChangeUntilRef.current = performance.now() + 500;
    api.updateScene({ elements: [] });
    sessionRef.current = null;
    setSessionMetadata(null);
    setStatus("setup");
    setMessage("참가자와 task를 설정하세요.");
    setSummary(emptySummary);
  }, [api]);

  useEffect(() => {
    if (status !== "active") return;
    const timer = setInterval(() => setElapsedDisplayMs(elapsedMs()), 1000);
    const snapshotTimer = setInterval(() => captureSnapshot("periodic", latestElementsRef.current), snapshotIntervalMs);
    return () => {
      clearInterval(timer);
      clearInterval(snapshotTimer);
    };
  }, [captureSnapshot, elapsedMs, status]);

  useEffect(() => {
    if (!api) return;
    const agentApi = createPilotAgentApi({
      api,
      nowMs: elapsedMs,
      onBeforeMutation: () => {
        flushHumanAction();
        suppressHumanChangeUntilRef.current = performance.now() + 1000;
        pendingHumanActionRef.current = null;
      },
      onAction: draft => {
        const nextElements = api.getSceneElements();
        appendAction(draft, phaseRef.current, nextElements);
        baselineRef.current = summarizeElements(nextElements);
      },
      onThinkAloud: text => appendThinkAloud(text, "agent_reasoning"),
      onFinish: finishSession
    });
    window.simevalAgentApi = agentApi;
    return () => {
      delete window.simevalAgentApi;
    };
  }, [api, appendAction, appendThinkAloud, elapsedMs, finishSession, flushHumanAction]);

  useEffect(() => () => {
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  const changeTask = (type: TaskType) => {
    const task = taskByType(type);
    setSelectedTaskType(type);
    setSelectedSeedId(task.seeds[0].id);
    setResolvedSeed(task.seeds[0]);
  };

  const formatDuration = (value: number) => {
    const seconds = Math.floor(value / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };

  return (
    <main className={`app-shell ${panelCollapsed ? "panel-collapsed" : ""}`}>
      <header className="session-bar">
        <div className="brand-block">
          <strong>Simeval Drawing Pilot</strong>
          <span>{sessionMetadata ? `${sessionMetadata.participantId} · ${sessionMetadata.taskTitle}` : "Human creative process collection"}</span>
        </div>
        {status !== "setup" && (
          <div className="session-metrics" aria-label="Session status">
            <span>{formatDuration(elapsedDisplayMs)}</span>
            <span>{actionCount} actions</span>
            <span>{snapshotCount} snapshots</span>
          </div>
        )}
        {status === "active" && <button className="danger-button" onClick={finishSession}>Finish session</button>}
        {status === "completed" && <button onClick={resetForNextSession}>New session</button>}
      </header>

      <div className="main-stage">
      {status === "setup" && (
        <section className="setup-view">
          <div className="setup-form">
            <div className="setup-heading">
              <span className="eyebrow">Pilot session setup</span>
              <h1>Drawing + Think-aloud</h1>
            </div>

            <div className="field-grid two-column">
              <label>
                <span>Participant ID</span>
                <input value={participantId} onChange={event => setParticipantId(event.target.value)} placeholder="P001" autoComplete="off" />
              </label>
              <label>
                <span>Primary input device</span>
                <select value={inputDevice} onChange={event => setInputDevice(event.target.value as InputDevice)}>
                  <option value="unknown">Not specified</option>
                  <option value="mouse">Mouse</option>
                  <option value="stylus">Stylus / pen tablet</option>
                  <option value="touch">Touch</option>
                  <option value="mixed">Mixed</option>
                </select>
              </label>
            </div>

            <fieldset className="task-picker">
              <legend>Task</legend>
              {taskDefinitions.map(task => (
                <label key={task.type} className={selectedTaskType === task.type ? "task-option selected" : "task-option"}>
                  <input type="radio" name="task" checked={selectedTaskType === task.type} onChange={() => changeTask(task.type)} />
                  <span className="task-number">{task.number}</span>
                  <span><strong>{task.title}</strong><small>{task.construct}</small></span>
                </label>
              ))}
            </fieldset>

            <div className="seed-row">
              <label className="seed-select">
                <span>{selectedTaskType === "conceptual_synthesis" ? "Concept pair" : "Seed"}</span>
                <select value={selectedSeedId} disabled={randomizeSeed} onChange={event => setSelectedSeedId(event.target.value)}>
                  {selectedTask.seeds.map(seed => <option key={seed.id} value={seed.id}>{seed.label}</option>)}
                </select>
              </label>
              <label className="check-control">
                <input type="checkbox" checked={randomizeSeed} onChange={event => setRandomizeSeed(event.target.checked)} />
                <span>Random assignment</span>
              </label>
            </div>

            <div className="instruction-preview">
              <span>Instruction</span>
              <p>{selectedTask.instruction}</p>
            </div>
            <button className="primary-button start-button" disabled={!api || !participantId.trim()} onClick={startSession}>Start session</button>
            <p className="status-line">{message}</p>
          </div>
        </section>
      )}
        <div className={`workspace ${status === "setup" ? "workspace-underlay" : ""}`}>
          <aside className="study-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">{phase === "single_phase" ? "Single phase" : phase.replace("_", " ")}</span>
                <h2>{sessionMetadata?.taskTitle}</h2>
              </div>
              <button className="icon-button" title="Hide study panel" aria-label="Hide study panel" onClick={() => setPanelCollapsed(true)}>‹</button>
            </div>
            <section className="instruction-block">
              <span>Instruction</span>
              <p>{currentInstruction}</p>
              {resolvedSeed.label && selectedTaskType === "free_creation" && <small>Seed: {resolvedSeed.label}</small>}
            </section>
            {status === "active" && selectedTaskType === "adaptive_reframing" && phase === "phase_1" && (
              <button className="constraint-button" onClick={revealPhaseTwo}>Reveal unexpected constraint</button>
            )}

            <section className="think-panel">
              <div className="section-title-row">
                <h3>Think-aloud</h3>
                <span>{thinkAloudCount}</span>
              </div>
              <textarea value={noteText} disabled={status !== "active"} onChange={event => setNoteText(event.target.value)} placeholder="생각을 짧게 기록하세요" />
              <button disabled={status !== "active" || !noteText.trim()} onClick={() => {
                appendThinkAloud(noteText, "human_text");
                setNoteText("");
              }}>Add note</button>
              <div className="record-row">
                <button className={isRecording ? "recording" : ""} disabled={status !== "active"} onClick={isRecording ? stopRecording : startRecording}>
                  {isRecording ? "Stop recording" : "Start recording"}
                </button>
                <span>{isRecording ? "Recording" : pendingTranscriptions > 0 ? `${pendingTranscriptions} transcribing` : "Idle"}</span>
              </div>
            </section>

            {selectedTaskType === "conceptual_synthesis" && (
              <label className="post-task-field">
                <span>두 개념이 어떻게 통합되었나요?</span>
                <textarea value={postTaskResponse} disabled={status !== "active"} onChange={event => setPostTaskResponse(event.target.value)} />
              </label>
            )}

            <div className="collection-status">
              <span>{summary.total} objects</span>
              <span>{message}</span>
            </div>

            {status === "completed" && (
              <div className="export-actions">
                <button className="primary-button" disabled={isRecording || pendingTranscriptions > 0} onClick={() => void exportSession()}>
                  {isRecording || pendingTranscriptions > 0 ? "Waiting for audio processing" : "Download session JSON"}
                </button>
                <button disabled={audioChunksRef.current.length === 0} onClick={downloadAudio}>Download audio</button>
              </div>
            )}
          </aside>

          <section
            className="canvas-shell"
            onPointerDown={event => {
              if (status !== "active") return;
              const pointerType = event.pointerType === "pen" || event.pointerType === "touch" ? event.pointerType : "mouse";
              pointerEventsRef.current.push({ timestamp: timestampAt(elapsedMs()), elapsedMs: elapsedMs(), pointerType });
            }}
          >
            {panelCollapsed && <button className="show-panel-button" onClick={() => setPanelCollapsed(false)}>Task</button>}
            <Excalidraw
              excalidrawAPI={setApi}
              onChange={onCanvasChange}
              langCode="en"
              theme="light"
            />
          </section>
        </div>
      </div>
    </main>
  );
}

export default App;
