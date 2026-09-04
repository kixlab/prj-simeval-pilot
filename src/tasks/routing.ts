import { taskByMode, type TaskDefinition } from "./catalog";

/**
 * Which screen a URL asks for. Kept apart from the React entry point so the
 * mapping can be tested without a DOM, and so adding a task cannot quietly
 * change what an existing mode means.
 */
export type ScreenRoute =
  | { screen: "launcher"; unknownMode?: string }
  | { screen: "excalidraw-session" }
  | { screen: "task"; task: TaskDefinition }
  | { screen: "task-placeholder"; task: TaskDefinition; markedAvailable: boolean };

export const launcherModeName = "launcher";
export const excalidrawModeName = "excalidraw-session";

/** `?mode=` wins; a bare path segment is accepted as the same thing. */
export function readMode(location: { search: string; pathname: string }) {
  return (
    new URLSearchParams(location.search).get("mode") ??
    location.pathname.replace(/^\/+|\/+$/g, "")
  );
}

/**
 * `implementedModes` is the set of task modes that actually have a screen. A
 * catalogued task outside it gets its description page, and being marked
 * available while missing a screen is reported rather than hidden.
 */
export function resolveRoute(mode: string, implementedModes: ReadonlySet<string>): ScreenRoute {
  if (mode === excalidrawModeName) return { screen: "excalidraw-session" };

  const task = taskByMode(mode);
  if (task) {
    if (implementedModes.has(task.mode)) return { screen: "task", task };
    return { screen: "task-placeholder", task, markedAvailable: task.status === "available" };
  }

  if (mode === "" || mode === launcherModeName) return { screen: "launcher" };
  return { screen: "launcher", unknownMode: mode };
}
