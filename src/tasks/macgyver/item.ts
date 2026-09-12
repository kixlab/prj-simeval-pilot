import {
  asObject,
  optionalString,
  ParseErrors,
  requireId,
  requireSource,
  requireString,
  requireStringArray,
  type ItemSource,
  type ParseResult
} from "../itemParsing";

/**
 * One MacGyver problem.
 *
 * The answer key is a nested field rather than a set of loose ones so that
 * withholding it is a single structural step (`participantView`) instead of a
 * list of fields each caller has to remember to drop. A participant or an
 * agent that could see `answerKey` would not be solving the task.
 */
export type MacGyverAnswerKey = {
  solvability: "solvable" | "unsolvable";
  /** Solvable items only; the paper's conventional / unconventional split. */
  solutionType: "conventional" | "unconventional" | null;
  /** Solvable items only. */
  goldSolution: readonly string[];
  /** Unsolvable items only. */
  unsolvableJustification: string | null;
};

export type MacGyverItem = {
  itemId: string;
  source: ItemSource;
  problem: string;
  /** The objects and tools the solver is allowed to use. */
  objects: readonly string[];
  /** Extra conditions stated by the item, if any. */
  constraints: readonly string[];
  answerKey: MacGyverAnswerKey;
  /** Where the item sits in the released dataset, for traceability. */
  datasetRef: string | null;
  notes: string | null;
  /** Reading aids from data/tasks/macgyver/translations/<language>.json; the English problem stays the stimulus. */
  translations?: { ko?: MacGyverTranslation };
};

export type MacGyverTranslation = { problem: string; source: string; machine: boolean };

/** Exactly what a participant or an agent is shown. */
export type MacGyverItemView = Omit<MacGyverItem, "answerKey">;

export function participantView(item: MacGyverItem): MacGyverItemView {
  const { answerKey: _answerKey, ...view } = item;
  return view;
}

export function parseMacGyverItem(raw: unknown): ParseResult<MacGyverItem> {
  const errors = new ParseErrors();
  const object = asObject(raw, errors);

  const itemId = requireId(object, "itemId", errors);
  const source = requireSource(object, errors);
  const problem = requireString(object, "problem", errors);
  const objects = requireStringArray(object, "objects", errors, { minLength: 1, unique: true });
  const constraints = Array.isArray(object.constraints)
    ? requireStringArray(object, "constraints", errors)
    : [];

  const keyRaw = asObject(object.answerKey ?? {}, new ParseErrors());
  const solvability = keyRaw.solvability;
  if (solvability !== "solvable" && solvability !== "unsolvable") {
    errors.add('answerKey.solvability must be "solvable" or "unsolvable".');
  }

  const solutionType =
    keyRaw.solutionType === "conventional" || keyRaw.solutionType === "unconventional"
      ? keyRaw.solutionType
      : null;
  // No length rule here: whether a gold solution is required or forbidden
  // depends on solvability, which the two branches below decide.
  const goldSolution = Array.isArray(keyRaw.goldSolution)
    ? requireStringArray(keyRaw, "goldSolution", errors)
    : [];
  const unsolvableJustification = optionalString(keyRaw, "unsolvableJustification");

  // A solvable item without a gold solution, or an unsolvable one carrying a
  // solution, would silently corrupt scoring, so neither is accepted.
  if (solvability === "solvable") {
    if (goldSolution.length === 0) errors.add("A solvable item needs answerKey.goldSolution.");
    if (!solutionType) {
      errors.add('A solvable item needs answerKey.solutionType ("conventional" or "unconventional").');
    }
    if (unsolvableJustification) {
      errors.add("A solvable item must not carry answerKey.unsolvableJustification.");
    }
  }
  if (solvability === "unsolvable") {
    if (!unsolvableJustification) {
      errors.add("An unsolvable item needs answerKey.unsolvableJustification.");
    }
    if (goldSolution.length > 0) errors.add("An unsolvable item must not carry a gold solution.");
    if (solutionType) errors.add("An unsolvable item must not carry a solutionType.");
  }

  return errors.result({
    itemId,
    source,
    problem,
    objects,
    constraints,
    answerKey: {
      solvability: solvability === "unsolvable" ? "unsolvable" : "solvable",
      solutionType,
      goldSolution,
      unsolvableJustification
    },
    datasetRef: optionalString(object, "datasetRef"),
    notes: optionalString(object, "notes")
  });
}

/**
 * The pilot subset the study runs: three unconventional solvable, one
 * conventional solvable, one unsolvable.
 */
export const pilotComposition = {
  unconventional: 3,
  conventional: 1,
  unsolvable: 1
} as const;

export const pilotSubsetSize =
  pilotComposition.unconventional + pilotComposition.conventional + pilotComposition.unsolvable;

export function describeComposition(items: readonly MacGyverItem[]) {
  const counts = { unconventional: 0, conventional: 0, unsolvable: 0 };
  for (const item of items) {
    if (item.answerKey.solvability === "unsolvable") counts.unsolvable += 1;
    else if (item.answerKey.solutionType === "conventional") counts.conventional += 1;
    else counts.unconventional += 1;
  }
  return counts;
}

/** Empty when the subset matches the composition above. */
export function pilotCompositionErrors(items: readonly MacGyverItem[]): readonly string[] {
  const counts = describeComposition(items);
  const problems: string[] = [];
  if (items.length !== pilotSubsetSize) {
    problems.push(`the pilot subset holds ${items.length} items, not ${pilotSubsetSize}`);
  }
  for (const [kind, expected] of Object.entries(pilotComposition) as [
    keyof typeof pilotComposition,
    number
  ][]) {
    if (counts[kind] !== expected) {
      problems.push(`${counts[kind]} ${kind} items, expected ${expected}`);
    }
  }
  return problems;
}
