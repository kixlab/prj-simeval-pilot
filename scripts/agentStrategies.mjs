// The three action protocols an agent can run under, for any task.
//
//   one-shot  one observation, one reply holding every action, no feedback
//   single    one action per reply, a fresh observation after each
//   multi     any number of actions per reply, a fresh observation after each reply
//
// A task adapter (scripts/agentTasks/) supplies the task text, the tool list,
// and the words for what the solver sees and how it finishes. The protocol
// sections below are the only part of the prompt that differs between
// strategies, so a difference between strategies is a difference in protocol,
// not in task.

import { extractCall, extractCallBatch } from "./agentReplyParser.mjs";

export const strategyNames = ["one-shot", "single", "multi"];

/**
 * Durations in words - "4 min 47 s". A clock format such as "1:00" was read by
 * models as an hour.
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

export function assertStrategy(strategy) {
  if (!strategyNames.includes(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}. Choose one of ${strategyNames.join(", ")}.`);
  }
}

function timedWorkRule(task, { timeLimitMs, finalizeWindowMs }) {
  if (!(timeLimitMs > 0)) return "";
  const { artifact, submitTool, finishSequence } = task.vocab;
  const window = formatDuration(finalizeWindowMs);
  const scope = task.rounds > 1 ? " of each round" : "";
  const ofRound = task.rounds > 1 ? " of the round" : "";
  return (
    `\n\nKeep working on the ${artifact} for the whole time limit${scope}. ${submitTool} is refused until ` +
    `the final ${window}${ofRound}; each message tells you the time remaining. When the final ${window} ` +
    `begins, finish with ${finishSequence} before time runs out.`
  );
}

function protocolPrompt(strategy, task, timing) {
  const { shown, whole, finishSequence } = task.vocab;
  switch (strategy) {
    case "one-shot": {
      const intro = task.rounds > 1
        ? `In each round you get exactly one reply, and you will not see ${shown} again until the next round begins.`
        : `You get exactly one reply, and you will not see ${shown} again after it.`;
      const deadline = timing.timeLimitMs > 0
        ? `\n\nYou may use the time limit${task.rounds > 1 ? " of the round" : ""} to think before replying, but your ` +
          "reply must arrive before time runs out; a later reply is not carried out."
        : "";
      return (
        `How to reply:\n${intro} Reply with ONE JSON object of the form {"calls":[action, action, ...]} that ` +
        `holds every action for ${whole}, in the order to perform them, ending with ${finishSequence}. ` +
        `The actions run in order; if one is rejected, the rest are skipped.${deadline}`
      );
    }
    case "single":
      return (
        "How to reply:\nReply with exactly ONE JSON object: one action from the list above. " +
        `After each action you will see ${shown} again.${timedWorkRule(task, timing)}`
      );
    case "multi":
      return (
        'How to reply:\nReply with ONE JSON object of the form {"calls":[action, action, ...]} holding one or ' +
        "more actions, in the order to perform them. You decide how many actions to put in each reply. The " +
        "actions run in order; if one is rejected, the rest of that reply is skipped. After each reply you will " +
        `see ${shown} again.${timedWorkRule(task, timing)}`
      );
  }
}

const thoughtPrompts = {
  "one-shot": 'Also include a top-level "thought" field saying what you see and what you plan to do.',
  single: 'Also include a "thought" field: one or two sentences saying what you see and why you chose this action.',
  multi: 'Also include a top-level "thought" field saying what you see and why you chose these actions.'
};

/**
 * `promptedThought` asks for a `thought` field. It is off by default: the trace
 * under study is the model's own thinking, and a requested field would be a
 * second, prompted channel. Turn it on for models that have no thinking mode.
 * `timeLimitMs` of 0 means untimed, which only tests and the mock provider use.
 */
export function systemPromptFor(strategy, task, { promptedThought = false, timeLimitMs = 0, finalizeWindowMs = 0 } = {}) {
  assertStrategy(strategy);
  const timing = { timeLimitMs, finalizeWindowMs };
  const parts = [task.taskPrompt(timing), protocolPrompt(strategy, task, timing)];
  if (promptedThought) parts.push(thoughtPrompts[strategy]);
  return parts.join("\n\n");
}

/** Whether the finishing call may be sent now. One-shot is exempt: its reply must finish. */
export function submitAllowed(strategy, { elapsedMs, timeLimitMs, finalizeWindowMs }) {
  if (strategy === "one-shot" || !(timeLimitMs > 0)) return true;
  return elapsedMs >= timeLimitMs - finalizeWindowMs;
}

/**
 * The per-turn user text. Single and multi get the time remaining, what the
 * solver sees, a short action history, and any status a participant could read
 * on screen. One-shot gets the time and what the solver sees, and nothing else.
 * Times are per round on tasks with rounds.
 */
export function userTextFor(
  strategy,
  task,
  { history, observationText = null, statusLines = [], elapsedMs = 0, timeLimitMs = 0, finalizeWindowMs = 0 }
) {
  assertStrategy(strategy);
  const timed = timeLimitMs > 0;
  const perRound = task.rounds > 1 ? " of this round" : "";

  if (strategy === "one-shot") {
    return [
      timed ? `You have ${formatDuration(timeLimitMs - elapsedMs)}${perRound} remaining.` : null,
      observationText,
      task.oneShotAsk
    ].filter(Boolean).join("\n\n");
  }

  const parts = [];
  if (timed) {
    const clock =
      `Time: ${formatDuration(elapsedMs)} elapsed of ${formatDuration(timeLimitMs)}${perRound} ` +
      `(${formatDuration(timeLimitMs - elapsedMs)} remaining).`;
    parts.push(
      submitAllowed(strategy, { elapsedMs, timeLimitMs, finalizeWindowMs })
        ? `${clock} Time is almost up: finish now with ${task.vocab.finishSequence}.`
        : `${clock} Keep improving the ${task.vocab.artifact}; ${task.vocab.submitTool} is not accepted yet.`
    );
  }
  if (observationText) parts.push(observationText);
  parts.push(history.length === 0 ? "You have not taken any action yet." : `Your actions so far:\n${history.join("\n")}`);
  parts.push(...statusLines);
  parts.push(task.turnAsk(strategy));
  return parts.join("\n\n");
}

/**
 * Reads a reply under a strategy's rules. `single` accepts one call and nothing
 * else - a reply holding several is unreadable, which is what makes the single
 * move forced rather than suggested.
 */
export function parseReply(strategy, task, text) {
  assertStrategy(strategy);
  if (strategy === "single") {
    const result = extractCall(text, task.normalizeCall);
    if (!result.ok) return { ok: false, error: result.error, code: result.code ?? null, repairs: result.repairs ?? [] };
    return {
      ok: true,
      calls: [result.call],
      repairs: result.repairs,
      promptedThought: result.promptedThought ?? null,
      invalidCall: null,
      unreadCallCount: 0
    };
  }
  const result = extractCallBatch(text, task.normalizeCall);
  if (!result.ok) return { ok: false, error: result.error, repairs: result.repairs ?? [] };
  const promptedThought =
    result.promptedThought ?? (result.callThoughts.filter(Boolean).join(" ") || null);
  return {
    ok: true,
    calls: result.calls,
    repairs: result.repairs,
    promptedThought,
    invalidCall: result.invalidCall,
    unreadCallCount: result.unreadCallCount
  };
}

/**
 * Model calls one round may use. One-shot has exactly one reply that runs; a
 * reply that cannot be read at all is resampled up to `parseRetries` times, and
 * each is counted as driver assistance. Single and multi are bounded by the
 * time limit instead.
 */
export function modelCallsPerRound(strategy, { parseRetries }) {
  assertStrategy(strategy);
  return strategy === "one-shot" ? 1 + parseRetries : Infinity;
}
