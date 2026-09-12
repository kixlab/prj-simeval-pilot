// MacGyver creative problem solving. The solver sees the problem and its answer so far, as text.

import { makeFlatCallNormalizer } from "../agentReplyParser.mjs";
import { formatDuration } from "../agentStrategies.mjs";
import { cannedReplies, readTextView, textTaskApi, timeLimitLine } from "./shared.mjs";

const taskId = "macgyver-problem-solving";

function taskPrompt(timing = {}) {
  return `You are solving a practical problem using only what the problem describes.

Your task: decide whether the problem can be solved with the objects and conditions it states. If it can, write the solution as a sequence of concrete steps. If it cannot, say so and explain why. Use nothing the problem does not mention, and do not look anything up.${timeLimitLine(timing, formatDuration)}

Available actions:
{"tool":"set_judgement","value":"solvable"}   or   {"tool":"set_judgement","value":"unsolvable"}
{"tool":"add_step","text":"one concrete step"}   add "position":N to insert it as step N instead of at the end
{"tool":"revise_step","step":2,"text":"the new wording of step 2"}
{"tool":"delete_step","step":2}
{"tool":"set_justification","text":"why the problem cannot be solved"}
{"tool":"submit_answer"}

Rules:
- Steps are numbered from 1. Each step is one concrete action.
- A solvable answer needs at least one step; an unsolvable answer needs a justification.
- The problem and your answer so far are shown in every message.

Finishing: set the judgement, make sure the steps (or the justification) are final, then call submit_answer.`;
}

const normalizeCall = makeFlatCallNormalizer(
  {
    set_judgement: { value: "string" },
    add_step: { text: "string", position: "integer" },
    revise_step: { step: "integer", text: "string" },
    delete_step: { step: "integer" },
    set_justification: { text: "string" },
    submit_answer: {}
  },
  { aliases: { value: ["judgement", "judgment"], step: ["index", "step_number"], text: ["content", "step_text"] } }
);

const mockScript = [
  { thought: "Nothing here is a hook, but the hanger can become one.", call: { tool: "set_judgement", value: "solvable" } },
  { thought: "Start by getting a straight piece of wire.", call: { tool: "add_step", text: "Cut a straight length from the coat hanger with the pliers." } },
  { thought: "The wire needs a hook end.", call: { tool: "add_step", text: "Bend one end into a flat hook." } },
  { thought: "The hook has to hold without nails.", call: { tool: "add_step", text: "Tape the hook to the wall." } },
  { thought: "Plain tape will not hold the weight; spread the load.", call: { tool: "revise_step", step: 3, text: "Tape the hook flat to the wall with several crossed strips of duct tape." } },
  { thought: "Finish by hanging and levelling the frame.", call: { tool: "add_step", text: "Hang the frame on the hook and level it with the ruler." } },
  { thought: "The steps are complete.", call: { tool: "submit_answer" } }
];

const mockGroups = {
  single: mockScript.map((_, index) => [index]),
  multi: [[0, 1, 2], [3, 4], [5, 6]],
  "one-shot": [mockScript.map((_, index) => index)]
};

export const macgyverTask = {
  id: "macgyver",
  taskId,
  rounds: 1,
  observation: "text",
  vocab: {
    shown: "your answer",
    artifact: "answer",
    whole: "your complete answer",
    finishSequence: "submit_answer",
    submitTool: "submit_answer"
  },
  artifactTools: new Set(["set_judgement", "add_step", "revise_step", "delete_step", "set_justification"]),
  taskPrompt,
  normalizeCall,
  callLabel: call => (call.step != null ? `${call.tool} ${call.step}` : call.tool),
  statusLines: () => [],
  turnAsk: strategy => (strategy === "single" ? "What is your next action?" : "What are your next actions?"),
  oneShotAsk: "Produce your complete answer now.",
  createBody: (options, agentRun) => ({ actorId: options.actorId, itemId: options.item ?? undefined, agentRun }),
  readView: readTextView,
  finalAnswer: ({ summary }) => ({
    judgement: summary?.judgement ?? null,
    stepCount: summary?.stepCount ?? 0,
    hasJustification: summary?.hasJustification ?? false
  }),
  itemOf: (options, created) => created.itemId ?? options.item,
  api: base => textTaskApi(base, taskId),
  mockReplies: strategy => cannedReplies(mockScript, mockGroups[strategy], strategy)
};
