import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTsBundle } from "./loadTsBundle.mjs";

// Validates the item files under data/tasks and the rules that keep an answer
// key away from whoever is solving the task. It passes on an empty repository,
// so it is useful before the real items land as well as after.

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = await loadTsBundle(join(projectRoot, "src/tasks/server/itemStore.ts"), "node");
const macgyver = await loadTsBundle(join(projectRoot, "src/tasks/macgyver/item.ts"));
const cs4 = await loadTsBundle(join(projectRoot, "src/tasks/cs4/item.ts"));

const { loadMacGyverItems, loadCs4Instances } = store;
const { parseMacGyverItem, pilotCompositionErrors, pilotSubsetSize } = macgyver;
const {
  parseCs4Instance,
  cs4Rounds,
  cs4ConstraintStages,
  cs4ConstraintCount,
  participantView: cs4View,
  wordCount
} = cs4;

// ---------------------------------------------------------------------------
// The rounds the pilot runs.

assert.deepEqual([...cs4ConstraintStages], [7, 15, 23], "CS4 runs 7, 15, then 23 constraints");
assert.equal(cs4ConstraintCount, 23, "an instance file carries every constraint the last round uses");

// ---------------------------------------------------------------------------
// Every file on disk parses, and the manifests agree with the files.

const mg = loadMacGyverItems(projectRoot);
assert.deepEqual(mg.errors, [], "MacGyver items and manifest are consistent");

const cs = loadCs4Instances(projectRoot);
assert.deepEqual(cs.errors, [], "CS4 instances and manifest are consistent");

for (const instance of cs.items) {
  const rounds = cs4Rounds(instance);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map(round => round.stage), [7, 15, 23]);
  // Cumulative by construction: each round extends the previous one exactly.
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1].constraints;
    assert.deepEqual(
      rounds[index].constraints.slice(0, previous.length),
      previous,
      `${instance.instanceId}: round ${index + 1} must keep round ${index}'s constraints`
    );
    assert.deepEqual(
      rounds[index].newConstraints,
      rounds[index].constraints.slice(previous.length),
      `${instance.instanceId}: newConstraints must be exactly what the round adds`
    );
  }
}

// ---------------------------------------------------------------------------
// A round never carries the next round's constraints.

const sample = cs.items[0];
if (sample) {
  for (const round of cs4Rounds(sample)) {
    const view = cs4View(sample, round.round);
    assert.equal(view.constraints.length, round.stage);
    assert.equal("constraints" in view, true);
    const serialized = JSON.stringify(view);
    for (const constraint of sample.constraints.slice(round.stage)) {
      assert.equal(
        serialized.includes(constraint),
        false,
        `round ${round.round} must not carry a later constraint`
      );
    }
  }
  // Clamping rather than throwing: a bad round number cannot open a later one.
  assert.equal(cs4View(sample, 0).stage, 7);
  assert.equal(cs4View(sample, 99).stage, 23);
}

// ---------------------------------------------------------------------------
// A MacGyver participant view never carries the answer key.

for (const item of mg.items) {
  const view = macgyver.participantView(item);
  assert.equal("answerKey" in view, false, `${item.itemId}: the view must drop the answer key`);
  const serialized = JSON.stringify(view);
  for (const step of item.answerKey.goldSolution) {
    assert.equal(serialized.includes(step), false, `${item.itemId}: a gold step leaked into the view`);
  }
  if (item.answerKey.unsolvableJustification) {
    assert.equal(serialized.includes(item.answerKey.unsolvableJustification), false);
  }
  assert.equal(serialized.includes(item.answerKey.solvability), false);
}

// ---------------------------------------------------------------------------
// Malformed items are rejected with a reason rather than half-loaded.

const solvable = {
  itemId: "mg-x", source: "official", problem: "p", objects: ["o"],
  answerKey: { solvability: "solvable", solutionType: "unconventional", goldSolution: ["step"] }
};
assert.equal(parseMacGyverItem(solvable).ok, true);
assert.equal(parseMacGyverItem({ ...solvable, answerKey: { ...solvable.answerKey, goldSolution: [] } }).ok, false,
  "a solvable item without a gold solution is rejected");
assert.equal(parseMacGyverItem({ ...solvable, answerKey: { ...solvable.answerKey, solutionType: null } }).ok, false,
  "a solvable item needs conventional / unconventional");
assert.equal(parseMacGyverItem({ ...solvable, objects: [] }).ok, false, "an item needs its objects");
assert.equal(parseMacGyverItem({ ...solvable, itemId: "MG X" }).ok, false, "ids stay url-safe");
assert.equal(
  parseMacGyverItem({ ...solvable, answerKey: { solvability: "unsolvable", solutionType: null, goldSolution: [], unsolvableJustification: "why" } }).ok,
  true, "an unsolvable item carries a justification instead");
assert.equal(
  parseMacGyverItem({ ...solvable, answerKey: { solvability: "unsolvable", solutionType: null, goldSolution: ["step"], unsolvableJustification: "why" } }).ok,
  false, "an unsolvable item must not carry a solution");

const instance = {
  instanceId: "cs4-x", source: "official", instruction: "i", baseStory: "s",
  constraints: Array.from({ length: 23 }, (_, index) => `c${index}`)
};
assert.equal(parseCs4Instance(instance).ok, true);
assert.equal(parseCs4Instance({ ...instance, constraints: instance.constraints.slice(0, 15) }).ok, false,
  "an instance needs all 23 constraints");
assert.equal(
  parseCs4Instance({ ...instance, constraints: [...instance.constraints.slice(0, 22), "c0"] }).ok,
  false, "constraints must not repeat");

// ---------------------------------------------------------------------------
// Readiness, reported rather than asserted: the real items are not in yet.

const composition = mg.pilot.length > 0 ? pilotCompositionErrors(mg.pilot) : [];
const lines = [
  `macgyver: ${mg.items.length} items (${mg.items.filter(i => i.source === "official").length} official), ` +
    `pilot subset ${mg.pilot.length}/${pilotSubsetSize}${composition.length > 0 ? ` — ${composition.join("; ")}` : ""}`,
  `cs4: ${cs.items.length} instances (${cs.items.filter(i => i.source === "official").length} official), ` +
    `pilot subset ${cs.pilot.length}` +
    (sample ? `, base story ${wordCount(sample.baseStory)} words` : "")
];
console.log(lines.join("\n"));
console.log("task item integrity tests passed");
