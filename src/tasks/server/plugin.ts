import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { roundEndCauses, type RoundEndCause } from "../agent/textTrial";
import {
  createTextTrial,
  endTextRound,
  executeTextToolCall,
  getTextTrial,
  observeTextTrial,
  textTrialStatus,
  type TextTrialRecord
} from "../agent/textTrialRegistry";
import { participantView as cs4View, cs4Rounds } from "../cs4/item";
import { cs4RevisionEngine } from "../cs4/revision";
import { macgyverAnswerEngine } from "../macgyver/answer";
import { participantView as macgyverView } from "../macgyver/item";
import { directoryForTask, loadCs4Instances, loadMacGyverItems } from "./itemStore";
import { writeTextBundle } from "./textExport";

/**
 * HTTP surface for the two text tasks.
 *
 * Items, read-only:
 *   GET  /api/tasks/:taskId/items              ids, order, and readiness
 *   GET  /api/tasks/:taskId/items/:itemId      one item, as a participant sees it
 *
 * Agent trials - tool calls and text observations only:
 *   POST /api/tasks/:taskId/agent/trial        {actorId, itemId?, agentRun?}
 *   GET  /api/tasks/:taskId/agent/observe      ?trialId=
 *   POST /api/tasks/:taskId/agent/tool         {trialId, call}
 * Host-only, gated by the render token issued at trial creation:
 *   GET  /api/tasks/:taskId/agent/_host/run    ?trialId=&token=
 *   POST /api/tasks/:taskId/agent/_host/end_round  {trialId, token, cause}
 *   POST /api/tasks/:taskId/agent/export       {trialId, token, endedAt}
 *
 * There is deliberately no endpoint for a MacGyver answer key or for a CS4
 * round the solver has not reached. Agent trials are built from participant
 * views, and scoring reads `data/tasks` from disk instead - which matters
 * because the agent runs against this same server.
 *
 * Items are read per request rather than cached, so adding or editing a file
 * takes effect on the next reload with no restart.
 */
export type TaskItemsPluginOptions = { appVersion?: string; appCommit?: string; exportDir?: string };

type AgentContext = { projectRoot: string; exportDir: string; appVersion: string; appCommit: string };

const maxBodyBytes = 2 * 1024 * 1024;

export function taskItemsPlugin(options: TaskItemsPluginOptions = {}): Plugin {
  return {
    name: "simeval-task-items",
    configureServer(server) {
      const projectRoot = server.config.root;
      const context: AgentContext = {
        projectRoot,
        exportDir: options.exportDir ?? join(projectRoot, "exports"),
        appVersion: options.appVersion ?? "unknown",
        appCommit: options.appCommit ?? "unknown"
      };
      server.middlewares.use("/api/tasks", async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        const url = new URL(request.url ?? "/", "http://localhost");
        const segments = url.pathname.split("/").filter(Boolean);
        const [taskId, collection, ...rest] = segments;

        if (!taskId || !directoryForTask[taskId]) {
          return send(response, 404, { ok: false, error: `No items are configured for "${taskId}".` });
        }

        try {
          if (collection === "agent") return await handleAgent(request, response, url, taskId, rest.join("/"), context);
          if (request.method !== "GET") return send(response, 405, { ok: false, error: "GET only." });
          if (collection !== "items") {
            return send(response, 404, { ok: false, error: `Unknown endpoint: ${url.pathname}` });
          }
          return handleItems(response, url, taskId, rest[0], projectRoot);
        } catch (error) {
          return send(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    }
  };
}

function handleItems(response: ServerResponse, url: URL, taskId: string, itemId: string | undefined, projectRoot: string) {
  if (taskId === "macgyver-problem-solving") {
    const loaded = loadMacGyverItems(projectRoot);
    if (!itemId) {
      return send(response, 200, {
        ok: true,
        taskId,
        ready: loaded.errors.length === 0 && loaded.pilot.length > 0,
        itemIds: loaded.items.map(item => item.itemId),
        // Passed through so a page can say what is a fixture without
        // opening the files.
        fixtureCount: loaded.items.filter(item => item.source === "development").length,
        pilotSubset: loaded.manifest.pilotSubset,
        errors: loaded.errors
      });
    }
    const item = loaded.items.find(candidate => candidate.itemId === itemId);
    if (!item) return send(response, 404, { ok: false, error: `Unknown item: ${itemId}` });
    return send(response, 200, { ok: true, taskId, item: macgyverView(item) });
  }

  const loaded = loadCs4Instances(projectRoot);
  if (!itemId) {
    return send(response, 200, {
      ok: true,
      taskId,
      ready: loaded.errors.length === 0 && loaded.pilot.length > 0,
      itemIds: loaded.items.map(instance => instance.instanceId),
      fixtureCount: loaded.items.filter(instance => instance.source === "development").length,
      pilotSubset: loaded.manifest.pilotSubset,
      errors: loaded.errors
    });
  }
  const instance = loaded.items.find(candidate => candidate.instanceId === itemId);
  if (!instance) return send(response, 404, { ok: false, error: `Unknown item: ${itemId}` });

  // Out-of-range rounds clamp instead of erroring, and a round the
  // participant has not reached simply is not in the response.
  const requested = Number.parseInt(url.searchParams.get("round") ?? "1", 10);
  const round = Number.isFinite(requested) ? requested : 1;
  return send(response, 200, {
    ok: true,
    taskId,
    totalRounds: cs4Rounds(instance).length,
    item: cs4View(instance, round)
  });
}

/**
 * Builds a new trial's engine and starting state. With no itemId, the first
 * item of the pilot subset is used, then the first item on disk.
 */
function startTrial(taskId: string, itemId: string | null, projectRoot: string) {
  if (taskId === "macgyver-problem-solving") {
    const loaded = loadMacGyverItems(projectRoot);
    const item = itemId
      ? loaded.items.find(candidate => candidate.itemId === itemId)
      : loaded.pilot[0] ?? loaded.items[0];
    if (!item) return null;
    return {
      engine: macgyverAnswerEngine,
      initialState: macgyverAnswerEngine.initial(macgyverView(item)),
      itemId: item.itemId,
      itemSource: item.source
    };
  }
  const loaded = loadCs4Instances(projectRoot);
  const instance = itemId
    ? loaded.items.find(candidate => candidate.instanceId === itemId)
    : loaded.pilot[0] ?? loaded.items[0];
  if (!instance) return null;
  return {
    engine: cs4RevisionEngine,
    initialState: cs4RevisionEngine.initial(instance),
    itemId: instance.instanceId,
    itemSource: instance.source
  };
}

async function handleAgent(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  taskId: string,
  route: string,
  context: AgentContext
) {
  if (route === "trial" && request.method === "POST") {
    const body = await readJson(request);
    const actorId = typeof body.actorId === "string" && body.actorId.trim() ? body.actorId.trim() : null;
    if (!actorId) return send(response, 400, { ok: false, error: "actorId is required." });
    const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : null;
    const started = startTrial(taskId, itemId, context.projectRoot);
    if (!started) return send(response, 404, { ok: false, error: `Unknown or missing item: ${itemId ?? "(none on disk)"}` });
    const record = createTextTrial({
      ...started,
      taskId,
      actorId,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      agentRun: typeof body.agentRun === "object" && body.agentRun ? (body.agentRun as Record<string, unknown>) : null
    });
    const status = textTrialStatus(record);
    return send(response, 200, {
      ok: true,
      trialId: record.trialId,
      sessionId: record.sessionId,
      // Host-only. The driver that runs the model must not forward it.
      renderToken: record.renderToken,
      itemId: record.itemId,
      itemSource: record.itemSource,
      totalRounds: status.totalRounds,
      tools: record.engine.toolNames
    });
  }

  if (route === "observe" && request.method === "GET") {
    const record = requireTrial(url.searchParams.get("trialId"), taskId, response);
    if (!record) return;
    return send(response, 200, { ok: true, ...observeTextTrial(record) });
  }

  if (route === "tool" && request.method === "POST") {
    const body = await readJson(request);
    const record = requireTrial(typeof body.trialId === "string" ? body.trialId : null, taskId, response);
    if (!record) return;
    const result = executeTextToolCall(record, body.call, Date.now() - record.createdAtEpochMs);
    return send(response, result.ok ? 200 : 400, result);
  }

  if (route === "_host/run" && request.method === "GET") {
    const record = requireTrial(url.searchParams.get("trialId"), taskId, response);
    if (!record || !checkToken(record, url.searchParams.get("token"), response)) return;
    return send(response, 200, {
      ok: true,
      agentRun: record.agentRun,
      runStats: record.runStats,
      rejections: record.rejections,
      status: textTrialStatus(record)
    });
  }

  if (route === "_host/end_round" && request.method === "POST") {
    const body = await readJson(request);
    const record = requireTrial(typeof body.trialId === "string" ? body.trialId : null, taskId, response);
    if (!record || !checkToken(record, body.token, response)) return;
    const cause = body.cause as RoundEndCause;
    if (!roundEndCauses.includes(cause)) {
      return send(response, 400, { ok: false, error: `cause must be one of ${roundEndCauses.join(", ")}.` });
    }
    const result = endTextRound(record, cause, Date.now() - record.createdAtEpochMs);
    return send(response, result.ok ? 200 : 400, result);
  }

  if (route === "export" && request.method === "POST") {
    const body = await readJson(request);
    const record = requireTrial(typeof body.trialId === "string" ? body.trialId : null, taskId, response);
    if (!record || !checkToken(record, body.token, response)) return;
    const result = writeTextBundle(record, {
      endedAt: typeof body.endedAt === "string" ? body.endedAt : new Date().toISOString(),
      appVersion: context.appVersion,
      appCommit: context.appCommit,
      exportDir: context.exportDir,
      protocol:
        body.protocol && typeof body.protocol === "object" && !Array.isArray(body.protocol)
          ? (body.protocol as Record<string, unknown>)
          : null
    });
    return send(response, 200, { ok: true, ...result });
  }

  return send(response, 404, { ok: false, error: `Unknown agent endpoint: ${route}` });
}

function requireTrial(trialId: string | null, taskId: string, response: ServerResponse): TextTrialRecord | null {
  const record = trialId ? getTextTrial(trialId) : null;
  if (!record || record.taskId !== taskId) {
    send(response, 404, { ok: false, error: "Unknown trial." });
    return null;
  }
  return record;
}

function checkToken(record: TextTrialRecord, token: unknown, response: ServerResponse) {
  if (token === record.renderToken) return true;
  send(response, 403, { ok: false, error: "Invalid render token." });
  return false;
}

function readJson(request: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (body.trim().length === 0) return resolve({});
      try {
        const parsed = JSON.parse(body);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${(error as Error).message}`));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
