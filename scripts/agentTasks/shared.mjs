// Helpers shared by the task adapters.

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json().catch(() => ({ ok: false, error: `HTTP ${response.status} with no JSON body` }));
}

export async function getJson(url) {
  const response = await fetch(url);
  return response.json().catch(() => ({ ok: false, error: `HTTP ${response.status} with no JSON body` }));
}

/**
 * Canned replies for the mock provider. `entries` are {thought, call};
 * `groups` lists which entries share a reply. Single-call replies are bare
 * objects, as a model under `single` would send them.
 */
export function cannedReplies(entries, groups, strategy) {
  return groups.map(indices => {
    const chosen = indices.map(index => entries[index]);
    const thinking = chosen.map(entry => entry.thought).join(" ");
    const calls = chosen.map(entry => entry.call);
    const json = strategy === "single" ? JSON.stringify(calls[0]) : JSON.stringify({ calls });
    return `<think>${thinking}</think>\n${json}`;
  });
}

/** The agent endpoints of a text task on the app server. */
export function textTaskApi(base, taskId) {
  const root = `${base}/api/tasks/${taskId}/agent`;
  const query = params => new URLSearchParams(params).toString();
  return {
    async createTrial(body) {
      const payload = await postJson(`${root}/trial`, body);
      if (!payload.ok) throw new Error(`Trial creation failed: ${JSON.stringify(payload)}`);
      return payload;
    },
    observe: trialId => getJson(`${root}/observe?${query({ trialId })}`),
    tool: (trialId, call) => postJson(`${root}/tool`, { trialId, call }),
    hostRun: (trialId, token) => getJson(`${root}/_host/run?${query({ trialId, token })}`),
    endRound: (trialId, token, cause) => postJson(`${root}/_host/end_round`, { trialId, token, cause }),
    exportBundle: (trialId, token, endedAt, protocol) => postJson(`${root}/export`, { trialId, token, endedAt, protocol })
  };
}

/** A text task's tool response, in the shape the runner reads. */
export function readTextView(result) {
  return {
    ok: result.ok === true,
    revision: result.revision,
    complete: result.status?.complete === true,
    round: result.status?.round ?? 1,
    image: null,
    text: result.observation?.text ?? null,
    description: null,
    summary: result.status?.summary ?? null,
    code: result.code ?? null,
    error: result.error ?? null
  };
}

export function timeLimitLine({ timeLimitMs = 0 }, formatDuration, { perRound = false } = {}) {
  if (!(timeLimitMs > 0)) return "";
  return perRound
    ? `\n\nTime limit: ${formatDuration(timeLimitMs)} per round.`
    : `\n\nTime limit: ${formatDuration(timeLimitMs)} from the start of the task.`;
}
