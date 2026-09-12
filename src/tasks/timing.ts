import rawTiming from "./taskTiming.json";

/**
 * Time limits, shared by human screens and the agent driver.
 *
 * `taskTiming.json` is the one place a limit is set, so a human and an agent on
 * the same task always run under the same clock unless a session deliberately
 * overrides it - and an override is recorded with the trial.
 */
export type TimingScope = "trial" | "round";

export type TaskTiming = {
  /** 0 means untimed. */
  timeLimitSec: number;
  /** Submit opens only for this final stretch of the limit. */
  finalizeWindowSec: number;
  scope: TimingScope;
};

const configured = rawTiming.tasks as Record<string, TaskTiming>;

export function taskTiming(taskId: string): TaskTiming {
  const timing = configured[taskId];
  if (!timing) throw new Error(`No timing is configured for ${taskId} in src/tasks/taskTiming.json.`);
  return { ...timing };
}

/**
 * The configured timing with `?timeLimitSec=` / `?finalizeWindowSec=` applied
 * for one session. A bad override is ignored and reported rather than guessed
 * at, so a typo in a link cannot silently change the protocol.
 */
export function timingFromQuery(taskId: string, query: URLSearchParams) {
  const base = taskTiming(taskId);
  const problems: string[] = [];
  const read = (name: string, fallback: number) => {
    const raw = query.get(name);
    if (raw == null || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${name}=${raw} is not a number of seconds; using ${fallback}.`);
      return fallback;
    }
    return value;
  };
  const timeLimitSec = read("timeLimitSec", base.timeLimitSec);
  let finalizeWindowSec = read("finalizeWindowSec", base.finalizeWindowSec);
  if (timeLimitSec > 0 && finalizeWindowSec >= timeLimitSec) {
    problems.push(`finalizeWindowSec must be shorter than timeLimitSec; Submit stays open for the whole ${timeLimitSec} s.`);
    finalizeWindowSec = timeLimitSec;
  }
  const overridden = timeLimitSec !== base.timeLimitSec || finalizeWindowSec !== base.finalizeWindowSec;
  return { timing: { ...base, timeLimitSec, finalizeWindowSec }, overridden, problems };
}

export function isTimed(timing: TaskTiming) {
  return timing.timeLimitSec > 0;
}

export function remainingMs(timing: TaskTiming, elapsedMs: number) {
  return isTimed(timing) ? timing.timeLimitSec * 1000 - elapsedMs : Infinity;
}

/** Whether the finishing action may be taken yet. */
export function submitOpen(timing: TaskTiming, elapsedMs: number) {
  return !isTimed(timing) || elapsedMs >= (timing.timeLimitSec - timing.finalizeWindowSec) * 1000;
}

/** m:ss for an on-screen countdown. People read it at a glance; agents get words instead. */
export function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
