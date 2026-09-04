import type { ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { participantView as cs4View, cs4Rounds } from "../cs4/item";
import { participantView as macgyverView } from "../macgyver/item";
import { directoryForTask, loadCs4Instances, loadMacGyverItems } from "./itemStore";

/**
 * Read-only HTTP surface for text-task items.
 *
 *   GET /api/tasks/:taskId/items            ids, order, and readiness
 *   GET /api/tasks/:taskId/items/:itemId    one item, as a participant sees it
 *
 * There is deliberately no endpoint for a MacGyver answer key or for a CS4
 * round the participant has not reached. Scoring reads `data/tasks` from disk
 * instead, so nothing that a solver must not see is reachable over HTTP —
 * which matters because the agent runs against this same server.
 *
 * Items are read per request rather than cached, so adding or editing a file
 * takes effect on the next reload with no restart.
 */
export function taskItemsPlugin(): Plugin {
  return {
    name: "simeval-task-items",
    configureServer(server) {
      const projectRoot = server.config.root;
      server.middlewares.use("/api/tasks", (request, response) => {
        response.setHeader("Content-Type", "application/json");
        const url = new URL(request.url ?? "/", "http://localhost");
        const segments = url.pathname.split("/").filter(Boolean);
        const [taskId, collection, itemId] = segments;

        if (request.method !== "GET") return send(response, 405, { ok: false, error: "GET only." });
        if (!taskId || !directoryForTask[taskId]) {
          return send(response, 404, { ok: false, error: `No items are configured for "${taskId}".` });
        }
        if (collection !== "items") {
          return send(response, 404, { ok: false, error: `Unknown endpoint: ${url.pathname}` });
        }

        try {
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

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
