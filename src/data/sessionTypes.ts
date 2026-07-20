import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { TaskPhase, TaskType } from "./tasks";
import type { ArtifactActionEntry } from "../logging/artifactActions";
import type { AgentTrajectoryEntry } from "../agent/timedAgent";

export type InputDevice = "mouse" | "touch" | "stylus" | "mixed" | "unknown";
export type SessionActor = "human" | "agent";

export type SessionMetadata = {
  sessionId: string;
  participantId: string;
  actorType: SessionActor;
  taskType: TaskType;
  taskTitle: string;
  seedId: string;
  seedLabel: string;
  seedSelection: "manual" | "random";
  inputDevice: InputDevice;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  completionReason: string | null;
  agentConfig: {
    model: string | null;
    timeBudgetMs: number;
    finalizationWindowMs: number;
    terminationPolicy: "time_budget";
  } | null;
};

export type CanvasSnapshot = {
  snapshotId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  phase: TaskPhase;
  reason: "initial" | "action" | "periodic" | "phase_1_end" | "phase_2_start" | "final";
  actionSequence?: number;
  elements: readonly ExcalidrawElement[];
};

export type PhaseTransition = {
  transitionId: string;
  timestamp: string;
  elapsedMs: number;
  from: "phase_1";
  to: "phase_2";
  phase1SnapshotId: string;
  phase2SnapshotId: string;
  revealedInstruction: string;
};

export type TranscriptionStatus = "completed" | "empty" | "failed";

export type ThinkAloudWord = {
  word: string;
  startSec: number;
  endSec: number;
  confidence: number | null;
};

export type ThinkAloudSegment = {
  index: number;
  transcript: string;
  confidence: number | null;
  words: ThinkAloudWord[];
};

export type ThinkAloudChunk = {
  thinkAloudChunkId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  chunkStartedAtMs: number;
  chunkEndedAtMs: number;
  durationMs: number;
  phaseAtStart: TaskPhase;
  phaseAtEnd: TaskPhase;
  crossesPhaseTransition: boolean;
  source: "human_audio";
  content: string;
  transcriptionStatus: TranscriptionStatus;
  audio: {
    chunkIndex: number;
    mimeType: string;
    byteSize: number;
    languageCode: string;
    success: boolean;
    error?: string;
    segments: ThinkAloudSegment[];
  };
};

export type ThinkAloudNote = {
  thinkAloudNoteId: string;
  sessionId: string;
  timestamp: string;
  elapsedMs: number;
  phase: TaskPhase;
  source: "agent_reasoning" | "post_task_response";
  content: string;
  linkedEventId?: string;
};

export type PointerModalityEvent = {
  timestamp: string;
  elapsedMs: number;
  pointerType: "mouse" | "pen" | "touch";
};

export type ElementMutationOperation =
  | "create" | "delete" | "move" | "resize" | "rotate" | "change_text"
  | "change_style" | "change_points" | "change_binding" | "compound_change";

export type CompactElementState = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  text: string | null;
  originalText: string | null;
  points: unknown;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  opacity: number;
  groupIds: string[];
  containerId: string | null;
  startBinding: unknown;
  endBinding: unknown;
  isDeleted: boolean;
};

export type ElementMutation = {
  mutationId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  onChangeBatchId: string;
  batchSequence: number;
  actorType: "human";
  source: "excalidraw_onchange";
  elementId: string;
  elementType: string;
  operation: ElementMutationOperation;
  changedProperties: Array<{ property: string; before: unknown; after: unknown }>;
  beforeElement: CompactElementState | null;
  afterElement: CompactElementState | null;
};

export type SessionExport = {
  schemaVersion: "simeval-drawing-session-v3";
  exportedAt: string;
  session: SessionMetadata;
  task: {
    instruction: string;
    instructionsByPhase: Partial<Record<TaskPhase, string>>;
    seed: { id: string; label: string; initialElementIds: string[] };
  };
  phaseTransitions: PhaseTransition[];
  actions: Array<ArtifactActionEntry & {
    phase: TaskPhase;
    beforeSnapshotId: string;
    afterSnapshotId: string;
    seedElementImpacts: string[];
  }>;
  elementMutations: ElementMutation[];
  thinkAloudChunks: ThinkAloudChunk[];
  thinkAloudNotes: ThinkAloudNote[];
  agentTrajectory: AgentTrajectoryEntry[];
  pointerModalities: PointerModalityEvent[];
  snapshots: CanvasSnapshot[];
  finalArtifact: {
    sceneElements: readonly ExcalidrawElement[];
    image: { mimeType: "image/png"; dataUrl: string };
    audio: {
      available: boolean;
      fileName: string | null;
      mimeType: string | null;
      byteSize: number;
      chunkCount: number;
      warning?: string;
    };
  };
};
