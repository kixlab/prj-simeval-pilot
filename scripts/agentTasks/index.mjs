import { audraTask } from "./audra.mjs";
import { cs4Task } from "./cs4.mjs";
import { macgyverTask } from "./macgyver.mjs";

export const taskAdapters = { audra: audraTask, macgyver: macgyverTask, cs4: cs4Task };

export const taskNames = Object.keys(taskAdapters);

export function taskAdapter(name) {
  const task = taskAdapters[name];
  if (!task) throw new Error(`Unknown task: ${name}. Choose one of ${taskNames.join(", ")}.`);
  return task;
}
