import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsBundle } from "./loadTsBundle.mjs";

// The MacGyver and CS4 engines and the text-trial registry: strict call
// parsing, the atomic edit semantics, the submission guards, round
// progression, and that no observation carries what a solver must not see.

const root = new URL("..", import.meta.url);
const path = relative => new URL(relative, root).pathname;
const readItem = relative => JSON.parse(readFileSync(new URL(relative, root), "utf8"));

const { macgyverAnswerEngine: mg } = await loadTsBundle(path("src/tasks/macgyver/answer.ts"));
const { cs4RevisionEngine: cs4, splitStory, storyText } = await loadTsBundle(path("src/tasks/cs4/revision.ts"));
const mgItems = await loadTsBundle(path("src/tasks/macgyver/item.ts"));
const cs4Items = await loadTsBundle(path("src/tasks/cs4/item.ts"));
const registry = await loadTsBundle(path("src/tasks/agent/textTrialRegistry.ts"));

function applyAll(engine, state, calls) {
  for (const call of calls) {
    const parsed = engine.parseCall(call);
    assert.equal(parsed.ok, true, `parse failed for ${JSON.stringify(call)}: ${parsed.error}`);
    const applied = engine.apply(state, parsed.call);
    assert.equal(applied.ok, true, `apply failed for ${JSON.stringify(call)}: ${applied.error}`);
    state = applied.state;
  }
  return state;
}

function expectRejected(engine, state, call, code) {
  const parsed = engine.parseCall(call);
  if (!parsed.ok) {
    assert.equal(parsed.code, code, `${JSON.stringify(call)} should fail with ${code}`);
    return;
  }
  const applied = engine.apply(state, parsed.call);
  assert.equal(applied.ok, false, `${JSON.stringify(call)} should be rejected`);
  assert.equal(applied.code, code);
}

// --- MacGyver -------------------------------------------------------------------

const official = mgItems.parseMacGyverItem(readItem("data/tasks/macgyver/items/mg-1655.json"));
assert.equal(official.ok, true);
const item = official.value;
const view = mgItems.participantView(item);

// Unknown tools and smuggled fields are rejected, not dropped.
assert.equal(mg.parseCall({ tool: "reveal_answer" }).code, "unsupported_tool");
assert.equal(mg.parseCall({ tool: "add_step", text: "x", answerKey: "y" }).code, "unsupported_field");
assert.equal(mg.parseCall({ tool: "set_judgement", value: "maybe" }).code, "invalid_arguments");
assert.equal(mg.parseCall({ tool: "revise_step", step: "2", text: "x" }).code, "invalid_arguments");

let answer = mg.initial(view);
expectRejected(mg, answer, { tool: "submit_answer" }, "no_judgement");
answer = applyAll(mg, answer, [{ tool: "set_judgement", value: "solvable" }]);
expectRejected(mg, answer, { tool: "submit_answer" }, "no_steps");

// Steps are one unit each; positions shift, and ranges are enforced.
answer = applyAll(mg, answer, [
  { tool: "add_step", text: "Dig a trench." },
  { tool: "add_step", text: "Drape the sheet." },
  { tool: "add_step", text: "Tie the stakes together.", position: 2 },
  { tool: "revise_step", step: 1, text: "Dig a shallow   trench around the crops." }
]);
assert.deepEqual(answer.steps, ["Dig a shallow trench around the crops.", "Tie the stakes together.", "Drape the sheet."]);
expectRejected(mg, answer, { tool: "delete_step", step: 4 }, "step_out_of_range");
expectRejected(mg, answer, { tool: "add_step", text: "x", position: 5 }, "step_out_of_range");
expectRejected(mg, answer, { tool: "add_step", text: "   " }, "empty_text");
expectRejected(mg, answer, { tool: "add_step", text: "x".repeat(601) }, "text_too_long");
answer = applyAll(mg, answer, [{ tool: "delete_step", step: 2 }]);
assert.deepEqual(answer.steps, ["Dig a shallow trench around the crops.", "Drape the sheet."]);

// The observation is the problem verbatim plus the answer - never the key.
{
  const seen = mg.observation(answer);
  assert.ok(seen.includes(item.problem));
  assert.ok(seen.includes("1. Dig a shallow trench around the crops."));
  for (const step of item.answerKey.goldSolution) assert.equal(seen.includes(step), false, "a gold step leaked");
  assert.equal(JSON.stringify(answer).includes(item.answerKey.goldSolution[0]), false, "the key never enters the state");
  assert.equal(JSON.stringify(mg.status(answer)).includes("unconventional"), false);
}

// A submitted answer is final.
answer = applyAll(mg, answer, [{ tool: "submit_answer" }]);
assert.equal(mg.status(answer).complete, true);
expectRejected(mg, answer, { tool: "add_step", text: "late" }, "already_submitted");
assert.deepEqual(mg.finalFiles(answer).map(file => file.name), ["answer.md", "answer.json"]);

// An unsolvable answer needs a justification instead of steps.
{
  let unsolvable = applyAll(mg, mg.initial(view), [{ tool: "set_judgement", value: "unsolvable" }]);
  expectRejected(mg, unsolvable, { tool: "submit_answer" }, "no_justification");
  unsolvable = applyAll(mg, unsolvable, [
    { tool: "set_justification", text: "Nothing on the list can hold the weight." },
    { tool: "submit_answer" }
  ]);
  assert.equal(mg.status(unsolvable).complete, true);
}

// --- CS4 ------------------------------------------------------------------------

const parsedInstance = cs4Items.parseCs4Instance(readItem("data/tasks/cs4/items/cs4-dev-fixture-01.json"));
assert.equal(parsedInstance.ok, true);
const instance = parsedInstance.value;

// Splitting into sentences loses nothing.
{
  const units = splitStory(instance.baseStory);
  const normalized = instance.baseStory
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  assert.equal(storyText(units), normalized);
  assert.ok(units.length > 4);
}

assert.equal(cs4.parseCall({ tool: "rewrite_story", text: "x" }).code, "unsupported_tool");
assert.equal(cs4.parseCall({ tool: "replace_sentence", sentence: 1, text: "x", round: 3 }).code, "unsupported_field");
assert.equal(cs4.parseCall({ tool: "insert_sentence", after: 1, text: "x", new_paragraph: "yes" }).code, "invalid_arguments");

let story = cs4.initial(instance);
const initialCount = story.units.length;

// Sentence numbers refer to the story as it is when each edit runs.
story = applyAll(cs4, story, [
  { tool: "replace_sentence", sentence: 1, text: "A new opening." },
  { tool: "insert_sentence", after: 1, text: "A second sentence." },
  { tool: "delete_sentence", sentence: 3 }
]);
assert.equal(story.units[0].text, "A new opening.");
assert.equal(story.units[1].text, "A second sentence.");
assert.equal(story.units.length, initialCount);
expectRejected(cs4, story, { tool: "delete_sentence", sentence: initialCount + 1 }, "sentence_out_of_range");
expectRejected(cs4, story, { tool: "insert_sentence", after: -1, text: "x" }, "sentence_out_of_range");
expectRejected(cs4, story, { tool: "replace_sentence", sentence: 1, text: "" }, "empty_text");

// Paragraphs survive edits.
{
  let edited = applyAll(cs4, story, [{ tool: "insert_sentence", after: 2, text: "Break here.", new_paragraph: true }]);
  assert.equal(edited.units[2].paragraphStart, true);
  assert.ok(storyText(edited.units).includes("\n\nBreak here."));
  edited = applyAll(cs4, edited, [{ tool: "delete_sentence", sentence: 3 }]);
  assert.equal(edited.units[2].paragraphStart, true, "deleting a paragraph's first sentence keeps the paragraph");

  const joined = applyAll(cs4, story, [{ tool: "insert_sentence", after: 0, text: "Before." }]);
  assert.ok(storyText(joined.units).startsWith("Before. A new opening."), "inserting at 0 joins the first paragraph");

  const tiny = cs4.initial({ ...instance, baseStory: "Only one." });
  expectRejected(cs4, tiny, { tool: "delete_sentence", sentence: 1 }, "story_would_be_empty");
}

// Round 1 shows the first seven constraints and nothing later.
{
  const seen = cs4.observation(story);
  assert.ok(seen.startsWith("Round 1 of 3."));
  for (const constraint of instance.constraints.slice(0, 7)) assert.ok(seen.includes(constraint));
  for (const constraint of instance.constraints.slice(7)) {
    assert.equal(seen.includes(constraint), false, "round 1 must not show a later constraint");
  }
  assert.ok(seen.includes("[1] A new opening."));
}

// Submitting carries the story into round 2, where the new constraints are marked.
story = applyAll(cs4, story, [{ tool: "submit_round" }]);
assert.equal(cs4.status(story).round, 2);
{
  const seen = cs4.observation(story);
  assert.ok(seen.startsWith("Round 2 of 3."));
  for (const constraint of instance.constraints.slice(7, 15)) assert.ok(seen.includes(`NEW: ${constraint}`));
  for (const constraint of instance.constraints.slice(15)) assert.equal(seen.includes(constraint), false);
  assert.equal(story.units[0].text, "A new opening.");
}

// The protocol can end a round on time; the next round still runs.
{
  const ended = cs4.endRound(story, "time_limit");
  assert.equal(ended.ok, true);
  assert.equal(ended.eventType, "round_ended");
  story = ended.state;
}
assert.equal(cs4.status(story).round, 3);
story = applyAll(cs4, story, [{ tool: "submit_round" }]);
assert.equal(cs4.status(story).complete, true);
expectRejected(cs4, story, { tool: "replace_sentence", sentence: 1, text: "late" }, "already_complete");
assert.equal(cs4.endRound(story, "time_limit").ok, false);
assert.deepEqual(
  story.results.map(result => [result.round, result.stage, result.endedBy]),
  [[1, 7, "submitted"], [2, 15, "time_limit"], [3, 23, "submitted"]]
);
assert.deepEqual(
  cs4.finalFiles(story).map(file => file.name),
  ["story_round1.txt", "story_round2.txt", "story_round3.txt", "story_final.txt", "rounds.json"]
);

// --- registry ---------------------------------------------------------------------

{
  const record = registry.createTextTrial({
    engine: cs4,
    initialState: cs4.initial(instance),
    taskId: cs4.taskId,
    itemId: instance.instanceId,
    itemSource: instance.source,
    actorId: "agent-1"
  });
  const bad = registry.executeTextToolCall(record, { tool: "delete_sentence", sentence: 999 }, 5);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "sentence_out_of_range");
  assert.equal(record.events.length, 0, "a rejected call leaves no event");
  assert.equal(record.rejections.length, 1, "but is recorded as a rejection");

  const good = registry.executeTextToolCall(record, { tool: "replace_sentence", sentence: 1, text: "Changed." }, 10);
  assert.equal(good.ok, true);
  assert.equal(good.revision, 1);
  assert.ok(good.observation.text.includes("[1] Changed."));

  const end = registry.endTextRound(record, "time_limit", 20);
  assert.equal(end.ok, true);
  assert.equal(end.status.round, 2);
  assert.deepEqual(
    record.events.map(event => [event.eventIndex, event.actorType, event.eventType, event.round]),
    [[0, "agent", "sentence_replaced", 1], [1, "system", "round_ended", 1]],
    "a round ended by the protocol is a system event, not the actor's"
  );

  const single = registry.createTextTrial({
    engine: mg,
    initialState: mg.initial(view),
    taskId: mg.taskId,
    itemId: item.itemId,
    itemSource: item.source,
    actorId: "agent-2"
  });
  assert.equal(registry.endTextRound(single, "time_limit", 1).code, "no_rounds");
}

console.log("text task engine integrity tests passed");
