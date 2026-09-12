import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsBundle } from "./loadTsBundle.mjs";
import { extractToolCallBatch } from "./audraToolCallParser.mjs";
import { driverDefaults, resolveOptions, runTrial } from "./agentDriver.mjs";
import { mockClient } from "./agentModelClients.mjs";
import { formatDuration, parseReply, strategyNames, systemPromptFor, userTextFor } from "./agentStrategies.mjs";
import { taskAdapter, taskNames } from "./agentTasks/index.mjs";

// The strategy loop, for every task: the three protocols, the time limit, per
// round clocks, and what a run records. Every endpoint is replaced by an
// in-process version running the same parser and engine the server runs.

const root = new URL("..", import.meta.url);
const path = relative => new URL(relative, root).pathname;
const readItem = relative => JSON.parse(readFileSync(new URL(relative, root), "utf8"));

const audra = await loadTsBundle(path("src/audra/index.ts"));
const registry = await loadTsBundle(path("src/tasks/agent/textTrialRegistry.ts"));
const { macgyverAnswerEngine } = await loadTsBundle(path("src/tasks/macgyver/answer.ts"));
const { cs4RevisionEngine, storyText } = await loadTsBundle(path("src/tasks/cs4/revision.ts"));
const mgItems = await loadTsBundle(path("src/tasks/macgyver/item.ts"));
const cs4Items = await loadTsBundle(path("src/tasks/cs4/item.ts"));

const mgItem = mgItems.parseMacGyverItem(readItem("data/tasks/macgyver/items/mg-dev-fixture-01.json")).value;
const cs4Instance = cs4Items.parseCs4Instance(readItem("data/tasks/cs4/items/cs4-dev-fixture-01.json")).value;

function audraApi() {
  const trials = new Map();
  const api = {
    trials,
    async createTrial(body) {
      const trialId = `trial-${trials.size + 1}`;
      const state = audra.createTrialState({
        sessionId: "session-test", trialId, stimulusId: body.stimulusId, actorType: "agent", actorId: body.actorId
      });
      trials.set(trialId, { state, strokeSequence: 0, clockMs: 0, observations: 0, agentRun: body.agentRun });
      return { ok: true, trialId, renderToken: "token", totalRounds: 1 };
    },
    async tool(trialId, raw) {
      const trial = trials.get(trialId);
      const status = () => ({ description: trial.state.description, submitted: trial.state.submittedAtMs != null });
      const parsed = audra.parseAgentToolCall(raw);
      if (!parsed.ok) return { ok: false, code: parsed.code, error: parsed.error, status: status() };
      if (parsed.call.tool === "observe_canvas") {
        trial.observations += 1;
        return { ok: true, revision: trial.state.revision, status: status(), image: { base64: "" } };
      }
      trial.clockMs += 10;
      const draft = audra.toEventDraft(parsed.call, {
        sessionId: "session-test", trialId, stimulusId: trial.state.stimulusId, actorId: trial.state.actorId,
        timestampMs: trial.clockMs, strokeSequence: trial.strokeSequence + 1
      });
      const result = audra.applyEvent(trial.state, draft);
      if (!result.ok) return { ok: false, code: result.code, error: result.error, status: status() };
      if (parsed.call.tool === "draw_stroke" || parsed.call.tool === "erase_stroke") trial.strokeSequence += 1;
      trial.state = result.state;
      return { ok: true, revision: trial.state.revision, status: status(), image: { base64: `revision-${trial.state.revision}` } };
    },
    async hostRun() {
      return { ok: true, agentRun: null, runStats: {}, rejections: [] };
    },
    async endRound() {
      return { ok: false, code: "no_rounds", error: "no rounds" };
    },
    async exportBundle() {
      throw new Error("export is disabled in these tests");
    }
  };
  api.observe = trialId => api.tool(trialId, { tool: "observe_canvas" });
  return api;
}

function textApi(engine, initial, meta) {
  const trials = new Map();
  return {
    trials,
    async createTrial(body) {
      const record = registry.createTextTrial({
        engine, initialState: initial(), taskId: engine.taskId, itemId: meta.itemId, itemSource: meta.source,
        actorId: body.actorId, agentRun: body.agentRun
      });
      trials.set(record.trialId, record);
      return {
        ok: true, trialId: record.trialId, renderToken: record.renderToken, itemId: meta.itemId,
        totalRounds: registry.textTrialStatus(record).totalRounds
      };
    },
    async observe(trialId) {
      return { ok: true, ...registry.observeTextTrial(trials.get(trialId)) };
    },
    async tool(trialId, call) {
      return registry.executeTextToolCall(trials.get(trialId), call, 0);
    },
    async endRound(trialId, _token, cause) {
      return registry.endTextRound(trials.get(trialId), cause, 0);
    },
    async hostRun() {
      return { ok: true, agentRun: null, runStats: {}, rejections: [] };
    },
    async exportBundle() {
      throw new Error("export is disabled in these tests");
    }
  };
}

const apiFor = {
  audra: audraApi,
  macgyver: () => textApi(
    macgyverAnswerEngine,
    () => macgyverAnswerEngine.initial(mgItems.participantView(mgItem)),
    { itemId: mgItem.itemId, source: mgItem.source }
  ),
  cs4: () => textApi(
    cs4RevisionEngine,
    () => cs4RevisionEngine.initial(cs4Instance),
    { itemId: cs4Instance.instanceId, source: cs4Instance.source }
  )
};

async function run(taskName, strategy, { replies, model, overrides = {}, now, api: givenApi } = {}) {
  const task = taskAdapter(taskName);
  const api = givenApi ?? apiFor[taskName]();
  const options = resolveOptions({ ...driverDefaults, task: taskName, provider: "mock", strategy, export: "false", ...overrides });
  const summary = await runTrial(options, {
    task,
    api,
    model: model ?? mockClient(replies ?? task.mockReplies(strategy)),
    log: () => {},
    now
  });
  return { summary, trial: api.trials.get(summary.trialId) };
}

/**
 * A timed run on a fake clock: each model call advances it by `stepMs`, so
 * deadlines are tested without waiting.
 */
async function runTimed(taskName, strategy, replyFor, { timeLimitSec = 100, finalizeWindowSec = 30, stepMs = 15_000, overrides = {}, api } = {}) {
  const clock = { t: 1_000_000 };
  const prompts = [];
  const model = {
    async call({ userText, turn }) {
      prompts.push(userText);
      clock.t += stepMs;
      const content = replyFor(turn);
      if (content instanceof Error) throw content;
      return {
        content,
        reasoning: { kind: "raw", reasoningContent: null, thinkBlocks: [`turn ${turn}`], channels: ["think_tags"] },
        finishReason: "stop", usage: null, latencyMs: stepMs, servedBy: "mock-script", fallbackRan: false
      };
    }
  };
  const result = await run(taskName, strategy, {
    model,
    api,
    now: () => clock.t,
    overrides: { timeLimitSec, finalizeWindowSec, ...overrides }
  });
  return { ...result, prompts };
}

function canvasOf(trial) {
  return trial.state.events.map(event => ({
    eventType: event.eventType,
    points: event.payload.points ?? null,
    width: event.payload.width ?? null,
    description: event.payload.description ?? null
  }));
}

const stroke = (x, y) => ({ tool: "draw_stroke", points: [{ x, y }, { x: x + 40, y: y + 40 }] });
const finish = [{ tool: "set_description", text: "a test" }, { tool: "submit_task" }];
const replace = text => ({ tool: "replace_sentence", sentence: 1, text });

// --- durations --------------------------------------------------------------------

assert.equal(formatDuration(300_000), "5 min");
assert.equal(formatDuration(287_000), "4 min 47 s");
assert.equal(formatDuration(47_000), "47 s");
assert.equal(formatDuration(-5), "0 s");

// --- reply parsing ------------------------------------------------------------------

{
  const result = extractToolCallBatch(JSON.stringify({ calls: [stroke(10, 10), { tool: "undo_last" }] }));
  assert.equal(result.ok, true);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.repairs, []);
}
{
  const result = extractToolCallBatch(JSON.stringify({ calls: [stroke(1, 1), { tool: "draw_stroke" }, stroke(2, 2)] }));
  assert.equal(result.calls.length, 1, "parsing stops at the first unreadable call");
  assert.equal(result.invalidCall.index, 1);
}
for (const reply of ['{"calls":[]}', '{"plan":"draw"}', "no json at all"]) {
  assert.equal(extractToolCallBatch(reply).ok, false, `expected failure for: ${reply}`);
}
for (const taskName of taskNames) {
  // Forced single move on every task: a reply holding several calls is unreadable.
  const task = taskAdapter(taskName);
  assert.equal(parseReply("single", task, '{"calls":[{"tool":"x"}]}').ok, false);
}
{
  // Text-task replies: aliases and numeric strings are repaired and counted;
  // an undeclared field never reaches the server.
  const task = taskAdapter("macgyver");
  const result = parseReply("single", task, '{"action":"revise_step","step":"2","text":"x","answerKey":"y"}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.calls[0], { tool: "revise_step", step: 2, text: "x" });
  assert.ok(result.repairs.includes("aliased_tool_key"));
  assert.ok(result.repairs.includes("coerced_numeric_string"));
}

// --- prompts differ only in the protocol --------------------------------------------

for (const taskName of taskNames) {
  const task = taskAdapter(taskName);
  for (const timing of [{}, { timeLimitMs: 300_000, finalizeWindowMs: 60_000 }]) {
    const shared = task.taskPrompt(timing);
    for (const strategy of strategyNames) {
      const prompt = systemPromptFor(strategy, task, timing);
      assert.ok(prompt.startsWith(shared), `${taskName}/${strategy} must share the task text verbatim`);
      assert.ok(!prompt.includes('"thought"'), `${taskName}/${strategy} must not request a thought field by default`);
      assert.ok(systemPromptFor(strategy, task, { ...timing, promptedThought: true }).includes('"thought"'));
      assert.ok(!/\b\d:\d\d\b/.test(prompt), "durations are written in words, never as m:ss");
    }
    assert.ok(!systemPromptFor("single", task, timing).includes('"calls"'));
    assert.equal(new Set(strategyNames.map(strategy => systemPromptFor(strategy, task, timing))).size, 3);
  }
  const timed = { timeLimitMs: 300_000, finalizeWindowMs: 60_000 };
  assert.ok(task.taskPrompt(timed).includes("5 min"));
  assert.ok(!task.taskPrompt({}).includes("Time limit"));
  for (const strategy of ["single", "multi"]) {
    assert.ok(systemPromptFor(strategy, task, timed).includes(`${task.vocab.submitTool} is refused`));
  }
  assert.ok(!systemPromptFor("one-shot", task, timed).includes("is refused"));
  assert.ok(systemPromptFor("one-shot", task, timed).includes("a later reply is not carried out"));
}
assert.ok(taskAdapter("cs4").taskPrompt({ timeLimitMs: 300_000 }).includes("5 min per round"));
assert.ok(systemPromptFor("multi", taskAdapter("cs4"), { timeLimitMs: 300_000, finalizeWindowMs: 60_000 }).includes("of each round"));
{
  const task = taskAdapter("audra");
  const timing = { timeLimitMs: 300_000, finalizeWindowMs: 60_000 };
  const early = userTextFor("multi", task, { history: [], elapsedMs: 61_000, ...timing });
  assert.ok(early.startsWith("Time: 1 min 1 s elapsed of 5 min (3 min 59 s remaining)."));
  assert.ok(early.includes("submit_task is not accepted yet"));
  assert.ok(userTextFor("multi", task, { history: [], elapsedMs: 250_000, ...timing }).includes("Time is almost up"));
  assert.ok(userTextFor("one-shot", task, { history: [], ...timing }).startsWith("You have 5 min remaining."));
  const cs4Text = userTextFor("single", taskAdapter("cs4"), { history: [], observationText: "Round 1 of 3.", ...timing });
  assert.ok(cs4Text.includes("of this round") && cs4Text.includes("Round 1 of 3."));
}

// --- the three strategies on every task, untimed ------------------------------------

const expectedCalls = {
  audra: { single: 7, multi: 3, "one-shot": 1 },
  macgyver: { single: 7, multi: 3, "one-shot": 1 },
  cs4: { single: 12, multi: 6, "one-shot": 3 }
};
const runs = {};
for (const taskName of taskNames) {
  runs[taskName] = {};
  for (const strategy of strategyNames) {
    const result = await run(taskName, strategy);
    runs[taskName][strategy] = result;
    const { summary, trial } = result;
    const label = `${taskName}/${strategy}`;
    assert.equal(summary.complete, true, `${label} completes`);
    assert.equal(summary.endedBy, "submitted", label);
    assert.equal(summary.timeLimitSec, 0, "mock runs are untimed unless a limit is given");
    assert.equal(summary.modelCalls, expectedCalls[taskName][strategy], `${label} model calls`);
    assert.equal(summary.calls.rejected, 0, label);
    assert.deepEqual(summary.driverAssistance, { parseRepairs: 0, parseFailures: 0 }, label);
    assert.deepEqual(summary.reasoningTrace.kinds, ["raw"], label);
    assert.equal(summary.reasoningTrace.repliesWithTrace, summary.modelCalls, label);
    assert.equal(trial.agentRun.strategy, strategy, `${label} records its strategy`);
  }
}

// Each strategy drives the same final artifact; only the protocol differs.
assert.deepEqual(canvasOf(runs.audra.multi.trial), canvasOf(runs.audra.single.trial));
assert.deepEqual(canvasOf(runs.audra["one-shot"].trial), canvasOf(runs.audra.single.trial));
for (const strategy of ["multi", "one-shot"]) {
  assert.deepEqual(runs.macgyver[strategy].trial.state.steps, runs.macgyver.single.trial.state.steps);
  assert.equal(
    storyText(runs.cs4[strategy].trial.state.units),
    storyText(runs.cs4.single.trial.state.units)
  );
}
assert.deepEqual(runs.macgyver.single.summary.finalAnswer, { judgement: "solvable", stepCount: 4, hasJustification: false });
for (const strategy of strategyNames) {
  assert.deepEqual(runs.cs4[strategy].summary.rounds.map(entry => entry.endedBy), ["submitted", "submitted", "submitted"]);
}
assert.equal(runs.audra["one-shot"].trial.observations, 1, "one-shot never sees the canvas again");
assert.equal(runs.audra.single.summary.reasoningTrace.artifactActionsPerTracedReply, 0.714);
assert.equal(runs.audra["one-shot"].summary.reasoningTrace.artifactActionsPerTracedReply, 5);

// Revision ranges tie each reply to the changes it produced.
{
  const turns = runs.cs4.multi.summary.turns;
  assert.equal(turns[0].revisionBefore, 0);
  for (let index = 1; index < turns.length; index += 1) {
    assert.equal(turns[index].revisionBefore, turns[index - 1].revisionAfter);
  }
}

// Every real provider defaults to the five-minute limit.
assert.equal(resolveOptions({ ...driverDefaults, provider: "openai", strategy: "single" }).timeLimitSec, 300);
assert.equal(resolveOptions({ ...driverDefaults, task: "cs4", provider: "local", strategy: "one-shot" }).timeLimitSec, 300);
assert.throws(() => resolveOptions({ ...driverDefaults, provider: "openai", strategy: "single", finalizeWindowSec: 300 }));
assert.throws(() => resolveOptions({ ...driverDefaults, task: "chess", provider: "mock" }));

// --- execution rules ----------------------------------------------------------------

{
  // Execution stops at the first rejected call; the agent replans on a fresh view.
  const outOfBounds = { tool: "draw_stroke", points: [{ x: 5000, y: 10 }, { x: 5100, y: 20 }] };
  const { summary, trial } = await run("audra", "multi", {
    replies: [JSON.stringify({ calls: [stroke(100, 100), outOfBounds, stroke(300, 300)] }), JSON.stringify({ calls: finish })]
  });
  assert.deepEqual(summary.turns[0].calls.map(call => call.status), ["accepted", "rejected", "skipped"]);
  assert.equal(summary.turns[0].calls[2].skipReason, "earlier_call_rejected");
  assert.equal(trial.state.events.filter(event => event.eventType === "draw_stroke").length, 1);
  assert.equal(summary.modelCalls, 2);
}
{
  // An unreadable call runs the calls before it and drops the ones after it.
  const { summary } = await run("audra", "multi", {
    replies: [JSON.stringify({ calls: [stroke(100, 100), { tool: "draw_stroke" }, stroke(300, 300)] }), JSON.stringify({ calls: finish })]
  });
  assert.deepEqual(summary.turns[0].calls.map(call => call.status), ["accepted", "unreadable"]);
  assert.equal(summary.turns[0].calls[1].droppedFollowingCalls, 1);
}
{
  // Calls after the finishing call are not sent, on any task.
  const { summary } = await run("audra", "multi", { replies: [JSON.stringify({ calls: [stroke(100, 100), ...finish, stroke(300, 300)] })] });
  assert.equal(summary.turns[0].calls.at(-1).skipReason, "after_submit");
  const cs4Run = await run("cs4", "multi", {
    replies: [
      JSON.stringify({ calls: [replace("One."), { tool: "submit_round" }, replace("Meant for round 1.")] }),
      JSON.stringify({ calls: [{ tool: "submit_round" }] }),
      JSON.stringify({ calls: [{ tool: "submit_round" }] })
    ]
  });
  assert.equal(cs4Run.summary.turns[0].calls[2].skipReason, "after_submit", "an edit after submit_round never lands in the next round");
  assert.equal(cs4Run.summary.complete, true);
}
{
  // The per-reply call cap holds.
  const { summary } = await run("audra", "multi", {
    replies: [JSON.stringify({ calls: [stroke(100, 100), stroke(200, 200), stroke(300, 300)] }), JSON.stringify({ calls: finish })],
    overrides: { maxCallsPerTurn: 2 }
  });
  assert.equal(summary.turns[0].calls[2].skipReason, "call_limit");
}
{
  // A server-side refusal is recorded and the agent carries on.
  const { summary } = await run("macgyver", "single", {
    replies: [
      JSON.stringify({ tool: "submit_answer" }),
      JSON.stringify({ tool: "set_judgement", value: "solvable" }),
      JSON.stringify({ tool: "add_step", text: "Bend the hanger into a hook." }),
      JSON.stringify({ tool: "submit_answer" })
    ]
  });
  assert.equal(summary.turns[0].calls[0].code, "no_judgement");
  assert.equal(summary.complete, true);
  assert.equal(summary.modelCalls, 4);
}

// One-shot: only an unreadable reply is resampled; nothing is completed for the model.
{
  const full = taskAdapter("audra").mockReplies("one-shot")[0];
  const retried = await run("audra", "one-shot", { replies: ["I will draw a lantern.", full] });
  assert.equal(retried.summary.modelCalls, 2);
  assert.equal(retried.summary.driverAssistance.parseFailures, 1);
  assert.equal(retried.summary.complete, true);

  const strict = await run("audra", "one-shot", { replies: ["I will draw a lantern.", full], overrides: { parseRetries: 0 } });
  assert.equal(strict.summary.modelCalls, 1);
  assert.equal(strict.summary.endedBy, "no_readable_reply");

  const unfinished = await run("audra", "one-shot", { replies: [JSON.stringify({ calls: [stroke(100, 100)] }), full] });
  assert.equal(unfinished.summary.modelCalls, 1);
  assert.equal(unfinished.summary.complete, false);
  assert.equal(unfinished.summary.endedBy, "reply_without_submit");
}

// --- time limit ---------------------------------------------------------------------
// Limit 100 s, final window 30 s: the finishing call is accepted from 70 s on.

{
  // An early submit is refused and the agent keeps working; it finishes in the window.
  const byTurn = {
    1: JSON.stringify(stroke(100, 100)),
    2: JSON.stringify({ tool: "submit_task" }),
    3: JSON.stringify(stroke(200, 200)),
    4: JSON.stringify(stroke(300, 300)),
    5: JSON.stringify(finish[0]),
    6: JSON.stringify(finish[1])
  };
  const { summary, prompts } = await runTimed("audra", "single", turn => byTurn[turn]);
  assert.equal(summary.endedBy, "submitted");
  assert.equal(summary.calls.deferredSubmits, 1);
  assert.equal(summary.turns[1].calls[0].skipReason, "too_early");
  assert.ok(prompts[0].includes("submit_task is not accepted yet"));
  assert.ok(prompts[2].includes("submit_task -> refused"), "the refusal is shown to the agent");
  assert.ok(prompts[5].includes("Time is almost up"));
}
{
  // An agent that never submits keeps going until the limit, then the run ends.
  const { summary, trial } = await runTimed("audra", "multi", () => JSON.stringify({ calls: [stroke(100, 100)] }), { stepMs: 20_000 });
  assert.equal(summary.endedBy, "time_limit");
  assert.equal(summary.modelCalls, 5);
  for (const turn of summary.turns) assert.ok(turn.startedAtMs < 100_000, "no model call starts after the limit");
  assert.equal(summary.turns.at(-1).late, true);
  assert.equal(summary.turns.at(-1).calls[0].skipReason, "time_limit", "a late reply is not carried out");
  assert.equal(trial.state.events.filter(event => event.eventType === "draw_stroke").length, 4);
}
{
  // One-shot may finish whenever its reply lands, but not after the limit.
  const full = taskAdapter("audra").mockReplies("one-shot")[0];
  assert.equal((await runTimed("audra", "one-shot", () => full, { stepMs: 10_000 })).summary.complete, true);
  const tooLate = await runTimed("audra", "one-shot", () => full, { stepMs: 120_000 });
  assert.equal(tooLate.summary.endedBy, "time_limit");
  assert.equal(tooLate.trial.state.events.length, 0);
}
{
  // A failed model request costs a turn, not the trial; repeated failures end it.
  const recovered = await runTimed(
    "audra",
    "multi",
    turn => (turn === 1 ? new Error("rate limited") : turn >= 5 ? JSON.stringify({ calls: finish }) : JSON.stringify({ calls: [stroke(100, 100)] }))
  );
  assert.equal(recovered.summary.modelErrors, 1);
  assert.equal(recovered.summary.complete, true);
  const failing = await runTimed("audra", "single", () => new Error("invalid api key"), { stepMs: 1_000 });
  assert.equal(failing.summary.endedBy, "model_errors");
  assert.equal(failing.summary.modelCalls, 3);
}

// Rounds: the clock is per round, and a round that runs out is ended by the protocol.
{
  const { summary, trial } = await runTimed("cs4", "multi", () => JSON.stringify({ calls: [replace("Still working.")] }), { stepMs: 20_000 });
  assert.equal(summary.endedBy, "time_limit");
  assert.equal(summary.complete, true, "all three rounds are closed");
  assert.deepEqual(summary.rounds.map(entry => entry.endedBy), ["time_limit", "time_limit", "time_limit"]);
  assert.equal(summary.modelCalls, 15, "each round gets its own full clock");
  assert.equal(trial.events.filter(event => event.actorType === "system" && event.eventType === "round_ended").length, 3);
}
{
  // A submit_round before the round's window is refused; a later one advances,
  // and the next round starts a fresh clock.
  const byTurn = turn => (turn === 1 || turn === 5 ? JSON.stringify({ tool: "submit_round" }) : JSON.stringify(replace(`Edit ${turn}.`)));
  const { summary, prompts } = await runTimed("cs4", "single", byTurn);
  assert.equal(summary.turns[0].calls[0].skipReason, "too_early");
  assert.deepEqual(summary.rounds.map(entry => entry.endedBy), ["submitted", "time_limit", "time_limit"]);
  assert.ok(prompts[5].startsWith("Time: 0 s elapsed of 1 min 40 s of this round"), prompts[5].slice(0, 80));
}
{
  // One-shot gets one reply per round; a reply that does not submit still ends its round.
  const { summary } = await runTimed("cs4", "one-shot", () => JSON.stringify({ calls: [replace("One pass.")] }), { stepMs: 5_000 });
  assert.equal(summary.modelCalls, 3);
  assert.deepEqual(summary.rounds.map(entry => entry.endedBy), ["reply_without_submit", "reply_without_submit", "reply_without_submit"]);
  assert.equal(summary.endedBy, "reply_without_submit");
}

// A single-move reply that breaks the rule is refused with a reason the agent can act on.
{
  const task = taskAdapter("macgyver");
  const lines = parseReply("single", task, '{"tool":"set_judgement","value":"solvable"}\n{"tool":"submit_answer"}');
  assert.equal(lines.ok, false);
  assert.equal(lines.error, "The reply held 2 actions; send exactly one action per reply.");
  const listed = parseReply("single", task, '{"calls":[{"tool":"submit_answer"},{"tool":"submit_answer"}]}');
  assert.equal(listed.error, "The reply held a list of 2 actions; send exactly one action per reply.");
  const braces = parseReply("single", task, '{"tool":"add_step","text":"use the {curly} bracket"}');
  assert.equal(braces.ok, true, "braces inside a string are not a second action");

  // Refused, not trimmed - and counted, so compliance can be reported per model.
  const { summary } = await run("macgyver", "single", {
    replies: [
      '{"tool":"set_judgement","value":"solvable"}\n{"tool":"add_step","text":"a"}',
      "no json at all",
      JSON.stringify({ tool: "set_judgement", value: "solvable" }),
      JSON.stringify({ tool: "add_step", text: "a" }),
      JSON.stringify({ tool: "submit_answer" })
    ]
  });
  assert.equal(summary.ruleViolations, 1, "only the multi-action reply is a rule violation");
  assert.equal(summary.driverAssistance.parseFailures, 2);
  assert.equal(summary.turns[0].parseCode, "multiple_actions");
  assert.equal(summary.complete, true);
}

// Several batches in one reply are joined in order under multi and one-shot,
// and the repair is counted; under single they stay a refusal.
{
  const task = taskAdapter("macgyver");
  const reply =
    '{"calls":[{"tool":"set_judgement","value":"solvable"},{"tool":"add_step","text":"a"}]}\n' +
    '{"calls":[{"tool":"revise_step","step":1,"text":"b"}]}\n{"calls":[{"tool":"submit_answer"}]}';
  for (const strategy of ["multi", "one-shot"]) {
    const merged = parseReply(strategy, task, reply);
    assert.equal(merged.ok, true, strategy);
    assert.deepEqual(merged.calls.map(call => call.tool), ["set_judgement", "add_step", "revise_step", "submit_answer"]);
    assert.ok(merged.repairs.includes("merged_call_batches"));
  }
  assert.equal(parseReply("single", task, reply).ok, false);
  assert.equal(parseReply("multi", task, '{"calls":[{"tool":"submit_answer"}]}\n{"note":"done"}').ok, false,
    "an object that is neither a batch nor a call is not merged");
  const { summary } = await run("macgyver", "multi", { replies: [reply] });
  assert.equal(summary.complete, true);
  assert.equal(summary.driverAssistance.parseRepairs, 1);
}

// A server that loses the trial (a dev-server restart) ends the run with the
// reason instead of throwing it away.
{
  const api = apiFor.macgyver();
  const realTool = api.tool;
  let toolCalls = 0;
  api.tool = async (trialId, call) => ((toolCalls += 1) > 2 ? { ok: false, error: "Unknown trial." } : realTool(trialId, call));
  const { summary } = await run("macgyver", "single", { api });
  assert.equal(summary.endedBy, "trial_lost");
  assert.equal(summary.complete, false);
  assert.equal(summary.modelCalls, 3);
  assert.equal(summary.turns.at(-1).calls[0].skipReason ?? summary.turns.at(-1).calls[0].status, "rejected");

  const cs4Api = apiFor.cs4();
  cs4Api.endRound = async () => ({ ok: false, error: "Unknown trial." });
  const lostRound = await runTimed("cs4", "multi", () => JSON.stringify({ calls: [replace("Still here.")] }), {
    stepMs: 20_000,
    api: cs4Api
  });
  assert.equal(lostRound.summary.endedBy, "server_error");
  assert.equal(lostRound.summary.modelCalls, 5);
}

// A call that outlasts its own timeout means the host was suspended; the run says so.
{
  const { summary } = await runTimed(
    "macgyver",
    "multi",
    () => JSON.stringify({ calls: [{ tool: "set_judgement", value: "solvable" }] }),
    { stepMs: 200_000 }
  );
  assert.equal(summary.hostStalls, 1);
  assert.equal(summary.turns[0].stalled, true);
  const normal = await runTimed("macgyver", "multi", () => JSON.stringify({ calls: [{ tool: "set_judgement", value: "solvable" }] }), { stepMs: 20_000 });
  assert.equal(normal.summary.hostStalls, 0);
}

console.log("agent strategy integrity tests passed");
