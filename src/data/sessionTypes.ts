import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { TaskPhase, TaskType } from "./tasks";
import type { ArtifactActionEntry } from "../logging/artifactActions";
import type { AgentTrajectoryEntry } from "../agent/timedAgent";

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
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  completionReason: string | null;
  datasetIds: {
    artifactId: string;
    trajectoryId: string;
    outcomeEvaluationId: string;
  };
  versions: {
    taskDefinitionVersion: string;
    appVersion: string;
    appCommit: string;
    promptVersion: string | null;
    promptHash: string | null;
    toolSchemaVersion: string | null;
  };
  agentConfig: {
    model: string | null;
    timeBudgetMs: number;
    finalizationWindowMs: number;
    terminationPolicy: "time_budget";
    promptVersion: string;
    promptHash: string;
    toolSchemaVersion: string;
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
  imageFileName?: string;
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

export type TranscriptionStatus = "pending" | "completed" | "empty" | "failed";

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

export type RationaleRecord = {
  rationaleId: string;
  sessionId: string;
  sequence: number;
  actorType: "human" | "agent";
  source:
    | "explicit_think_aloud"
    | "agent_decision_rationale"
    | "agent_reasoning"
    | "clarification_response"
    | "post_task_response"
    | "inferred";
  content: string;
  startedAtMs: number;
  endedAtMs: number;
  availableAtMs: number;
  sourceEventIds: string[];
  linkedEventIds: string[];
  provenance: "observed" | "model_inferred" | "human_annotated";
  confidence?: number | null;
  decisionNumber?: number;
};

export type PointerModalityEvent = {
  timestamp: string;
  elapsedMs: number;
  pointerType: "mouse" | "pen" | "touch";
};

export type ElementMutationOperation =
  | "create" | "create_stroke" | "delete" | "move" | "resize" | "rotate" | "change_text"
  | "change_style" | "change_points" | "change_binding" | "out_of_scope_change" | "unclassified_change" | "compound_change";

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
  roughness: number;
  roundness: unknown;
  opacity: number;
  fontSize: number | null;
  fontFamily: number | null;
  textAlign: string | null;
  verticalAlign: string | null;
  lineHeight: number | null;
  startArrowhead: string | null;
  endArrowhead: string | null;
  groupIds: string[];
  containerId: string | null;
  frameId: string | null;
  boundElements: unknown;
  startBinding: unknown;
  endBinding: unknown;
  locked: boolean;
  link: string | null;
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
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
  pointCount?: number;
};

export type SessionExport = {
  schemaVersion: "simeval-drawing-session-v4";
  exportedAt: string;
  archive: {
    fileName: string;
    rootDirectory: string;
    screenshotPolicy: "initial_action_phase_final_no_periodic";
  };
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
  validationErrors: string[];
  thinkAloudNotes: ThinkAloudNote[];
  rationaleRecords: RationaleRecord[];
  agentTrajectory: AgentTrajectoryEntry[];
  pointerModalities: PointerModalityEvent[];
  snapshots: CanvasSnapshot[];
  outcomeEvaluation: {
    evaluationId: string;
    artifactId: string;
    status: "pending";
  };
  finalArtifact: {
    sceneElements: readonly ExcalidrawElement[];
    image: { mimeType: "image/png"; fileName: string | null };
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
