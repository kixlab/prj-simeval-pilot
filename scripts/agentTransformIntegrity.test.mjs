import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function importTypeScriptModule(relativeUrl) {
  const source = readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const { applyElementBindings, applyElementRotations } = await importTypeScriptModule("../src/agent/elementTransforms.ts");
const { diffSceneSummaries, sceneActionLabel } = await importTypeScriptModule("../src/logging/artifactActions.ts");

function element(id, type, overrides = {}) {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    boundElements: null,
    groupIds: [],
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    updated: 1,
    ...overrides
  };
}

// Rotation accepts model-friendly absolute degrees and stores normalized radians.
const rotated = applyElementRotations(
  [element("a", "rectangle"), element("b", "diamond")],
  [{ id: "a", angleDegrees: 450 }, { id: "b", angleDegrees: -90 }]
);
assert(Math.abs(rotated[0].angle - Math.PI / 2) < 1e-10);
assert(Math.abs(rotated[1].angle - Math.PI * 3 / 2) < 1e-10);
assert.equal(rotated[0].version, 2);

// Binding updates both arrow endpoints and the targets' reverse references.
const initial = [
  element("start", "rectangle"),
  element("end", "ellipse", { boundElements: [{ id: "label", type: "text" }] }),
  element("arrow", "arrow", { points: [[0, 0], [100, 0]], startBinding: null, endBinding: null })
];
const bound = applyElementBindings(initial, [{
  arrowId: "arrow",
  startElementId: "start",
  endElementId: "end"
}]);
const boundById = new Map(bound.map(item => [item.id, item]));
assert.equal(boundById.get("arrow").startBinding.elementId, "start");
assert.equal(boundById.get("arrow").endBinding.elementId, "end");
assert.deepEqual(boundById.get("start").boundElements, [{ id: "arrow", type: "arrow" }]);
assert.deepEqual(boundById.get("end").boundElements, [
  { id: "label", type: "text" },
  { id: "arrow", type: "arrow" }
]);

// Rebinding and unbinding remove stale reverse references without duplicating them.
const rebound = applyElementBindings(bound, [{
  arrowId: "arrow",
  startElementId: "end",
  endElementId: null
}]);
const reboundById = new Map(rebound.map(item => [item.id, item]));
assert.equal(reboundById.get("start").boundElements, null);
assert.deepEqual(reboundById.get("end").boundElements, [
  { id: "label", type: "text" },
  { id: "arrow", type: "arrow" }
]);
assert.equal(reboundById.get("arrow").startBinding.elementId, "end");
assert.equal(reboundById.get("arrow").endBinding, null);

function summary(elements) {
  return {
    total: elements.length,
    byType: {},
    bySemanticRole: {},
    validationWarnings: [],
    warnings: [],
    elements
  };
}

// Shared artifact actions distinguish rotation and binding instead of flattening them to update_object.
const rotationDiff = diffSceneSummaries(
  summary([{ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100, angle: 0 }]),
  summary([{ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100, angle: Math.PI / 2 }])
);
assert.deepEqual(rotationDiff.rotated, ["a"]);
assert.deepEqual(rotationDiff.updated, []);
assert.equal(sceneActionLabel(rotationDiff), "rotate_object");

const bindingDiff = diffSceneSummaries(
  summary([{ id: "arrow", type: "arrow", x: 0, y: 0, width: 100, height: 0, startBinding: null, endBinding: null }]),
  summary([{ id: "arrow", type: "arrow", x: 0, y: 0, width: 100, height: 0, startBinding: { elementId: "a", focus: 0, gap: 1 }, endBinding: null }])
);
assert.deepEqual(bindingDiff.bindingChanged, ["arrow"]);
assert.equal(sceneActionLabel(bindingDiff), "change_binding");

// The autonomous protocol, executor, instrumenter, and prompt all expose the new mutating tools.
const protocolSource = readFileSync(new URL("../src/agent/timedAgentProtocol.ts", import.meta.url), "utf8");
const executorSource = readFileSync(new URL("../src/agent/timedAgent.ts", import.meta.url), "utf8");
const actionSource = readFileSync(new URL("../src/logging/artifactActions.ts", import.meta.url), "utf8");
const promptSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
for (const toolName of ["rotate_elements", "bind_elements"]) {
  assert(protocolSource.includes(`"${toolName}"`));
  assert(executorSource.includes(`call.toolName === "${toolName}"`));
  assert(actionSource.includes(`"${toolName}"`));
  assert(promptSource.includes(toolName));
}

console.log("agent transform integrity tests passed");
