// Turns a sweep's reasoning logs into one readable document.
//
//   node scripts/reasoningDigest.mjs runs/sweep-mg-v2 [--out path.md] [--chars 0]
//
// A reasoning.jsonl holds one JSON object per model call, which is exactly the
// wrong shape for reading. This rewrites a whole sweep as prose: what the model
// was told to do, what it thought, and what it actually did, turn by turn, with
// the strategies side by side.
//
// `--chars N` truncates each trace to N characters (0, the default, keeps all).

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith("--"));
const flag = name => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
if (!dir) {
  console.error("usage: node scripts/reasoningDigest.mjs <run directory> [--out file.md] [--chars N]");
  process.exit(1);
}
const limit = Number(flag("chars") ?? 0);
const outFile = flag("out") ?? join(dir, "reasoning.md");

const strategyOrder = ["one-shot", "single", "multi"];
const seconds = ms => (ms == null ? "?" : `${Math.round(ms / 1000)}s`);
const clip = text => (limit > 0 && text.length > limit ? `${text.slice(0, limit)}…` : text);

/** One line per call: what the model did, and whether the server took it. */
function actionLine(call, index) {
  const detail = call.pointCount != null ? ` (${call.pointCount} points)` : "";
  const status = call.status === "accepted" ? "" : ` — **${call.status}**`;
  return `${index + 1}. \`${call.tool}\`${detail}${status}`;
}

const trials = readdirSync(dir)
  .filter(name => name.endsWith(".run.json"))
  .map(name => {
    const run = JSON.parse(readFileSync(join(dir, name), "utf8"));
    const traceFile = join(dir, name.replace(".run.json", ".reasoning.jsonl"));
    const calls = existsSync(traceFile)
      ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
    return { run, calls };
  })
  .sort((a, b) => strategyOrder.indexOf(a.run.strategy) - strategyOrder.indexOf(b.run.strategy));

if (trials.length === 0) {
  console.error(`No .run.json files in ${dir}`);
  process.exit(1);
}

const first = trials[0].run;
const out = [];
out.push(`# Reasoning digest — ${first.task} / ${first.itemId}`);
out.push("");
out.push(`Model \`${first.model}\` (${first.provider}), ${trials.length} strategies, from \`${dir}\`.`);
out.push("");
out.push("The trace is what the model reported thinking, not its raw thinking: on this");
out.push("provider it is a summary the API returns. Empty turns are replies that carried");
out.push("no trace at all.");
out.push("");

// --- One table, so the strategies can be compared before reading any of them.
out.push("| Strategy | Model calls | Active | Actions | Rule violations | Trace chars |");
out.push("| --- | --- | --- | --- | --- | --- |");
for (const { run, calls } of trials) {
  const traceChars = calls.reduce((sum, call) => sum + (call.reasoningContent?.length ?? 0), 0);
  out.push(
    `| ${run.strategy} | ${run.modelCalls} | ${seconds(run.activeMs)} | ${run.calls?.accepted ?? "?"} accepted` +
      ` | ${run.ruleViolations} | ${traceChars.toLocaleString()} |`
  );
}
out.push("");

for (const { run, calls } of trials) {
  out.push("---");
  out.push("");
  out.push(`## ${run.strategy}`);
  out.push("");
  const answer = run.finalAnswer?.text;
  if (answer) {
    out.push(`**Final answer.** ${answer}`);
    out.push("");
  }
  if (run.rounds?.length > 1) {
    out.push(`**Rounds.** ${run.rounds.map(r => `${r.round}: ${r.endedBy} (${seconds(r.activeMs)}, ${r.modelCalls} calls)`).join(" · ")}`);
    out.push("");
  }

  for (const call of calls) {
    const heading = run.rounds?.length > 1 ? `Round ${call.round}, turn ${call.turn}` : `Turn ${call.turn}`;
    out.push(`### ${heading}`);
    out.push("");
    if (call.parseError) {
      out.push(`> **Reply refused** (\`${call.parseCode ?? "unreadable"}\`): ${call.parseError}`);
      out.push("");
    }
    if (call.reasoningContent) {
      // The trace's own bold headings survive as-is; blockquote keeps it apart
      // from the actions, which are this file's voice rather than the model's.
      for (const line of clip(call.reasoningContent).trim().split("\n")) out.push(`> ${line}`);
      out.push("");
    } else if (!call.parseError) {
      out.push("_No trace on this reply._");
      out.push("");
    }
    const actions = call.calls ?? [];
    if (actions.length > 0) {
      out.push(actions.length === 1 ? "**Action**" : `**Actions** (${actions.length})`);
      out.push("");
      // A long batch is summarised by tool rather than listed one by one.
      if (actions.length > 12) {
        const tally = {};
        for (const action of actions) tally[action.tool] = (tally[action.tool] ?? 0) + 1;
        out.push(Object.entries(tally).map(([tool, count]) => `\`${tool}\` ×${count}`).join(", "));
      } else {
        for (const [index, action] of actions.entries()) out.push(actionLine(action, index));
      }
      out.push("");
    }
  }
}

writeFileSync(outFile, `${out.join("\n")}\n`);
console.log(`${outFile} — ${trials.length} trials, ${trials.reduce((n, t) => n + t.calls.length, 0)} model calls`);
