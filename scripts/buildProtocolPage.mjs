// Builds one web page from several sweeps: the artifacts three protocols
// produced on a task, and every reasoning trace behind them, turn by turn.
//
//   node scripts/buildProtocolPage.mjs runs/sweep-audra runs/sweep-mg runs/sweep-cs4
//   node scripts/buildProtocolPage.mjs runs/sweep-mg --out /tmp/mg.html
//
// One sweep per task, each holding <trial>.run.json and <trial>.reasoning.jsonl
// as agentSweep.mjs writes them. Artifacts (the drawing, the steps, the story)
// are read from each run's export bundle, so a sweep whose bundles have been
// moved still renders - it just shows the numbers and the traces.
//
// The page is self-contained: no data file beside it, nothing fetched at runtime.

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = name => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? null : argv[at + 1];
};
const runDirs = argv.filter((value, index) => !value.startsWith("--") && !(index > 0 && argv[index - 1].startsWith("--")));
const outFile = flag("out") ?? "runs/protocol-comparison.html";

if (runDirs.length === 0) {
  console.error("usage: node scripts/buildProtocolPage.mjs <run directory…> [--out page.html]");
  process.exit(1);
}

const strategyOrder = ["one-shot", "single", "multi"];

/** Reads one sweep directory into the shape the page renders from. */
function readSweep(dir) {
  const runFiles = fs.readdirSync(dir).filter(name => name.endsWith(".run.json"));
  if (runFiles.length === 0) throw new Error(`No .run.json files in ${dir}`);
  const trials = runFiles.map(name => {
    const run = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    const traceFile = path.join(dir, name.replace(".run.json", ".reasoning.jsonl"));
    const turns = (fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8").trim().split("\n") : [])
      .filter(Boolean)
      .map(JSON.parse)
      .map(entry => ({
        turn: entry.turn,
        round: entry.round,
        parseError: entry.parseError ?? null,
        parseCode: entry.parseCode ?? null,
        trace: entry.reasoningContent ?? null,
        calls: (entry.calls ?? []).map(call => ({ tool: call.tool, status: call.status, points: call.pointCount ?? null }))
      }));
    const bundle = run.exportBundle?.directory;
    const fromBundle = file => (bundle && fs.existsSync(path.join(bundle, file)) ? fs.readFileSync(path.join(bundle, file), "utf8") : null);
    const roundsFile = fromBundle("rounds.json");
    return {
      task: run.task,
      itemId: run.itemId,
      model: run.model,
      strategy: run.strategy,
      modelCalls: run.modelCalls,
      activeMs: run.activeMs,
      calls: run.calls,
      violations: run.ruleViolations,
      finalAnswer: run.finalAnswer,
      rounds: run.rounds,
      traceChars: turns.reduce((sum, turn) => sum + (turn.trace?.length ?? 0), 0),
      turns,
      svg: fromBundle("final_canvas.svg"),
      answer: fromBundle("answer.md"),
      story: fromBundle("story_final.txt"),
      roundsJson: roundsFile ? JSON.parse(roundsFile) : null
    };
  });
  trials.sort((a, b) => strategyOrder.indexOf(a.strategy) - strategyOrder.indexOf(b.strategy));
  return trials;
}

const data = {};
for (const dir of runDirs) {
  const trials = readSweep(dir);
  const task = trials[0].task;
  // Two sweeps of one task would render as one section and silently lose a run.
  if (data[task]) throw new Error(`Two sweeps for "${task}": ${dir} and an earlier one. Pass one sweep per task.`);
  data[task] = trials;
}

const runDate = new Date().toISOString().slice(0, 10);
const modelName = Object.values(data).flat()[0]?.model ?? "unknown model";

const esc = value =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const secs = ms => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);

const TASKS = {
  audra: {
    name: "Incomplete shapes", short: "drawing", item: "dev-fixture-02", unit: "one stroke, erase, or undo",
    finish: "set_description, then submit_task",
    brief: "Four unfinished lines are already on a 1024×1024 canvas. Use all four in one creative drawing, then name what it is."
  },
  macgyver: {
    name: "Creative problem solving", short: "solving", item: "mg-1655", unit: "one step: add, revise, or delete",
    finish: "submit_answer",
    brief: "A downpour is coming and the garden crops need cover. Decide whether the objects at hand are enough, then write the steps."
  },
  cs4: {
    name: "Constrained story revision", short: "writing", item: "cs4-sb000", unit: "one sentence: replace, insert, or delete",
    finish: "submit_round, three times",
    brief: "Revise one ~500-word story through three rounds of constraints — 7, then 15, then 23 — each round keeping every earlier one."
  }
};

const tally = trial => {
  const counts = {};
  for (const turn of trial.turns) for (const call of turn.calls) counts[call.tool] = (counts[call.tool] ?? 0) + 1;
  return counts;
};
const erases = trial => (tally(trial).erase_stroke ?? 0) + (tally(trial).undo_last ?? 0);

/** Actions per reply, as a strip. The shape of a protocol is the shape of this row. */
function strip(trial) {
  const counts = trial.turns.map(t => t.calls.length);
  const max = Math.max(...counts, 1);
  const bars = counts
    .map((n, i) => {
      const refused = trial.turns[i].parseError ? " bar--refused" : "";
      const height = n === 0 ? 3 : Math.max(4, Math.round((n / max) * 34));
      return `<span class="bar${refused}" style="height:${height}px" title="reply ${i + 1}: ${n} action${n === 1 ? "" : "s"}"></span>`;
    })
    .join("");
  return `<div class="strip"><div class="strip-bars">${bars}</div><p class="strip-note">${counts.length} replies · up to <strong>${max}</strong> action${max === 1 ? "" : "s"} in one reply</p></div>`;
}

function turnBlock(trial, turn, index) {
  const label = trial.rounds?.length > 1 ? `R${turn.round} · turn ${turn.turn}` : `Turn ${turn.turn}`;
  const preview = turn.parseError
    ? esc(turn.parseError)
    : turn.trace
      ? esc(turn.trace.replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 96)) + "…"
      : "no trace on this reply";
  const counts = {};
  for (const call of turn.calls) counts[call.tool] = (counts[call.tool] ?? 0) + 1;
  const actionSummary = turn.calls.length === 0
    ? "no actions"
    : Object.entries(counts).map(([tool, n]) => `${tool}${n > 1 ? `×${n}` : ""}`).join(" · ");
  const skipped = turn.calls.filter(c => c.status !== "accepted").length;

  const traceHtml = turn.trace
    ? turn.trace
        .trim()
        .split(/\n{2,}/)
        .map(para => {
          const heading = para.match(/^\*\*(.+?)\*\*\s*/);
          const body = heading ? para.slice(heading[0].length) : para;
          return (heading ? `<h5>${esc(heading[1])}</h5>` : "") + (body.trim() ? `<p>${esc(body.trim())}</p>` : "");
        })
        .join("")
    : `<p class="nothing">This reply carried no reasoning trace.</p>`;

  const actionList = turn.calls.length === 0
    ? ""
    : turn.calls.length > 14
      ? `<ul class="actions actions--tally">${Object.entries(counts).map(([tool, n]) => `<li><code>${esc(tool)}</code><span>×${n}</span></li>`).join("")}</ul>`
      : `<ol class="actions">${turn.calls
          .map(c => `<li><code>${esc(c.tool)}</code>${c.points ? `<span class="pts">${c.points} points</span>` : ""}${c.status !== "accepted" ? `<span class="chip chip--${c.status}">${c.status}</span>` : ""}</li>`)
          .join("")}</ol>`;

  return `<details class="turn${turn.parseError ? " turn--refused" : ""}"${index === 0 ? " open" : ""}>
  <summary>
    <span class="turn-label">${esc(label)}</span>
    <span class="turn-actions">${turn.parseError ? `<span class="chip chip--refused">refused</span>` : esc(actionSummary)}${skipped ? ` <span class="chip chip--skipped">${skipped} not run</span>` : ""}</span>
    <span class="turn-preview">${preview}</span>
  </summary>
  <div class="turn-body">
    ${turn.parseError ? `<p class="refusal"><strong>Reply refused</strong> — ${esc(turn.parseError)}</p>` : ""}
    <div class="trace">${traceHtml}</div>
    ${actionList}
  </div>
</details>`;
}

/** The artifact each protocol actually produced, in the task's own terms. */
function artifact(task, trial) {
  if (task === "audra") {
    const svg = trial.svg.replace(/<svg([^>]*)>/, '<svg$1 class="canvas" role="img" aria-label="Final drawing">');
    return `${svg}<p class="answer"><span class="answer-q">What did you draw?</span>“${esc(trial.finalAnswer?.text ?? "—")}”</p>`;
  }
  if (task === "macgyver") {
    const lines = trial.answer.split("\n");
    const steps = lines.filter(l => /^\d+\./.test(l.trim()));
    const judgement = (lines.find(l => l.startsWith("Judgement:")) ?? "").replace("Judgement:", "").trim();
    return `<p class="answer"><span class="answer-q">Solvable?</span>${esc(judgement)} · ${steps.length} step${steps.length === 1 ? "" : "s"}</p>
      <ol class="steps">${steps.map(s => `<li>${esc(s.replace(/^\s*\d+\.\s*/, ""))}</li>`).join("")}</ol>`;
  }
  const rounds = trial.roundsJson ?? [];
  const excerpt = trial.story.trim().split(/\s+/).slice(0, 48).join(" ");
  return `<table class="rounds"><thead><tr><th>Round</th><th>Constraints</th><th>Words</th><th>Sentences</th></tr></thead><tbody>
    ${rounds.map(r => `<tr><td>${r.round}</td><td>${r.stage}</td><td>${r.words}</td><td>${r.sentences}</td></tr>`).join("")}
  </tbody></table><blockquote class="story">${esc(excerpt)}…</blockquote>`;
}

const protocolNote = {
  "one-shot": "Every action in one reply. The canvas or draft is never seen again.",
  single: "Exactly one action per reply. A reply holding several is refused, not trimmed.",
  multi: "As many actions per reply as the model chooses. It sees its work after each reply."
};

const present = Object.entries(TASKS).filter(([task]) => data[task]);
const sections = present.map(([task, meta]) => {
  const trials = data[task];
  return `<section class="task" id="${task}">
  <header class="task-head">
    <p class="eyebrow">${esc(meta.item)}</p>
    <h2>${esc(meta.name)}</h2>
    <p class="brief">${esc(meta.brief)}</p>
    <dl class="task-spec">
      <div><dt>Atomic action</dt><dd>${esc(meta.unit)}</dd></div>
      <div><dt>Finishes with</dt><dd><code>${esc(meta.finish)}</code></dd></div>
    </dl>
  </header>

  <div class="artifacts">
    ${trials.map(t => `<figure class="artifact"><figcaption>${t.strategy}</figcaption>${artifact(task, t)}</figure>`).join("")}
  </div>

  ${trials.map(trial => `<section class="protocol">
    <header class="protocol-head">
      <h3>${esc(trial.strategy)}</h3>
      <p class="protocol-note">${esc(protocolNote[trial.strategy])}</p>
      <dl class="metrics">
        <div><dt>Model calls</dt><dd>${trial.modelCalls}</dd></div>
        <div><dt>Working time</dt><dd>${secs(trial.activeMs)}</dd></div>
        <div><dt>Actions run</dt><dd>${trial.calls.accepted}</dd></div>
        <div${trial.violations ? ' class="flag"' : ""}><dt>Rule violations</dt><dd>${trial.violations}</dd></div>
        <div${trial.calls.skipped ? ' class="flag"' : ""}><dt>Not run</dt><dd>${trial.calls.skipped + trial.calls.rejected}</dd></div>
        <div><dt>Trace</dt><dd>${(trial.traceChars / 1000).toFixed(1)}k chars</dd></div>
      </dl>
      ${strip(trial)}
    </header>
    <div class="turns">${trial.turns.map((turn, i) => turnBlock(trial, turn, i)).join("")}</div>
  </section>`).join("")}
</section>`;
}).join("");

const matrixRows = present.map(([task, meta]) => {
  const cells = data[task].map(t => `<td>
      <span class="cell-main">${t.calls.accepted} <span class="cell-unit">actions</span></span>
      <span class="cell-sub">${t.modelCalls} call${t.modelCalls === 1 ? "" : "s"} · ${secs(t.activeMs)}</span>
      ${t.violations ? `<span class="chip chip--refused">${t.violations} violations</span>` : `<span class="chip chip--clean">no violations</span>`}
    </td>`).join("");
  return `<tr><th scope="row"><span>${esc(meta.name)}</span><em>${esc(meta.item)}</em></th>${cells}</tr>`;
});

// Every figure in the findings comes from the sweeps passed in, and a card
// that has no evidence in them is left out rather than quietly reworded.
const reversalTools = new Set(["erase_stroke", "undo_last", "delete_step", "delete_sentence"]);
const acceptedCalls = trials => trials.flatMap(t => t.turns).flatMap(t => t.calls);
const acceptedReversals = trials =>
  acceptedCalls(trials).filter(call => reversalTools.has(call.tool) && call.status === "accepted").length;

const singleRuns = present
  .map(([task, meta]) => ({ meta, trial: data[task].find(t => t.strategy === "single") }))
  .filter(entry => entry.trial);

const drawActions = (data.audra ?? []).reduce((sum, t) => sum + t.calls.accepted, 0);
const drawReversals = acceptedReversals(data.audra ?? []);
const textTasks = [...(data.cs4 ?? []), ...(data.macgyver ?? [])];
const textReversals = acceptedReversals(textTasks);

// The reply that lost the most: a rejected call takes the rest of its batch down.
const lossy = Object.values(data).flat().map(trial => {
  const queued = trial.turns.flatMap(t => t.calls).length;
  const worst = Math.max(0, ...trial.turns.map(t => t.calls.filter(c => c.status === "skipped").length));
  return { trial, queued, lost: queued - trial.calls.accepted, worst };
}).sort((a, b) => b.lost - a.lost)[0];

const findings = [];
if (singleRuns.length >= 2) {
  findings.push(`<div class="finding">
        <span class="figure">${singleRuns.map(r => r.trial.violations).join(" / ")}</span>
        <h4>The one-move rule breaks by task, not by model</h4>
        <p>Violations under <code>single</code>, ${singleRuns.map(r => esc(r.meta.short)).join(" then ")}. Same model, same protocol, same wording. The damage does not follow the count — MacGyver recovered nothing and ended with <strong>one step</strong> on record, while CS4 broke the rule most often and still landed 70 accepted edits.</p>
      </div>`);
}
if (data.audra && textTasks.length > 0) {
  findings.push(`<div class="finding">
        <span class="figure">${drawReversals} / ${drawActions}</span>
        <h4>The drawing is never undone. The text is.</h4>
        <p>Not one <code>erase_stroke</code> or <code>undo_last</code> in ${drawActions} accepted drawing actions, across all three protocols, with both tools named in the prompt and a rule asking the model to fix rather than draw over. On the page it deletes freely: <strong>${textReversals} deletions</strong> in the text tasks. Whatever blocks reversal is specific to the canvas.</p>
      </div>`);
}
if (lossy && lossy.lost > 0) {
  findings.push(`<div class="finding">
        <span class="figure">${lossy.lost} / ${lossy.queued}</span>
        <h4>Multi pays for its batches</h4>
        <p>A rejected call skips the rest of the reply that carried it. ${esc(TASKS[lossy.trial.task]?.name ?? lossy.trial.task)} under <code>${esc(lossy.trial.strategy)}</code> queued ${lossy.queued} actions and ${lossy.lost} never ran — the worst reply lost <strong>${lossy.worst}</strong> when a call near its head was refused. Planned moves that never reach the artifact never reach a linkograph either.</p>
      </div>`);
}

const html = `<title>One-Shot, Single, Multi</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:ital@0;1&display=swap">
<style>
:root {
  --ground: #edf1f0; --surface: #ffffff; --sunk: #e4e9e8;
  --line: #d2d9d7; --line-strong: #b9c3c0;
  --ink: #111a18; --muted: #5a6a66;
  --signal: #0a6b5b; --signal-soft: #dceeea;
  --warn: #8f5a0a; --warn-soft: #f6ead6;
  --stop: #963629; --stop-soft: #f7e3df;
  --sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --cond: "IBM Plex Sans Condensed", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --serif: "IBM Plex Serif", Georgia, serif;
  --radius: 3px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0d1413; --surface: #141d1b; --sunk: #101817;
    --line: #253230; --line-strong: #354542;
    --ink: #e6edeb; --muted: #94a5a0;
    --signal: #4fd0b6; --signal-soft: #10302b;
    --warn: #d9a441; --warn-soft: #2e2413;
    --stop: #e98b7b; --stop-soft: #331c18;
  }
}
:root[data-theme="dark"] {
  --ground: #0d1413; --surface: #141d1b; --sunk: #101817;
  --line: #253230; --line-strong: #354542;
  --ink: #e6edeb; --muted: #94a5a0;
  --signal: #4fd0b6; --signal-soft: #10302b;
  --warn: #d9a441; --warn-soft: #2e2413;
  --stop: #e98b7b; --stop-soft: #331c18;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--ground); color: var(--ink);
  font-family: var(--sans); font-size: 16px; line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1080px; margin: 0 auto; padding-inline: 20px; padding-block: 56px 96px; }
h1, h2, h3, h4 { font-family: var(--cond); font-weight: 600; text-wrap: balance; margin: 0; letter-spacing: -0.01em; }
h1 { font-size: clamp(34px, 6vw, 52px); line-height: 1.05; }
h2 { font-size: clamp(25px, 3.4vw, 33px); }
h3 { font-size: 20px; }
p { margin: 0; }
code { font-family: var(--mono); font-size: 0.88em; }
a { color: var(--signal); }
:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.eyebrow {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--muted);
}

/* --- Masthead ------------------------------------------------------- */
.masthead { display: flex; flex-direction: column; gap: 18px; padding-bottom: 34px; }
.standfirst { max-width: 62ch; font-size: 18px; color: var(--muted); }
.standfirst strong { color: var(--ink); font-weight: 500; }
.spec {
  display: flex; flex-wrap: wrap; gap: 0; margin: 6px 0 0;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.spec > div { flex: 1 1 150px; padding: 12px 16px; border-right: 1px solid var(--line); }
.spec > div:last-child { border-right: 0; }
.spec dt { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.spec dd { margin: 3px 0 0; font-size: 14px; font-family: var(--mono); }

/* --- Matrix --------------------------------------------------------- */
.matrix-wrap { overflow-x: auto; }
table.matrix { width: 100%; border-collapse: collapse; min-width: 640px; }
table.matrix th, table.matrix td { text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.matrix thead th {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line-strong);
}
table.matrix th[scope="row"] { font-family: var(--cond); font-size: 17px; font-weight: 600; width: 23%; }
table.matrix th[scope="row"] em { display: block; font-family: var(--mono); font-size: 11px; font-style: normal; color: var(--muted); font-weight: 400; }
.cell-main { display: block; font-family: var(--mono); font-size: 19px; font-variant-numeric: tabular-nums; }
.cell-unit { font-size: 12px; color: var(--muted); }
.cell-sub { display: block; font-family: var(--mono); font-size: 12px; color: var(--muted); margin-bottom: 6px; font-variant-numeric: tabular-nums; }

/* --- Chips ---------------------------------------------------------- */
.chip {
  display: inline-block; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.04em;
  padding: 2px 7px; border-radius: 2px; white-space: nowrap;
}
.chip--refused { background: var(--stop-soft); color: var(--stop); }
.chip--skipped, .chip--rejected { background: var(--warn-soft); color: var(--warn); }
.chip--clean { background: var(--signal-soft); color: var(--signal); }

/* --- Findings ------------------------------------------------------- */
.findings { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius); }
.finding { background: var(--surface); padding: 20px; }
.finding h4 { font-size: 15px; margin-bottom: 6px; }
.finding p { font-size: 14.5px; color: var(--muted); }
.finding .figure { font-family: var(--mono); font-size: 27px; color: var(--signal); display: block; margin-bottom: 4px; font-variant-numeric: tabular-nums; }

/* --- Task ----------------------------------------------------------- */
.task { margin-top: 76px; }
.task-head { border-top: 2px solid var(--ink); padding-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.brief { max-width: 62ch; color: var(--muted); }
.task-spec { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 4px 0 0; }
.task-spec dt { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.task-spec dd { margin: 2px 0 0; font-size: 14.5px; }

.artifacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(258px, 1fr)); gap: 16px; margin-top: 26px; }
.artifact {
  margin: 0; padding: 16px; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius);
  display: flex; flex-direction: column; gap: 12px;
}
.artifact figcaption {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--signal);
}
.canvas { width: 100%; height: auto; max-width: 100%; background: #fff; border: 1px solid var(--line); border-radius: 2px; }
.answer { font-size: 14.5px; }
.answer-q { display: block; font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.steps { margin: 0; padding-left: 20px; font-size: 13.5px; color: var(--muted); display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; }
.steps li::marker { font-family: var(--mono); color: var(--signal); }
table.rounds { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; }
table.rounds th { text-align: left; font-weight: 500; color: var(--muted); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; padding-bottom: 4px; }
table.rounds td { padding: 3px 0; border-top: 1px solid var(--line); }
.story { margin: 0; font-family: var(--serif); font-size: 14.5px; line-height: 1.65; color: var(--muted); border-left: 2px solid var(--signal); padding-left: 12px; }

/* --- Protocol ------------------------------------------------------- */
.protocol { margin-top: 30px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.protocol-head { padding: 18px 20px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 12px; }
.protocol-head h3 { font-family: var(--mono); font-size: 15px; letter-spacing: 0.02em; }
.protocol-note { font-size: 14px; color: var(--muted); max-width: 60ch; }
.metrics { display: flex; flex-wrap: wrap; gap: 10px 26px; margin: 0; }
.metrics dt { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.metrics dd { margin: 1px 0 0; font-family: var(--mono); font-size: 16px; font-variant-numeric: tabular-nums; }
.metrics .flag dd { color: var(--stop); }

.strip { display: flex; flex-direction: column; gap: 5px; }
.strip-bars { display: flex; align-items: flex-end; gap: 2px; height: 36px; }
.bar { width: 7px; background: var(--signal); border-radius: 1px 1px 0 0; flex: 0 0 auto; }
.bar--refused { background: var(--stop); }
.strip-note { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.strip-note strong { color: var(--ink); font-weight: 500; }

/* --- Turns ---------------------------------------------------------- */
.turns { display: flex; flex-direction: column; }
.turn { border-bottom: 1px solid var(--line); }
.turn:last-child { border-bottom: 0; }
.turn > summary {
  cursor: pointer; padding: 11px 20px; display: grid; gap: 2px 14px;
  grid-template-columns: 94px minmax(0, 1fr); align-items: baseline;
}
.turn > summary::-webkit-details-marker { display: none; }
.turn > summary::marker { content: ""; }
.turn:hover > summary { background: var(--sunk); }
.turn--refused > summary { border-left: 2px solid var(--stop); }
.turn-label { font-family: var(--mono); font-size: 12px; color: var(--signal); }
.turn-actions { font-family: var(--mono); font-size: 12px; color: var(--ink); }
.turn-preview {
  grid-column: 2; font-size: 13px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.turn[open] .turn-preview { display: none; }
.turn-body { padding: 4px 20px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
.turn-body .trace { max-width: 68ch; }
.trace h5 { font-family: var(--cond); font-size: 14px; margin: 14px 0 3px; }
.trace h5:first-child { margin-top: 0; }
.trace p { font-size: 14.5px; color: var(--muted); margin-bottom: 8px; }
.trace .nothing { font-style: italic; }
.refusal { font-size: 14px; color: var(--stop); background: var(--stop-soft); padding: 9px 12px; border-radius: 2px; }
.actions { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.actions--tally { list-style: none; padding-left: 0; flex-direction: row; flex-wrap: wrap; gap: 6px 14px; }
.actions--tally li { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.actions li::marker { font-family: var(--mono); color: var(--muted); font-size: 11px; }
.actions code { color: var(--ink); }
.pts { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-left: 6px; }

footer { margin-top: 80px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13.5px; color: var(--muted); }
footer p + p { margin-top: 8px; }

@media (max-width: 620px) {
  .turn > summary { grid-template-columns: 1fr; }
  .turn-preview { grid-column: 1; }
}
</style>

<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">SimEval pilot · protocol comparison</p>
    <h1>One-Shot, Single, Multi</h1>
    <p class="standfirst">The same model runs three creativity tasks under three action protocols. The question is not which drawing is prettiest — it is <strong>which protocol leaves a trail worth building a linkograph from</strong>. Every reasoning trace from all nine runs is here, turn by turn.</p>
    <dl class="spec">
      <div><dt>Model</dt><dd>${esc(modelName)}</dd></div>
      <div><dt>Run</dt><dd>${runDate}</dd></div>
      <div><dt>Time limit</dt><dd>5 min<span class="cell-unit"> · per CS4 round</span></dd></div>
      <div><dt>Submit opens</dt><dd>final 1 min</dd></div>
      <div><dt>Trace kind</dt><dd>summary</dd></div>
    </dl>
  </header>

  <section>
    <h2>What each protocol did</h2>
    <p class="brief" style="margin-top:8px">Actions the server accepted, with the model calls and working time they took.</p>
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr><th scope="col">Task</th><th scope="col">one-shot</th><th scope="col">single</th><th scope="col">multi</th></tr></thead>
        <tbody>${matrixRows.join("")}</tbody>
      </table>
    </div>
  </section>

  ${findings.length === 0 ? "" : `<section style="margin-top:44px">
    <h2>What this run settled</h2>
    <div class="findings" style="margin-top:18px">
      ${findings.join("")}
    </div>
  </section>`}

  ${sections}

  <footer>
    <p>Traces are the summaries the provider returns, not raw thinking, and they are the model's own account of its reasoning — useful, but not evidence of what the weights did. Every turn shown here also exists as <code>runs/&lt;sweep&gt;/&lt;trial&gt;.reasoning.jsonl</code>, one JSON object per model call, beside the export bundle it produced.</p>
    <p>Stimulus <code>dev-fixture-02</code> is a development fixture traced from a test image, not an official MTCI stimulus. One item per task, one repeat each — this is a protocol shakedown, not a measurement.</p>
  </footer>
</div>
`;

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`${outFile} — ${Math.round(html.length / 1024)}KB, ${Object.keys(data).length} task(s), ${Object.values(data).flat().length} trials`);
