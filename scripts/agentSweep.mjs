#!/usr/bin/env node
// Runs one model under several action strategies, on one or more items of one
// task, and tabulates what each run leaves behind for a linkograph: how many
// replies carried a trace, how long the trace was, and how many changes each
// traced reply covers.
//
// Strategies are interleaved within each item and repeat (one-shot, single,
// multi, one-shot, ...) so drift in a hosted model or a warm local server does
// not line up with one strategy.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driverDefaults, parseArgsWithProfile, resolveOptions, runTrial } from "./agentDriver.mjs";
import { loadEnvLocal } from "./agentModelClients.mjs";
import { formatDuration, strategyNames } from "./agentStrategies.mjs";

const sweepDefaults = {
  ...driverDefaults,
  strategies: strategyNames.join(","),
  // Comma-separated item ids for the text tasks; empty runs the server's default item.
  items: null,
  repeats: 1,
  actorId: null
};

function rowFrom(summary, repeat) {
  return {
    task: summary.task,
    item: summary.itemId,
    strategy: summary.strategy,
    repeat,
    trialId: summary.trialId,
    complete: summary.complete,
    endedBy: summary.endedBy,
    rounds: summary.rounds.map(entry => entry.endedBy).join(" "),
    active: formatDuration(summary.activeMs),
    modelCalls: summary.modelCalls,
    callsPerReply: summary.callsPerReply.join(" "),
    accepted: summary.calls.accepted,
    rejected: summary.calls.rejected,
    skipped: summary.calls.skipped,
    deferredSubmits: summary.calls.deferredSubmits,
    parseFailures: summary.driverAssistance.parseFailures,
    modelErrors: summary.modelErrors,
    hostStalls: summary.hostStalls,
    ruleViolations: summary.ruleViolations,
    tracedReplies: summary.reasoningTrace.repliesWithTrace,
    traceKinds: summary.reasoningTrace.kinds.join(","),
    traceChars: summary.reasoningTrace.traceChars,
    actionsPerTrace: summary.reasoningTrace.artifactActionsPerTracedReply,
    fallbackTurns: summary.fallbackTurns,
    final: JSON.stringify(summary.finalAnswer),
    bundle: summary.exportBundle?.directory ?? null
  };
}

async function main() {
  loadEnvLocal();
  const raw = parseArgsWithProfile(process.argv.slice(2), sweepDefaults);
  const strategies = raw.strategies.split(",").map(name => name.trim()).filter(Boolean);
  const items = raw.items ? raw.items.split(",").map(id => id.trim()).filter(Boolean) : [raw.item];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const out = raw.out ?? join("runs", `sweep-${raw.task}-${stamp}`);
  mkdirSync(out, { recursive: true });

  const rows = [];
  for (let repeat = 1; repeat <= raw.repeats; repeat += 1) {
    for (const item of items) {
      for (const strategy of strategies) {
        const options = resolveOptions({ ...raw, item, strategy, out });
        options.actorId = [raw.actorId ?? options.model, item, strategy, `r${repeat}`].filter(Boolean).join("-");
        console.log(`\n=== ${raw.task}${item ? `/${item}` : ""} · ${strategy} · repeat ${repeat}/${raw.repeats}`);
        try {
          rows.push(rowFrom(await runTrial(options), repeat));
        } catch (error) {
          console.log(`run failed: ${error.message}`);
          rows.push({ task: raw.task, item, strategy, repeat, error: error.message });
        }
      }
    }
  }

  const resolved = resolveOptions({ ...raw, strategy: strategies[0] });
  const file = join(out, "sweep.json");
  writeFileSync(file, JSON.stringify({
    createdAt: new Date().toISOString(),
    task: raw.task,
    provider: resolved.provider,
    model: resolved.model,
    timeLimitSec: resolved.timeLimitSec,
    finalizeWindowSec: resolved.finalizeWindowSec,
    strategies,
    items,
    repeats: raw.repeats,
    rows
  }, null, 2));

  console.log("");
  console.table(rows.map(({ trialId, final, bundle, ...rest }) => rest));
  console.log(`sweep -> ${file}`);
  if (rows.some(row => row.error || !row.complete)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
