import { alignUnits, applyTextEdit, summarizeTextEdits } from "../humanText";
import type { Judgement } from "./answer";

export { textDiff, type TextEdit } from "../humanText";

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
export type HumanMacGyverEventType = "text_edit" | "pause" | "judgement_set" | "translation_toggle" | "submit";

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

export function initialHumanState(): HumanMacGyverState {
  return { text: "", judgement: null, submitted: false };
}

type Result = { ok: true; state: HumanMacGyverState } | { ok: false; error: string };

export function applyHumanEvent(state: HumanMacGyverState, event: HumanMacGyverEvent): Result {
  if (state.submitted) return { ok: false, error: "The answer has been submitted; nothing can change it now." };
  switch (event.eventType) {
    case "text_edit": {
      const edited = applyTextEdit(state.text, event.payload, event.eventIndex, humanMemoLimits.maxChars);
      return edited.ok ? { ok: true, state: { ...state, text: edited.text } } : edited;
    }
    case "pause":
    case "translation_toggle":
      // Process markers: they change nothing in the answer.
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
    for (const { change, position, text, previous } of alignUnits(settled, steps)) {
      changes.push({ eventIndex: event.eventIndex, timestampMs: event.timestampMs, change, step: position, text, previous });
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
  return {
    ...summarizeTextEdits(events),
    judgementChanges: events.filter(event => event.eventType === "judgement_set").length
  };
}
