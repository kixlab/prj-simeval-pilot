import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeThinkAloud,
  toThinkAloudJsonl,
  validateThinkAloudChunks,
  type ThinkAloudChunk
} from "../../audra/thinkAloud";
import {
  replayHumanEvents,
  stepChangesFromEvents,
  stepsFromText,
  summarizeHumanProcess,
  type HumanMacGyverEvent
} from "../macgyver/humanAnswer";
import { bundleBaseNameFor, textExportVersion } from "./textExport";

/**
 * Export bundle for a participant's MacGyver trial - the same layout and
 * session fields as an agent's, plus the think-aloud trace.
 *
 * The posted log is replayed before anything is written. A log that does not
 * reproduce - an edit whose removed text is not there, a gap in the indices,
 * a memo that does not match - is refused rather than exported.
 */
export type HumanMacGyverExport = {
  sessionId: string;
  trialId: string;
  itemId: string;
  itemSource: string;
  actorId: string;
  events: HumanMacGyverEvent[];
  finalText: string | null;
  startedAt: string;
  endedAt: string;
  protocol: Record<string, unknown> | null;
  thinkAloud: ThinkAloudChunk[];
  audioBase64: string | null;
};

export function writeHumanMacGyverBundle(
  request: HumanMacGyverExport,
  context: { appVersion: string; appCommit: string; exportDir: string }
) {
  const state = replayHumanEvents(request.events);
  if (request.finalText != null && request.finalText !== state.text) {
    throw new Error("The posted answer does not match what its edit log replays to.");
  }
  const steps = state.judgement === "solvable" ? stepsFromText(state.text) : [];
  const justification = state.judgement === "unsolvable" ? state.text.trim() : null;
  const stepChanges = stepChangesFromEvents(request.events);
  const audioFileName = request.audioBase64 ? "thinkaloud_audio.webm" : null;

  const baseName = bundleBaseNameFor(
    { taskId: "macgyver-problem-solving", actorType: "human", actorId: request.actorId, itemId: request.itemId, trialId: request.trialId },
    request.startedAt
  );
  const directory = join(context.exportDir, baseName);
  mkdirSync(directory, { recursive: true });

  const session = {
    exportVersion: textExportVersion,
    taskId: "macgyver-problem-solving",
    item: { itemId: request.itemId, source: request.itemSource },
    sessionId: request.sessionId,
    trialId: request.trialId,
    actor: { type: "human", id: request.actorId },
    timing: { startedAt: request.startedAt, endedAt: request.endedAt },
    versions: { appVersion: context.appVersion, appCommit: context.appCommit },
    protocol: request.protocol,
    answer: {
      judgement: state.judgement,
      stepCount: steps.length,
      textChars: state.text.length,
      submitted: state.submitted
    },
    humanProcess: summarizeHumanProcess(request.events),
    stepReading: "non-blank memo lines, numbering and bullets removed, compared between typing pauses",
    stepChangeCount: stepChanges.length,
    thinkAloud:
      request.thinkAloud.length > 0 || audioFileName
        ? {
            ...summarizeThinkAloud(request.thinkAloud),
            audioFileName,
            chunkDurationMs: 10000,
            validationErrors: validateThinkAloudChunks(request.thinkAloud)
          }
        : null,
    eventCount: request.events.length
  };

  const answerLines = [
    `Judgement: ${state.judgement ?? "not set"}`,
    "",
    "Memo, as written:",
    state.text,
    ""
  ];
  if (steps.length > 0) {
    answerLines.push("Steps, read from the memo's lines:", ...steps.map((step, index) => `${index + 1}. ${step}`), "");
  }

  const files = [
    { name: "events.jsonl", content: `${request.events.map(event => JSON.stringify(event)).join("\n")}\n` },
    { name: "session.json", content: `${JSON.stringify(session, null, 2)}\n` },
    { name: "answer.md", content: `${answerLines.join("\n")}\n` },
    {
      name: "answer.json",
      content: `${JSON.stringify({ judgement: state.judgement, text: state.text, steps, justification, submitted: state.submitted }, null, 2)}\n`
    },
    { name: "step_changes.jsonl", content: stepChanges.map(change => JSON.stringify(change)).join("\n") + (stepChanges.length ? "\n" : "") }
  ];
  if (request.thinkAloud.length > 0) files.push({ name: "thinkaloud.jsonl", content: toThinkAloudJsonl(request.thinkAloud) });
  for (const file of files) writeFileSync(join(directory, file.name), file.content, "utf8");
  const written = files.map(file => file.name);
  if (request.audioBase64 && audioFileName) {
    writeFileSync(join(directory, audioFileName), Buffer.from(request.audioBase64, "base64"));
    written.push(audioFileName);
  }
  return { directory, baseName, files: written.sort() };
}
