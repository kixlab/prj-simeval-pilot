#!/usr/bin/env node
// Agent driver for every task in the pilot.
//
// Runs one trial of one task (--task audra | macgyver | cs4, see agentTasks/)
// under one action strategy (see agentStrategies.mjs) against one model
// provider (see agentModelClients.mjs), within a time limit. `--provider mock`
// runs the task's canned replies, which exercises the whole loop without a
// model.
//
// The app server validates every call; this driver is deliberately not trusted.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripThinkTags } from "./agentReplyParser.mjs";
import {
  createModelClient,
  decodingParametersFor,
  loadEnvLocal,
  resolveProviderOptions
} from "./agentModelClients.mjs";
import {
  assertStrategy,
  formatDuration,
  modelCallsPerRound,
  parseReply,
  submitAllowed,
  systemPromptFor,
  userTextFor
} from "./agentStrategies.mjs";
import { profileOptions } from "./agentProfiles.mjs";
import { taskAdapter } from "./agentTasks/index.mjs";

export const driverDefaults = {
  // A model profile from config/agentModels.json; flags override its settings.
  profile: null,
  base: "http://127.0.0.1:5173",
  task: "audra",
  // Text tasks: which item to run; empty means the server's first pilot item.
  item: null,
  // Drawing task: which stimulus to run.
  stimulus: "dev-fixture-02",
  endpoint: "http://127.0.0.1:8000/v1/chat/completions",
  provider: "local",
  // Deprecated alias for --provider: `mock` and `openai` (an OpenAI-compatible
  // local server) keep working.
  driver: null,
  strategy: "single",
  model: null,
  actorId: "agent",
  // null takes the task's limit from src/tasks/taskTiming.json - the file the
  // human screens read too - or 0 (untimed) for the mock provider, whose
  // replies take no time at all. Per round on tasks with rounds.
  timeLimitSec: null,
  finalizeWindowSec: null,
  // Only a safety cap; the time limit is what ends a timed run.
  maxTurns: 200,
  parseRetries: 2,
  maxCallsPerTurn: 64,
  maxModelErrors: 3,
  temperature: 0.7,
  topP: 0.9,
  maxTokens: null,
  effort: null,
  fallbacks: "default",
  reasoningSummary: "auto",
  promptedThought: "off",
  observationSize: 1024,
  seed: null,
  apiKey: null,
  out: null,
  checkpoint: null,
  export: "true"
};

const numericOptions = new Set([
  "timeLimitSec", "finalizeWindowSec", "maxTurns", "parseRetries", "maxCallsPerTurn", "maxModelErrors",
  "temperature", "topP", "maxTokens", "observationSize", "seed", "repeats"
]);

export function parseArgs(argv, defaults = driverDefaults) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    index += 1;
    options[key] = numericOptions.has(key) ? Number(value) : value;
  }
  return options;
}

/**
 * Parses flags on top of a profile: `--profile` picks the profile, its settings
 * become the defaults, and every flag given on the command line still wins.
 */
export function parseArgsWithProfile(argv, defaults = driverDefaults) {
  const first = parseArgs(argv, defaults);
  if (!first.profile) return first;
  const fromProfile = profileOptions(first.profile, new Set(Object.keys(driverDefaults)));
  return parseArgs(argv, { ...defaults, ...fromProfile });
}

const timingFile = new URL("../src/tasks/taskTiming.json", import.meta.url);

/** A task's limit as src/tasks/taskTiming.json sets it for humans and agents alike. */
export function configuredTiming(taskId) {
  const timing = JSON.parse(readFileSync(timingFile, "utf8")).tasks?.[taskId];
  if (!timing) throw new Error(`No timing is configured for ${taskId} in src/tasks/taskTiming.json.`);
  return timing;
}

export function resolveOptions(raw) {
  const options = { ...raw };
  if (options.driver) {
    options.provider = options.driver === "mock" ? "mock" : options.driver === "openai" ? "local" : options.driver;
  }
  const task = taskAdapter(options.task);
  assertStrategy(options.strategy);
  const configured = configuredTiming(task.taskId);
  if (options.timeLimitSec == null) options.timeLimitSec = options.provider === "mock" ? 0 : configured.timeLimitSec;
  if (options.finalizeWindowSec == null) options.finalizeWindowSec = configured.finalizeWindowSec;
  if (options.timeLimitSec > 0 && options.finalizeWindowSec >= options.timeLimitSec) {
    throw new Error("--finalize-window-sec must be shorter than --time-limit-sec.");
  }
  return resolveProviderOptions(options);
}

// A model call still in flight at the deadline is given this long to return,
// so its trace is kept; its actions are not carried out.
const lateReplyGraceMs = 60_000;

// A call that outlasts its own timeout by more than this can only mean the host
// was suspended (a laptop asleep): timers stop during sleep, the wall clock
// does not. The run's timing is then not what the agent experienced.
const stallMarginMs = 30_000;

// What the app server answers once it no longer holds a trial - after a dev
// server restart, which drops every trial kept in memory.
const lostTrialError = "Unknown trial.";

function traceText(turn) {
  const reasoning = turn.reasoning ?? {};
  return [reasoning.reasoningContent, ...(reasoning.thinkBlocks ?? []), reasoning.promptedThought]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Runs one trial. Each model reply is one turn record: the trace the reply
 * carried, every call it held with what happened to it, and the revision before
 * and after - so any later segmentation of the trace can be tied back to the
 * changes it was about.
 *
 * Timed runs keep going until the time limit: no model call starts after it, a
 * reply that arrives after it is recorded but not carried out, and under single
 * and multi the finishing call is refused until the final window. On a task
 * with rounds the clock is per round, and a round whose clock runs out is ended
 * by the protocol (a system event), not by the agent.
 */
export async function runTrial(options, deps = {}) {
  const task = deps.task ?? taskAdapter(options.task);
  const api = deps.api ?? task.api(options.base);
  const model = deps.model ?? createModelClient(options, task);
  const log = deps.log ?? console.log;
  const now = deps.now ?? Date.now;

  const startedAt = now();
  const { strategy } = options;
  const timeLimitMs = Math.max(0, options.timeLimitSec) * 1000;
  const finalizeWindowMs = Math.max(0, options.finalizeWindowSec) * 1000;
  const timing = { timeLimitMs, finalizeWindowMs };
  const system = systemPromptFor(strategy, task, { promptedThought: options.promptedThought === "on", ...timing });

  const created = await api.createTrial(
    task.createBody(options, {
      model: options.model,
      checkpoint: options.checkpoint,
      seed: options.seed,
      driver: options.provider,
      strategy,
      timeLimitSec: options.timeLimitSec,
      finalizeWindowSec: timeLimitMs > 0 ? options.finalizeWindowSec : null,
      decodingParameters: decodingParametersFor(options)
    })
  );
  const { trialId, renderToken } = created;
  if ((created.totalRounds ?? 1) !== task.rounds) {
    throw new Error(`${task.id}: the server reports ${created.totalRounds} rounds; the driver expects ${task.rounds}.`);
  }
  const itemId = task.itemOf(options, created);
  log(
    `trial ${trialId}  ${task.id}/${itemId}  ${options.provider}/${options.model}  strategy ${strategy}` +
      (timeLimitMs > 0 ? `  time limit ${formatDuration(timeLimitMs)}${task.rounds > 1 ? " per round" : ""}` : "  untimed")
  );

  // Seed the loop with an observation, exactly as a participant opening the page.
  const first = task.readView(await api.observe(trialId));
  if (!first.ok) throw new Error(`Initial observation failed: ${first.error ?? "unknown error"}`);
  let { revision, image, text: observationText, complete, round, summary } = first;
  let description = first.description ?? "";

  const update = result => {
    const view = task.readView(result);
    if (view.description != null) description = view.description;
    if (view.ok) {
      revision = view.revision;
      if (view.image) image = view.image;
      if (view.text != null) observationText = view.text;
      complete = view.complete;
      round = view.round;
      summary = view.summary;
    }
    return view;
  };

  const turns = [];
  const history = [];
  const rounds = [];
  const sessionStart = now();
  let roundStart = sessionStart;
  let deadline = timeLimitMs > 0 ? roundStart + timeLimitMs : Infinity;
  let roundModelCalls = 0;
  const elapsed = () => now() - roundStart;
  const timeLeft = () => deadline - now();

  const closeRound = (endedRound, endedBy) => {
    rounds.push({ round: endedRound, endedBy, activeMs: elapsed(), modelCalls: roundModelCalls });
    roundStart = now();
    deadline = timeLimitMs > 0 ? roundStart + timeLimitMs : Infinity;
    roundModelCalls = 0;
    if (!complete) history.push(`--- round ${round} of ${task.rounds} begins ---`);
  };
  const endRoundBy = async cause => {
    const endedRound = round;
    const result = await api.endRound(trialId, renderToken, cause);
    if (!result.ok) {
      log(`  round ${endedRound} could not be ended: ${result.error}`);
      return false;
    }
    update(result);
    closeRound(endedRound, cause);
    log(`  round ${endedRound} ended (${cause})`);
    return true;
  };

  let parseRepairs = 0;
  let parseFailures = 0;
  let consecutiveModelErrors = 0;
  let endedBy = null;
  let trialLost = false;
  let turn = 0;
  const callBudget = modelCallsPerRound(strategy, options);

  while (!complete) {
    const outOfTime = timeLeft() <= 0;
    if (outOfTime || roundModelCalls >= callBudget) {
      const cause = outOfTime ? "time_limit" : "no_readable_reply";
      if (task.rounds > 1) {
        if (!(await endRoundBy(cause))) {
          endedBy = "server_error";
          break;
        }
        if (complete) endedBy = cause;
        continue;
      }
      endedBy = cause;
      break;
    }
    if (turn >= options.maxTurns) {
      endedBy = "max_turns";
      break;
    }
    turn += 1;
    roundModelCalls += 1;

    const roundAtStart = round;
    const revisionBefore = revision;
    const startedAtMs = elapsed();
    const callTimeoutMs = Number.isFinite(deadline) ? timeLeft() + lateReplyGraceMs : null;
    const stalledCall = () => callTimeoutMs != null && elapsed() - startedAtMs > callTimeoutMs + stallMarginMs;
    let reply;
    try {
      reply = await model.call({
        system,
        userText: userTextFor(strategy, task, {
          history,
          observationText,
          statusLines: strategy === "one-shot" ? [] : task.statusLines({ description, summary }),
          elapsedMs: startedAtMs,
          ...timing
        }),
        imageBase64: task.observation === "image" ? image : null,
        turn,
        timeoutMs: callTimeoutMs
      });
      consecutiveModelErrors = 0;
    } catch (error) {
      // One failed request costs one turn, not the trial; a provider that keeps
      // failing (bad key, no quota) ends the run.
      consecutiveModelErrors += 1;
      turns.push({
        turn, round: roundAtStart, revisionBefore, startedAtMs, endedAtMs: elapsed(),
        modelError: error.message, stalled: stalledCall(), calls: [], revisionAfter: revision
      });
      log(`  turn ${turn}: model error - ${error.message}`);
      if (consecutiveModelErrors >= options.maxModelErrors) {
        endedBy = "model_errors";
        break;
      }
      continue;
    }
    const endedAtMs = elapsed();
    const late = timeLeft() <= 0;

    // Think spans are reasoning, not the answer; calls are read from what
    // remains so a stray brace inside a <think> block cannot become an action.
    const parsed = parseReply(strategy, task, stripThinkTags(reply.content));
    parseRepairs += parsed.repairs.length;
    const record = {
      turn,
      round: roundAtStart,
      revisionBefore,
      startedAtMs,
      endedAtMs,
      late,
      stalled: stalledCall(),
      rawReply: reply.content,
      reasoning: { ...reply.reasoning, promptedThought: parsed.promptedThought ?? null },
      finishReason: reply.finishReason,
      stopDetails: reply.stopDetails ?? null,
      usage: reply.usage,
      latencyMs: reply.latencyMs,
      servedBy: reply.servedBy,
      fallbackRan: reply.fallbackRan,
      repairs: parsed.repairs
    };

    if (!parsed.ok) {
      parseFailures += 1;
      history.push(`turn ${turn}: unreadable reply (${parsed.error})`);
      turns.push({ ...record, parseError: parsed.error, parseCode: parsed.code ?? null, calls: [], revisionAfter: revision });
      log(`  turn ${turn}: unparseable reply - ${parsed.error}`);
      continue;
    }

    const calls = [];
    let stopReason = late ? "time_limit" : null;
    for (let index = 0; index < parsed.calls.length; index += 1) {
      const call = parsed.calls[index];
      const tag = parsed.calls.length > 1 ? `${turn}.${index + 1}` : `${turn}`;
      const entry = { index, tool: call.tool, pointCount: call.points?.length ?? null, call };
      if (!stopReason && index >= options.maxCallsPerTurn) stopReason = "call_limit";
      if (!stopReason && timeLeft() <= 0) stopReason = "time_limit";
      if (stopReason) {
        calls.push({ ...entry, status: "skipped", skipReason: stopReason });
        history.push(`turn ${tag}: ${task.callLabel(call)} -> skipped`);
        continue;
      }
      // Refused by the driver, not the server: the round is not over yet. The
      // rest of the reply still runs.
      if (call.tool === task.vocab.submitTool && !submitAllowed(strategy, { elapsedMs: elapsed(), ...timing })) {
        calls.push({ ...entry, status: "skipped", skipReason: "too_early" });
        history.push(`turn ${tag}: ${call.tool} -> refused, ${formatDuration(timeLeft())} remain; keep working`);
        log(`  turn ${tag}: ${call.tool} -> deferred (${formatDuration(timeLeft())} remain)`);
        continue;
      }
      const result = await api.tool(trialId, call);
      update(result);
      if (result.ok) {
        calls.push({ ...entry, status: "accepted", revision });
        history.push(`turn ${tag}: ${task.callLabel(call)} -> accepted`);
        // Whatever follows a finished round or trial was meant for a state
        // that no longer exists.
        if (complete || round !== roundAtStart) stopReason = "after_submit";
      } else {
        calls.push({ ...entry, status: "rejected", code: result.code ?? null, error: result.error ?? null });
        history.push(`turn ${tag}: ${task.callLabel(call)} -> rejected: ${result.error}`);
        stopReason = "earlier_call_rejected";
        if (result.error === lostTrialError) {
          trialLost = true;
          stopReason = "trial_lost";
        }
      }
      log(`  turn ${tag}: ${task.callLabel(call)} -> ${calls.at(-1).status === "accepted" ? "ok" : `REJECTED (${result.code})`}`);
    }
    if (parsed.invalidCall) {
      calls.push({
        index: parsed.invalidCall.index,
        tool: null,
        status: "unreadable",
        error: parsed.invalidCall.error,
        droppedFollowingCalls: parsed.unreadCallCount - 1
      });
      history.push(`turn ${turn}: call ${parsed.invalidCall.index + 1} unreadable (${parsed.invalidCall.error}); later calls dropped`);
    }
    if (late) log(`  turn ${turn}: reply arrived after the time limit; not carried out`);

    const excerpt = traceText(record);
    if (excerpt) log(`           trace: ${excerpt.replace(/\s+/g, " ").slice(0, 110)}`);
    turns.push({ ...record, calls, revisionAfter: revision });

    if (trialLost) {
      endedBy = "trial_lost";
      log("  the server no longer holds this trial (did the dev server restart?); the run ends here");
      break;
    }
    if (complete) {
      closeRound(roundAtStart, "submitted");
      endedBy = "submitted";
      break;
    }
    if (round !== roundAtStart) {
      closeRound(roundAtStart, "submitted");
      continue;
    }
    // One-shot means one reply per round that runs, whatever it contained.
    if (strategy === "one-shot") {
      const cause = late ? "time_limit" : "reply_without_submit";
      if (task.rounds > 1) {
        if (!(await endRoundBy(cause))) {
          endedBy = "server_error";
          break;
        }
        if (complete) endedBy = cause;
        continue;
      }
      endedBy = cause;
      break;
    }
  }
  if (!rounds.some(entry => entry.round === round)) {
    rounds.push({ round, endedBy, activeMs: elapsed(), modelCalls: roundModelCalls });
  }
  const activeMs = now() - sessionStart;

  const run = await api.hostRun(trialId, renderToken);

  let exported = null;
  if (options.export !== "false") {
    // The same protocol block a human trial records, so the two can be compared.
    const result = await api.exportBundle(trialId, renderToken, new Date().toISOString(), {
      scope: task.rounds > 1 ? "round" : "trial",
      timeLimitSec: options.timeLimitSec,
      finalizeWindowSec: timeLimitMs > 0 ? options.finalizeWindowSec : null,
      endedBy,
      activeMs,
      rounds
    });
    if (result.ok) {
      exported = result;
      log(`bundle   -> ${result.directory}`);
    } else {
      log(`export failed: ${result.error}`);
    }
  }

  const allCalls = turns.flatMap(entry => entry.calls);
  const acceptedCalls = allCalls.filter(entry => entry.status === "accepted");
  const countStatus = status => allCalls.filter(entry => entry.status === status).length;
  const artifactActions = acceptedCalls.filter(entry => task.artifactTools.has(entry.tool)).length;
  const tracedTurns = turns.filter(entry => traceText(entry));
  const summary_ = {
    trialId,
    task: task.id,
    taskId: task.taskId,
    itemId,
    strategy,
    provider: options.provider,
    model: options.model,
    submitted: complete && endedBy === "submitted",
    complete,
    endedBy,
    timeLimitSec: options.timeLimitSec,
    activeMs,
    wallClockMs: now() - startedAt,
    rounds,
    modelCalls: turns.length,
    modelErrors: turns.filter(entry => entry.modelError).length,
    hostStalls: turns.filter(entry => entry.stalled).length,
    // Replies refused under `single` for holding several actions. They are
    // refused, not trimmed to their first action, so how often a model breaks
    // the one-move rule stays visible and comparable across models.
    ruleViolations: turns.filter(entry => entry.parseCode === "multiple_actions").length,
    // Driver leniency is assistance a human participant does not receive, so it
    // is reported rather than hidden.
    driverAssistance: { parseRepairs, parseFailures },
    calls: {
      written: allCalls.length,
      accepted: acceptedCalls.length,
      rejected: countStatus("rejected"),
      skipped: countStatus("skipped"),
      unreadable: countStatus("unreadable"),
      deferredSubmits: allCalls.filter(entry => entry.skipReason === "too_early").length
    },
    callsPerReply: turns.filter(entry => !entry.parseError && !entry.modelError).map(entry => entry.calls.length),
    artifactActions,
    fallbackTurns: turns.filter(entry => entry.fallbackRan).length,
    finalAnswer: task.finalAnswer({ description, summary, acceptedCalls }),
    reasoningTrace: {
      kinds: [...new Set(turns.filter(entry => !entry.modelError).map(entry => entry.reasoning?.kind ?? "none"))],
      repliesWithTrace: tracedTurns.length,
      traceChars: tracedTurns.reduce((sum, entry) => sum + traceText(entry).length, 0),
      // How many accepted changes one reply's trace has to account for: about
      // 1 under single, the batch size under multi, everything under one-shot.
      artifactActionsPerTracedReply: tracedTurns.length ? Number((artifactActions / tracedTurns.length).toFixed(3)) : null
    },
    options: { ...options, apiKey: options.apiKey ? "[set]" : null },
    exportBundle: exported,
    serverRun: run.ok ? { agentRun: run.agentRun, runStats: run.runStats, rejections: run.rejections } : null,
    turns
  };

  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    const file = join(options.out, `${trialId}.run.json`);
    writeFileSync(file, JSON.stringify(summary_, null, 2));

    // The reasoning trace is written separately, one record per model reply, so
    // it can be analysed without the run log and never travels with a scoring
    // input. Call arguments stay in the run log and the event log.
    const traceFile = join(options.out, `${trialId}.reasoning.jsonl`);
    const records = turns.map(entry => ({
      trialId,
      task: task.taskId,
      itemId,
      actorType: "agent",
      actorId: options.actorId,
      provider: options.provider,
      model: options.model,
      servedBy: entry.servedBy ?? null,
      fallbackRan: entry.fallbackRan ?? false,
      strategy,
      turn: entry.turn,
      round: entry.round,
      startedAtMs: entry.startedAtMs,
      endedAtMs: entry.endedAtMs,
      late: entry.late ?? false,
      stalled: entry.stalled ?? false,
      revisionBefore: entry.revisionBefore,
      revisionAfter: entry.revisionAfter,
      calls: entry.calls.map(({ call, ...rest }) => rest),
      parseError: entry.parseError ?? null,
      parseCode: entry.parseCode ?? null,
      modelError: entry.modelError ?? null,
      traceKind: entry.reasoning?.kind ?? "none",
      reasoningContent: entry.reasoning?.reasoningContent ?? null,
      thinkBlocks: entry.reasoning?.thinkBlocks ?? [],
      channels: entry.reasoning?.channels ?? [],
      promptedThought: entry.reasoning?.promptedThought ?? null,
      finishReason: entry.finishReason ?? null,
      usage: entry.usage ?? null,
      latencyMs: entry.latencyMs ?? null,
      rawReply: entry.rawReply ?? null
    }));
    writeFileSync(traceFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    log(`run log  -> ${file}`);
    log(`reasoning -> ${traceFile}`);
  }

  log(
    `\n${complete ? "complete" : "NOT complete"} (${endedBy}) · ${task.id} · ${strategy} · active ${formatDuration(activeMs)}` +
      ` · ${turns.length} model call(s)` +
      ` · calls accepted ${summary_.calls.accepted} / rejected ${summary_.calls.rejected} / skipped ${summary_.calls.skipped}` +
      ` · parse failures ${parseFailures}\n` +
      `trace on ${tracedTurns.length}/${turns.length} replies (${summary_.reasoningTrace.kinds.join(", ")}), ` +
      `${summary_.reasoningTrace.traceChars} chars · ${artifactActions} changes\n` +
      (task.rounds > 1 ? `rounds: ${rounds.map(entry => `${entry.round}=${entry.endedBy}`).join(" ")}\n` : "") +
      `final: ${JSON.stringify(summary_.finalAnswer)}`
  );
  if (summary_.hostStalls > 0) {
    log(
      `warning: ${summary_.hostStalls} model call(s) outlasted their timeout - the host was probably asleep. ` +
        "This run's timing is not what the agent experienced; rerun it (e.g. under caffeinate)."
    );
  }
  if (summary_.fallbackTurns > 0) {
    log(`warning: ${summary_.fallbackTurns} turn(s) were served by a fallback model; see servedBy in the trace.`);
  }
  return summary_;
}

async function main() {
  loadEnvLocal();
  const options = resolveOptions(parseArgsWithProfile(process.argv.slice(2)));
  const summary = await runTrial(options);
  if (!summary.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
