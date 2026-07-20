import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const validPhases = ["single_phase", "phase_1", "phase_2"];

function statusFor({ requestFailed = false, content = "" }) {
  if (requestFailed) return "failed";
  return content.trim().length === 0 ? "empty" : "completed";
}

function buildChunk({
  sessionId,
  chunkIndex,
  chunkStartedAtMs,
  chunkEndedAtMs,
  phaseAtStart,
  phaseAtEnd,
  content = "thinking aloud",
  requestFailed = false,
  byteSize = 128
}) {
  const transcriptionStatus = statusFor({ requestFailed, content });
  return {
    thinkAloudChunkId: `${sessionId}:think-aloud-chunk:${chunkIndex}`,
    sessionId,
    sequence: chunkIndex,
    timestamp: new Date(chunkStartedAtMs).toISOString(),
    chunkStartedAtMs,
    chunkEndedAtMs,
    durationMs: chunkEndedAtMs - chunkStartedAtMs,
    phaseAtStart,
    phaseAtEnd,
    crossesPhaseTransition: phaseAtStart !== phaseAtEnd,
    source: "human_audio",
    content,
    transcriptionStatus,
    audio: {
      chunkIndex,
      mimeType: "audio/webm;codecs=opus",
      byteSize,
      languageCode: "ko-KR",
      success: !requestFailed,
      error: requestFailed ? "ASR failed" : undefined,
      segments: content.trim() ? [{
        index: 0,
        transcript: content,
        confidence: null,
        words: [{ word: "thinking", startSec: 0.1, endSec: 0.5, confidence: null }]
      }] : []
    }
  };
}

function validate(sessionId, chunks, pendingCount = 0) {
  assert.equal(pendingCount, 0);
  const ids = new Set();
  const indexes = new Set();
  let previousSequence = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.sessionId, sessionId);
    assert(!ids.has(chunk.thinkAloudChunkId));
    assert(!indexes.has(chunk.audio.chunkIndex));
    assert(chunk.sequence > previousSequence);
    assert(chunk.chunkStartedAtMs >= 0);
    assert(chunk.chunkEndedAtMs >= chunk.chunkStartedAtMs);
    assert.equal(chunk.durationMs, chunk.chunkEndedAtMs - chunk.chunkStartedAtMs);
    assert(validPhases.includes(chunk.phaseAtStart));
    assert(validPhases.includes(chunk.phaseAtEnd));
    assert.equal(chunk.crossesPhaseTransition, chunk.phaseAtStart !== chunk.phaseAtEnd);
    if (chunk.transcriptionStatus === "failed") {
      assert.equal(chunk.audio.success, false);
      assert(chunk.audio.error);
    }
    if (chunk.transcriptionStatus === "empty") {
      assert.equal(chunk.audio.success, true);
      assert.equal(chunk.content.trim(), "");
    }
    if (chunk.transcriptionStatus === "completed") {
      assert.equal(chunk.audio.success, true);
      assert.notEqual(chunk.content.trim(), "");
    }
    ids.add(chunk.thinkAloudChunkId);
    indexes.add(chunk.audio.chunkIndex);
    previousSequence = chunk.sequence;
  }
}

function assertRejectsValidation(sessionId, chunks, pendingCount = 0) {
  assert.throws(() => validate(sessionId, chunks, pendingCount));
}

// Test 1. Late ASR response session binding: A chunks must not validate under B.
const delayedSessionAChunk = buildChunk({
  sessionId: "session-a",
  chunkIndex: 1,
  chunkStartedAtMs: 0,
  chunkEndedAtMs: 10000,
  phaseAtStart: "single_phase",
  phaseAtEnd: "single_phase"
});
validate("session-a", [delayedSessionAChunk]);
assertRejectsValidation("session-b", [delayedSessionAChunk]);
assertRejectsValidation("session-a", [delayedSessionAChunk], 1);

// Test 2. Phase transition during chunk.
validate("session-a", [buildChunk({
  sessionId: "session-a",
  chunkIndex: 1,
  chunkStartedAtMs: 55000,
  chunkEndedAtMs: 65000,
  phaseAtStart: "phase_1",
  phaseAtEnd: "phase_2"
})]);

// Test 3. Phase 1 chunk with delayed response remains phase_1.
const phaseOneDelayedChunk = buildChunk({
  sessionId: "session-a",
  chunkIndex: 1,
  chunkStartedAtMs: 20000,
  chunkEndedAtMs: 30000,
  phaseAtStart: "phase_1",
  phaseAtEnd: "phase_1"
});
assert.equal(phaseOneDelayedChunk.phaseAtStart, "phase_1");
assert.equal(phaseOneDelayedChunk.phaseAtEnd, "phase_1");
validate("session-a", [phaseOneDelayedChunk]);

// Test 4. Final short chunk can be represented and validated.
validate("session-a", [buildChunk({
  sessionId: "session-a",
  chunkIndex: 1,
  chunkStartedAtMs: 0,
  chunkEndedAtMs: 4200,
  phaseAtStart: "single_phase",
  phaseAtEnd: "single_phase"
})]);

// Test 5. Empty transcription is retained.
const emptyChunk = buildChunk({
  sessionId: "session-a",
  chunkIndex: 1,
  chunkStartedAtMs: 0,
  chunkEndedAtMs: 10000,
  phaseAtStart: "single_phase",
  phaseAtEnd: "single_phase",
  content: ""
});
assert.equal(emptyChunk.transcriptionStatus, "empty");
validate("session-a", [emptyChunk]);

// Test 6. Failed transcription retains the audio chunk metadata.
const failedChunk = buildChunk({
  sessionId: "session-a",
  chunkIndex: 1,
  chunkStartedAtMs: 0,
  chunkEndedAtMs: 10000,
  phaseAtStart: "single_phase",
  phaseAtEnd: "single_phase",
  content: "",
  requestFailed: true
});
assert.equal(failedChunk.transcriptionStatus, "failed");
assert.equal(failedChunk.audio.byteSize, 128);
validate("session-a", [failedChunk]);

// Test 7. Combined export identity metadata.
const exportSessionId = "session-a";
const audioMetadata = {
  available: true,
  fileName: `drawing-${exportSessionId}.webm`,
  mimeType: "audio/webm;codecs=opus",
  byteSize: 256,
  chunkCount: 2
};
assert.equal(audioMetadata.fileName, "drawing-session-a.webm");
assert.equal(audioMetadata.chunkCount, 2);
validate(exportSessionId, [
  buildChunk({ sessionId: exportSessionId, chunkIndex: 1, chunkStartedAtMs: 0, chunkEndedAtMs: 10000, phaseAtStart: "single_phase", phaseAtEnd: "single_phase" }),
  buildChunk({ sessionId: exportSessionId, chunkIndex: 2, chunkStartedAtMs: 10000, chunkEndedAtMs: 18000, phaseAtStart: "single_phase", phaseAtEnd: "single_phase" })
]);

// Test 8. Sequential recorder finalization includes the final data event before transcription.
const lifecycle = [];
const finalizedParts = [];
function finalizeStandaloneChunk(parts, chunkIndex, startedAtMs, endedAtMs) {
  lifecycle.push(`stop:${chunkIndex}`);
  finalizedParts.push(...parts, "final-dataavailable");
  lifecycle.push(`dataavailable:${chunkIndex}`);
  const blobParts = [...finalizedParts];
  lifecycle.push(`transcribe:${chunkIndex}`);
  finalizedParts.length = 0;
  return buildChunk({
    sessionId: "session-a",
    chunkIndex,
    chunkStartedAtMs: startedAtMs,
    chunkEndedAtMs: endedAtMs,
    phaseAtStart: "single_phase",
    phaseAtEnd: "single_phase",
    byteSize: blobParts.length
  });
}
const sequentialChunks = [
  finalizeStandaloneChunk(["header-1", "audio-1"], 1, 0, 10000),
  finalizeStandaloneChunk(["header-2", "audio-2"], 2, 10000, 20000),
  finalizeStandaloneChunk(["header-3", "partial-audio"], 3, 20000, 24750)
];
assert.deepEqual(lifecycle, [
  "stop:1", "dataavailable:1", "transcribe:1",
  "stop:2", "dataavailable:2", "transcribe:2",
  "stop:3", "dataavailable:3", "transcribe:3"
]);
assert.equal(sequentialChunks[2].durationMs, 4750);
validate("session-a", sequentialChunks);

// Test 9. The implementation uses fresh stopped recorders for STT and keeps a separate full-session recorder.
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /const startSttChunkRecorder/);
assert.match(appSource, /recorder\.onstop = \(\) => \{[\s\S]*new Blob\(parts[\s\S]*transcribeChunk\(blob/);
assert.match(appSource, /fullRecorder\.start\(recordingTimesliceMs\)/);
assert.match(appSource, /recorder\.start\(\);/);
assert.doesNotMatch(appSource, /recorder\.start\(recordingTimesliceMs\)/);

// Test 10. INVALID_ARGUMENT errors keep their real cause, while auth failures get credential guidance.
const viteSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
assert.match(viteSource, /authenticationFailure[\s\S]*\? `\$\{message\}\. Check Google Cloud ADC/);
assert.match(viteSource, /: message;/);
assert.match(viteSource, /languageCode,\n\s+error: formatSttError\(error\)/);
assert.equal(failedChunk.audio.languageCode, "ko-KR");

console.log("think-aloud integrity tests passed");
