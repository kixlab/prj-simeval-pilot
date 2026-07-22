import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPilotAgentApi, type PilotAgentApi } from "./agent/pilotAgentApi";
import { runTimedAgent, type AgentTrajectoryEntry } from "./agent/timedAgent";
import { summarizeElements, type SceneSummary } from "./agent/tools";
import { createSeedScene } from "./data/seedScenes";
import {
  sessionArchiveBaseName,
  snapshotImageFileName,
  StreamingZipArchive
} from "./data/exportArchive";
import { buildRationaleRecords } from "./data/rationaleRecords";
import {
  agentPromptVersion,
  agentToolSchemaVersion,
  defaultConditionId,
  defaultStudyId,
  sessionSchemaVersion,
  taskDefinitionVersion
} from "./data/versionInfo";
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
  CompactElementState,
  ElementMutation,
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
import { compactElementMap, diffElementMaps } from "./logging/elementMutations";

const actionIdleMs = 700;
const freeDrawIdleMs = 1500;
const snapshotIntervalMs = 5000;
const recordingTimesliceMs = 10000;
const defaultAgentTimeBudgetMinutes = 5;
const agentFinalizationWindowMs = 30 * 1000;
const enableAgentMode = import.meta.env.VITE_ENABLE_AGENT_MODE === "true";
const configuredStudyId = import.meta.env.VITE_STUDY_ID || defaultStudyId;
const configuredConditionId = import.meta.env.VITE_CONDITION_ID || defaultConditionId;
const appVersion = import.meta.env.VITE_APP_VERSION || "unknown";
const appCommit = import.meta.env.VITE_APP_COMMIT || "unknown";
const agentPromptHash = import.meta.env.VITE_AGENT_PROMPT_HASH || "unknown";

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
type PendingFreeDrawStroke = {
  elementId: string;
  startedAtMs: number;
  latestElement: CompactElementState;
  onChangeBatchId: string;
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
  thinkAloudChunkId: string;
  sequence: number;
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
  const seenSequences = new Set<number>();
  let previousSequence = 0;

  assertCondition(pendingCount === 0, "Pending transcription requests remain for this session.");
  for (const [arrayIndex, chunk] of chunks.entries()) {
    assertCondition(chunk.sessionId === session.sessionId, `Think-aloud chunk belongs to another session: ${chunk.thinkAloudChunkId}`);
    assertCondition(!seenChunkIds.has(chunk.thinkAloudChunkId), `Duplicate think-aloud chunk id: ${chunk.thinkAloudChunkId}`);
    assertCondition(!seenChunkIndexes.has(chunk.audio.chunkIndex), `Duplicate audio chunk index: ${chunk.audio.chunkIndex}`);
    assertCondition(
      !seenSequences.has(chunk.sequence),
      `Duplicate think-aloud chunk sequence: previousSequence=${previousSequence}, currentSequence=${chunk.sequence}, arrayIndex=${arrayIndex}, chunkId=${chunk.thinkAloudChunkId}`
    );
    assertCondition(
      chunk.sequence > previousSequence,
      `Think-aloud chunk sequence is not strictly increasing: previousSequence=${previousSequence}, currentSequence=${chunk.sequence}, arrayIndex=${arrayIndex}, chunkId=${chunk.thinkAloudChunkId}`
    );
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
    assertCondition(chunk.transcriptionStatus !== "pending", `Pending transcription remains: arrayIndex=${arrayIndex}, chunkId=${chunk.thinkAloudChunkId}`);

    seenChunkIds.add(chunk.thinkAloudChunkId);
    seenChunkIndexes.add(chunk.audio.chunkIndex);
    seenSequences.add(chunk.sequence);
    previousSequence = chunk.sequence;
  }
}

function App() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<SessionStatus>("setup");
  const [selectedActor, setSelectedActor] = useState<SessionActor | null>(enableAgentMode ? null : "human");
  const [participantId, setParticipantId] = useState("");
  const [studyId, setStudyId] = useState(configuredStudyId);
  const [conditionId, setConditionId] = useState(configuredConditionId);
  const [assignmentId, setAssignmentId] = useState("");
  const [matchedPairId, setMatchedPairId] = useState("");
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
  const [isExporting, setIsExporting] = useState(false);
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
  const elementMutationsRef = useRef<ElementMutation[]>([]);
  const previousElementsByIdRef = useRef<Map<string, CompactElementState>>(new Map());
  const onChangeBatchSequenceRef = useRef(0);
  const pendingFreeDrawStrokeRef = useRef<PendingFreeDrawStroke | null>(null);
  const pendingFreeDrawStartedAtRef = useRef<number | null>(null);
  const freeDrawIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeToolTypeRef = useRef<string | null>(null);
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
  const fullSessionMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sttChunkPartsRef = useRef<Blob[]>([]);
  const sttChunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttStopRequestedRef = useRef(false);
  const sttFlushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const audioChunksRef = useRef<Blob[]>([]);
  const recorderMimeTypeRef = useRef<string | null>(null);
  const audioChunkIndexRef = useRef(0);
  const nextThinkAloudChunkSequenceRef = useRef(1);
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

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateAppHeight = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
    };
    updateAppHeight();
    viewport?.addEventListener("resize", updateAppHeight);
    viewport?.addEventListener("scroll", updateAppHeight);
    window.addEventListener("orientationchange", updateAppHeight);
    return () => {
      viewport?.removeEventListener("resize", updateAppHeight);
      viewport?.removeEventListener("scroll", updateAppHeight);
      window.removeEventListener("orientationchange", updateAppHeight);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

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

  const buildAudioMetadata = useCallback((): AudioExportMetadata => {
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
      fileName: "audio/think-aloud.webm",
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

  const insertPendingThinkAloudChunk = useCallback((chunk: ThinkAloudChunk) => {
    if (!sessionRef.current || sessionRef.current.sessionId !== chunk.sessionId) {
      console.error("[ThinkAloud] Pending chunk session mismatch", {
        sourceSessionId: chunk.sessionId,
        activeSessionId: sessionRef.current?.sessionId ?? null,
        chunkIndex: chunk.audio.chunkIndex
      });
      return;
    }
    thinkAloudChunksRef.current.push(chunk);
    setThinkAloudCount(thinkAloudChunksRef.current.length);
  }, []);

  const updateThinkAloudChunk = useCallback((
    sourceSessionId: string,
    thinkAloudChunkId: string,
    update: (chunk: ThinkAloudChunk) => ThinkAloudChunk
  ) => {
    if (!sessionRef.current || sessionRef.current.sessionId !== sourceSessionId) {
      console.error("[ThinkAloud] Late transcription session mismatch", {
        sourceSessionId,
        activeSessionId: sessionRef.current?.sessionId ?? null,
        thinkAloudChunkId
      });
      return;
    }
    const index = thinkAloudChunksRef.current.findIndex(chunk => chunk.thinkAloudChunkId === thinkAloudChunkId);
    if (index < 0) {
      console.error("[ThinkAloud] Pending chunk not found", { sourceSessionId, thinkAloudChunkId });
      return;
    }
    thinkAloudChunksRef.current[index] = update(thinkAloudChunksRef.current[index]);
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
    if (freeDrawIdleTimerRef.current) clearTimeout(freeDrawIdleTimerRef.current);
    freeDrawIdleTimerRef.current = null;
    pendingFreeDrawStrokeRef.current = null;
    pendingFreeDrawStartedAtRef.current = null;
    suppressHumanChangeUntilRef.current = performance.now() + 1000;
    api.resetScene();
    api.updateScene({ elements: elements as ExcalidrawElement[] });
    api.history.clear();
    latestElementsRef.current = elements;
    latestFilesRef.current = {};
    baselineRef.current = summarizeElements(elements);
    previousElementsByIdRef.current = compactElementMap(elements);
    setSummary(baselineRef.current);
    if (elements.length > 0) {
      api.scrollToContent(elements, { fitToContent: true, animate: false });
    }
  }, [api]);

  const flushFreeDrawStroke = useCallback((endedAtMs = elapsedMs()) => {
    if (freeDrawIdleTimerRef.current) clearTimeout(freeDrawIdleTimerRef.current);
    freeDrawIdleTimerRef.current = null;
    pendingFreeDrawStartedAtRef.current = null;
    const stroke = pendingFreeDrawStrokeRef.current;
    pendingFreeDrawStrokeRef.current = null;
    const session = sessionRef.current;
    if (!stroke || !session || stroke.latestElement.isDeleted) return;

    const end = Math.max(stroke.startedAtMs, endedAtMs);
    const sequence = elementMutationsRef.current.length + 1;
    const changedProperties = Object.entries(stroke.latestElement)
      .filter(([property]) => property !== "id" && property !== "type")
      .map(([property, after]) => ({ property, before: null, after }));
    elementMutationsRef.current.push({
      mutationId: `${session.sessionId}:element-mutation:${sequence}`,
      sessionId: session.sessionId,
      sequence,
      timestamp: timestampAt(end),
      elapsedMs: end,
      onChangeBatchId: stroke.onChangeBatchId,
      batchSequence: 0,
      actorType: "human",
      source: "excalidraw_onchange",
      elementId: stroke.elementId,
      elementType: "freedraw",
      operation: "create_stroke",
      changedProperties,
      beforeElement: null,
      afterElement: stroke.latestElement,
      startedAtMs: stroke.startedAtMs,
      endedAtMs: end,
      durationMs: end - stroke.startedAtMs,
      pointCount: Array.isArray(stroke.latestElement.points) ? stroke.latestElement.points.length : 0
    });
  }, [elapsedMs, timestampAt]);

  const finishFreeDrawPointer = useCallback(() => {
    // Let Excalidraw's final pointer update reach onChange before committing the stroke.
    setTimeout(() => flushFreeDrawStroke(), 0);
  }, [flushFreeDrawStroke]);

  const onCanvasChange = useCallback((
    elements: readonly ExcalidrawElement[],
    appState: unknown,
    files: BinaryFiles
  ) => {
    latestElementsRef.current = elements;
    latestFilesRef.current = files;
    const nextSummary = summarizeElements(elements);
    const currentElementsById = compactElementMap(elements);
    setSummary(nextSummary);
    const session = sessionRef.current;
    if (status !== "active" || session?.actorType !== "human" || performance.now() < suppressHumanChangeUntilRef.current) {
      previousElementsByIdRef.current = currentElementsById;
      baselineRef.current = nextSummary;
      return;
    }
    const now = elapsedMs();
    const batchNumber = onChangeBatchSequenceRef.current + 1;
    onChangeBatchSequenceRef.current = batchNumber;
    const drafts = diffElementMaps(previousElementsByIdRef.current, currentElementsById);
    const onChangeBatchId = `${session.sessionId}:onchange-batch:${batchNumber}`;
    for (const [batchSequence, draft] of drafts.entries()) {
      if (draft.elementType === "freedraw") {
        const pendingStroke = pendingFreeDrawStrokeRef.current;
        if (draft.operation === "create" || pendingStroke?.elementId === draft.elementId) {
          if (draft.afterElement) {
            if (pendingStroke && pendingStroke.elementId !== draft.elementId) flushFreeDrawStroke(now);
            pendingFreeDrawStrokeRef.current = {
              elementId: draft.elementId,
              startedAtMs: pendingStroke?.elementId === draft.elementId
                ? pendingStroke.startedAtMs
                : pendingFreeDrawStartedAtRef.current ?? now,
              latestElement: draft.afterElement,
              onChangeBatchId: pendingStroke?.elementId === draft.elementId
                ? pendingStroke.onChangeBatchId
                : onChangeBatchId
            };
            if (freeDrawIdleTimerRef.current) clearTimeout(freeDrawIdleTimerRef.current);
            freeDrawIdleTimerRef.current = setTimeout(() => flushFreeDrawStroke(now), freeDrawIdleMs);
          }
          continue;
        }
      }
      const sequence = elementMutationsRef.current.length + 1;
      elementMutationsRef.current.push({
        ...draft,
        mutationId: `${session.sessionId}:element-mutation:${sequence}`,
        sessionId: session.sessionId,
        sequence,
        timestamp: timestampAt(now),
        elapsedMs: now,
        onChangeBatchId,
        batchSequence,
        actorType: "human",
        source: "excalidraw_onchange"
      });
    }
    const nextActiveToolType = (appState as { activeTool?: { type?: string } } | null)?.activeTool?.type ?? null;
    if (activeToolTypeRef.current === "freedraw" && nextActiveToolType !== "freedraw") {
      flushFreeDrawStroke(now);
    }
    activeToolTypeRef.current = nextActiveToolType;
    previousElementsByIdRef.current = currentElementsById;
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
  }, [elapsedMs, flushFreeDrawStroke, flushHumanAction, status, timestampAt]);

  const startSession = useCallback(() => {
    if (!api || !selectedActor || !studyId.trim() || !conditionId.trim() || (selectedActor === "human" && !participantId.trim())) {
      setMessage(!api
        ? "Canvas가 준비되지 않았습니다."
        : !studyId.trim() || !conditionId.trim()
          ? "Study ID와 Condition ID를 입력하세요."
          : "Participant ID를 입력하세요.");
      return;
    }
    if (selectedActor === "agent" && !enableAgentMode) {
      setMessage("Agent mode is disabled in this deployment.");
      return;
    }
    const previousSession = sessionRef.current;
    if (previousSession && !sessionExported) {
      setMessage("Export the previous session ZIP before starting a new session.");
      return;
    }
    const seed = chooseSeed(selectedTaskType, selectedSeedId, randomizeSeed);
    const initialPhase: TaskPhase = selectedTaskType === "adaptive_reframing" ? "phase_1" : "single_phase";
    const initialElements = selectedTaskType === "open_ended_interpretation" ? createSeedScene(seed.id) : [];
    const selectedAgentTimeBudgetMs = Math.max(1, agentTimeBudgetMinutes) * 60 * 1000;
    const sessionId = `drawing-${selectedTaskType}-${crypto.randomUUID()}`;
    const artifactId = `${sessionId}:artifact`;
    const trajectoryId = `${sessionId}:trajectory`;
    const outcomeEvaluationId = `${sessionId}:outcome-evaluation`;
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
      study: {
        studyId: studyId.trim(),
        conditionId: conditionId.trim(),
        assignmentId: assignmentId.trim() || null,
        matchedPairId: matchedPairId.trim() || null
      },
      datasetIds: { artifactId, trajectoryId, outcomeEvaluationId },
      versions: {
        taskDefinitionVersion,
        appVersion,
        appCommit,
        promptVersion: selectedActor === "agent" ? agentPromptVersion : null,
        promptHash: selectedActor === "agent" ? agentPromptHash : null,
        toolSchemaVersion: selectedActor === "agent" ? agentToolSchemaVersion : null
      },
      agentConfig: selectedActor === "agent" ? {
        model: null,
        timeBudgetMs: selectedAgentTimeBudgetMs,
        finalizationWindowMs: agentFinalizationWindowMs,
        terminationPolicy: "time_budget",
        promptVersion: agentPromptVersion,
        promptHash: agentPromptHash,
        toolSchemaVersion: agentToolSchemaVersion
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
    elementMutationsRef.current = [];
    pendingFreeDrawStrokeRef.current = null;
    pendingFreeDrawStartedAtRef.current = null;
    if (freeDrawIdleTimerRef.current) clearTimeout(freeDrawIdleTimerRef.current);
    freeDrawIdleTimerRef.current = null;
    onChangeBatchSequenceRef.current = 0;
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
    nextThinkAloudChunkSequenceRef.current = 1;
    previousAudioChunkEndRef.current = 0;
    previousAudioChunkPhaseRef.current = initialPhase;
    recordingSessionIdRef.current = null;
    sttChunkPartsRef.current = [];
    if (sttChunkTimerRef.current) clearTimeout(sttChunkTimerRef.current);
    sttChunkTimerRef.current = null;
    sttStopRequestedRef.current = false;
    sttFlushQueueRef.current = Promise.resolve();
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
  }, [agentTimeBudgetMinutes, api, assignmentId, captureSnapshot, conditionId, inputDevice, matchedPairId, participantId, randomizeSeed, resetCanvasForSession, selectedActor, selectedSeedId, selectedTask, selectedTaskType, sessionExported, studyId]);

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
      updateThinkAloudChunk(context.sourceSessionId, context.thinkAloudChunkId, chunk => ({
        ...chunk,
        content: content.trim(),
        transcriptionStatus: response.ok && result.success
          ? content.trim().length > 0 ? "completed" : "empty"
          : "failed",
        audio: {
          ...chunk.audio,
          languageCode: result.languageCode ?? "",
          success: response.ok && result.success,
          error: result.error,
          segments: result.segments ?? []
        }
      }));
      setMessage(response.ok && result.success ? `Audio chunk ${context.chunkIndex} transcribed` : `Audio chunk ${context.chunkIndex} saved; STT failed`);
    } catch (error) {
      updateThinkAloudChunk(context.sourceSessionId, context.thinkAloudChunkId, chunk => ({
        ...chunk,
        content: "",
        transcriptionStatus: "failed",
        audio: {
          ...chunk.audio,
          languageCode: "",
          success: false,
          error: error instanceof Error ? error.message : String(error),
          segments: []
        }
      }));
      setMessage(`Audio chunk ${context.chunkIndex} saved; STT failed`);
    } finally {
      decrementPending(context.sourceSessionId);
    }
  }, [decrementPending, incrementPending, updateThinkAloudChunk]);

  const stopActiveSttChunkRecorder = useCallback(() => {
    if (sttChunkTimerRef.current) clearTimeout(sttChunkTimerRef.current);
    sttChunkTimerRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording" || sttStopRequestedRef.current) return;
    sttStopRequestedRef.current = true;
    recorder.stop();
  }, []);

  const startSttChunkRecorder = useCallback((stream: MediaStream, mimeType: string, sourceSessionId: string) => {
    if (recordingSessionIdRef.current !== sourceSessionId || !stream.active) return;
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const started = previousAudioChunkEndRef.current;
    const phaseAtStart = previousAudioChunkPhaseRef.current;
    sttChunkPartsRef.current = [];
    mediaRecorderRef.current = recorder;
    sttStopRequestedRef.current = false;
    finalDataAvailableHandledRef.current = false;

    recorder.ondataavailable = event => {
      if (event.data.size > 0) sttChunkPartsRef.current.push(event.data);
    };
    recorder.onstop = () => {
      if (sttChunkTimerRef.current) clearTimeout(sttChunkTimerRef.current);
      sttChunkTimerRef.current = null;
      const parts = sttChunkPartsRef.current;
      sttChunkPartsRef.current = [];
      const flush = async () => {
        const ended = elapsedMs();
        const phaseAtEnd = phaseRef.current;
        finalDataAvailableHandledRef.current = true;
        if (parts.length > 0) {
          const blob = new Blob(parts, { type: recorder.mimeType || mimeType || "audio/webm" });
          const sequence = nextThinkAloudChunkSequenceRef.current;
          nextThinkAloudChunkSequenceRef.current += 1;
          const chunkIndex = audioChunkIndexRef.current + 1;
          audioChunkIndexRef.current = chunkIndex;
          const thinkAloudChunkId = `${sourceSessionId}:think-aloud-chunk:${sequence}`;
          insertPendingThinkAloudChunk({
            thinkAloudChunkId,
            sessionId: sourceSessionId,
            sequence,
            timestamp: timestampAt(started),
            chunkStartedAtMs: started,
            chunkEndedAtMs: ended,
            durationMs: Math.max(0, ended - started),
            phaseAtStart,
            phaseAtEnd,
            crossesPhaseTransition: phaseAtStart !== phaseAtEnd,
            source: "human_audio",
            content: "",
            transcriptionStatus: "pending",
            audio: {
              chunkIndex,
              mimeType: blob.type,
              byteSize: blob.size,
              languageCode: "",
              success: false,
              segments: []
            }
          });
          void transcribeChunk(blob, {
            sourceSessionId,
            thinkAloudChunkId,
            sequence,
            chunkIndex,
            chunkStartedAtMs: started,
            chunkEndedAtMs: ended,
            phaseAtStart,
            phaseAtEnd,
            crossesPhaseTransition: phaseAtStart !== phaseAtEnd
          });
        }
        previousAudioChunkEndRef.current = ended;
        previousAudioChunkPhaseRef.current = phaseAtEnd;
        mediaRecorderRef.current = null;
        sttStopRequestedRef.current = false;

        if (recordingSessionIdRef.current === sourceSessionId && stream.active) {
          startSttChunkRecorder(stream, mimeType, sourceSessionId);
          return;
        }
        const fullRecorder = fullSessionMediaRecorderRef.current;
        if (fullRecorder && fullRecorder.state !== "inactive") fullRecorder.stop();
      };
      sttFlushQueueRef.current = sttFlushQueueRef.current.then(flush, flush);
    };
    recorder.start();
    sttChunkTimerRef.current = setTimeout(() => {
      stopActiveSttChunkRecorder();
    }, recordingTimesliceMs);
  }, [elapsedMs, insertPendingThinkAloudChunk, stopActiveSttChunkRecorder, timestampAt, transcribeChunk]);

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
      const fullRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaStreamRef.current = stream;
      fullSessionMediaRecorderRef.current = fullRecorder;
      recorderMimeTypeRef.current = fullRecorder.mimeType || mimeType || "audio/webm";
      recordingSessionIdRef.current = session.sessionId;
      audioChunksRef.current = [];
      previousAudioChunkEndRef.current = elapsedMs();
      previousAudioChunkPhaseRef.current = phaseRef.current;
      fullRecorder.ondataavailable = event => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      fullRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        fullSessionMediaRecorderRef.current = null;
        mediaStreamRef.current = null;
        setIsRecording(false);
        recorderStopResolverRef.current?.();
        recorderStopResolverRef.current = null;
      };
      fullRecorder.start(recordingTimesliceMs);
      startSttChunkRecorder(stream, recorderMimeTypeRef.current, session.sessionId);
      setIsRecording(true);
      setRecordingFinalizationStatus("recording");
      setMessage("Continuous think-aloud recording active");
    } catch (error) {
      setMessage(`Microphone access failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [elapsedMs, startSttChunkRecorder, status]);

  const stopRecording = useCallback(() => {
    if (sttChunkTimerRef.current) clearTimeout(sttChunkTimerRef.current);
    sttChunkTimerRef.current = null;
    recordingSessionIdRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (recorder) stopActiveSttChunkRecorder();
    else {
      const fullRecorder = fullSessionMediaRecorderRef.current;
      if (fullRecorder && fullRecorder.state !== "inactive") fullRecorder.stop();
    }
  }, [stopActiveSttChunkRecorder]);

  const stopRecordingAndWait = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    const fullRecorder = fullSessionMediaRecorderRef.current;
    if ((!recorder || recorder.state === "inactive") && (!fullRecorder || fullRecorder.state === "inactive")) {
      finalDataAvailableHandledRef.current = true;
      return Promise.resolve();
    }
    setRecordingFinalizationStatus("stopping");
    return new Promise<void>(resolve => {
      recorderStopResolverRef.current = resolve;
      if (sttChunkTimerRef.current) clearTimeout(sttChunkTimerRef.current);
      sttChunkTimerRef.current = null;
      recordingSessionIdRef.current = null;
      if (recorder) stopActiveSttChunkRecorder();
      else if (fullRecorder && fullRecorder.state !== "inactive") fullRecorder.stop();
    });
  }, [stopActiveSttChunkRecorder]);

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
    flushFreeDrawStroke();
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
    setMessage("Session completed. Export the ZIP before starting the next session.");
  }, [appendThinkAloudNote, captureSnapshot, elapsedMs, flushFreeDrawStroke, flushHumanAction, getPendingCount, isRecording, postTaskResponse, refreshPendingTranscriptions, stopRecordingAndWait, timestampAt, waitForPendingTranscriptions]);

  const exportSession = useCallback(async () => {
    if (!api || !sessionRef.current || status !== "completed" || isRecording || isAgentRunning || isExporting || getPendingCount(sessionRef.current.sessionId) > 0) return;
    const session = sessionRef.current;
    setIsExporting(true);
    try {
    setMessage("Preparing session ZIP archive");
    flushFreeDrawStroke();
    const sortedThinkAloudChunks = [...thinkAloudChunksRef.current].sort((left, right) => left.sequence - right.sequence);
    thinkAloudChunksRef.current = sortedThinkAloudChunks;
    const validationErrors: string[] = [];
    try {
      validateThinkAloudChunks({
        session,
        chunks: sortedThinkAloudChunks,
        pendingCount: getPendingCount(session.sessionId)
      });
    } catch (error) {
      validationErrors.push(error instanceof Error ? error.message : String(error));
    }
    const elements = api.getSceneElements();
    const task = taskByType(session.taskType);
    const instructionsByPhase = session.taskType === "adaptive_reframing"
      ? {
          phase_1: instructionForTask(session.taskType, session.seedLabel, "phase_1"),
          phase_2: instructionForTask(session.taskType, session.seedLabel, "phase_2")
        }
      : { single_phase: instructionForTask(session.taskType, session.seedLabel, "single_phase") };
    const audioBlob = createCombinedAudioBlob();
    const audioMetadata = buildAudioMetadata();
    const baseName = sessionArchiveBaseName(session);
    const archiveFileName = `${baseName}.zip`;
    const rootDirectory = baseName;
    const archive = new StreamingZipArchive();
    const imageFileNameBySnapshotId = new Map<string, string>();
    const screenshots = snapshotsRef.current.filter(snapshot =>
      snapshot.reason !== "periodic" && snapshot.elements.length > 0
    );

    for (const [index, snapshot] of screenshots.entries()) {
      setMessage(`Rendering ZIP screenshot ${index + 1}/${screenshots.length}`);
      const relativeFileName = snapshotImageFileName(snapshot);
      const imageBlob = await exportToBlob({
        elements: snapshot.elements,
        appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 24,
        maxWidthOrHeight: 1800
      });
      await archive.addBlob(`${rootDirectory}/${relativeFileName}`, imageBlob);
      imageFileNameBySnapshotId.set(snapshot.snapshotId, relativeFileName);
    }

    if (audioBlob && audioMetadata.fileName) {
      await archive.addBlob(`${rootDirectory}/${audioMetadata.fileName}`, audioBlob);
    }

    const exportedSnapshots = snapshotsRef.current.map(snapshot => ({
      ...snapshot,
      imageFileName: imageFileNameBySnapshotId.get(snapshot.snapshotId)
    }));
    const exportedAgentTrajectory = agentTrajectoryRef.current.map(entry => ({
      ...entry,
      observationImageFileName: entry.observationSnapshotId
        ? imageFileNameBySnapshotId.get(entry.observationSnapshotId)
        : undefined
    }));
    const rationaleRecords = buildRationaleRecords({
      sessionId: session.sessionId,
      humanChunks: sortedThinkAloudChunks,
      notes: thinkAloudNotesRef.current,
      agentTrajectory: exportedAgentTrajectory
    });
    const finalSnapshot = [...exportedSnapshots].reverse().find(snapshot => snapshot.reason === "final");
    const finalImageFileName = finalSnapshot?.imageFileName ?? null;
    const payload: SessionExport = {
      schemaVersion: sessionSchemaVersion,
      exportedAt: new Date().toISOString(),
      archive: {
        fileName: archiveFileName,
        rootDirectory,
        screenshotPolicy: "initial_action_phase_final_no_periodic"
      },
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
      elementMutations: elementMutationsRef.current,
      thinkAloudChunks: sortedThinkAloudChunks,
      validationErrors,
      thinkAloudNotes: thinkAloudNotesRef.current,
      rationaleRecords,
      agentTrajectory: exportedAgentTrajectory,
      pointerModalities: pointerEventsRef.current,
      snapshots: exportedSnapshots,
      outcomeEvaluation: {
        evaluationId: session.datasetIds.outcomeEvaluationId,
        artifactId: session.datasetIds.artifactId,
        status: "pending"
      },
      finalArtifact: {
        sceneElements: cloneElements(elements),
        image: { mimeType: "image/png", fileName: finalImageFileName },
        audio: audioMetadata
      }
    };
    archive.addText(`${rootDirectory}/session.json`, JSON.stringify(payload, null, 2));
    archive.addText(`${rootDirectory}/README.txt`, [
      `SimEval session: ${session.sessionId}`,
      `Actor: ${session.actorType}`,
      `Participant: ${session.participantId}`,
      `Task: ${session.taskType}`,
      `Seed: ${session.seedId}`,
      `Study / condition: ${session.study.studyId} / ${session.study.conditionId}`,
      "",
      "session.json contains raw event streams, scene snapshots, rationale timing, and file references.",
      "PNG files are generated at export for initial, action, phase-boundary, and final snapshots.",
      "Periodic snapshots remain as scene JSON only to control archive size.",
      "Outcome ratings should reference the outcomeEvaluation.evaluationId in session.json."
    ].join("\n"));
    const archiveBlob = await archive.finish();
    downloadBlob(archiveFileName, archiveBlob);
    exportedSessionIdsRef.current.add(session.sessionId);
    setSessionExported(true);
    setRecordingFinalizationStatus("exported");
    setMessage(validationErrors.length > 0
      ? `ZIP exported with validation warning: ${validationErrors.join(" | ")}`
      : `Session ZIP downloaded: ${archiveFileName}`);
    } catch (error) {
      setMessage(`ZIP export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExporting(false);
    }
  }, [api, buildAudioMetadata, createCombinedAudioBlob, flushFreeDrawStroke, getPendingCount, isAgentRunning, isExporting, isRecording, status]);

  const downloadAudio = useCallback(() => {
    if (!sessionRef.current || audioChunksRef.current.length === 0) return;
    const audioBlob = createCombinedAudioBlob();
    if (!audioBlob) return;
    downloadBlob(`${sessionArchiveBaseName(sessionRef.current)}__think-aloud.webm`, audioBlob);
  }, [createCombinedAudioBlob]);

  const resetForNextSession = useCallback(() => {
    if (!api) return;
    if (sessionRef.current && !sessionExported) {
      setMessage("Export the previous session ZIP before starting a new session.");
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
  }, [api, getPendingCount, resetCanvasForSession, sessionExported]);

  const captureAgentObservation = useCallback(async (decisionNumber: number) => {
    const session = sessionRef.current;
    if (!api || !session) throw new Error("Agent observation is unavailable.");
    const observationId = `${session.sessionId}:observation:${decisionNumber}`;
    const snapshotId = currentSnapshotIdRef.current || captureSnapshot("initial", api.getSceneElements());
    const observedAtMs = elapsedMs();
    const elements = api.getSceneElements();
    if (elements.length === 0) return { observationId, snapshotId, observedAtMs };
    const blob = await exportToBlob({
      elements,
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
      files: api.getFiles(),
      mimeType: "image/png",
      exportPadding: 24,
      maxWidthOrHeight: 2400
    });
    return { observationId, snapshotId, observedAtMs, screenshotDataUrl: await blobToDataUrl(blob) };
  }, [api, captureSnapshot, elapsedMs]);

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
      sessionId: session.sessionId,
      tools: agentApi.tools,
      getInstruction: () => instructionForTask(
        sessionRef.current!.taskType,
        sessionRef.current!.seedLabel,
        phaseRef.current
      ),
      captureObservation: captureAgentObservation,
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
  }, [captureAgentObservation, finishSession, status]);

  useEffect(() => () => {
    clearActionTimer(actionTimerRef);
    flushFreeDrawStroke();
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
  }, [flushFreeDrawStroke]);

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
  const canStartNextSession = status === "completed" && currentSessionPendingTranscriptions === 0 && sessionExported;
  const canExportSession = status === "completed" && !isRecording && !isAgentRunning && !isExporting && currentSessionPendingTranscriptions === 0;

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

                <div className="field-grid two-column">
                  <label>
                    <span>Study ID</span>
                    <input value={studyId} onChange={event => setStudyId(event.target.value)} placeholder="simeval-pilot" />
                  </label>
                  <label>
                    <span>Condition ID</span>
                    <input value={conditionId} onChange={event => setConditionId(event.target.value)} placeholder="baseline" />
                  </label>
                  <label>
                    <span>Assignment ID (optional)</span>
                    <input value={assignmentId} onChange={event => setAssignmentId(event.target.value)} placeholder="A001" />
                  </label>
                  <label>
                    <span>Matched pair ID (optional)</span>
                    <input value={matchedPairId} onChange={event => setMatchedPairId(event.target.value)} placeholder="pair-task1-seed2-01" />
                  </label>
                </div>

                {selectedActor === "human" ? (
                  <div className="field-grid two-column">
                    <label>
                      <span>Participant ID</span>
                      <input
                        value={participantId}
                        onChange={event => setParticipantId(event.target.value)}
                        placeholder="P001"
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        inputMode="text"
                        enterKeyHint="done"
                      />
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
                <button className="primary-button start-button" disabled={!api || !studyId.trim() || !conditionId.trim() || (selectedActor === "human" && !participantId.trim())} onClick={startSession}>
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
                  {!canExportSession ? "Waiting for session processing" : "Download session ZIP"}
                </button>
                {sessionMetadata?.actorType === "human" && <button disabled={audioChunksRef.current.length === 0} onClick={downloadAudio}>Download audio</button>}
              </div>
            )}
          </aside>

          <section
            className="canvas-shell"
            onPointerDown={event => {
              if (status !== "active") return;
              const now = elapsedMs();
              const pointerType = event.pointerType === "pen" || event.pointerType === "touch" ? event.pointerType : "mouse";
              pointerEventsRef.current.push({ timestamp: timestampAt(now), elapsedMs: now, pointerType });
              if (api?.getAppState().activeTool.type === "freedraw") {
                pendingFreeDrawStartedAtRef.current = now;
              }
            }}
            onPointerUp={finishFreeDrawPointer}
            onPointerCancel={finishFreeDrawPointer}
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
