import { canonicalArtboard, eraserWidth, pencilWidth } from "../artboard";
import {
  parseAgentToolCall,
  toEventDraft,
  agentToolDefinitions,
  type AgentToolCall
} from "../agentTools";
import type { AudraEvent } from "../events";
import {
  applyEvent,
  canUndo,
  createTrialState,
  hasDrawingAttempt,
  type AudraTrialState,
  type RejectionCode
} from "../reducer";
import { taskInstruction, type Stimulus } from "../stimulus";
import { defaultObservationSize } from "./renderer";

/**
 * Authoritative, server-side trial state.
 *
 * Agents never hold trial state; they hold a trialId. Every tool call is
 * re-validated here against the same reducer the human UI uses, so a malformed
 * or out-of-bounds call is rejected regardless of what the calling driver
 * believes it is allowed to do.
 */

export type AgentRunMetadata = {
  model: string | null;
  checkpoint: string | null;
  decodingParameters: Record<string, unknown> | null;
  seed: number | null;
  driver: string | null;
  /** Action protocol the driver ran under: one-shot, single, or multi. */
  strategy: string | null;
  /** The run's time limit and final window; 0 means untimed. */
  timeLimitSec: number | null;
  finalizeWindowSec: number | null;
};

export type RejectionRecord = {
  atMs: number;
  code: RejectionCode | "unsupported_tool" | "unsupported_field" | "invalid_arguments";
  error: string;
  tool: string | null;
};

export type RenderedFrame = { mimeType: string; base64: string; receivedAtMs: number };

export type TrialRecord = {
  trialId: string;
  sessionId: string;
  renderToken: string;
  stimulus: Stimulus;
  state: AudraTrialState;
  createdAtEpochMs: number;
  strokeSequence: number;
  agentRun: AgentRunMetadata;
  /** Width in pixels of the PNG returned to the agent. Logged with the run. */
  observationSize: number;
  /** Counted separately from the shared canvas event log. */
  runStats: {
    toolCallCount: number;
    acceptedCount: number;
    rejectedCount: number;
    observeCount: number;
    retries: number;
    firstToolCallAtMs: number | null;
    lastToolCallAtMs: number | null;
  };
  rejections: RejectionRecord[];
  frames: Map<number, RenderedFrame>;
  frameWaiters: Array<{ revision: number; resolve: (frame: RenderedFrame) => void }>;
};

const trials = new Map<string, TrialRecord>();

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function createTrial(input: {
  sessionId?: string;
  actorId: string;
  stimulus: Stimulus;
  agentRun?: Partial<AgentRunMetadata>;
  observationSize?: number;
}): TrialRecord {
  const trialId = randomId("trial");
  const sessionId = input.sessionId ?? randomId("session");
  const record: TrialRecord = {
    trialId,
    sessionId,
    renderToken: randomId("render"),
    stimulus: input.stimulus,
    state: createTrialState({
      sessionId,
      trialId,
      stimulusId: input.stimulus.stimulusId,
      actorType: "agent",
      actorId: input.actorId
    }),
    createdAtEpochMs: Date.now(),
    strokeSequence: 0,
    observationSize: input.observationSize ?? defaultObservationSize,
    agentRun: {
      model: input.agentRun?.model ?? null,
      checkpoint: input.agentRun?.checkpoint ?? null,
      decodingParameters: input.agentRun?.decodingParameters ?? null,
      seed: input.agentRun?.seed ?? null,
      driver: input.agentRun?.driver ?? null,
      strategy: input.agentRun?.strategy ?? null,
      timeLimitSec: input.agentRun?.timeLimitSec ?? null,
      finalizeWindowSec: input.agentRun?.finalizeWindowSec ?? null
    },
    runStats: {
      toolCallCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      observeCount: 0,
      retries: 0,
      firstToolCallAtMs: null,
      lastToolCallAtMs: null
    },
    rejections: [],
    frames: new Map(),
    frameWaiters: []
  };
  trials.set(trialId, record);
  return record;
}

export function getTrial(trialId: string) {
  return trials.get(trialId) ?? null;
}

/**
 * What the agent is told about the task. This mirrors the human instruction
 * screen plus the coordinate system needed to operate a canvas it can only see
 * as an image. It carries no contour geometry, element ids, or scene structure.
 */
export function agentContract(record: TrialRecord) {
  return {
    trialId: record.trialId,
    instruction: taskInstruction,
    descriptionPrompt: "What did you draw?",
    artboard: {
      width: canonicalArtboard.width,
      height: canonicalArtboard.height,
      origin: "top-left",
      xAxis: "increases to the right",
      yAxis: "increases downward",
      units: "artboard units, identical to pixels at 1x"
    },
    ink: { color: "black on white", pencilWidth, eraserWidth },
    tools: agentToolDefinitions,
    notes: [
      "The canvas already contains starting lines that cannot be moved or erased.",
      "All starting lines must become part of one creative drawing.",
      "observe_canvas is the only way to see the canvas."
    ]
  };
}

/** The status a human could read off the screen. Nothing more. */
export function visibleStatus(record: TrialRecord) {
  return {
    canUndo: canUndo(record.state),
    hasDrawingAttempt: hasDrawingAttempt(record.state),
    description: record.state.description,
    submitted: record.state.submittedAtMs != null,
    availableTools: ["pencil", "eraser", "undo_last", "submit_task"]
  };
}

export type ToolResult =
  | {
      ok: true;
      changed: boolean;
      revision: number;
      status: ReturnType<typeof visibleStatus>;
      event: AudraEvent | null;
    }
  | { ok: false; error: string; code: string; status: ReturnType<typeof visibleStatus> };

export function executeToolCall(record: TrialRecord, raw: unknown, nowMs: number): ToolResult {
  record.runStats.toolCallCount += 1;
  record.runStats.lastToolCallAtMs = nowMs;
  if (record.runStats.firstToolCallAtMs == null) record.runStats.firstToolCallAtMs = nowMs;

  const parsed = parseAgentToolCall(raw);
  if (!parsed.ok) {
    record.runStats.rejectedCount += 1;
    record.rejections.push({
      atMs: nowMs,
      code: parsed.code,
      error: parsed.error,
      tool: typeof (raw as { tool?: unknown })?.tool === "string" ? (raw as { tool: string }).tool : null
    });
    return { ok: false, error: parsed.error, code: parsed.code, status: visibleStatus(record) };
  }

  const call: AgentToolCall = parsed.call;
  if (call.tool === "observe_canvas") {
    record.runStats.observeCount += 1;
    record.runStats.acceptedCount += 1;
    return { ok: true, changed: false, revision: record.state.revision, status: visibleStatus(record), event: null };
  }

  const draft = toEventDraft(call, {
    sessionId: record.sessionId,
    trialId: record.trialId,
    stimulusId: record.stimulus.stimulusId,
    actorId: record.state.actorId,
    timestampMs: nowMs,
    strokeSequence: record.strokeSequence + 1
  });
  if (!draft) throw new Error(`Tool ${call.tool} produced no event draft.`);

  const result = applyEvent(record.state, draft);
  if (!result.ok) {
    record.runStats.rejectedCount += 1;
    record.rejections.push({ atMs: nowMs, code: result.code, error: result.error, tool: call.tool });
    return { ok: false, error: result.error, code: result.code, status: visibleStatus(record) };
  }

  if (call.tool === "draw_stroke" || call.tool === "erase_stroke") record.strokeSequence += 1;
  record.state = result.state;
  record.runStats.acceptedCount += 1;
  return {
    ok: true,
    changed: true,
    revision: record.state.revision,
    status: visibleStatus(record),
    event: result.event
  };
}

export function recordFrame(record: TrialRecord, revision: number, frame: RenderedFrame) {
  record.frames.set(revision, frame);
  const ready = record.frameWaiters.filter(waiter => waiter.revision <= revision);
  record.frameWaiters = record.frameWaiters.filter(waiter => waiter.revision > revision);
  for (const waiter of ready) waiter.resolve(frame);
}

/**
 * Waits for the host page to render `revision`. The browser owns rasterization,
 * so agent and human observations come from the identical renderer rather than
 * a second, subtly different server-side one.
 */
export function awaitFrame(record: TrialRecord, revision: number, timeoutMs: number) {
  const existing = record.frames.get(revision);
  if (existing) return Promise.resolve(existing);
  const newest = [...record.frames.keys()].reduce((max, key) => (key > max ? key : max), -1);
  if (newest >= revision) return Promise.resolve(record.frames.get(newest)!);
  return new Promise<RenderedFrame | null>(resolve => {
    const waiter = { revision, resolve: (frame: RenderedFrame) => resolve(frame) };
    record.frameWaiters.push(waiter);
    setTimeout(() => {
      record.frameWaiters = record.frameWaiters.filter(item => item !== waiter);
      resolve(record.frames.get(revision) ?? null);
    }, timeoutMs);
  });
}

export function noteRetry(record: TrialRecord) {
  record.runStats.retries += 1;
}

export function clearTrials() {
  trials.clear();
}
