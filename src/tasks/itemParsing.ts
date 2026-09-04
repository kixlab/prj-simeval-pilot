/**
 * Shared parsing for task item files.
 *
 * Item content arrives as JSON written by hand or exported from a benchmark
 * release, so every field is checked before it reaches a participant. A parse
 * collects all of an item's problems instead of throwing on the first one: the
 * point is to tell whoever is adding items everything that is wrong with a
 * file in one pass.
 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: readonly string[] };

/** Where an item came from. Mirrors the stimulus convention in `src/audra`. */
export type ItemSource = "development" | "official";

export class ParseErrors {
  private readonly errors: string[] = [];

  add(message: string) {
    this.errors.push(message);
  }

  get list(): readonly string[] {
    return this.errors;
  }

  result<T>(value: T): ParseResult<T> {
    return this.errors.length === 0 ? { ok: true, value } : { ok: false, errors: this.errors };
  }
}

export function asObject(raw: unknown, errors: ParseErrors): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.add("The file must contain a JSON object.");
    return {};
  }
  return raw as Record<string, unknown>;
}

export function requireString(
  raw: Record<string, unknown>,
  field: string,
  errors: ParseErrors
): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.add(`${field} must be a non-empty string.`);
    return "";
  }
  return value;
}

export function optionalString(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function requireStringArray(
  raw: Record<string, unknown>,
  field: string,
  errors: ParseErrors,
  options?: { minLength?: number; exactLength?: number; unique?: boolean }
): readonly string[] {
  const value = raw[field];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    errors.add(`${field} must be an array of strings.`);
    return [];
  }
  const list = value as string[];
  if (list.some(entry => entry.trim().length === 0)) {
    errors.add(`${field} must not contain empty strings.`);
  }
  if (options?.exactLength != null && list.length !== options.exactLength) {
    errors.add(`${field} must have exactly ${options.exactLength} entries, not ${list.length}.`);
  }
  if (options?.minLength != null && list.length < options.minLength) {
    errors.add(`${field} needs at least ${options.minLength} entries.`);
  }
  if (options?.unique && new Set(list).size !== list.length) {
    errors.add(`${field} must not repeat an entry.`);
  }
  return list;
}

export function requireSource(raw: Record<string, unknown>, errors: ParseErrors): ItemSource {
  const value = raw.source;
  if (value === "development" || value === "official") return value;
  errors.add('source must be "development" (a fixture) or "official" (real benchmark item).');
  return "development";
}

/** Item ids appear in file names, URLs, and export bundles. */
export function requireId(raw: Record<string, unknown>, field: string, errors: ParseErrors): string {
  const value = requireString(raw, field, errors);
  if (value && !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    errors.add(`${field} must be lowercase letters, digits, and hyphens.`);
  }
  return value;
}
