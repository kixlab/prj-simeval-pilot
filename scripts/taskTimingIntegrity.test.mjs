import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsBundle } from "./loadTsBundle.mjs";
import { configuredTiming, driverDefaults, resolveOptions } from "./agentDriver.mjs";
import { taskAdapter, taskNames } from "./agentTasks/index.mjs";

// One timing file for humans and agents: every task has an entry, the human
// screens and the agent driver read the same numbers, and a session override
// is applied, validated, and reported rather than guessed at.

const root = new URL("..", import.meta.url);
const file = JSON.parse(readFileSync(new URL("src/tasks/taskTiming.json", root), "utf8"));
const timing = await loadTsBundle(new URL("src/tasks/timing.ts", root).pathname);
const { formatClock, isTimed, remainingMs, submitOpen, taskTiming, timingFromQuery } = timing;

// Every task the driver can run, and every catalog task, has a limit.
for (const name of taskNames) {
  const { taskId } = taskAdapter(name);
  const entry = file.tasks[taskId];
  assert.ok(entry, `${taskId} needs an entry in taskTiming.json`);
  assert.ok(entry.timeLimitSec >= 0 && entry.finalizeWindowSec >= 0);
  assert.ok(entry.timeLimitSec === 0 || entry.finalizeWindowSec < entry.timeLimitSec);

  // Humans (timing.ts) and agents (the driver) read the same numbers.
  assert.deepEqual(taskTiming(taskId), entry);
  assert.deepEqual(configuredTiming(taskId), entry);
  const resolved = resolveOptions({ ...driverDefaults, task: name, provider: "openai", strategy: "single" });
  assert.equal(resolved.timeLimitSec, entry.timeLimitSec, `${name}: the driver uses the configured limit`);
  assert.equal(resolved.finalizeWindowSec, entry.finalizeWindowSec);
}
assert.equal(file.tasks["cs4-creative-writing"].scope, "round", "CS4 puts a fresh clock on every round");

// A CLI flag still overrides the file for one run; the mock stays untimed.
assert.equal(resolveOptions({ ...driverDefaults, provider: "openai", strategy: "single", timeLimitSec: 120 }).timeLimitSec, 120);
assert.equal(resolveOptions({ ...driverDefaults, provider: "mock", strategy: "single" }).timeLimitSec, 0);

// URL overrides for a human session.
{
  const base = taskTiming("audra-incomplete-shapes");
  const none = timingFromQuery("audra-incomplete-shapes", new URLSearchParams(""));
  assert.deepEqual(none.timing, base);
  assert.equal(none.overridden, false);
  assert.deepEqual(none.problems, []);

  const custom = timingFromQuery("audra-incomplete-shapes", new URLSearchParams("timeLimitSec=420&finalizeWindowSec=90"));
  assert.equal(custom.timing.timeLimitSec, 420);
  assert.equal(custom.timing.finalizeWindowSec, 90);
  assert.equal(custom.overridden, true, "an override is flagged so it is recorded with the trial");

  const typo = timingFromQuery("audra-incomplete-shapes", new URLSearchParams("timeLimitSec=five"));
  assert.equal(typo.timing.timeLimitSec, base.timeLimitSec, "a bad value falls back to the configured one");
  assert.equal(typo.problems.length, 1);

  const window = timingFromQuery("audra-incomplete-shapes", new URLSearchParams("timeLimitSec=60&finalizeWindowSec=90"));
  assert.equal(window.timing.finalizeWindowSec, 60, "a window longer than the limit leaves Submit open throughout");
  assert.equal(window.problems.length, 1);

  const untimed = timingFromQuery("audra-incomplete-shapes", new URLSearchParams("timeLimitSec=0"));
  assert.equal(isTimed(untimed.timing), false);
  assert.equal(submitOpen(untimed.timing, 0), true);
  assert.equal(remainingMs(untimed.timing, 10_000), Infinity);
}

// Submit opens only for the final window, the same rule the driver applies to agents.
{
  const five = { timeLimitSec: 300, finalizeWindowSec: 60, scope: "trial" };
  assert.equal(submitOpen(five, 0), false);
  assert.equal(submitOpen(five, 239_000), false);
  assert.equal(submitOpen(five, 240_000), true);
  assert.equal(remainingMs(five, 61_000), 239_000);
  assert.equal(formatClock(239_000), "3:59");
  assert.equal(formatClock(300_000), "5:00");
  assert.equal(formatClock(-1), "0:00");
}
assert.throws(() => taskTiming("chess"));

console.log("task timing integrity tests passed");
