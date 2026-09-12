import type { Judgement } from "./answer";

/**
 * A participant's MacGyver answer: a judgement and a free-text memo, written
 * the way one writes in a notepad.
 *
 * The memo is recorded edit by edit, and the log is lossless - it replays to
 * the exact final text - with a pause marker wherever typing stopped. Between
 * pauses the memo's lines are read as solution steps, which is the unit an
 * agent's answer is built from, so the two processes can be compared at the
 * same grain without asking the participant to write in a form.
 *
 * Pure, so the browser, the server's replay check, and the tests share it.
 */
export type HumanMacGyverEventType = "text_edit" | "pause" | "judgement_set" | "submit";

export type HumanMacGyverEvent = {
  /** Position in the log; a replay refuses a gap or a reordering. */
  eventIndex: number;
  /** Milliseconds since the trial page opened. */
  timestampMs: number;
  eventType: HumanMacGyverEventType;
  payload: Record<string, unknown>;
};

export type HumanMacGyverState = {
  text: string;
  judgement: Judgement | null;
  submitted: boolean;
};

export const humanMemoLimits = { maxChars: 10000 } as const;

export type TextEdit = { start: number; removed: string; inserted: string };

export function initialHumanState(): HumanMacGyverState {
  return { text: "", judgement: null, submitted: false };
}

/** The smallest single replacement that turns one text into the other. */
export function textDiff(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { start, removed: before.slice(start, endBefore), inserted: after.slice(start, endAfter) };
}

type Result = { ok: true; state: HumanMacGyverState } | { ok: false; error: string };

export function applyHumanEvent(state: HumanMacGyverState, event: HumanMacGyverEvent): Result {
  if (state.submitted) return { ok: false, error: "The answer has been submitted; nothing can change it now." };
  switch (event.eventType) {
    case "text_edit": {
      const { start, removed, inserted } = event.payload as Partial<TextEdit>;
      if (!Number.isInteger(start) || typeof removed !== "string" || typeof inserted !== "string") {
        return { ok: false, error: `Edit ${event.eventIndex} needs start, removed and inserted.` };
      }
      const at = start as number;
      if (at < 0 || state.text.slice(at, at + removed.length) !== removed) {
        return { ok: false, error: `Edit ${event.eventIndex} does not match the text it claims to change.` };
      }
      const text = state.text.slice(0, at) + inserted + state.text.slice(at + removed.length);
      if (text.length > humanMemoLimits.maxChars) {
        return { ok: false, error: `The answer is limited to ${humanMemoLimits.maxChars} characters.` };
      }
      return { ok: true, state: { ...state, text } };
    }
    case "pause":
      return { ok: true, state };
    case "judgement_set": {
      const value = event.payload.value;
      if (value !== "solvable" && value !== "unsolvable") {
        return { ok: false, error: 'A judgement is "solvable" or "unsolvable".' };
      }
      return { ok: true, state: { ...state, judgement: value } };
    }
    case "submit":
      // The same guard an agent's submit_answer meets.
      if (!state.judgement) return { ok: false, error: "Choose whether the problem can be solved before submitting." };
      if (state.text.trim().length === 0) return { ok: false, error: "Write your answer before submitting." };
      return { ok: true, state: { ...state, submitted: true } };
    default:
      return { ok: false, error: `Unknown event type: ${String(event.eventType)}` };
  }
}

/** Rebuilds the answer from its log, refusing any log that does not reproduce. */
export function replayHumanEvents(events: readonly HumanMacGyverEvent[]): HumanMacGyverState {
  let state = initialHumanState();
  events.forEach((event, index) => {
    if (event.eventIndex !== index) throw new Error(`Event ${index} carries eventIndex ${event.eventIndex}.`);
    if (index > 0 && event.timestampMs < events[index - 1].timestampMs) {
      throw new Error(`Event ${index} is timestamped before the event it follows.`);
    }
    const result = applyHumanEvent(state, event);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  });
  return state;
}

// "1." "1)" "2 ." or a bullet, at the start of a line.
const stepMarker = /^\s*(?:\d+\s*[.)]\s*|[-*•]\s+)/;

/** The memo's non-blank lines, with any numbering or bullet removed, as solution steps. */
export function stepsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(stepMarker, "").trim())
    .filter(Boolean);
}

export type StepChange = {
  eventIndex: number;
  timestampMs: number;
  change: "added" | "revised" | "deleted";
  /** 1-based position after the change; for a deletion, the position it had before. */
  step: number;
  text: string | null;
  previous: string | null;
};

type AlignedChange = Omit<StepChange, "eventIndex" | "timestampMs">;

/**
 * Line-level alignment of two step lists (longest common subsequence). Within
 * a run of unmatched lines, a removed line paired with an added one is a
 * revision; the rest are additions or deletions.
 */
function alignSteps(before: readonly string[], after: readonly string[]): AlignedChange[] {
  const rows = before.length;
  const columns = after.length;
  const common = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const changes: AlignedChange[] = [];
  let removed: Array<[number, string]> = [];
  let added: Array<[number, string]> = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k += 1) {
      changes.push({ change: "revised", step: added[k][0] + 1, text: added[k][1], previous: removed[k][1] });
    }
    for (const [index, line] of added.slice(pairs)) changes.push({ change: "added", step: index + 1, text: line, previous: null });
    for (const [index, line] of removed.slice(pairs)) changes.push({ change: "deleted", step: index + 1, text: null, previous: line });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && before[i] === after[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < columns && (i >= rows || common[i][j + 1] >= common[i + 1][j])) {
      added.push([j, after[j]]);
      j += 1;
    } else {
      removed.push([i, before[i]]);
      i += 1;
    }
  }
  flush();
  return changes;
}

/**
 * Step-level changes between consecutive pauses - the moves an agent's
 * add_step / revise_step / delete_step are compared with. Text typed after the
 * last pause (a trial cut off by the clock) is still counted at the final event.
 */
export function stepChangesFromEvents(events: readonly HumanMacGyverEvent[]): StepChange[] {
  let state = initialHumanState();
  let settled: string[] = [];
  const changes: StepChange[] = [];
  const settle = (event: HumanMacGyverEvent) => {
    const steps = stepsFromText(state.text);
    for (const change of alignSteps(settled, steps)) {
      changes.push({ eventIndex: event.eventIndex, timestampMs: event.timestampMs, ...change });
    }
    settled = steps;
  };
  for (const event of events) {
    const result = applyHumanEvent(state, event);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    if (event.eventType === "pause" || event.eventType === "submit") settle(event);
  }
  const last = events.at(-1);
  if (last) settle(last);
  return changes;
}

export function summarizeHumanProcess(events: readonly HumanMacGyverEvent[]) {
  const edits = events.filter(event => event.eventType === "text_edit");
  return {
    edits: edits.length,
    charsInserted: edits.reduce((sum, event) => sum + String(event.payload.inserted ?? "").length, 0),
    charsRemoved: edits.reduce((sum, event) => sum + String(event.payload.removed ?? "").length, 0),
    pastes: edits.filter(event => event.payload.source === "paste").length,
    pauses: events.filter(event => event.eventType === "pause").length,
    judgementChanges: events.filter(event => event.eventType === "judgement_set").length
  };
}
