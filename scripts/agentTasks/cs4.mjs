// CS4 constrained story revision, three rounds. The solver sees the round's
// constraints and the numbered story, as text.

import { makeFlatCallNormalizer } from "../agentReplyParser.mjs";
import { formatDuration } from "../agentStrategies.mjs";
import { cannedReplies, readTextView, textTaskApi, timeLimitLine } from "./shared.mjs";

const taskId = "cs4-creative-writing";
// Matches cs4ConstraintStages in src/tasks/cs4/item.ts; the runner checks it
// against the round count the server reports.
const rounds = 3;

function taskPrompt(timing = {}) {
  return `You are revising a short story so that it satisfies a list of constraints.

Your task: the session has ${rounds} rounds. Each round lists the constraints in force - the previous round's constraints plus new ones. Revise the story you ended the previous round with so that it satisfies every constraint in force and stays one coherent story of about 500 words.${timeLimitLine(timing, formatDuration, { perRound: true })}

Available actions (sentences are numbered from 1):
{"tool":"replace_sentence","sentence":3,"text":"the new sentence"}
{"tool":"insert_sentence","after":3,"text":"a new sentence"}   "after":0 inserts at the beginning; add "new_paragraph":true to start a new paragraph with it
{"tool":"delete_sentence","sentence":3}
{"tool":"submit_round"}

Rules:
- Each action changes one sentence. A sentence number refers to the story as it is when that action runs; after an insert or a delete, the sentences after it are renumbered.
- The instruction, the constraints in force, and the numbered story are shown in every message.
- submit_round ends the round. The next round starts from the story as you left it.

Finishing a round: when the story satisfies every constraint in force, call submit_round.`;
}

const normalizeCall = makeFlatCallNormalizer(
  {
    replace_sentence: { sentence: "integer", text: "string" },
    insert_sentence: { after: "integer", text: "string", new_paragraph: "boolean" },
    delete_sentence: { sentence: "integer" },
    submit_round: {}
  },
  {
    aliases: {
      sentence: ["index", "sentence_number"],
      after: ["after_sentence"],
      text: ["content", "new_text"],
      new_paragraph: ["newParagraph"]
    }
  }
);

function roundScript(round) {
  return [
    { thought: `Round ${round}: the opening has to reflect the new constraints.`, call: { tool: "replace_sentence", sentence: 1, text: `The morning of round ${round} began quietly at the harbour.` } },
    { thought: "A detail after the opening carries the new requirement.", call: { tool: "insert_sentence", after: 1, text: `A detail added in round ${round} settled on the counter.` } },
    { thought: "The third sentence now repeats itself, so it goes.", call: { tool: "delete_sentence", sentence: 3 } },
    { thought: "The round's constraints are covered.", call: { tool: "submit_round" } }
  ];
}

const mockScript = [1, 2, 3].flatMap(roundScript);
const perRound = offsets => [0, 4, 8].flatMap(base => offsets.map(group => group.map(index => base + index)));

const mockGroups = {
  single: mockScript.map((_, index) => [index]),
  multi: perRound([[0, 1], [2, 3]]),
  "one-shot": perRound([[0, 1, 2, 3]])
};

export const cs4Task = {
  id: "cs4",
  taskId,
  rounds,
  observation: "text",
  vocab: {
    shown: "the story",
    artifact: "story",
    whole: "the round's revision",
    finishSequence: "submit_round",
    submitTool: "submit_round"
  },
  artifactTools: new Set(["replace_sentence", "insert_sentence", "delete_sentence"]),
  taskPrompt,
  normalizeCall,
  callLabel: call => {
    const where = call.sentence ?? call.after;
    return where != null ? `${call.tool} ${where}` : call.tool;
  },
  statusLines: () => [],
  turnAsk: strategy => (strategy === "single" ? "What is your next action?" : "What are your next actions?"),
  oneShotAsk: "Produce the round's revision now.",
  createBody: (options, agentRun) => ({ actorId: options.actorId, itemId: options.item ?? undefined, agentRun }),
  readView: readTextView,
  finalAnswer: ({ summary }) => ({ words: summary?.words ?? null, roundsFinished: summary?.roundsFinished ?? 0 }),
  itemOf: (options, created) => created.itemId ?? options.item,
  api: base => textTaskApi(base, taskId),
  mockReplies: strategy => cannedReplies(mockScript, mockGroups[strategy], strategy)
};
