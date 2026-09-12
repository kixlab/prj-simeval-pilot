import type { RoundEndCause, TextActorType, TextEvent, TextTaskEngine, TextTrialStatus } from "./textTrial";

/**
 * Authoritative, server-side state for text-task agent trials.
 *
 * Agents hold a trialId, never state. Every call is re-validated by the task's
 * engine, so a malformed or out-of-range call is rejected regardless of what
 * the calling driver believes it may do. Pure - no I/O - so the integrity
 * tests drive it directly.
 */

// Engines differ in state and call types; the registry only passes them through.
type AnyEngine = TextTaskEngine<any, { tool: string }>;

export type TextRejection = { atMs: number; code: string; error: string; tool: string | null };

export type TextTrialRecord = {
  trialId: string;
  sessionId: string;
  renderToken: string;
  taskId: string;
  itemId: string;
  itemSource: string;
  actorId: string;
  engine: AnyEngine;
  state: unknown;
  events: TextEvent[];
  createdAtEpochMs: number;
  agentRun: Record<string, unknown> | null;
  /** Counted separately from the event log. */
  runStats: {
    toolCallCount: number;
    acceptedCount: number;
    rejectedCount: number;
    observeCount: number;
    roundEnds: number;
    firstToolCallAtMs: number | null;
    lastToolCallAtMs: number | null;
  };
  rejections: TextRejection[];
};

export type TextTrialView = {
  revision: number;
  status: TextTrialStatus;
  observation: { kind: "text"; text: string };
};

export type TextToolResult =
  | ({ ok: true } & TextTrialView)
  | { ok: false; code: string; error: string; status: TextTrialStatus };

const trials = new Map<string, TextTrialRecord>();

function randomId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function createTextTrial(input: {
  engine: AnyEngine;
  initialState: unknown;
  taskId: string;
  itemId: string;
  itemSource: string;
  actorId: string;
  agentRun?: Record<string, unknown> | null;
  sessionId?: string;
}): TextTrialRecord {
  const record: TextTrialRecord = {
    trialId: randomId("trial"),
    sessionId: input.sessionId ?? randomId("session"),
    renderToken: randomId("render"),
    taskId: input.taskId,
    itemId: input.itemId,
    itemSource: input.itemSource,
    actorId: input.actorId,
    engine: input.engine,
    state: input.initialState,
    events: [],
    createdAtEpochMs: Date.now(),
    agentRun: input.agentRun ?? null,
    runStats: {
      toolCallCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      observeCount: 0,
      roundEnds: 0,
      firstToolCallAtMs: null,
      lastToolCallAtMs: null
    },
    rejections: []
  };
  trials.set(record.trialId, record);
  return record;
}

export function getTextTrial(trialId: string) {
  return trials.get(trialId) ?? null;
}

export function clearTextTrials() {
  trials.clear();
}

export function textTrialStatus(record: TextTrialRecord): TextTrialStatus {
  return record.engine.status(record.state);
}

function view(record: TextTrialRecord): TextTrialView {
  return {
    revision: record.events.length,
    status: textTrialStatus(record),
    observation: { kind: "text", text: record.engine.observation(record.state) }
  };
}

/** What the solver sees now. Counted, as an agent observation is on the drawing task. */
export function observeTextTrial(record: TextTrialRecord): TextTrialView {
  record.runStats.observeCount += 1;
  return view(record);
}

function append(
  record: TextTrialRecord,
  actorType: TextActorType,
  round: number,
  eventType: string,
  payload: Record<string, unknown>,
  nowMs: number
) {
  record.events.push({
    sessionId: record.sessionId,
    trialId: record.trialId,
    taskId: record.taskId,
    itemId: record.itemId,
    actorType,
    actorId: actorType === "system" ? "system" : record.actorId,
    eventIndex: record.events.length,
    timestampMs: nowMs,
    round,
    eventType,
    payload
  });
}

function reject(record: TextTrialRecord, nowMs: number, code: string, error: string, tool: string | null): TextToolResult {
  record.runStats.rejectedCount += 1;
  record.rejections.push({ atMs: nowMs, code, error, tool });
  return { ok: false, code, error, status: textTrialStatus(record) };
}

export function executeTextToolCall(record: TextTrialRecord, raw: unknown, nowMs: number): TextToolResult {
  record.runStats.toolCallCount += 1;
  record.runStats.lastToolCallAtMs = nowMs;
  if (record.runStats.firstToolCallAtMs == null) record.runStats.firstToolCallAtMs = nowMs;

  const parsed = record.engine.parseCall(raw);
  const toolName = typeof (raw as { tool?: unknown })?.tool === "string" ? (raw as { tool: string }).tool : null;
  if (!parsed.ok) return reject(record, nowMs, parsed.code, parsed.error, toolName);

  const round = textTrialStatus(record).round;
  const applied = record.engine.apply(record.state, parsed.call);
  if (!applied.ok) return reject(record, nowMs, applied.code, applied.error, parsed.call.tool);

  record.state = applied.state;
  append(record, "agent", round, applied.eventType, applied.payload, nowMs);
  record.runStats.acceptedCount += 1;
  return { ok: true, ...view(record) };
}

/**
 * Ends the current round without a submission - the round clock ran out, or a
 * one-shot reply ended without submitting. Host-only: it is the protocol acting,
 * not the actor, so it is logged as a system event.
 */
export function endTextRound(record: TextTrialRecord, cause: RoundEndCause, nowMs: number): TextToolResult {
  if (!record.engine.endRound) {
    return { ok: false, code: "no_rounds", error: "This task has no rounds.", status: textTrialStatus(record) };
  }
  const round = textTrialStatus(record).round;
  const applied = record.engine.endRound(record.state, cause);
  if (!applied.ok) return { ok: false, code: applied.code, error: applied.error, status: textTrialStatus(record) };
  record.state = applied.state;
  append(record, "system", round, applied.eventType, applied.payload, nowMs);
  record.runStats.roundEnds += 1;
  return { ok: true, ...view(record) };
}
