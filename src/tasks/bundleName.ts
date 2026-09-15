/**
 * One naming scheme for every export bundle, on every task, for both actors.
 *
 * Time first, so a directory listing is in the order the trials were run:
 *
 *   20260915-0306Z__audra__gpt-5-5-one-shot-r1__dev-fixture-02__cyx7mp
 *   20260915-0412Z__audra__human-p001__dev-fixture-02__a3f9c2
 *   20260915-0530Z__cs4__human-p001__cs4-sb000__b71e04
 *
 * The stamp is UTC, marked by its trailing Z, and matches the ISO `startedAt`
 * recorded inside session.json. Minutes are enough to read a listing; the short
 * trial id keeps two trials of the same minute apart.
 *
 * Nothing reads a bundle back by parsing its name - the name is for a person
 * browsing exports/, and session.json is what a tool should read.
 */

const shortTaskName: Record<string, string> = {
  "audra-incomplete-shapes": "audra",
  "macgyver-problem-solving": "macgyver",
  "cs4-creative-writing": "cs4"
};

const safe = (value: string) => value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "unknown";

/** `2026-09-15T03:06:44.123Z` -> `20260915-0306Z`. */
function utcStamp(startedAt: string) {
  const time = new Date(startedAt);
  if (Number.isNaN(time.getTime())) return "unknown-time";
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${time.getUTCFullYear()}${pad(time.getUTCMonth() + 1)}${pad(time.getUTCDate())}` +
    `-${pad(time.getUTCHours())}${pad(time.getUTCMinutes())}Z`
  );
}

export function bundleBaseNameFor(
  parts: { taskId: string; actorType: "human" | "agent"; actorId: string; itemId: string; trialId: string },
  startedAt: string
) {
  // An agent's id already carries its model and strategy, so it reads on its
  // own; a participant id does not, and is marked as one.
  const actor = parts.actorType === "human" ? `human-${safe(parts.actorId)}` : safe(parts.actorId);
  const shortTrialId = (parts.trialId.split("-").at(-1) ?? "trial").slice(0, 6);
  return [
    utcStamp(startedAt),
    shortTaskName[parts.taskId] ?? safe(parts.taskId),
    actor,
    safe(parts.itemId),
    shortTrialId
  ].join("__");
}
