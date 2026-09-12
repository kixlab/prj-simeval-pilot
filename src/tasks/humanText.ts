/**
 * Shared pieces of the participant text screens (MacGyver, CS4): the
 * lossless edit record, and the alignment that reads a free-text answer as a
 * sequence of units - steps or sentences - so it can be compared with an
 * agent's unit-level moves.
 */

export type TextEdit = { start: number; removed: string; inserted: string };

/** The smallest single replacement that turns one text into the other. */
export function textDiff(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { start, removed: before.slice(start, endBefore), inserted: after.slice(start, endAfter) };
}

/** Applies one recorded edit, refusing one that does not match the text it claims to change. */
export function applyTextEdit(
  text: string,
  payload: Record<string, unknown>,
  eventIndex: number,
  maxChars: number
): { ok: true; text: string } | { ok: false; error: string } {
  const { start, removed, inserted } = payload as Partial<TextEdit>;
  if (!Number.isInteger(start) || typeof removed !== "string" || typeof inserted !== "string") {
    return { ok: false, error: `Edit ${eventIndex} needs start, removed and inserted.` };
  }
  const at = start as number;
  if (at < 0 || text.slice(at, at + removed.length) !== removed) {
    return { ok: false, error: `Edit ${eventIndex} does not match the text it claims to change.` };
  }
  const next = text.slice(0, at) + inserted + text.slice(at + removed.length);
  if (next.length > maxChars) return { ok: false, error: `The text is limited to ${maxChars} characters.` };
  return { ok: true, text: next };
}

export type AlignedChange = {
  change: "added" | "revised" | "deleted";
  /** 1-based position after the change; for a deletion, the position it had before. */
  position: number;
  text: string | null;
  previous: string | null;
};

/**
 * Unit-level alignment of two lists (longest common subsequence). Within a
 * run of unmatched units, a removed unit paired with an added one is a
 * revision; the rest are additions or deletions.
 */
export function alignUnits(before: readonly string[], after: readonly string[]): AlignedChange[] {
  const rows = before.length;
  const columns = after.length;
  const common = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const changes: AlignedChange[] = [];
  let removed: Array<[number, string]> = [];
  let added: Array<[number, string]> = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k += 1) {
      changes.push({ change: "revised", position: added[k][0] + 1, text: added[k][1], previous: removed[k][1] });
    }
    for (const [index, unit] of added.slice(pairs)) changes.push({ change: "added", position: index + 1, text: unit, previous: null });
    for (const [index, unit] of removed.slice(pairs)) changes.push({ change: "deleted", position: index + 1, text: null, previous: unit });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && before[i] === after[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < columns && (i >= rows || common[i][j + 1] >= common[i + 1][j])) {
      added.push([j, after[j]]);
      j += 1;
    } else {
      removed.push([i, before[i]]);
      i += 1;
    }
  }
  flush();
  return changes;
}

type LoggedEvent = { eventType: string; payload: Record<string, unknown> };

/** How the text was produced: typing, deleting, pasting, pausing, reading the translation. */
export function summarizeTextEdits(events: readonly LoggedEvent[]) {
  const edits = events.filter(event => event.eventType === "text_edit");
  return {
    edits: edits.length,
    charsInserted: edits.reduce((sum, event) => sum + String(event.payload.inserted ?? "").length, 0),
    charsRemoved: edits.reduce((sum, event) => sum + String(event.payload.removed ?? "").length, 0),
    pastes: edits.filter(event => event.payload.source === "paste").length,
    pauses: events.filter(event => event.eventType === "pause").length,
    translationToggles: events.filter(event => event.eventType === "translation_toggle").length
  };
}
