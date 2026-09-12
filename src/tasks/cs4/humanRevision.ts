import { alignUnits, applyTextEdit, summarizeTextEdits } from "../humanText";
import { cs4ConstraintStages, wordCount } from "./item";
import { splitStory } from "./revision";

export { textDiff } from "../humanText";

/**
 * A participant's CS4 session: one story, revised freely in a note area
 * through the rounds in `cs4ConstraintStages`, each round starting from the
 * story the previous one ended with.
 *
 * As on the MacGyver screen, the story is recorded edit by edit (lossless, it
 * replays from the base story to the exact final text) with a pause marker
 * wherever typing stopped. Between pauses the story is split into sentences -
 * the unit an agent's replace / insert / delete_sentence acts on - and aligned
 * with the previous split, so the two processes can be compared at one grain.
 *
 * Pure: the browser, the server's replay check, and the tests share it.
 */
export type HumanCs4EventType = "text_edit" | "pause" | "translation_toggle" | "round_submit" | "round_end";

export type HumanCs4Event = {
  eventIndex: number;
  /** Milliseconds since the session page opened. */
  timestampMs: number;
  eventType: HumanCs4EventType;
  payload: Record<string, unknown>;
};

export type HumanCs4RoundResult = {
  round: number;
  stage: number;
  endedBy: "submitted" | "time_limit";
  story: string;
  words: number;
  sentences: number;
  endedAtMs: number;
};

export type HumanCs4State = {
  round: number;
  text: string;
  results: readonly HumanCs4RoundResult[];
  complete: boolean;
};

export const humanStoryLimits = { maxChars: 20000 } as const;

export function initialHumanCs4State(baseStory: string): HumanCs4State {
  return { round: 1, text: baseStory, results: [], complete: false };
}

type Result = { ok: true; state: HumanCs4State } | { ok: false; error: string };

function finishRound(state: HumanCs4State, endedBy: HumanCs4RoundResult["endedBy"], endedAtMs: number): HumanCs4State {
  const result: HumanCs4RoundResult = {
    round: state.round,
    stage: cs4ConstraintStages[state.round - 1],
    endedBy,
    story: state.text,
    words: wordCount(state.text),
    sentences: splitStory(state.text).length,
    endedAtMs
  };
  const complete = state.round >= cs4ConstraintStages.length;
  return { ...state, results: [...state.results, result], round: complete ? state.round : state.round + 1, complete };
}

export function applyHumanCs4Event(state: HumanCs4State, event: HumanCs4Event): Result {
  if (state.complete) return { ok: false, error: "Every round is finished; the story can no longer change." };
  switch (event.eventType) {
    case "text_edit": {
      const edited = applyTextEdit(state.text, event.payload, event.eventIndex, humanStoryLimits.maxChars);
      return edited.ok ? { ok: true, state: { ...state, text: edited.text } } : edited;
    }
    case "pause":
    case "translation_toggle":
      return { ok: true, state };
    case "round_submit":
      // The participant finishes the round - the same guard as an agent's submit_round.
      if (state.text.trim().length === 0) return { ok: false, error: "The story is empty." };
      return { ok: true, state: finishRound(state, "submitted", event.timestampMs) };
    case "round_end":
      // The round's clock ran out: the protocol ends it, not the participant.
      if (event.payload.cause !== "time_limit") return { ok: false, error: 'A round ends by "time_limit".' };
      return { ok: true, state: finishRound(state, "time_limit", event.timestampMs) };
    default:
      return { ok: false, error: `Unknown event type: ${String(event.eventType)}` };
  }
}

/** Rebuilds the session from the base story and its log, refusing any log that does not reproduce. */
export function replayHumanCs4Events(baseStory: string, events: readonly HumanCs4Event[]): HumanCs4State {
  let state = initialHumanCs4State(baseStory);
  events.forEach((event, index) => {
    if (event.eventIndex !== index) throw new Error(`Event ${index} carries eventIndex ${event.eventIndex}.`);
    if (index > 0 && event.timestampMs < events[index - 1].timestampMs) {
      throw new Error(`Event ${index} is timestamped before the event it follows.`);
    }
    const result = applyHumanCs4Event(state, event);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
  });
  return state;
}

export type SentenceChange = {
  eventIndex: number;
  timestampMs: number;
  round: number;
  change: "added" | "revised" | "deleted";
  /** 1-based position after the change; for a deletion, the position it had before. */
  sentence: number;
  text: string | null;
  previous: string | null;
};

/**
 * Sentence-level changes between pauses and at every round boundary - the
 * moves an agent's sentence tools are compared with - each attributed to the
 * round it happened in. The base story is the starting point, so only what the
 * participant changed is counted.
 */
export function sentenceChangesFromEvents(baseStory: string, events: readonly HumanCs4Event[]): SentenceChange[] {
  let state = initialHumanCs4State(baseStory);
  const sentences = (text: string) => splitStory(text).map(unit => unit.text);
  let settled = sentences(baseStory);
  const changes: SentenceChange[] = [];
  const settle = (event: HumanCs4Event, round: number) => {
    const current = sentences(state.text);
    for (const { change, position, text, previous } of alignUnits(settled, current)) {
      changes.push({ eventIndex: event.eventIndex, timestampMs: event.timestampMs, round, change, sentence: position, text, previous });
    }
    settled = current;
  };
  for (const event of events) {
    const roundBefore = state.round;
    const result = applyHumanCs4Event(state, event);
    if (!result.ok) throw new Error(result.error);
    state = result.state;
    if (event.eventType === "pause" || event.eventType === "round_submit" || event.eventType === "round_end") {
      settle(event, roundBefore);
    }
  }
  const last = events.at(-1);
  if (last) settle(last, state.complete ? state.round : state.round);
  return changes;
}

export function summarizeHumanCs4Process(events: readonly HumanCs4Event[]) {
  return summarizeTextEdits(events);
}
