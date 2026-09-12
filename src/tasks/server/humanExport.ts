import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeThinkAloud,
  toThinkAloudJsonl,
  validateThinkAloudChunks,
  type ThinkAloudChunk
} from "../../audra/thinkAloud";
import {
  replayHumanCs4Events,
  sentenceChangesFromEvents,
  summarizeHumanCs4Process,
  type HumanCs4Event
} from "../cs4/humanRevision";
import { cs4ConstraintStages, type Cs4Instance } from "../cs4/item";
import {
  replayHumanEvents,
  stepChangesFromEvents,
  stepsFromText,
  summarizeHumanProcess,
  type HumanMacGyverEvent
} from "../macgyver/humanAnswer";
import { bundleBaseNameFor, textExportVersion } from "./textExport";

/**
 * Export bundles for participants' text-task trials - the same layout and
 * session fields as an agent's, plus the think-aloud trace.
 *
 * A posted log is replayed before anything is written. A log that does not
 * reproduce - an edit whose removed text is not there, a gap in the indices, a
 * final text that does not match - is refused rather than exported.
 */
type HumanExportBase = {
  sessionId: string;
  trialId: string;
  itemId: string;
  itemSource: string;
  actorId: string;
  finalText: string | null;
  startedAt: string;
  endedAt: string;
  protocol: Record<string, unknown> | null;
  thinkAloud: ThinkAloudChunk[];
  audioBase64: string | null;
};

export type HumanMacGyverExport = HumanExportBase & { events: HumanMacGyverEvent[] };
export type HumanCs4Export = HumanExportBase & { events: HumanCs4Event[] };

type ExportContext = { appVersion: string; appCommit: string; exportDir: string };
type TextFile = { name: string; content: string };

const jsonl = (records: readonly unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");

function thinkAloudSummary(request: HumanExportBase, audioFileName: string | null) {
  if (request.thinkAloud.length === 0 && !audioFileName) return null;
  return {
    ...summarizeThinkAloud(request.thinkAloud),
    audioFileName,
    chunkDurationMs: 10000,
    validationErrors: validateThinkAloudChunks(request.thinkAloud)
  };
}

/** Writes the files every human bundle shares, around the task's own. */
function writeBundle(
  taskId: string,
  request: HumanExportBase,
  context: ExportContext,
  session: Record<string, unknown>,
  events: readonly unknown[],
  taskFiles: readonly TextFile[]
) {
  const audioFileName = request.audioBase64 ? "thinkaloud_audio.webm" : null;
  const baseName = bundleBaseNameFor(
    { taskId, actorType: "human", actorId: request.actorId, itemId: request.itemId, trialId: request.trialId },
    request.startedAt
  );
  const directory = join(context.exportDir, baseName);
  mkdirSync(directory, { recursive: true });

  const fullSession = {
    exportVersion: textExportVersion,
    taskId,
    item: { itemId: request.itemId, source: request.itemSource },
    sessionId: request.sessionId,
    trialId: request.trialId,
    actor: { type: "human", id: request.actorId },
    timing: { startedAt: request.startedAt, endedAt: request.endedAt },
    versions: { appVersion: context.appVersion, appCommit: context.appCommit },
    protocol: request.protocol,
    ...session,
    thinkAloud: thinkAloudSummary(request, audioFileName),
    eventCount: events.length
  };
  const files: TextFile[] = [
    { name: "events.jsonl", content: jsonl(events) },
    { name: "session.json", content: `${JSON.stringify(fullSession, null, 2)}\n` },
    ...taskFiles
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

export function writeHumanMacGyverBundle(request: HumanMacGyverExport, context: ExportContext) {
  const state = replayHumanEvents(request.events);
  if (request.finalText != null && request.finalText !== state.text) {
    throw new Error("The posted answer does not match what its edit log replays to.");
  }
  const steps = state.judgement === "solvable" ? stepsFromText(state.text) : [];
  const justification = state.judgement === "unsolvable" ? state.text.trim() : null;
  const stepChanges = stepChangesFromEvents(request.events);

  const answerLines = [`Judgement: ${state.judgement ?? "not set"}`, "", "Memo, as written:", state.text, ""];
  if (steps.length > 0) {
    answerLines.push("Steps, read from the memo's lines:", ...steps.map((step, index) => `${index + 1}. ${step}`), "");
  }

  return writeBundle(
    "macgyver-problem-solving",
    request,
    context,
    {
      answer: { judgement: state.judgement, stepCount: steps.length, textChars: state.text.length, submitted: state.submitted },
      humanProcess: summarizeHumanProcess(request.events),
      stepReading: "non-blank memo lines, numbering and bullets removed, compared between typing pauses",
      stepChangeCount: stepChanges.length
    },
    request.events,
    [
      { name: "answer.md", content: `${answerLines.join("\n")}\n` },
      {
        name: "answer.json",
        content: `${JSON.stringify({ judgement: state.judgement, text: state.text, steps, justification, submitted: state.submitted }, null, 2)}\n`
      },
      { name: "step_changes.jsonl", content: jsonl(stepChanges) }
    ]
  );
}

export function writeHumanCs4Bundle(request: HumanCs4Export, instance: Cs4Instance, context: ExportContext) {
  const state = replayHumanCs4Events(instance.baseStory, request.events);
  if (request.finalText != null && request.finalText !== state.text) {
    throw new Error("The posted story does not match what its edit log replays to.");
  }
  // The screen posts only once the last round has ended, by the participant or
  // by its clock; a log that stops earlier is not a session it produced.
  if (!state.complete) {
    throw new Error(`The session ended after round ${state.results.length} of ${cs4ConstraintStages.length}; every round must end before export.`);
  }
  const sentenceChanges = sentenceChangesFromEvents(instance.baseStory, request.events);
  const rounds = state.results.map(({ story: _story, ...rest }) => rest);

  return writeBundle(
    "cs4-creative-writing",
    request,
    context,
    {
      rounds,
      answer: {
        complete: state.complete,
        roundsFinished: state.results.length,
        finalWords: state.text.trim().split(/\s+/).filter(Boolean).length
      },
      humanProcess: summarizeHumanCs4Process(request.events),
      sentenceReading: "the story split at terminal punctuation, compared between typing pauses and at round ends",
      sentenceChangeCount: sentenceChanges.length
    },
    request.events,
    [
      ...state.results.map(result => ({ name: `story_round${result.round}.txt`, content: `${result.story}\n` })),
      { name: "story_final.txt", content: `${state.text}\n` },
      { name: "rounds.json", content: `${JSON.stringify(rounds, null, 2)}\n` },
      { name: "sentence_changes.jsonl", content: jsonl(sentenceChanges) }
    ]
  );
}
