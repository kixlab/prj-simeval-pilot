import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function executeBatch({ decisionNumber, calls, execute }) {
  const trajectory = [{ kind: "decision", decisionNumber }];
  const actions = [];
  const executed = [];
  let failedCall = null;

  for (let toolCallIndex = 0; toolCallIndex < calls.length; toolCallIndex += 1) {
    const call = calls[toolCallIndex];
    const toolExecutionId = `agent-tool:${decisionNumber}:${toolCallIndex}:${trajectory.length + 1}`;
    if (failedCall) {
      trajectory.push({
        kind: "tool_call",
        decisionNumber,
        toolCallIndex,
        toolCallCount: calls.length,
        toolExecutionId,
        executionStatus: "skipped",
        success: false,
        failedToolCallIndex: failedCall.index,
        failedToolExecutionId: failedCall.executionId
      });
      continue;
    }

    executed.push(call.name);
    let output;
    try {
      output = execute(call);
    } catch (error) {
      output = { success: false, error: error.message };
    }
    const executionStatus = output.success ? "success" : "failed";
    trajectory.push({
      kind: "tool_call",
      decisionNumber,
      toolCallIndex,
      toolCallCount: calls.length,
      toolExecutionId,
      executionStatus,
      success: output.success
    });
    if (output.success && call.mutates) {
      actions.push({ decisionNumber, toolCallIndex, toolExecutionId, name: call.name });
    }
    if (!output.success) failedCall = { index: toolCallIndex, executionId: toolExecutionId };
  }

  return { trajectory, actions, executed, shouldReobserve: failedCall !== null };
}

const calls = [
  { name: "first", mutates: true },
  { name: "second", mutates: true },
  { name: "third", mutates: true }
];

// Test 1. All calls execute sequentially and create ordered actions.
const allSuccess = executeBatch({ decisionNumber: 1, calls, execute: () => ({ success: true }) });
assert.deepEqual(allSuccess.executed, ["first", "second", "third"]);
assert.deepEqual(allSuccess.trajectory.slice(1).map(entry => entry.toolCallIndex), [0, 1, 2]);
assert(allSuccess.trajectory.slice(1).every(entry => entry.executionStatus === "success"));
assert.deepEqual(allSuccess.actions.map(action => action.toolCallIndex), [0, 1, 2]);

// Test 2. A middle failure skips the final executor call and requests re-observation.
const middleFailure = executeBatch({
  decisionNumber: 2,
  calls,
  execute: call => ({ success: call.name !== "second", error: call.name === "second" ? "missing ID" : undefined })
});
assert.deepEqual(middleFailure.executed, ["first", "second"]);
assert.deepEqual(middleFailure.trajectory.slice(1).map(entry => entry.executionStatus), ["success", "failed", "skipped"]);
assert.equal(middleFailure.shouldReobserve, true);
assert.deepEqual(middleFailure.actions.map(action => action.name), ["first"]);

// Test 3. A first-call exception skips every remaining call without ending the session.
const firstFailure = executeBatch({
  decisionNumber: 3,
  calls,
  execute: () => { throw new Error("executor crashed"); }
});
assert.deepEqual(firstFailure.executed, ["first"]);
assert.deepEqual(firstFailure.trajectory.slice(1).map(entry => entry.executionStatus), ["failed", "skipped", "skipped"]);
assert.equal(firstFailure.actions.length, 0);
assert.equal(firstFailure.shouldReobserve, true);

// Test 4. Decision/tool ordering remains reconstructable across cycles.
const combinedTrajectory = [
  ...middleFailure.trajectory,
  { kind: "decision", decisionNumber: 3 }
];
assert.deepEqual(combinedTrajectory.map(entry => entry.kind === "decision"
  ? `decision:${entry.decisionNumber}`
  : `tool:${entry.decisionNumber}-${entry.toolCallIndex}`), [
  "decision:2", "tool:2-0", "tool:2-1", "tool:2-2", "decision:3"
]);

// Test 5. The production loop is sequential, logs skipped calls, re-observes, and propagates action metadata.
const timedAgentSource = readFileSync(new URL("../src/agent/timedAgent.ts", import.meta.url), "utf8");
const actionSource = readFileSync(new URL("../src/logging/artifactActions.ts", import.meta.url), "utf8");
assert.match(timedAgentSource, /for \(let toolCallIndex = 0; toolCallIndex < toolCallCount; toolCallIndex \+= 1\)/);
assert.doesNotMatch(timedAgentSource, /Promise\.all\([^)]*decision\.toolCalls/);
assert.match(timedAgentSource, /executionStatus: "skipped"/);
assert.match(timedAgentSource, /if \(!output\.success\) failedCall/);
assert.match(timedAgentSource, /if \(failedCall\) \{\n\s+continue;\n\s+\}/);
assert.match(timedAgentSource, /setAgentToolExecutionContext\(tools, \{ decisionNumber, toolCallIndex, toolExecutionId \}\)/);
assert.match(actionSource, /decisionNumber: executionContext\?\.decisionNumber/);
assert.match(actionSource, /toolCallIndex: executionContext\?\.toolCallIndex/);
assert.match(actionSource, /toolExecutionId: executionContext\?\.toolExecutionId/);

console.log("agent batch integrity tests passed");
