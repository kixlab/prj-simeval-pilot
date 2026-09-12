import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { textTrialStatus, type TextTrialRecord } from "../agent/textTrialRegistry";

/**
 * Export bundle for a text-task agent trial, written server-side like the
 * incomplete-shapes bundle. The answer key is never written here: scoring reads
 * `data/tasks` from disk and joins on the item id in session.json.
 */
export const textExportVersion = "text-task-export-v1" as const;

const shortTaskName: Record<string, string> = {
  "macgyver-problem-solving": "macgyver",
  "cs4-creative-writing": "cs4"
};

export type TextExportContext = {
  startedAt: string;
  endedAt: string;
  appVersion: string;
  appCommit: string;
  /** Time limit and how the trial ended, recorded the same way for both actors. */
  protocol?: Record<string, unknown> | null;
};

export function textBundleBaseName(record: TextTrialRecord, startedAt: string) {
  const safe = (value: string) => value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "unknown";
  const stamp = startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return [
    shortTaskName[record.taskId] ?? safe(record.taskId),
    `agent-${safe(record.actorId)}`,
    `item-${safe(record.itemId)}`,
    stamp,
    record.trialId.split("-").at(-1) ?? "trial"
  ].join("__");
}

export function buildTextSession(record: TextTrialRecord, context: TextExportContext) {
  return {
    exportVersion: textExportVersion,
    taskId: record.taskId,
    item: { itemId: record.itemId, source: record.itemSource },
    sessionId: record.sessionId,
    trialId: record.trialId,
    actor: { type: "agent", id: record.actorId },
    timing: { startedAt: context.startedAt, endedAt: context.endedAt },
    versions: { appVersion: context.appVersion, appCommit: context.appCommit },
    protocol: context.protocol ?? null,
    // Kept apart from the event log, as on the drawing task.
    agentRun: record.agentRun,
    runStats: record.runStats,
    rejections: record.rejections,
    status: textTrialStatus(record),
    answer: record.engine.details(record.state),
    eventCount: record.events.length
  };
}

export function writeTextBundle(
  record: TextTrialRecord,
  context: Omit<TextExportContext, "startedAt"> & { exportDir: string }
) {
  const startedAt = new Date(record.createdAtEpochMs).toISOString();
  const baseName = textBundleBaseName(record, startedAt);
  const directory = join(context.exportDir, baseName);
  mkdirSync(directory, { recursive: true });

  const files = [
    { name: "events.jsonl", content: `${record.events.map(event => JSON.stringify(event)).join("\n")}\n` },
    { name: "session.json", content: `${JSON.stringify(buildTextSession(record, { ...context, startedAt }), null, 2)}\n` },
    ...record.engine.finalFiles(record.state)
  ];
  for (const file of files) writeFileSync(join(directory, file.name), file.content, "utf8");
  return { directory, baseName, files: files.map(file => file.name) };
}
