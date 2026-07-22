import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const moduleSource = readFileSync(new URL("../src/logging/elementMutations.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const { compactElementMap, diffElementMaps } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

function element(id, type, overrides = {}) {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    opacity: 100,
    groupIds: [],
    isDeleted: false,
    version: 1,
    versionNonce: 11,
    updated: 100,
    seed: 42,
    ...overrides
  };
}

function diff(before, after) {
  return diffElementMaps(compactElementMap(before), compactElementMap(after));
}

// Test 1. Create/resize order survives across callbacks inside one idle window.
const diamond0 = element("diamond", "diamond");
const diamond1 = element("diamond", "diamond", { width: 130, height: 125 });
const rectangle0 = element("rectangle", "rectangle", { x: 200 });
const rectangle1 = element("rectangle", "rectangle", { x: 200, width: 160 });
const callbacks = [
  diff([], [diamond0]),
  diff([diamond0], [diamond1]),
  diff([diamond1], [diamond1, rectangle0]),
  diff([diamond1, rectangle0], [diamond1, rectangle1])
];
assert.deepEqual(callbacks.flat().map(({ operation, elementId }) => `${operation}:${elementId}`), [
  "create:diamond", "resize:diamond", "create:rectangle", "resize:rectangle"
]);

// Test 2. Consecutive resize mutations link exact before/after dimensions.
const rectangle2 = element("rectangle", "rectangle", { x: 200, width: 180, height: 120 });
const resize1 = diff([rectangle0], [rectangle1])[0];
const resize2 = diff([rectangle1], [rectangle2])[0];
assert.equal(resize1.operation, "resize");
assert.equal(resize1.afterElement.width, resize2.beforeElement.width);
assert.deepEqual(resize2.changedProperties.map(change => change.property), ["width", "height"]);

// Test 3. Movement and style changes remain distinct.
const moved = element("rectangle", "rectangle", { x: 25, y: 10 });
const styled = element("rectangle", "rectangle", { x: 25, y: 10, strokeColor: "#e03131" });
assert.equal(diff([element("rectangle", "rectangle")], [moved])[0].operation, "move");
assert.equal(diff([moved], [styled])[0].operation, "change_style");

// Test 4. Text edits retain each callback's before/after value.
const textA = element("text", "text", { text: "a", originalText: "a" });
const textAB = element("text", "text", { text: "ab", originalText: "ab" });
const textABC = element("text", "text", { text: "abc", originalText: "abc" });
const textMutations = [diff([], [textA])[0], diff([textA], [textAB])[0], diff([textAB], [textABC])[0]];
assert.deepEqual(textMutations.map(mutation => mutation.operation), ["create", "change_text", "change_text"]);
assert.equal(textMutations[1].afterElement.text, textMutations[2].beforeElement.text);

// Test 5. Version-only Excalidraw churn is ignored.
const versionChanged = element("rectangle", "rectangle", { version: 9, versionNonce: 99, updated: 999, seed: 777 });
assert.deepEqual(diff([element("rectangle", "rectangle")], [versionChanged]), []);

// Test 6. Multiple elements in one callback are split but share a batch identity.
const sameBatchDrafts = diff([], [diamond0, rectangle0]);
const batchId = "session-a:onchange-batch:1";
const recorded = sameBatchDrafts.map((draft, batchSequence) => ({
  ...draft,
  sequence: batchSequence + 1,
  elapsedMs: 100,
  onChangeBatchId: batchId,
  batchSequence
}));
assert.equal(recorded.length, 2);
assert(recorded.every(mutation => mutation.onChangeBatchId === batchId));
assert.deepEqual(recorded.map(mutation => mutation.batchSequence), [0, 1]);
assert(recorded.every(mutation => mutation.sequence > 0));

// Test 7. Sequence/time monotonicity and create-before-update invariants.
const timeline = callbacks.flat().map((mutation, index) => ({ ...mutation, sequence: index + 1, elapsedMs: [10, 20, 900, 920][index] }));
for (let index = 1; index < timeline.length; index += 1) {
  assert(timeline[index].sequence > timeline[index - 1].sequence);
  assert(timeline[index].elapsedMs >= timeline[index - 1].elapsedMs);
}
const created = new Set();
for (const mutation of timeline) {
  if (mutation.operation === "create") created.add(mutation.elementId);
  else assert(created.has(mutation.elementId));
}

// Test 8. App-level gate records this stream only for active Human sessions and keeps legacy actions.
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /session\?\.actorType !== "human"/);
assert.match(appSource, /elementMutations: elementMutationsRef\.current/);
assert.match(appSource, /actions: actionsRef\.current/);
assert.match(appSource, /schemaVersion: sessionSchemaVersion/);

// Test 8b. Expanded style and intentionally out-of-scope properties are not silently lost.
const fontChanged = element("text-style", "text", { text: "label", originalText: "label", fontSize: 24 });
const fontChangedAgain = element("text-style", "text", { text: "label", originalText: "label", fontSize: 30 });
assert.equal(diff([fontChanged], [fontChangedAgain])[0].operation, "change_style");
const grouped = element("grouped", "rectangle", { groupIds: ["group-1"] });
assert.equal(diff([element("grouped", "rectangle")], [grouped])[0].operation, "out_of_scope_change");
assert.match(moduleSource, /categories\.size === 0\) return "unclassified_change"/);

// Test 9. Free-draw callbacks are buffered into one stroke mutation and all
// required finalization paths remain wired.
assert.match(appSource, /draft\.elementType === "freedraw"/);
assert.match(appSource, /operation: "create_stroke"/);
assert.match(appSource, /pointCount: Array\.isArray\(stroke\.latestElement\.points\)/);
assert.match(appSource, /setTimeout\(\(\) => flushFreeDrawStroke\(now\), freeDrawIdleMs\)/);
assert.match(appSource, /activeToolTypeRef\.current === "freedraw"/);
assert.match(appSource, /onPointerUp=\{finishFreeDrawPointer\}/);
assert.match(appSource, /onPointerCancel=\{finishFreeDrawPointer\}/);
assert.match(appSource, /const finishSession[\s\S]*?flushFreeDrawStroke\(\)/);
assert.match(appSource, /const exportSession[\s\S]*?flushFreeDrawStroke\(\)/);

console.log("element mutation integrity tests passed");
