import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import ts from "typescript";

async function importTypeScriptModule(relativeUrl, replacements = []) {
  let source = readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
  for (const [pattern, replacement] of replacements) source = source.replace(pattern, replacement);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const rationaleModule = await importTypeScriptModule("../src/data/rationaleRecords.ts");
const fflateUrl = import.meta.resolve("fflate");
const archiveModule = await importTypeScriptModule("../src/data/exportArchive.ts", [
  [/from "fflate"/, `from "${fflateUrl}"`]
]);

const rationaleRecords = rationaleModule.buildRationaleRecords({
  sessionId: "session-a",
  humanChunks: [{
    thinkAloudChunkId: "chunk-1",
    chunkStartedAtMs: 1_000,
    chunkEndedAtMs: 3_000,
    content: "크기를 키운다",
    audio: {
      segments: [{
        index: 0,
        transcript: "크기를 키운다",
        confidence: 0.9,
        words: [{ word: "크기", startSec: 0.2, endSec: 0.8, confidence: 0.9 }]
      }]
    }
  }],
  notes: [],
  agentTrajectory: [{
    eventId: "decision-1",
    kind: "decision",
    decisionRationale: "강조를 위해 크기를 키운다",
    startedAtMs: 4_000,
    endedAtMs: 4_500,
    elapsedMs: 4_500,
    decisionNumber: 1
  }]
});
assert.equal(rationaleRecords.length, 2);
assert.equal(rationaleRecords[0].startedAtMs, 1_200);
assert.equal(rationaleRecords[0].availableAtMs, 1_800);
assert.equal(rationaleRecords[1].availableAtMs, 4_500);
assert.equal(rationaleRecords[1].source, "agent_decision_rationale");

const session = {
  actorType: "human",
  participantId: "P 001",
  taskType: "free_creation",
  seedId: "daily_object",
  startedAt: "2026-07-22T12:34:56.789Z",
  sessionId: "drawing-free_creation-12345678-abcd1234"
};
const baseName = archiveModule.sessionArchiveBaseName(session);
assert.match(baseName, /^simeval__participant-p-001__task-free_creation__seed-daily_object__20260722T123456Z__abcd1234$/);
assert.equal(archiveModule.snapshotImageFileName({ sequence: 3, reason: "action", actionSequence: 2 }),
  "screenshots/snapshot-0003__action__action-0002.png");

const archive = new archiveModule.StreamingZipArchive();
archive.addText(`${baseName}/session.json`, JSON.stringify({ ok: true }));
await archive.addBlob(`${baseName}/screenshots/test.png`, new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
const zipBlob = await archive.finish();
const files = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
assert.equal(strFromU8(files[`${baseName}/session.json`]), '{"ok":true}');
assert.deepEqual([...files[`${baseName}/screenshots/test.png`]], [1, 2, 3]);

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const agentSource = readFileSync(new URL("../src/agent/timedAgent.ts", import.meta.url), "utf8");
assert.match(appSource, /screenshotPolicy: "initial_action_phase_final_no_periodic"/);
assert.match(appSource, /outcomeEvaluationId/);
assert.match(appSource, /buildRationaleRecords/);
assert.doesNotMatch(appSource, /Study ID|Condition ID|Assignment ID|Matched pair ID|Primary input device/);
assert.match(agentSource, /observationSnapshotId/);
assert.match(agentSource, /requestDurationMs/);

console.log("data collection integrity tests passed");
