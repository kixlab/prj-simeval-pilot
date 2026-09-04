import type { Cs4InstanceView } from "./cs4/item";
import type { MacGyverItemView } from "./macgyver/item";

/**
 * Browser side of the item endpoints. Only participant views cross this line:
 * the answer key and unreached CS4 rounds never leave the server, so a task
 * screen cannot accidentally render one.
 */
export type TaskItemList = {
  taskId: string;
  /** True when the pilot subset is present and every item file validates. */
  ready: boolean;
  itemIds: readonly string[];
  /** How many of those are development fixtures rather than benchmark items. */
  fixtureCount: number;
  pilotSubset: readonly string[];
  errors: readonly string[];
};

async function getJson(url: string) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

export async function fetchTaskItemList(taskId: string): Promise<TaskItemList> {
  const payload = await getJson(`/api/tasks/${encodeURIComponent(taskId)}/items`);
  return {
    taskId: payload.taskId,
    ready: Boolean(payload.ready),
    itemIds: payload.itemIds ?? [],
    fixtureCount: payload.fixtureCount ?? 0,
    pilotSubset: payload.pilotSubset ?? [],
    errors: payload.errors ?? []
  };
}

export async function fetchMacGyverItem(itemId: string): Promise<MacGyverItemView> {
  const payload = await getJson(
    `/api/tasks/macgyver-problem-solving/items/${encodeURIComponent(itemId)}`
  );
  return payload.item;
}

export async function fetchCs4Round(instanceId: string, round: number): Promise<Cs4InstanceView> {
  const payload = await getJson(
    `/api/tasks/cs4-creative-writing/items/${encodeURIComponent(instanceId)}?round=${round}`
  );
  return payload.item;
}
