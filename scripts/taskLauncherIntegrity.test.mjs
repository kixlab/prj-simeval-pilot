import assert from "node:assert/strict";
import { loadTsBundle } from "./loadTsBundle.mjs";

const routing = await loadTsBundle(new URL("../src/tasks/routing.ts", import.meta.url).pathname);
const catalog = await loadTsBundle(new URL("../src/tasks/catalog.ts", import.meta.url).pathname);
const { readMode, resolveRoute, excalidrawModeName, launcherModeName } = routing;
const { listTasks, taskByMode, taskById, taskHref } = catalog;

const implemented = new Set(["audra-incomplete-shapes", "macgyver-problem-solving"]);
const route = (mode, modes = implemented) => resolveRoute(mode, modes);

// ---------------------------------------------------------------------------
// The catalog is the single source of task identity.

const tasks = listTasks();
assert.equal(tasks.length, 3, "the pilot collects three tasks");
assert.equal(new Set(tasks.map(task => task.taskId)).size, 3, "task ids are unique");
assert.equal(new Set(tasks.map(task => task.mode)).size, 3, "task modes are unique");

for (const task of tasks) {
  assert.equal(taskById(task.taskId), task);
  assert.equal(taskByMode(task.mode), task);
  assert.ok(task.outputs.length > 0, `${task.taskId} states what a trial produces`);
  assert.ok(task.reference.length > 0, `${task.taskId} names its instrument`);
  // A task nobody can run yet must say what is missing, because the
  // description page is all a participant or a reviewer sees of it.
  if (task.status === "planned") {
    assert.ok(task.remaining.length > 0, `${task.taskId} states what is still missing`);
  }
}

// Only tasks that have a screen may claim to be available.
for (const task of tasks) {
  assert.equal(
    task.status === "available",
    implemented.has(task.mode),
    `${task.taskId}: catalog status and implemented screens disagree`
  );
}

// ---------------------------------------------------------------------------
// A participant id typed on the launcher survives into the task URL.

const audra = taskByMode("audra-incomplete-shapes");
assert.equal(taskHref(audra), "/?mode=audra-incomplete-shapes");
assert.equal(taskHref(audra, { participantId: " p001 " }), "/?mode=audra-incomplete-shapes&participant=p001");
assert.equal(taskHref(audra, { participantId: "   " }), "/?mode=audra-incomplete-shapes");

// ---------------------------------------------------------------------------
// Mode resolution. The agent host URL and the human deep link must keep
// meaning exactly what they meant before the launcher existed.

assert.deepEqual(readMode({ search: "?mode=audra-incomplete-shapes", pathname: "/" }), "audra-incomplete-shapes");
assert.deepEqual(readMode({ search: "", pathname: "/audra-incomplete-shapes" }), "audra-incomplete-shapes");
assert.deepEqual(readMode({ search: "", pathname: "/" }), "");
// `?mode=` wins over the path so a host URL is never reinterpreted by it.
assert.deepEqual(readMode({ search: "?mode=launcher", pathname: "/audra-incomplete-shapes" }), "launcher");

const hostMode = readMode({
  search: "?mode=audra-incomplete-shapes&trialId=trial-9&token=abc",
  pathname: "/"
});
assert.deepEqual(route(hostMode), { screen: "task", task: audra });

assert.deepEqual(route(""), { screen: "launcher" });
assert.deepEqual(route(launcherModeName), { screen: "launcher" });
assert.deepEqual(route(excalidrawModeName), { screen: "excalidraw-session" });
assert.deepEqual(route("no-such-task"), { screen: "launcher", unknownMode: "no-such-task" });

for (const task of tasks.filter(item => item.status === "planned")) {
  assert.deepEqual(route(task.mode), { screen: "task-placeholder", task, markedAvailable: false });
}

// A task marked available but missing its screen is reported, never silently
// served as a description page that looks like a plan.
assert.deepEqual(route("audra-incomplete-shapes", new Set()), {
  screen: "task-placeholder",
  task: audra,
  markedAvailable: true
});

console.log("task launcher integrity tests passed");
