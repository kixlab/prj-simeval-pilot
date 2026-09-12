// Model profiles: config/agentModels.json names each model once - provider,
// endpoint, served model name, decoding settings - so a run is `--profile
// qwen3-vl-2b-thinking` rather than five flags retyped per model.

import { readFileSync } from "node:fs";

const profilesFile = new URL("../config/agentModels.json", import.meta.url);

// Documentation fields in a profile; everything else must be a driver option.
const descriptiveKeys = new Set(["serve", "notes"]);

export function loadProfiles(file = profilesFile) {
  return JSON.parse(readFileSync(file, "utf8")).profiles ?? {};
}

/**
 * A profile's settings as driver options. An unknown key is an error rather
 * than silently ignored, so a typo in the config cannot change a run unnoticed.
 */
export function profileOptions(name, allowedKeys, file = profilesFile) {
  const profiles = loadProfiles(file);
  const entry = profiles[name];
  if (!entry) {
    throw new Error(`Unknown profile: ${name}. Profiles in config/agentModels.json: ${Object.keys(profiles).join(", ")}.`);
  }
  const options = {};
  for (const [key, value] of Object.entries(entry)) {
    if (descriptiveKeys.has(key)) continue;
    if (!allowedKeys.has(key)) throw new Error(`Profile ${name}: "${key}" is not a driver option.`);
    options[key] = value;
  }
  return options;
}
