import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPilotAgentApi, type PilotAgentApi } from "./agent/pilotAgentApi";
import { runTimedAgent, type AgentTrajectoryEntry } from "./agent/timedAgent";
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
  SessionActor,
  SessionMetadata,
  ThinkAloudChunk,
  ThinkAloudNote,
  ThinkAloudSegment
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
const defaultAgentTimeBudgetMinutes = 5;
const agentFinalizationWindowMs = 30 * 1000;
const enableAgentMode = import.meta.env.VITE_ENABLE_AGENT_MODE === "true";

type SessionStatus = "setup" | "active" | "completed";
type RecordingFinalizationStatus = "idle" | "recording" | "stopping" | "transcribing" | "ready_to_export" | "exported";
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
  segments?: ThinkAloudSegment[];
};
type ThinkAloudChunkContext = {
  sourceSessionId: string;
  chunkIndex: number;
  chunkStartedAtMs: number;
  chunkEndedAtMs: number;
  phaseAtStart: TaskPhase;
  phaseAtEnd: TaskPhase;
  crossesPhaseTransition: boolean;
};
type AudioExportMetadata = SessionExport["finalArtifact"]["audio"];

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

function clearActionTimer(timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = null;
}

function assertCondition(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function validateThinkAloudChunks({
  session,
  chunks,
  pendingCount
}: {
  session: SessionMetadata;
  chunks: readonly ThinkAloudChunk[];
  pendingCount: number;
}) {
  const validPhases: TaskPhase[] = ["single_phase", "phase_1", "phase_2"];
  const seenChunkIds = new Set<string>();
  const seenChunkIndexes = new Set<number>();
  let previousSequence = 0;

  assertCondition(pendingCount === 0, "Pending transcription requests remain for this session.");
  for (const chunk of chunks) {
    assertCondition(chunk.sessionId === session.sessionId, `Think-aloud chunk belongs to another session: ${chunk.thinkAloudChunkId}`);
    assertCondition(!seenChunkIds.has(chunk.thinkAloudChunkId), `Duplicate think-aloud chunk id: ${chunk.thinkAloudChunkId}`);
    assertCondition(!seenChunkIndexes.has(chunk.audio.chunkIndex), `Duplicate audio chunk index: ${chunk.audio.chunkIndex}`);
    assertCondition(chunk.sequence > previousSequence, `Think-aloud chunk sequence is not strictly increasing: ${chunk.sequence}`);
    assertCondition(chunk.chunkStartedAtMs >= 0, `Invalid chunk start time: ${chunk.thinkAloudChunkId}`);
    assertCondition(chunk.chunkEndedAtMs >= chunk.chunkStartedAtMs, `Invalid chunk end time: ${chunk.thinkAloudChunkId}`);
    assertCondition(chunk.durationMs === chunk.chunkEndedAtMs - chunk.chunkStartedAtMs, `Invalid chunk duration: ${chunk.thinkAloudChunkId}`);
    assertCondition(validPhases.includes(chunk.phaseAtStart), `Invalid phaseAtStart: ${chunk.phaseAtStart}`);
    assertCondition(validPhases.includes(chunk.phaseAtEnd), `Invalid phaseAtEnd: ${chunk.phaseAtEnd}`);
    assertCondition(chunk.crossesPhaseTransition === (chunk.phaseAtStart !== chunk.phaseAtEnd), `Invalid phase transition flag: ${chunk.thinkAloudChunkId}`);
    if (chunk.transcriptionStatus === "failed") {
      assertCondition(chunk.audio.success === false, `Failed transcription has audio.success=true: ${chunk.thinkAloudChunkId}`);
      assertCondition(Boolean(chunk.audio.error), `Failed transcription has no error: ${chunk.thinkAloudChunkId}`);
    }
    if (chunk.transcriptionStatus === "empty") {
      assertCondition(chunk.audio.success === true, `Empty transcription has audio.success=false: ${chunk.thinkAloudChunkId}`);
      assertCondition(chunk.content.trim() === "", `Empty transcription has content: ${chunk.thinkAloudChunkId}`);
    }
    if (chunk.transcriptionStatus === "completed") {
      assertCondition(chunk.audio.success === true, `Completed transcription has audio.success=false: ${chunk.thinkAloudChunkId}`);
      assertCondition(chunk.content.trim() !== "", `Completed transcription is empty: ${chunk.thinkAloudChunkId}`);
    }

    seenChunkIds.add(chunk.thinkAloudChunkId);
    seenChunkIndexes.add(chunk.audio.chunkIndex);
    previousSequence = chunk.sequence;
  }
}

function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<SessionStatus>("setup");
  const [selectedActor, setSelectedActor] = useState<SessionActor | null>(enableAgentMode ? null : "human");
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
  const [postTaskResponse, setPostTaskResponse] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [recordingFinalizationStatus, setRecordingFinalizationStatus] = useState<RecordingFinalizationStatus>("idle");
  const [sessionExported, setSessionExported] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [agentTimeBudgetMinutes, setAgentTimeBudgetMinutes] = useState(defaultAgentTimeBudgetMinutes);
  const [agentTrajectory, setAgentTrajectory] = useState<AgentTrajectoryEntry[]>([]);
  const [message, setMessage] = useState("참가자와 task를 설정하세요.");

  const sessionRef = useRef<SessionMetadata | null>(null);
  const phaseRef = useRef<TaskPhase>("single_phase");
  const sessionStartedPerformanceRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const actionsRef = useRef<RecordedAction[]>([]);
  const snapshotsRef = useRef<CanvasSnapshot[]>([]);
  const thinkAloudChunksRef = useRef<ThinkAloudChunk[]>([]);
  const thinkAloudNotesRef = useRef<ThinkAloudNote[]>([]);
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
  const recorderMimeTypeRef = useRef<string | null>(null);
  const audioChunkIndexRef = useRef(0);
  const previousAudioChunkEndRef = useRef(0);
  const previousAudioChunkPhaseRef = useRef<TaskPhase>("single_phase");
  const recordingSessionIdRef = useRef<string | null>(null);
  const pendingTranscriptionsBySessionRef = useRef<Map<string, number>>(new Map());
  const pendingResolversBySessionRef = useRef<Map<string, Array<() => void>>>(new Map());
  const recorderStopResolverRef = useRef<(() => void) | null>(null);
  const finalDataAvailableHandledRef = useRef(true);
  const exportedSessionIdsRef = useRef<Set<string>>(new Set());
  const pilotAgentApiRef = useRef<PilotAgentApi | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const agentStartedSessionIdRef = useRef("");
  const agentTrajectoryRef = useRef<AgentTrajectoryEntry[]>([]);
  const completionReasonRef = useRef("manual");

  const selectedTask = useMemo(() => taskByType(selectedTaskType), [selectedTaskType]);
  const currentInstruction = instructionForTask(selectedTaskType, resolvedSeed.label, phase);

  useEffect(() => {
    if (!enableAgentMode && selectedActor !== "human") {
      setSelectedActor("human");
    }
  }, [selectedActor]);

  const elapsedMs = useCallback(() => {
    if (!sessionRef.current) return 0;
    return Math.max(0, Math.round(performance.now() - sessionStartedPerformanceRef.current));
  }, []);

  const timestampAt = useCallback((relativeMs: number) => {
    return new Date(sessionEpochRef.current + relativeMs).toISOString();
  }, []);

  const getPendingCount = useCallback((sessionId?: string | null) => {
    if (!sessionId) return 0;
    return pendingTranscriptionsBySessionRef.current.get(sessionId) ?? 0;
  }, []);

  const refreshPendingTranscriptions = useCallback((sessionId = sessionRef.current?.sessionId ?? null) => {
    setPendingTranscriptions(getPendingCount(sessionId));
  }, [getPendingCount]);

  const resolvePendingWaiters = useCallback((sessionId: string) => {
    if (getPendingCount(sessionId) !== 0) return;
    const resolvers = pendingResolversBySessionRef.current.get(sessionId) ?? [];
    pendingResolversBySessionRef.current.delete(sessionId);
    resolvers.forEach(resolve => resolve());
  }, [getPendingCount]);

  const incrementPending = useCallback((sessionId: string) => {
    const current = getPendingCount(sessionId);
    pendingTranscriptionsBySessionRef.current.set(sessionId, current + 1);
    refreshPendingTranscriptions(sessionId);
  }, [getPendingCount, refreshPendingTranscriptions]);

  const decrementPending = useCallback((sessionId: string) => {
    const current = getPendingCount(sessionId);
    pendingTranscriptionsBySessionRef.current.set(sessionId, Math.max(0, current - 1));
    refreshPendingTranscriptions(sessionId);
    resolvePendingWaiters(sessionId);
  }, [getPendingCount, refreshPendingTranscriptions, resolvePendingWaiters]);

  const waitForPendingTranscriptions = useCallback((sessionId: string) => {
    if (getPendingCount(sessionId) === 0) return Promise.resolve();
    return new Promise<void>(resolve => {
      const resolvers = pendingResolversBySessionRef.current.get(sessionId) ?? [];
      resolvers.push(resolve);
      pendingResolversBySessionRef.current.set(sessionId, resolvers);
    });
  }, [getPendingCount]);

  const createCombinedAudioBlob = useCallback(() => {
    if (audioChunksRef.current.length === 0) return null;
    const mimeType = recorderMimeTypeRef.current || audioChunksRef.current[0]?.type || "audio/webm";
    return new Blob(audioChunksRef.current, { type: mimeType });
  }, []);

  const buildAudioMetadata = useCallback((sessionId: string): AudioExportMetadata => {
    const audioBlob = createCombinedAudioBlob();
    if (!audioBlob) {
      return {
        available: false,
        fileName: null,
        mimeType: null,
        byteSize: 0,
        chunkCount: 0,
        warning: "No think-aloud audio was recorded for this session."
      };
    }
    return {
      available: true,
      fileName: `drawing-${sessionId}.webm`,
      mimeType: audioBlob.type || "audio/webm",
      byteSize: audioBlob.size,
      chunkCount: audioChunksRef.current.length
    };
  }, [createCombinedAudioBlob]);

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

  const appendThinkAloudNote = useCallback((
    content: string,
    source: ThinkAloudNote["source"],
    noteElapsedMs = elapsedMs()
  ) => {
    const session = sessionRef.current;
    const clean = content.trim();
    if (!session || !clean) return;
    const note: ThinkAloudNote = {
      thinkAloudNoteId: `${session.sessionId}:note:${thinkAloudNotesRef.current.length + 1}`,
      sessionId: session.sessionId,
      timestamp: timestampAt(noteElapsedMs),
      elapsedMs: noteElapsedMs,
      phase: phaseRef.current,
      source,
      content: clean
    };
    thinkAloudNotesRef.current.push(note);
  }, [elapsedMs, timestampAt]);

  const appendThinkAloudChunk = useCallback((chunk: ThinkAloudChunk) => {
    if (!sessionRef.current || sessionRef.current.sessionId !== chunk.sessionId) {
      console.error("[ThinkAloud] Late transcription session mismatch", {
        sourceSessionId: chunk.sessionId,
        activeSessionId: sessionRef.current?.sessionId ?? null,
        chunkIndex: chunk.audio.chunkIndex
      });
      return;
    }
    thinkAloudChunksRef.current.push(chunk);
    setThinkAloudCount(thinkAloudChunksRef.current.length);
  }, []);

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
    clearActionTimer(actionTimerRef);
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

  const resetCanvasForSession = useCallback((elements: readonly ExcalidrawElement[]) => {
    if (!api) return;
    clearActionTimer(actionTimerRef);
    pendingHumanActionRef.current = null;
    suppressHumanChangeUntilRef.current = performance.now() + 1000;
    api.resetScene();
    api.updateScene({ elements: elements as ExcalidrawElement[] });
    api.history.clear();
    latestElementsRef.current = elements;
    latestFilesRef.current = {};
    baselineRef.current = summarizeElements(elements);
    setSummary(baselineRef.current);
    if (elements.length > 0) {
      api.scrollToContent(elements, { fitToContent: true, animate: false });
    }
  }, [api]);

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
    if (!api || !selectedActor || (selectedActor === "human" && !participantId.trim())) {
      setMessage(!api ? "Canvas가 준비되지 않았습니다." : "Participant ID를 입력하세요.");
      return;
    }
    if (selectedActor === "agent" && !enableAgentMode) {
      setMessage("Agent mode is disabled in this deployment.");
      return;
    }
    const previousSession = sessionRef.current;
    if (
      previousSession &&
      !sessionExported &&
      buildAudioMetadata(previousSession.sessionId).available
    ) {
      setMessage("Export the previous session JSON/audio before starting a new session.");
      return;
    }
    const seed = chooseSeed(selectedTaskType, selectedSeedId, randomizeSeed);
    const initialPhase: TaskPhase = selectedTaskType === "adaptive_reframing" ? "phase_1" : "single_phase";
    const initialElements = selectedTaskType === "open_ended_interpretation" ? createSeedScene(seed.id) : [];
    const selectedAgentTimeBudgetMs = Math.max(1, agentTimeBudgetMinutes) * 60 * 1000;
    const sessionId = `drawing-${selectedTaskType}-${crypto.randomUUID()}`;
    const startedAt = new Date();
    const metadata: SessionMetadata = {
      sessionId,
      participantId: selectedActor === "human" ? participantId.trim() : "agent",
      actorType: selectedActor,
      taskType: selectedTaskType,
      taskTitle: selectedTask.title,
      seedId: seed.id,
      seedLabel: seed.label,
      seedSelection: randomizeSeed ? "random" : "manual",
      inputDevice: selectedActor === "human" ? inputDevice : "unknown",
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationMs: null,
      completionReason: null,
      agentConfig: selectedActor === "agent" ? {
        model: null,
        timeBudgetMs: selectedAgentTimeBudgetMs,
        finalizationWindowMs: agentFinalizationWindowMs,
        terminationPolicy: "time_budget"
      } : null
    };

    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    agentStartedSessionIdRef.current = "";
    clearActionTimer(actionTimerRef);
    pendingHumanActionRef.current = null;
    sessionRef.current = null;
    resetCanvasForSession(initialElements);

    sessionStartedPerformanceRef.current = performance.now();
    sessionEpochRef.current = startedAt.getTime();
    sessionRef.current = metadata;
    phaseRef.current = initialPhase;
    actionsRef.current = [];
    snapshotsRef.current = [];
    thinkAloudChunksRef.current = [];
    thinkAloudNotesRef.current = [];
    agentTrajectoryRef.current = [];
    completionReasonRef.current = "manual";
    phaseTransitionsRef.current = [];
    pointerEventsRef.current = [];
    audioChunksRef.current = [];
    recorderMimeTypeRef.current = null;
    audioChunkIndexRef.current = 0;
    previousAudioChunkEndRef.current = 0;
    previousAudioChunkPhaseRef.current = initialPhase;
    recordingSessionIdRef.current = null;
    finalDataAvailableHandledRef.current = true;
    pendingTranscriptionsBySessionRef.current.set(sessionId, 0);
    pendingHumanActionRef.current = null;
    initialSeedElementIdsRef.current = initialElements.map(element => element.id);
    setResolvedSeed(seed);
    setPhase(initialPhase);
    setSessionMetadata(metadata);
    setSummary(baselineRef.current);
    setActionCount(0);
    setSnapshotCount(0);
    setThinkAloudCount(0);
    setPendingTranscriptions(0);
    setRecordingFinalizationStatus("idle");
    setSessionExported(false);
    setAgentTrajectory([]);
    setIsAgentRunning(false);
    setElapsedDisplayMs(0);
    setPostTaskResponse("");
    setStatus("active");
    setMessage(selectedActor === "agent" ? "Agent session ready" : "Session recording active");
    captureSnapshot("initial", initialElements, initialPhase);
  }, [agentTimeBudgetMinutes, api, buildAudioMetadata, captureSnapshot, inputDevice, participantId, randomizeSeed, resetCanvasForSession, selectedActor, selectedSeedId, selectedTask, selectedTaskType, sessionExported]);

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

  const transcribeChunk = useCallback(async (blob: Blob, context: ThinkAloudChunkContext) => {
    incrementPending(context.sourceSessionId);
    try {
      const response = await fetch("/api/google-stt-transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: await blobToBase64(blob),
          mimeType: blob.type,
          chunkIndex: context.chunkIndex,
          chunkStartedAtMs: context.chunkStartedAtMs,
          chunkEndedAtMs: context.chunkEndedAtMs
        })
      });
      const result = await response.json() as SttResponse;
      const content = result.transcript ?? "";
      appendThinkAloudChunk({
        thinkAloudChunkId: `${context.sourceSessionId}:think-aloud-chunk:${context.chunkIndex}`,
        sessionId: context.sourceSessionId,
        sequence: context.chunkIndex,
        timestamp: timestampAt(context.chunkStartedAtMs),
        chunkStartedAtMs: context.chunkStartedAtMs,
        chunkEndedAtMs: context.chunkEndedAtMs,
        durationMs: Math.max(0, context.chunkEndedAtMs - context.chunkStartedAtMs),
        phaseAtStart: context.phaseAtStart,
        phaseAtEnd: context.phaseAtEnd,
        crossesPhaseTransition: context.crossesPhaseTransition,
        source: "human_audio",
        content: content.trim(),
        transcriptionStatus: response.ok && result.success
          ? content.trim().length > 0 ? "completed" : "empty"
          : "failed",
        audio: {
          chunkIndex: context.chunkIndex,
          mimeType: blob.type,
          byteSize: blob.size,
          languageCode: result.languageCode ?? "",
          success: response.ok && result.success,
          error: result.error,
          segments: result.segments ?? []
        }
      });
      setMessage(response.ok && result.success ? `Audio chunk ${context.chunkIndex} transcribed` : `Audio chunk ${context.chunkIndex} saved; STT failed`);
    } catch (error) {
      appendThinkAloudChunk({
        thinkAloudChunkId: `${context.sourceSessionId}:think-aloud-chunk:${context.chunkIndex}`,
        sessionId: context.sourceSessionId,
        sequence: context.chunkIndex,
        timestamp: timestampAt(context.chunkStartedAtMs),
        chunkStartedAtMs: context.chunkStartedAtMs,
        chunkEndedAtMs: context.chunkEndedAtMs,
        durationMs: Math.max(0, context.chunkEndedAtMs - context.chunkStartedAtMs),
        phaseAtStart: context.phaseAtStart,
        phaseAtEnd: context.phaseAtEnd,
        crossesPhaseTransition: context.crossesPhaseTransition,
        source: "human_audio",
        content: "",
        transcriptionStatus: "failed",
        audio: {
          chunkIndex: context.chunkIndex,
          mimeType: blob.type,
          byteSize: blob.size,
          languageCode: "",
          success: false,
          error: error instanceof Error ? error.message : String(error),
          segments: []
        }
      });
      setMessage(`Audio chunk ${context.chunkIndex} saved; STT failed`);
    } finally {
      decrementPending(context.sourceSessionId);
    }
  }, [appendThinkAloudChunk, decrementPending, incrementPending, timestampAt]);

  const startRecording = useCallback(async () => {
    if (status !== "active") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessage("이 브라우저에서는 음성 녹음을 사용할 수 없습니다.");
      return;
    }
    try {
      const session = sessionRef.current;
      if (!session) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorderMimeTypeRef.current = recorder.mimeType || mimeType || "audio/webm";
      recordingSessionIdRef.current = session.sessionId;
      audioChunksRef.current = [];
      previousAudioChunkEndRef.current = elapsedMs();
      previousAudioChunkPhaseRef.current = phaseRef.current;
      finalDataAvailableHandledRef.current = false;
      recorder.ondataavailable = event => {
        finalDataAvailableHandledRef.current = true;
        if (event.data.size === 0) return;
        const sourceSessionId = recordingSessionIdRef.current;
        if (!sourceSessionId) return;
        audioChunksRef.current.push(event.data);
        const ended = elapsedMs();
        const started = previousAudioChunkEndRef.current;
        const phaseAtStart = previousAudioChunkPhaseRef.current;
        const phaseAtEnd = phaseRef.current;
        previousAudioChunkEndRef.current = ended;
        previousAudioChunkPhaseRef.current = phaseAtEnd;
        const chunkIndex = audioChunkIndexRef.current + 1;
        audioChunkIndexRef.current = chunkIndex;
        void transcribeChunk(event.data, {
          sourceSessionId,
          chunkIndex,
          chunkStartedAtMs: started,
          chunkEndedAtMs: ended,
          phaseAtStart,
          phaseAtEnd,
          crossesPhaseTransition: phaseAtStart !== phaseAtEnd
        });
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        finalDataAvailableHandledRef.current = true;
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        setIsRecording(false);
        recorderStopResolverRef.current?.();
        recorderStopResolverRef.current = null;
      };
      recorder.start(recordingTimesliceMs);
      setIsRecording(true);
      setRecordingFinalizationStatus("recording");
      setMessage("Continuous think-aloud recording active");
    } catch (error) {
      setMessage(`Microphone access failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [elapsedMs, status, transcribeChunk]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const stopRecordingAndWait = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      finalDataAvailableHandledRef.current = true;
      return Promise.resolve();
    }
    setRecordingFinalizationStatus("stopping");
    return new Promise<void>(resolve => {
      recorderStopResolverRef.current = resolve;
      recorder.stop();
    });
  }, []);

  const finishSession = useCallback(async () => {
    if (!sessionRef.current || sessionRef.current.endedAt) return;
    const finishingSessionId = sessionRef.current.sessionId;
    agentAbortRef.current?.abort();
    if (isRecording || mediaRecorderRef.current?.state === "recording") {
      await stopRecordingAndWait();
    }
    if (!finalDataAvailableHandledRef.current) {
      setRecordingFinalizationStatus("stopping");
    }
    if (getPendingCount(finishingSessionId) > 0) {
      setRecordingFinalizationStatus("transcribing");
      setMessage(`Waiting for ${getPendingCount(finishingSessionId)} audio transcription(s)`);
      await waitForPendingTranscriptions(finishingSessionId);
    }
    flushHumanAction();
    if (postTaskResponse.trim()) appendThinkAloudNote(postTaskResponse, "post_task_response");
    captureSnapshot("final", latestElementsRef.current);
    const duration = elapsedMs();
    const completed = {
      ...sessionRef.current,
      endedAt: timestampAt(duration),
      durationMs: duration,
      completionReason: completionReasonRef.current
    };
    sessionRef.current = completed;
    setSessionMetadata(completed);
    setElapsedDisplayMs(duration);
    setStatus("completed");
    setRecordingFinalizationStatus("ready_to_export");
    refreshPendingTranscriptions(finishingSessionId);
    setMessage("Session completed. Export JSON and audio before starting the next session.");
  }, [appendThinkAloudNote, captureSnapshot, elapsedMs, flushHumanAction, getPendingCount, isRecording, postTaskResponse, refreshPendingTranscriptions, stopRecordingAndWait, timestampAt, waitForPendingTranscriptions]);

  const exportSession = useCallback(async () => {
    if (!api || !sessionRef.current || status !== "completed" || isRecording || isAgentRunning || getPendingCount(sessionRef.current.sessionId) > 0) return;
    const session = sessionRef.current;
    try {
      validateThinkAloudChunks({
        session,
        chunks: thinkAloudChunksRef.current,
        pendingCount: getPendingCount(session.sessionId)
      });
    } catch (error) {
      setMessage(`Export validation failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const elements = api.getSceneElements();
    const imageBlob = await exportToBlob({
      elements,
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
      files: api.getFiles(),
      mimeType: "image/png",
      exportPadding: 24,
      maxWidthOrHeight: 1800
    });
    const task = taskByType(session.taskType);
    const instructionsByPhase = session.taskType === "adaptive_reframing"
      ? {
          phase_1: instructionForTask(session.taskType, session.seedLabel, "phase_1"),
          phase_2: instructionForTask(session.taskType, session.seedLabel, "phase_2")
        }
      : { single_phase: instructionForTask(session.taskType, session.seedLabel, "single_phase") };
    const audioBlob = createCombinedAudioBlob();
    const audioMetadata = buildAudioMetadata(session.sessionId);
    const payload: SessionExport = {
      schemaVersion: "simeval-drawing-session-v2",
      exportedAt: new Date().toISOString(),
      session,
      task: {
        instruction: task.instruction,
        instructionsByPhase,
        seed: {
          id: session.seedId,
          label: session.seedLabel,
          initialElementIds: initialSeedElementIdsRef.current
        }
      },
      phaseTransitions: phaseTransitionsRef.current,
      actions: actionsRef.current,
      thinkAloudChunks: thinkAloudChunksRef.current,
      thinkAloudNotes: thinkAloudNotesRef.current,
      agentTrajectory: agentTrajectoryRef.current,
      pointerModalities: pointerEventsRef.current,
      snapshots: snapshotsRef.current,
      finalArtifact: {
        sceneElements: cloneElements(elements),
        image: { mimeType: "image/png", dataUrl: await blobToDataUrl(imageBlob) },
        audio: audioMetadata
      }
    };
    if (audioBlob && audioMetadata.fileName) {
      downloadBlob(audioMetadata.fileName, audioBlob);
    }
    downloadBlob(`drawing-${session.sessionId}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    exportedSessionIdsRef.current.add(session.sessionId);
    setSessionExported(true);
    setRecordingFinalizationStatus("exported");
    setMessage(audioBlob ? "Session JSON and audio downloaded" : "Session JSON downloaded; no audio was recorded");
  }, [api, buildAudioMetadata, createCombinedAudioBlob, getPendingCount, isAgentRunning, isRecording, status]);

  const downloadAudio = useCallback(() => {
    if (!sessionRef.current || audioChunksRef.current.length === 0) return;
    const audioBlob = createCombinedAudioBlob();
    if (!audioBlob) return;
    downloadBlob(`drawing-${sessionRef.current.sessionId}.webm`, audioBlob);
  }, [createCombinedAudioBlob]);

  const resetForNextSession = useCallback(() => {
    if (!api) return;
    if (
      sessionRef.current &&
      !sessionExported &&
      buildAudioMetadata(sessionRef.current.sessionId).available
    ) {
      setMessage("Export the previous session JSON/audio before starting a new session.");
      return;
    }
    if (sessionRef.current && getPendingCount(sessionRef.current.sessionId) > 0) {
      setMessage("Wait for pending transcription before starting a new session.");
      return;
    }
    resetCanvasForSession([]);
    sessionRef.current = null;
    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    agentStartedSessionIdRef.current = "";
    setSessionMetadata(null);
    setSelectedActor(null);
    setStatus("setup");
    setMessage("참가자와 task를 설정하세요.");
    setSummary(emptySummary);
    setAgentTrajectory([]);
    setRecordingFinalizationStatus("idle");
  }, [api, buildAudioMetadata, getPendingCount, resetCanvasForSession, sessionExported]);

  const captureAgentScreenshot = useCallback(async () => {
    if (!api) return undefined;
    const elements = api.getSceneElements();
    if (elements.length === 0) return undefined;
    const blob = await exportToBlob({
      elements,
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
      files: api.getFiles(),
      mimeType: "image/png",
      exportPadding: 24,
      maxWidthOrHeight: 1400
    });
    return blobToDataUrl(blob);
  }, [api]);

  useEffect(() => {
    if (status !== "active") return;
    const timer = setInterval(() => setElapsedDisplayMs(elapsedMs()), 1000);
    const snapshotTimer = sessionRef.current?.actorType === "human"
      ? setInterval(() => captureSnapshot("periodic", latestElementsRef.current), snapshotIntervalMs)
      : null;
    return () => {
      clearInterval(timer);
      if (snapshotTimer) clearInterval(snapshotTimer);
    };
  }, [captureSnapshot, elapsedMs, status]);

  useEffect(() => {
    if (!api) return;
    if (!enableAgentMode) {
      pilotAgentApiRef.current = null;
      delete window.simevalAgentApi;
      return;
    }
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
      onThinkAloud: text => appendThinkAloudNote(text, "agent_reasoning"),
      onFinish: finishSession
    });
    pilotAgentApiRef.current = agentApi;
    window.simevalAgentApi = agentApi;
    return () => {
      pilotAgentApiRef.current = null;
      delete window.simevalAgentApi;
    };
  }, [api, appendAction, appendThinkAloudNote, elapsedMs, finishSession, flushHumanAction]);

  useEffect(() => {
    const session = sessionRef.current;
    const agentApi = pilotAgentApiRef.current;
    if (!enableAgentMode || status !== "active" || session?.actorType !== "agent" || !agentApi) return;
    if (agentStartedSessionIdRef.current === session.sessionId) return;
    agentStartedSessionIdRef.current = session.sessionId;
    const controller = new AbortController();
    agentAbortRef.current = controller;
    setIsAgentRunning(true);
    setMessage("Agent is observing the canvas");

    void runTimedAgent({
      tools: agentApi.tools,
      getInstruction: () => instructionForTask(
        sessionRef.current!.taskType,
        sessionRef.current!.seedLabel,
        phaseRef.current
      ),
      captureScreenshot: captureAgentScreenshot,
      timeBudgetMs: session.agentConfig?.timeBudgetMs ?? defaultAgentTimeBudgetMinutes * 60 * 1000,
      finalizationWindowMs: session.agentConfig?.finalizationWindowMs ?? agentFinalizationWindowMs,
      signal: controller.signal,
      onLog: entry => {
        agentTrajectoryRef.current.push(entry);
        setAgentTrajectory([...agentTrajectoryRef.current]);
        if (entry.model && sessionRef.current?.agentConfig && sessionRef.current.agentConfig.model !== entry.model) {
          sessionRef.current = {
            ...sessionRef.current,
            agentConfig: { ...sessionRef.current.agentConfig, model: entry.model }
          };
          setSessionMetadata(sessionRef.current);
        }
        setMessage(entry.message ?? entry.kind);
      }
    }).then(result => {
      if (!sessionRef.current?.endedAt) {
        completionReasonRef.current = result.reason;
        setMessage(result.reason === "time_budget" ? "Time budget ended" : "Agent finalized the artifact");
        finishSession();
      }
    }).catch(error => {
      completionReasonRef.current = "agent_error";
      setMessage(`Agent stopped: ${error instanceof Error ? error.message : String(error)}`);
      if (!sessionRef.current?.endedAt) finishSession();
    }).finally(() => {
      setIsAgentRunning(false);
    });

    return () => controller.abort();
  }, [captureAgentScreenshot, finishSession, status]);

  useEffect(() => () => {
    clearActionTimer(actionTimerRef);
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

  const currentSessionPendingTranscriptions = getPendingCount(sessionMetadata?.sessionId);
  const currentSessionHasAudio = audioChunksRef.current.length > 0;
  const canStartNextSession = status === "completed" && currentSessionPendingTranscriptions === 0 && (sessionExported || !currentSessionHasAudio);
  const canExportSession = status === "completed" && !isRecording && !isAgentRunning && currentSessionPendingTranscriptions === 0;

  return (
    <main className={`app-shell ${panelCollapsed ? "panel-collapsed" : ""}`}>
      <header className="session-bar">
        <div className="brand-block">
          <strong>Simeval Drawing Pilot</strong>
          <span>{sessionMetadata ? `${sessionMetadata.actorType} · ${sessionMetadata.participantId} · ${sessionMetadata.taskTitle}` : enableAgentMode ? "Human and Agent creative process collection" : "Human drawing process collection"}</span>
        </div>
        {status !== "setup" && (
          <div className="session-metrics" aria-label="Session status">
            <span>{sessionMetadata?.actorType === "agent" ? `${formatDuration(Math.max(0, (sessionMetadata.agentConfig?.timeBudgetMs ?? defaultAgentTimeBudgetMinutes * 60 * 1000) - elapsedDisplayMs))} left` : formatDuration(elapsedDisplayMs)}</span>
            <span>{actionCount} actions</span>
            <span>{snapshotCount} snapshots</span>
          </div>
        )}
        {status === "active" && <button className="danger-button" onClick={() => void finishSession()}>Finish session</button>}
        {status === "completed" && <button disabled={!canStartNextSession} onClick={resetForNextSession}>New session</button>}
      </header>

      <div className="main-stage">
      {status === "setup" && (
        <section className="setup-view">
          <div className="setup-form">
            {!selectedActor && enableAgentMode ? (
              <>
                <div className="setup-heading">
                  <span className="eyebrow">Pilot session</span>
                  <h1>Who will perform this task?</h1>
                </div>
                <div className="actor-picker">
                  <button onClick={() => setSelectedActor("human")}>
                    <strong>Human</strong>
                    <span>Drawing interaction and optional think-aloud recording</span>
                  </button>
                  <button onClick={() => setSelectedActor("agent")}>
                    <strong>Agent</strong>
                    <span>Five-minute autonomous drawing with live trajectory logs</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                {enableAgentMode && <button className="back-button" onClick={() => setSelectedActor(null)}>Back</button>}
                <div className="setup-heading compact-heading">
                  <span className="eyebrow">{selectedActor ?? "human"} session setup</span>
                  <h1>{selectedActor === "agent" ? "Timed Agent Drawing" : "Drawing + Think-aloud"}</h1>
                </div>

                {selectedActor === "human" ? (
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
                ) : (
                  <div className="agent-budget-row">
                    <label>
                      <span>Time budget</span>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        step={1}
                        value={agentTimeBudgetMinutes}
                        onChange={event => setAgentTimeBudgetMinutes(Math.min(30, Math.max(1, Number(event.target.value) || 1)))}
                      />
                    </label>
                    <strong>{String(agentTimeBudgetMinutes).padStart(2, "0")}:00</strong>
                    <small>Minutes. Finalization begins with 00:30 remaining.</small>
                  </div>
                )}

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
                <button className="primary-button start-button" disabled={!api || (selectedActor === "human" && !participantId.trim())} onClick={startSession}>
                  Start {selectedActor} session
                </button>
                <p className="status-line">{message}</p>
              </>
            )}
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

            {sessionMetadata?.actorType === "human" ? (
              <section className="think-panel">
                <div className="section-title-row">
                  <h3>Think-aloud recording</h3>
                  <span>{thinkAloudCount}</span>
                </div>
                <div className="record-row">
                  <button className={isRecording ? "recording" : ""} disabled={status !== "active"} onClick={isRecording ? stopRecording : startRecording}>
                    {isRecording ? "Stop recording" : "Start recording"}
                  </button>
                  <span>{isRecording ? "Recording" : currentSessionPendingTranscriptions > 0 ? `${currentSessionPendingTranscriptions} transcribing` : recordingFinalizationStatus}</span>
                </div>
              </section>
            ) : (
              <section className="agent-log-panel" aria-live="polite">
                <div className="section-title-row">
                  <h3>Agent trajectory</h3>
                  <span>{isAgentRunning ? "Running" : status === "completed" ? "Finished" : "Ready"}</span>
                </div>
                <pre>{agentTrajectory.length > 0
                  ? agentTrajectory.slice(-20).map(entry => JSON.stringify(entry)).join("\n")
                  : "Waiting for the first decision..."}</pre>
              </section>
            )}

            {sessionMetadata?.actorType === "human" && selectedTaskType === "conceptual_synthesis" && (
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
                <button className="primary-button" disabled={!canExportSession} onClick={() => void exportSession()}>
                  {!canExportSession ? "Waiting for session processing" : "Download session JSON + audio"}
                </button>
                {sessionMetadata?.actorType === "human" && <button disabled={audioChunksRef.current.length === 0} onClick={downloadAudio}>Download audio</button>}
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
              viewModeEnabled={false}
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
