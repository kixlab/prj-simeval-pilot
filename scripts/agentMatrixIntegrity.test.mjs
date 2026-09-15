import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverDefaults, parseArgsWithProfile, resolveOptions } from "./agentDriver.mjs";
import { isUsable, jobKey, planJobs } from "./agentMatrix.mjs";
import { loadProfiles, profileOptions } from "./agentProfiles.mjs";

// Model profiles and the run matrix: a profile fills the driver's options and a
// flag still wins; the matrix plans every combination once, interleaves
// strategies innermost, and knows which finished runs can be trusted.

const allowed = new Set(Object.keys(driverDefaults));

// Every profile in the shipped config is valid.
for (const name of Object.keys(loadProfiles())) {
  const options = resolveOptions({ ...driverDefaults, ...profileOptions(name, allowed), task: "macgyver", strategy: "multi" });
  assert.ok(options.provider && options.model, `${name} resolves to a provider and a model`);
}

// A profile fills the options; a command-line flag overrides it.
{
  const fromProfile = parseArgsWithProfile(["--profile", "qwen3-vl-2b-thinking", "--task", "cs4"]);
  assert.equal(fromProfile.provider, "local");
  assert.equal(fromProfile.model, "Qwen/Qwen3-VL-2B-Thinking");
  assert.equal(fromProfile.task, "cs4");
  const overridden = parseArgsWithProfile(["--profile", "qwen3-vl-2b-thinking", "--max-tokens", "2048", "--endpoint", "http://gpu:9000/v1/chat/completions"]);
  assert.equal(overridden.maxTokens, 2048);
  assert.equal(overridden.endpoint, "http://gpu:9000/v1/chat/completions");
  assert.equal(parseArgsWithProfile(["--task", "audra"]).provider, driverDefaults.provider, "no profile, no change");
  assert.throws(() => parseArgsWithProfile(["--profile", "no-such-model"]), /Unknown profile/);
}

// A typo in a profile is an error, not a silently ignored setting.
{
  const dir = mkdtempSync(join(tmpdir(), "profiles-"));
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify({ profiles: { bad: { provider: "local", maxTokenz: 10, notes: "fine" } } }));
  assert.throws(() => profileOptions("bad", allowed, file), /maxTokenz/);
}

// The plan: every combination once, strategies innermost.
{
  const jobs = planJobs({
    profiles: ["a", "b"],
    tasks: ["audra", "cs4"],
    strategies: ["one-shot", "single", "multi"],
    repeats: 2,
    itemsByTask: { audra: ["dev-fixture-02"], cs4: ["cs4-sb000", "cs4-sb001"] }
  });
  assert.equal(jobs.length, 2 * 2 * (1 + 2) * 3);
  assert.equal(new Set(jobs.map(job => job.key)).size, jobs.length, "keys are unique");
  assert.deepEqual(jobs.slice(0, 3).map(job => job.strategy), ["one-shot", "single", "multi"]);
  assert.deepEqual(jobs.slice(0, 4).map(job => job.item), ["dev-fixture-02", "dev-fixture-02", "dev-fixture-02", "cs4-sb000"]);
  assert.equal(jobs[0].key, jobKey({ profile: "a", task: "audra", item: "dev-fixture-02", strategy: "one-shot", repeat: 1 }));
  assert.equal(jobs.at(-1).profile, "b");
}

// Which finished runs can be trusted; --resume reruns the rest.
assert.equal(isUsable({ endedBy: "submitted", hostStalls: 0 }), true);
assert.equal(isUsable({ endedBy: "time_limit", hostStalls: 0 }), true, "running out of time is a valid outcome");
assert.equal(isUsable({ endedBy: "submitted", hostStalls: 1 }), false, "a sleeping host invalidates the timing");
assert.equal(isUsable({ endedBy: "trial_lost" }), false);
assert.equal(isUsable({ endedBy: "model_errors" }), false);
assert.equal(isUsable({ error: "boom" }), false);

console.log("agent matrix integrity tests passed");
