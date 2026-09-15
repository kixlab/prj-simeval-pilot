// Incomplete-shapes drawing task (AuDrA). The solver sees a rendered image.

import { formatDuration } from "../agentStrategies.mjs";
import { normalizeAudraCall } from "../audraToolCallParser.mjs";
import { cannedReplies, getJson, postJson, timeLimitLine } from "./shared.mjs";

const actions = `Available actions:
{"tool":"draw_stroke","points":[[x,y],[x,y],...],"width":6}
{"tool":"erase_stroke","points":[[x,y],[x,y],...],"width":24}
{"tool":"undo_last"}
{"tool":"set_description","text":"what you drew"}
{"tool":"submit_task"}`;

function taskPrompt(timing = {}) {
  return `You are drawing on a square canvas that already contains four unfinished lines.

Your task: use ALL four starting lines as part of ONE creative drawing. Be as creative as you can.${timeLimitLine(timing, formatDuration)}

Coordinates: x from 0 (left) to 1024 (right), y from 0 (top) to 1024 (bottom).
Always give coordinates in this 0-1024 space, whatever pixel size the canvas
image happens to be shown at. Use the whole canvas.

${actions}

Rules:
- draw_stroke needs at least 2 points. Long curves need many points.
- You cannot move or erase the four starting lines.
- Draw several strokes before finishing.
- Fix what goes wrong instead of drawing over it: erase_stroke removes your ink
  along the points you give it, and undo_last removes your most recent stroke.
  Neither can touch the four starting lines.
- Stop adding when the picture reads clearly. A finished drawing is usually 20
  to 60 strokes; past that, more ink buries the picture instead of improving it.
  Use the remaining time to fix and refine rather than to keep adding.

Finishing, in this exact order:
1. set_description - answer the question "What did you draw?" with ONE final
   answer naming the whole picture, for example "a lantern floating over a
   river". Call this exactly once, when the drawing is finished.
2. submit_task - only after your answer is recorded.`;
}

/** One fixed drawing, cut into replies differently per strategy. */
const mockScript = [
  { thought: "The broken arch reads as the top of a lantern; I will close its body.", call: { tool: "draw_stroke", points: [[187, 259], [150, 430], [250, 540], [413, 470], [413, 259]], width: 6 } },
  { thought: "The zigzag can be a second lantern with a folded paper shade.", call: { tool: "draw_stroke", points: [[640, 200], [610, 430], [880, 430], [880, 290]], width: 6 } },
  { thought: "Boxing the wave turns it into water inside a tank.", call: { tool: "draw_stroke", points: [[170, 690], [170, 800], [470, 800], [470, 690]], width: 6 } },
  { thought: "The hook becomes a small creature curled on the ground.", call: { tool: "draw_stroke", points: [[700, 820], [660, 900], [860, 900], [840, 860]], width: 6 } },
  { thought: "The tank base is too heavy; I will open a gap in it.", call: { tool: "erase_stroke", points: [[300, 800], [340, 800]], width: 24 } },
  { thought: "Naming the scene now that all four starting lines are used.", call: { tool: "set_description", text: "four lanterns floating above a river" } },
  { thought: "Every starting line is part of the drawing, so I am done.", call: { tool: "submit_task" } }
].map(entry => ({
  ...entry,
  call: entry.call.points ? { ...entry.call, points: entry.call.points.map(([x, y]) => ({ x, y })) } : entry.call
}));

const mockGroups = {
  single: mockScript.map((_, index) => [index]),
  multi: [[0, 1], [2, 3, 4], [5, 6]],
  "one-shot": [mockScript.map((_, index) => index)]
};

export const audraTask = {
  id: "audra",
  taskId: "audra-incomplete-shapes",
  rounds: 1,
  observation: "image",
  vocab: {
    shown: "the canvas",
    artifact: "drawing",
    whole: "the complete drawing",
    finishSequence: "set_description and then submit_task",
    submitTool: "submit_task"
  },
  artifactTools: new Set(["draw_stroke", "erase_stroke", "undo_last"]),
  taskPrompt,
  normalizeCall: normalizeAudraCall,
  callLabel: call =>
    call.tool === "draw_stroke" || call.tool === "erase_stroke" ? `${call.tool} (${call.points.length} points)` : call.tool,
  // A participant can always see what they typed in the answer box, so the
  // agent is shown the same thing rather than having to remember it.
  statusLines: ({ description }) => [
    description
      ? `Your recorded answer to "What did you draw?": "${description}"`
      : 'You have NOT yet answered "What did you draw?". You must call set_description once before submit_task.'
  ],
  turnAsk: strategy =>
    `This is the canvas right now. ${strategy === "single" ? "What is your next action?" : "What are your next actions?"}`,
  oneShotAsk: "This is the canvas. Produce the complete drawing now.",
  createBody: (options, agentRun) => ({
    actorId: options.actorId,
    stimulusId: options.stimulus,
    observationSize: options.observationSize,
    agentRun
  }),
  readView: result => ({
    ok: result.ok === true,
    revision: result.revision,
    complete: result.status?.submitted === true,
    round: 1,
    image: result.image?.base64 ?? null,
    text: null,
    description: result.status?.description ?? null,
    summary: null,
    code: result.code ?? null,
    error: result.error ?? null
  }),
  finalAnswer: ({ description, acceptedCalls }) => ({
    text: description || null,
    recorded: Boolean(description),
    setDescriptionCalls: acceptedCalls.filter(call => call.tool === "set_description").length
  }),
  itemOf: (options, created) => created.stimulusId ?? options.stimulus,
  api: base => ({
    async createTrial(body) {
      const payload = await postJson(`${base}/api/audra/trial`, body);
      if (!payload.ok) throw new Error(`Trial creation failed: ${JSON.stringify(payload)}`);
      return { ...payload, totalRounds: 1 };
    },
    observe: trialId => postJson(`${base}/api/audra/tool`, { trialId, call: { tool: "observe_canvas" } }),
    tool: (trialId, call) => postJson(`${base}/api/audra/tool`, { trialId, call }),
    hostRun: (trialId, token) => getJson(`${base}/api/audra/_host/run?trialId=${trialId}&token=${token}`),
    endRound: async () => ({ ok: false, code: "no_rounds", error: "The drawing task has no rounds." }),
    exportBundle: (trialId, token, endedAt, protocol) =>
      postJson(`${base}/api/audra/export`, { trialId, token, endedAt, protocol })
  }),
  mockReplies: strategy => cannedReplies(mockScript, mockGroups[strategy], strategy)
};
