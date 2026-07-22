import type {
  RationaleRecord,
  ThinkAloudChunk,
  ThinkAloudNote
} from "./sessionTypes";
import type { AgentTrajectoryEntry } from "../agent/timedAgent";

type RationaleInputs = {
  sessionId: string;
  humanChunks: readonly ThinkAloudChunk[];
  notes: readonly ThinkAloudNote[];
  agentTrajectory: readonly AgentTrajectoryEntry[];
};

export function buildRationaleRecords({
  sessionId,
  humanChunks,
  notes,
  agentTrajectory
}: RationaleInputs): RationaleRecord[] {
  const drafts: Omit<RationaleRecord, "rationaleId" | "sequence">[] = [];

  for (const chunk of humanChunks) {
    const segments = chunk.audio.segments.length > 0
      ? chunk.audio.segments
      : chunk.content.trim()
        ? [{ index: 0, transcript: chunk.content, confidence: null, words: [] }]
        : [];
    for (const segment of segments) {
      const firstWord = segment.words[0];
      const lastWord = segment.words.at(-1);
      const startedAtMs = firstWord
        ? chunk.chunkStartedAtMs + Math.round(firstWord.startSec * 1000)
        : chunk.chunkStartedAtMs;
      const endedAtMs = lastWord
        ? chunk.chunkStartedAtMs + Math.round(lastWord.endSec * 1000)
        : chunk.chunkEndedAtMs;
      drafts.push({
        sessionId,
        actorType: "human",
        source: "explicit_think_aloud",
        content: segment.transcript.trim(),
        startedAtMs,
        endedAtMs,
        availableAtMs: endedAtMs,
        sourceEventIds: [chunk.thinkAloudChunkId],
        linkedEventIds: [],
        provenance: "observed",
        confidence: segment.confidence
      });
    }
  }

  for (const note of notes) {
    drafts.push({
      sessionId,
      actorType: note.source === "agent_reasoning" ? "agent" : "human",
      source: note.source,
      content: note.content,
      startedAtMs: note.elapsedMs,
      endedAtMs: note.elapsedMs,
      availableAtMs: note.elapsedMs,
      sourceEventIds: [note.thinkAloudNoteId],
      linkedEventIds: note.linkedEventId ? [note.linkedEventId] : [],
      provenance: "observed"
    });
  }

  for (const entry of agentTrajectory) {
    if (entry.kind !== "decision" || !entry.decisionRationale?.trim()) continue;
    const availableAtMs = entry.endedAtMs ?? entry.elapsedMs;
    drafts.push({
      sessionId,
      actorType: "agent",
      source: "agent_decision_rationale",
      content: entry.decisionRationale.trim(),
      startedAtMs: entry.startedAtMs ?? availableAtMs,
      endedAtMs: availableAtMs,
      availableAtMs,
      sourceEventIds: [entry.eventId],
      linkedEventIds: [entry.eventId],
      provenance: "observed",
      decisionNumber: entry.decisionNumber
    });
  }

  return drafts
    .filter(record => record.content.length > 0)
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .map((record, index) => ({
      ...record,
      rationaleId: `${sessionId}:rationale:${index + 1}`,
      sequence: index + 1
    }));
}

