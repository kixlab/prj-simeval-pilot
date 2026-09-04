import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  parseMacGyverItem,
  participantView as macgyverView,
  pilotCompositionErrors,
  type MacGyverItem
} from "../macgyver/item";
import { parseCs4Instance, participantView as cs4View, type Cs4Instance } from "../cs4/item";

/**
 * Reads task items from disk.
 *
 * Items live outside the served directory on purpose: MacGyver ships a gold
 * solution with every problem, and anything under `public/` would hand that to
 * whatever is solving the task. The store is the only reader, and the HTTP
 * layer above it can only ever pass on a participant view.
 */
export const taskItemRoot = "data/tasks";

export type TaskItemsDirectory = "macgyver" | "cs4";

export const directoryForTask: Record<string, TaskItemsDirectory> = {
  "macgyver-problem-solving": "macgyver",
  "cs4-creative-writing": "cs4"
};

export type Manifest = {
  taskId: string;
  /** Every item file that belongs to this task. */
  items: readonly string[];
  /** The items the pilot actually runs, in order. */
  pilotSubset: readonly string[];
};

export type LoadedItems<T> = {
  taskId: string;
  directory: string;
  manifest: Manifest;
  items: readonly T[];
  pilot: readonly T[];
  /** Everything wrong with the item set. Empty means it is ready to run. */
  errors: readonly string[];
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readManifest(directory: string, taskId: string, errors: string[]): Manifest {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) {
    errors.push(`${path} is missing.`);
    return { taskId, items: [], pilotSubset: [] };
  }
  const raw = readJson(path) as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items.filter(id => typeof id === "string") : [];
  const pilotSubset = Array.isArray(raw.pilotSubset)
    ? raw.pilotSubset.filter(id => typeof id === "string")
    : [];
  if (raw.taskId !== taskId) errors.push(`${path}: taskId should be "${taskId}".`);
  for (const id of pilotSubset) {
    if (!items.includes(id)) errors.push(`${path}: pilotSubset lists "${id}", which items does not.`);
  }
  return { taskId, items, pilotSubset };
}

function listItemFiles(directory: string) {
  const itemsDir = join(directory, "items");
  if (!existsSync(itemsDir)) return [];
  return readdirSync(itemsDir)
    .filter(name => name.endsWith(".json"))
    .sort();
}

/**
 * Loads and validates one task's items. Adding an item is meant to be dropping
 * a JSON file next to the others and naming it in the manifest; every way of
 * getting that half right is reported here rather than at run time.
 */
function loadDirectory<T>(
  projectRoot: string,
  taskId: string,
  idOf: (item: T) => string,
  parse: (raw: unknown) => { ok: true; value: T } | { ok: false; errors: readonly string[] }
): LoadedItems<T> {
  const errors: string[] = [];
  const directoryName = directoryForTask[taskId];
  if (!directoryName) {
    return {
      taskId,
      directory: "",
      manifest: { taskId, items: [], pilotSubset: [] },
      items: [],
      pilot: [],
      errors: [`No item directory is configured for task "${taskId}".`]
    };
  }

  const directory = join(projectRoot, taskItemRoot, directoryName);
  const manifest = readManifest(directory, taskId, errors);
  const files = listItemFiles(directory);

  const items: T[] = [];
  for (const file of files) {
    const id = basename(file, ".json");
    if (!manifest.items.includes(id)) {
      errors.push(`items/${file} exists but manifest.json does not list "${id}".`);
    }
    let raw: unknown;
    try {
      raw = readJson(join(directory, "items", file));
    } catch (error) {
      errors.push(`items/${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parse(raw);
    if (!parsed.ok) {
      for (const message of parsed.errors) errors.push(`items/${file}: ${message}`);
      continue;
    }
    if (idOf(parsed.value) !== id) {
      errors.push(`items/${file}: the id inside the file must match the file name.`);
    }
    items.push(parsed.value);
  }

  const known = new Set(items.map(idOf));
  for (const id of manifest.items) {
    if (!known.has(id)) errors.push(`manifest.json lists "${id}", but items/${id}.json is missing.`);
  }

  const pilot = manifest.pilotSubset
    .map(id => items.find(item => idOf(item) === id))
    .filter((item): item is T => item != null);

  return { taskId, directory, manifest, items, pilot, errors };
}

export function loadMacGyverItems(projectRoot: string) {
  const loaded = loadDirectory<MacGyverItem>(
    projectRoot,
    "macgyver-problem-solving",
    item => item.itemId,
    parseMacGyverItem
  );
  // The pilot subset has a fixed composition; report a mismatch only once the
  // subset is populated, so an empty repository stays quiet.
  const compositionErrors =
    loaded.pilot.length > 0
      ? pilotCompositionErrors(loaded.pilot).map(problem => `pilotSubset: ${problem}`)
      : [];
  return { ...loaded, errors: [...loaded.errors, ...compositionErrors] };
}

export function loadCs4Instances(projectRoot: string) {
  return loadDirectory<Cs4Instance>(
    projectRoot,
    "cs4-creative-writing",
    instance => instance.instanceId,
    parseCs4Instance
  );
}

/** Participant views only. This is the widest thing the HTTP layer may return. */
export function macgyverViews(items: readonly MacGyverItem[]) {
  return items.map(macgyverView);
}

export function cs4Views(instances: readonly Cs4Instance[], round: number) {
  return instances.map(instance => cs4View(instance, round));
}
