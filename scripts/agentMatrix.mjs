#!/usr/bin/env node
// Runs every combination of model profile x task x item x strategy x repeat,
// and keeps a table of what each run left behind for a linkograph.
//
//   npm run agent:matrix -- --profiles qwen3-vl-2b-thinking,internvl3_5-2b --dry-run
//   npm run agent:matrix -- --profiles qwen3-vl-2b-thinking,internvl3_5-2b
//   npm run agent:matrix -- --resume runs/matrix-20260912T010203
//
// Each profile's runs go in sequence - one model, one GPU - while different
// profiles run side by side (`--parallel none` runs everything in sequence).
// Strategies are interleaved innermost, so drift in a model server never lines
// up with one strategy. Results are saved after every run; `--resume` skips the
// runs that already finished cleanly and reruns the rest.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { driverDefaults, parseArgs, resolveOptions, runTrial } from "./agentDriver.mjs";
import { loadEnvLocal } from "./agentModelClients.mjs";
import { profileOptions } from "./agentProfiles.mjs";
import { formatDuration, strategyNames } from "./agentStrategies.mjs";
import { taskAdapter, taskNames } from "./agentTasks/index.mjs";

const matrixDefaults = {
  base: driverDefaults.base,
  profiles: null,
  tasks: taskNames.join(","),
  strategies: strategyNames.join(","),
  // Per task: "pilot" (the manifest's pilot subset), "all", or comma-separated
  // ids. --items applies to every task; --items-<task> overrides one.
  items: "pilot",
  itemsAudra: null,
  itemsMacgyver: null,
  itemsCs4: null,
  repeats: 1,
  parallel: "profiles",
  out: null,
  resume: null,
  dryRun: "false"
};

const allowedDriverKeys = new Set(Object.keys(driverDefaults));
// Runs that did not produce trustworthy data; --resume reruns them.
const failedEndings = new Set(["trial_lost", "server_error", "model_errors"]);

const list = value => String(value ?? "").split(",").map(entry => entry.trim()).filter(Boolean);

export function jobKey(job) {
  return `${job.profile}|${job.task}|${job.item}|${job.strategy}|r${job.repeat}`;
}

/** Profile-major, then repeat, task, item; strategies innermost. */
export function planJobs({ profiles, tasks, strategies, repeats, itemsByTask }) {
  const jobs = [];
  for (const profile of profiles) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const task of tasks) {
        for (const item of itemsByTask[task]) {
          for (const strategy of strategies) {
            const job = { profile, task, item, strategy, repeat };
            jobs.push({ ...job, key: jobKey(job) });
          }
        }
      }
    }
  }
  return jobs;
}

/** A run whose data can be used: it finished, the host stayed awake, the server kept the trial. */
export function isUsable(row) {
  return row != null && !row.error && !(row.hostStalls > 0) && !failedEndings.has(row.endedBy);
}

async function itemsFor(taskName, spec, base) {
  const task = taskAdapter(taskName);
  if (task.id === "audra") {
    return spec === "pilot" || spec === "all" ? [driverDefaults.stimulus] : list(spec);
  }
  if (spec !== "pilot" && spec !== "all") return list(spec);
  const response = await fetch(`${base}/api/tasks/${task.taskId}/items`).catch(error => {
    throw new Error(`The app server at ${base} is not reachable (${error.message}). Start it with npm run dev.`);
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`${task.taskId} items: ${payload.error}`);
  const ids = spec === "pilot" ? payload.pilotSubset : payload.itemIds;
  if (ids.length === 0) throw new Error(`${task.taskId} has no ${spec} items.`);
  return ids;
}

/** Checks every model endpoint and key before the first run, so a matrix does not fail an hour in. */
async function preflight(profiles) {
  const problems = [];
  for (const name of profiles) {
    const options = { ...driverDefaults, ...profileOptions(name, allowedDriverKeys) };
    if (options.provider === "local") {
      const modelsUrl = options.endpoint.replace(/\/chat\/completions\/?$/, "/models");
      try {
        const response = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) problems.push(`${name}: ${modelsUrl} answered ${response.status}.`);
      } catch (error) {
        problems.push(`${name}: no model server at ${modelsUrl} (${error.message}).`);
      }
    } else if (options.provider === "openai" && !process.env.OPENAI_API_KEY) {
      problems.push(`${name}: OPENAI_API_KEY is not set.`);
    } else if (options.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
      problems.push(`${name}: ANTHROPIC_API_KEY is not set.`);
    }
  }
  return problems;
}

function rowFrom(job, summary) {
  return {
    key: job.key,
    profile: job.profile,
    task: job.task,
    item: job.item,
    strategy: job.strategy,
    repeat: job.repeat,
    trialId: summary.trialId,
    model: summary.model,
    endedBy: summary.endedBy,
    complete: summary.complete,
    rounds: summary.rounds.map(entry => entry.endedBy).join(" "),
    activeMs: summary.activeMs,
    modelCalls: summary.modelCalls,
    callsPerReply: summary.callsPerReply.join(" "),
    accepted: summary.calls.accepted,
    rejected: summary.calls.rejected,
    skipped: summary.calls.skipped,
    deferredSubmits: summary.calls.deferredSubmits,
    parseFailures: summary.driverAssistance.parseFailures,
    parseRepairs: summary.driverAssistance.parseRepairs,
    modelErrors: summary.modelErrors,
    hostStalls: summary.hostStalls,
    ruleViolations: summary.ruleViolations,
    tracedReplies: summary.reasoningTrace.repliesWithTrace,
    traceKinds: summary.reasoningTrace.kinds.join(","),
    traceChars: summary.reasoningTrace.traceChars,
    actionsPerTrace: summary.reasoningTrace.artifactActionsPerTracedReply,
    final: JSON.stringify(summary.finalAnswer),
    bundle: summary.exportBundle?.directory ?? null
  };
}

const csvColumns = [
  "key", "profile", "task", "item", "strategy", "repeat", "endedBy", "complete", "rounds", "activeMs",
  "modelCalls", "accepted", "rejected", "skipped", "deferredSubmits", "parseFailures", "parseRepairs",
  "modelErrors", "hostStalls", "ruleViolations", "tracedReplies", "traceKinds", "traceChars", "actionsPerTrace", "final", "error", "bundle"
];

function toCsv(rows) {
  const cell = value => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [csvColumns.join(","), ...rows.map(row => csvColumns.map(column => cell(row[column])).join(","))].join("\n") + "\n";
}

function maxMinutes(job) {
  const options = resolveOptions({ ...driverDefaults, ...profileOptions(job.profile, allowedDriverKeys), task: job.task, strategy: job.strategy });
  return (options.timeLimitSec / 60) * taskAdapter(job.task).rounds;
}

async function main() {
  loadEnvLocal();
  const raw = parseArgs(process.argv.slice(2), matrixDefaults);
  const out = raw.resume ?? raw.out ?? join("runs", `matrix-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`);
  const stateFile = join(out, "matrix.json");
  const previous = raw.resume && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;

  // A resumed matrix keeps its original plan, so resuming cannot quietly change it.
  const config = previous?.config ?? {
    base: raw.base,
    profiles: list(raw.profiles),
    tasks: list(raw.tasks),
    strategies: list(raw.strategies),
    repeats: raw.repeats,
    items: {}
  };
  if (config.profiles.length === 0) throw new Error("--profiles is required: names from config/agentModels.json.");
  for (const task of config.tasks) taskAdapter(task);
  if (!previous) {
    for (const task of config.tasks) {
      const spec = raw[`items${task[0].toUpperCase()}${task.slice(1)}`] ?? raw.items;
      config.items[task] = await itemsFor(task, spec, config.base);
    }
  }

  const jobs = planJobs({ ...config, itemsByTask: config.items });
  const rows = previous?.rows ?? [];
  const done = new Set(rows.filter(isUsable).map(row => row.key));
  const pending = jobs.filter(job => !done.has(job.key));

  const byProfile = new Map(config.profiles.map(profile => [profile, pending.filter(job => job.profile === profile)]));
  console.log(`matrix -> ${out}`);
  console.log(`${jobs.length} runs planned, ${done.size} already done, ${pending.length} to go`);
  for (const [profile, queue] of byProfile) {
    const minutes = queue.reduce((sum, job) => sum + maxMinutes(job), 0);
    console.log(`  ${profile}: ${queue.length} runs, at most ${formatDuration(minutes * 60_000)}`);
  }
  for (const task of config.tasks) console.log(`  ${task} items: ${config.items[task].join(", ")}`);
  if (raw.dryRun !== "false") return;

  const problems = await preflight(config.profiles);
  if (problems.length > 0) throw new Error(`Not starting:\n  ${problems.join("\n  ")}`);

  mkdirSync(out, { recursive: true });
  const save = () => {
    writeFileSync(stateFile, JSON.stringify({ createdAt: previous?.createdAt ?? new Date().toISOString(), config, rows }, null, 2));
    writeFileSync(join(out, "matrix.csv"), toCsv(rows));
  };
  save();

  const runJob = async job => {
    const log = line => console.log(`[${job.profile}] ${line}`);
    const task = taskAdapter(job.task);
    const options = resolveOptions({
      ...driverDefaults,
      ...profileOptions(job.profile, allowedDriverKeys),
      task: job.task,
      strategy: job.strategy,
      base: config.base,
      out: join(out, job.profile),
      item: task.id === "audra" ? null : job.item,
      stimulus: task.id === "audra" ? job.item : driverDefaults.stimulus,
      actorId: `${job.profile}-${job.task}-${job.item}-${job.strategy}-r${job.repeat}`
    });
    log(`=== ${job.key}`);
    let row;
    try {
      row = rowFrom(job, await runTrial(options, { log }));
    } catch (error) {
      log(`run failed: ${error.message}`);
      row = { key: job.key, profile: job.profile, task: job.task, item: job.item, strategy: job.strategy, repeat: job.repeat, error: error.message };
    }
    const index = rows.findIndex(existing => existing.key === job.key);
    if (index === -1) rows.push(row);
    else rows[index] = row;
    save();
  };

  const queues = raw.parallel === "none" ? [pending] : [...byProfile.values()];
  await Promise.all(queues.map(async queue => {
    for (const job of queue) await runJob(job);
  }));

  const unusable = rows.filter(row => !isUsable(row));
  console.log(`\nfinished: ${rows.length - unusable.length}/${jobs.length} usable runs -> ${stateFile}`);
  if (unusable.length > 0) {
    console.log(`${unusable.length} to rerun: npm run agent:matrix -- --resume ${out}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
