import {
  cleanText,
  invalid,
  readCall,
  rejected,
  type Applied,
  type CallParse,
  type RoundEndCause,
  type TextTaskEngine
} from "../agent/textTrial";
import { cs4Rounds, participantView, wordCount, type Cs4Instance } from "./item";

/**
 * A CS4 revision session: one story, revised through the rounds in
 * `cs4ConstraintStages`, each round starting from the story the previous round
 * ended with.
 *
 * The atomic unit is one sentence. Every change to the story is one call on a
 * numbered sentence, so an agent's process is a sequence of sentence-level
 * moves; a human's free-text edits are compared at the same unit by diffing
 * the sentence list.
 *
 * The state holds the whole instance because later rounds need their
 * constraints, but the observation is built from the round's participant view
 * only, so no round ever shows a later round's constraints.
 */

export const cs4RevisionLimits = {
  maxSentences: 300,
  maxSentenceChars: 600
} as const;

export type StoryUnit = { text: string; paragraphStart: boolean };

export type Cs4RoundEnd = "submitted" | RoundEndCause;

export type Cs4RoundResult = {
  round: number;
  stage: number;
  endedBy: Cs4RoundEnd;
  story: string;
  words: number;
  sentences: number;
};

export type Cs4RevisionState = {
  instance: Cs4Instance;
  round: number;
  units: readonly StoryUnit[];
  results: readonly Cs4RoundResult[];
  complete: boolean;
};

export type Cs4Call =
  | { tool: "replace_sentence"; sentence: number; text: string }
  | { tool: "insert_sentence"; after: number; text: string; new_paragraph?: boolean }
  | { tool: "delete_sentence"; sentence: number }
  | { tool: "submit_round" };

const allowedFields = {
  replace_sentence: ["sentence", "text"],
  insert_sentence: ["after", "text", "new_paragraph"],
  delete_sentence: ["sentence"],
  submit_round: []
} as const;

/**
 * Paragraphs split on blank lines, sentences on whitespace after terminal
 * punctuation (and any closing quote or bracket). Abbreviations such as "Mr."
 * split too; that only makes a unit smaller, never loses text.
 */
export function splitStory(text: string): StoryUnit[] {
  const units: StoryUnit[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const clean = cleanText(paragraph);
    if (!clean) continue;
    clean.split(/(?<=[.!?]["'”’)\]]*)\s+(?=\S)/).forEach((sentence, index) => {
      units.push({ text: sentence, paragraphStart: index === 0 });
    });
  }
  return units;
}

export function storyText(units: readonly StoryUnit[]) {
  return units
    .map((unit, index) => (index === 0 ? unit.text : `${unit.paragraphStart ? "\n\n" : " "}${unit.text}`))
    .join("");
}

function parseCs4Call(raw: unknown): CallParse<Cs4Call> {
  const read = readCall(raw, allowedFields);
  if (!read.ok) return read;
  const { tool, args } = read;
  switch (tool) {
    case "replace_sentence":
      if (!Number.isInteger(args.sentence)) return invalid("replace_sentence needs sentence: a whole number.");
      if (typeof args.text !== "string") return invalid("replace_sentence needs text: string.");
      return { ok: true, call: { tool, sentence: args.sentence as number, text: args.text } };
    case "insert_sentence":
      if (!Number.isInteger(args.after)) return invalid("insert_sentence needs after: a whole number (0 for the beginning).");
      if (typeof args.text !== "string") return invalid("insert_sentence needs text: string.");
      if (args.new_paragraph != null && typeof args.new_paragraph !== "boolean") {
        return invalid("insert_sentence new_paragraph must be true or false.");
      }
      return {
        ok: true,
        call: { tool, after: args.after as number, text: args.text, new_paragraph: args.new_paragraph as boolean | undefined }
      };
    case "delete_sentence":
      if (!Number.isInteger(args.sentence)) return invalid("delete_sentence needs sentence: a whole number.");
      return { ok: true, call: { tool, sentence: args.sentence as number } };
    case "submit_round":
      return { ok: true, call: { tool } };
  }
}

function checkSentence(text: string): string | { ok: false; code: string; error: string } {
  const cleaned = cleanText(text);
  if (cleaned.length === 0) return rejected("empty_text", "The sentence is empty.");
  if (cleaned.length > cs4RevisionLimits.maxSentenceChars) {
    return rejected("text_too_long", `A sentence is at most ${cs4RevisionLimits.maxSentenceChars} characters.`);
  }
  return cleaned;
}

function sentenceOutOfRange(sentence: number, count: number) {
  return rejected("sentence_out_of_range", `Sentence ${sentence} does not exist; sentences run from 1 to ${count}.`);
}

function finishRound(state: Cs4RevisionState, endedBy: Cs4RoundEnd): Applied<Cs4RevisionState> {
  const rounds = cs4Rounds(state.instance);
  const story = storyText(state.units);
  const result: Cs4RoundResult = {
    round: state.round,
    stage: rounds[state.round - 1].stage,
    endedBy,
    story,
    words: wordCount(story),
    sentences: state.units.length
  };
  const complete = state.round >= rounds.length;
  return {
    ok: true,
    state: { ...state, results: [...state.results, result], round: complete ? state.round : state.round + 1, complete },
    eventType: endedBy === "submitted" ? "round_submitted" : "round_ended",
    payload: { round: state.round, endedBy, words: result.words, sentences: result.sentences }
  };
}

function applyCs4Call(state: Cs4RevisionState, call: Cs4Call): Applied<Cs4RevisionState> {
  if (state.complete) return rejected("already_complete", "Every round is finished; the story can no longer change.");
  const count = state.units.length;
  switch (call.tool) {
    case "replace_sentence": {
      if (call.sentence < 1 || call.sentence > count) return sentenceOutOfRange(call.sentence, count);
      const text = checkSentence(call.text);
      if (typeof text !== "string") return text;
      const units = [...state.units];
      const previous = units[call.sentence - 1];
      units[call.sentence - 1] = { ...previous, text };
      return {
        ok: true,
        state: { ...state, units },
        eventType: "sentence_replaced",
        payload: { sentence: call.sentence, text, previous: previous.text }
      };
    }
    case "insert_sentence": {
      if (call.after < 0 || call.after > count) {
        return rejected("sentence_out_of_range", `after must be 0 (the beginning) to ${count}.`);
      }
      if (count >= cs4RevisionLimits.maxSentences) {
        return rejected("too_many_sentences", `A story has at most ${cs4RevisionLimits.maxSentences} sentences.`);
      }
      const text = checkSentence(call.text);
      if (typeof text !== "string") return text;
      const newParagraph = call.new_paragraph === true;
      const units = [...state.units];
      units.splice(call.after, 0, { text, paragraphStart: call.after === 0 || newParagraph });
      // Inserted at the very start without a paragraph break: it joins the
      // first paragraph, so the old first sentence no longer starts one.
      if (call.after === 0 && !newParagraph && units[1]) units[1] = { ...units[1], paragraphStart: false };
      return {
        ok: true,
        state: { ...state, units },
        eventType: "sentence_inserted",
        payload: { after: call.after, text, newParagraph }
      };
    }
    case "delete_sentence": {
      if (call.sentence < 1 || call.sentence > count) return sentenceOutOfRange(call.sentence, count);
      if (count === 1) return rejected("story_would_be_empty", "The last sentence cannot be deleted.");
      const units = [...state.units];
      const [removed] = units.splice(call.sentence - 1, 1);
      // Removing a paragraph's first sentence keeps the paragraph.
      const next = units[call.sentence - 1];
      if (removed.paragraphStart && next && !next.paragraphStart) {
        units[call.sentence - 1] = { ...next, paragraphStart: true };
      }
      return {
        ok: true,
        state: { ...state, units },
        eventType: "sentence_deleted",
        payload: { sentence: call.sentence, removed: removed.text }
      };
    }
    case "submit_round":
      return finishRound(state, "submitted");
  }
}

function observation(state: Cs4RevisionState) {
  const view = participantView(state.instance, state.round);
  const fresh = new Set(view.round > 1 ? view.newConstraints : []);
  const story = storyText(state.units);
  const lines = [
    state.complete ? `All ${view.totalRounds} rounds are finished.` : `Round ${view.round} of ${view.totalRounds}.`,
    "",
    `Writing instruction: ${view.instruction}`,
    "",
    view.round > 1
      ? `Constraints in force (${view.constraints.length}; the ${view.newConstraints.length} marked NEW were added this round):`
      : `Constraints in force (${view.constraints.length}):`
  ];
  view.constraints.forEach((constraint, index) => {
    lines.push(`${index + 1}. ${fresh.has(constraint) ? "NEW: " : ""}${constraint}`);
  });
  lines.push(
    "",
    `Story (${wordCount(story)} words, ${state.units.length} sentences; sentence numbers in brackets, a blank line starts a new paragraph):`
  );
  state.units.forEach((unit, index) => {
    if (unit.paragraphStart && index > 0) lines.push("");
    lines.push(`[${index + 1}] ${unit.text}`);
  });
  return lines.join("\n");
}

export const cs4RevisionEngine: TextTaskEngine<Cs4RevisionState, Cs4Call> & {
  initial(instance: Cs4Instance): Cs4RevisionState;
} = {
  taskId: "cs4-creative-writing",
  toolNames: Object.keys(allowedFields),
  initial: instance => ({ instance, round: 1, units: splitStory(instance.baseStory), results: [], complete: false }),
  parseCall: parseCs4Call,
  apply: applyCs4Call,
  observation,
  status: state => ({
    round: state.round,
    totalRounds: cs4Rounds(state.instance).length,
    complete: state.complete,
    summary: {
      round: state.round,
      words: wordCount(storyText(state.units)),
      sentences: state.units.length,
      roundsFinished: state.results.length
    }
  }),
  endRound: (state, cause) =>
    state.complete ? rejected("already_complete", "Every round is finished.") : finishRound(state, cause),
  finalFiles: state => [
    ...state.results.map(result => ({ name: `story_round${result.round}.txt`, content: `${result.story}\n` })),
    { name: "story_final.txt", content: `${storyText(state.units)}\n` },
    {
      name: "rounds.json",
      content: `${JSON.stringify(state.results.map(({ story: _story, ...rest }) => rest), null, 2)}\n`
    }
  ],
  details: state => ({
    rounds: state.results.map(({ story: _story, ...rest }) => rest),
    complete: state.complete,
    finalWords: wordCount(storyText(state.units))
  })
};
