import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AudraMode from "./audra/AudraMode";
import TaskLauncher from "./launcher/TaskLauncher";
import MacGyverMode from "./macgyver/MacGyverMode";
import TaskPlaceholder from "./launcher/TaskPlaceholder";
import { readMode, resolveRoute } from "./tasks/routing";
import "./style.css";

// One mode per screen, selected by `?mode=` or by an equivalent path segment.
// Each task mode owns its own page: they share no canvas, no session, and no
// state, so the launcher is only a way in and never part of a trial.
//
//   (none) | launcher       task chooser
//   audra-incomplete-shapes AuDrA-style drawing task
//   <planned task mode>     description page for a task that is not built yet
//   excalidraw-session      the earlier Excalidraw session app
//
// `?mode=audra-incomplete-shapes` keeps its exact meaning, including the agent
// host URL issued by /api/audra/trial.
//
// The catalog decides which tasks exist; this map decides which of them can
// actually run.
const taskScreens: Record<string, () => ReactElement> = {
  "audra-incomplete-shapes": () => <AudraMode />,
  "macgyver-problem-solving": () => <MacGyverMode />
};

function screenFor(route: ReturnType<typeof resolveRoute>): ReactElement {
  switch (route.screen) {
    case "excalidraw-session":
      return <App />;
    case "task":
      return taskScreens[route.task.mode]();
    case "task-placeholder":
      // A task marked available with no screen behind it is a bug, and a
      // description page would otherwise hide it behind something plausible.
      if (route.markedAvailable) {
        console.error(`Task "${route.task.taskId}" is marked available but has no screen.`);
      }
      return <TaskPlaceholder task={route.task} />;
    case "launcher":
      // Unknown modes fall back to the chooser instead of guessing a task.
      if (route.unknownMode) {
        console.warn(`Unknown mode "${route.unknownMode}"; showing the task launcher.`);
      }
      return <TaskLauncher />;
  }
}

const route = resolveRoute(readMode(window.location), new Set(Object.keys(taskScreens)));

createRoot(document.getElementById("root")!).render(<StrictMode>{screenFor(route)}</StrictMode>);
