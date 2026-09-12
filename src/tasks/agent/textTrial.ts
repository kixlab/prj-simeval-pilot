/**
 * Shared shapes for the text tasks' trial environment (MacGyver, CS4).
 *
 * The same principle as `src/audra`: everything that can change an answer is a
 * call validated by one pure engine, and the event log is the record. An agent
 * reaches the engine through `/api/tasks/:taskId/agent/*`; a human editor will
 * produce the same state from free text edits. Engines hold no I/O, so they run
 * in the browser, on the server, and in the integrity tests unchanged.
 */

export type TextActorType = "agent" | "human" | "system";

export type TextEvent = {
  sessionId: string;
  trialId: string;
  taskId: string;
  itemId: string;
  actorType: TextActorType;
  actorId: string;
  /** Assigned by the registry, never by the actor. */
  eventIndex: number;
  /** Milliseconds since the trial was created. */
  timestampMs: number;
  /** The round the event happened in; always 1 for single-round tasks. */
  round: number;
  eventType: string;
  payload: Record<string, unknown>;
};

export type CallParseCode = "unsupported_tool" | "unsupported_field" | "invalid_arguments";

export type CallParse<C> = { ok: true; call: C } | { ok: false; code: CallParseCode; error: string };

export type Applied<S> =
  | { ok: true; state: S; eventType: string; payload: Record<string, unknown> }
  | { ok: false; code: string; error: string };

/** Why a round ended without the actor submitting it. */
export type RoundEndCause = "time_limit" | "reply_without_submit" | "no_readable_reply";

export const roundEndCauses: readonly RoundEndCause[] = ["time_limit", "reply_without_submit", "no_readable_reply"];

export type TextTrialStatus = {
  round: number;
  totalRounds: number;
  complete: boolean;
  /** Visible facts only - what a participant could read off the screen. */
  summary: Record<string, unknown>;
};

export type TextFile = { name: string; content: string };

export type TextTaskEngine<S, C extends { tool: string }> = {
  taskId: string;
  toolNames: readonly string[];
  /** Strict: unknown tools and unknown argument fields are rejected, never dropped. */
  parseCall(raw: unknown): CallParse<C>;
  /** Range, length, and state checks. Pure: returns a new state. */
  apply(state: S, call: C): Applied<S>;
  /** Everything the solver may see, as text, and nothing more. */
  observation(state: S): string;
  status(state: S): TextTrialStatus;
  /** Only tasks with rounds: ends the current round without a submission. */
  endRound?(state: S, cause: RoundEndCause): Applied<S>;
  /** The answer as files for the export bundle. */
  finalFiles(state: S): readonly TextFile[];
  /** Answer details recorded in session.json. */
  details(state: S): Record<string, unknown>;
};

export function invalid(error: string): { ok: false; code: "invalid_arguments"; error: string } {
  return { ok: false, code: "invalid_arguments", error };
}

export function rejected(code: string, error: string): { ok: false; code: string; error: string } {
  return { ok: false, code, error };
}

/**
 * Reads the tool name and arguments of one call, rejecting an unknown tool or
 * any field the tool does not declare. Argument types are left to the engine.
 */
export function readCall<T extends string>(
  raw: unknown,
  allowed: Record<T, readonly string[]>
): { ok: true; tool: T; args: Record<string, unknown> } | { ok: false; code: CallParseCode; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("A tool call must be an object.");
  const record = raw as Record<string, unknown>;
  const names = Object.keys(allowed) as T[];
  if (typeof record.tool !== "string" || !names.includes(record.tool as T)) {
    return {
      ok: false,
      code: "unsupported_tool",
      error: `Unsupported tool: ${String(record.tool)}. Available: ${names.join(", ")}.`
    };
  }
  const tool = record.tool as T;
  const extraneous = Object.keys(record).filter(key => key !== "tool" && !allowed[tool].includes(key));
  if (extraneous.length > 0) {
    return { ok: false, code: "unsupported_field", error: `${tool} does not accept: ${extraneous.join(", ")}.` };
  }
  const { tool: _tool, ...args } = record;
  return { ok: true, tool, args };
}

/** Collapses whitespace; the engines store one-line text units. */
export function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
