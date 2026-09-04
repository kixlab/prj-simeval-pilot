import { useMemo, useState } from "react";
import { listTasks, taskHref, type TaskDefinition } from "../tasks/catalog";
import "./launcher.css";

/**
 * The entry screen a participant lands on. Its only job is to choose one task
 * and hand the run over to that task's own mode; it owns no trial state and
 * never touches a task's session, so a task behaves identically whether it was
 * opened from here or from its own deep link.
 */
export function TaskLauncher() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [participantId, setParticipantId] = useState(query.get("participant") ?? "");
  const tasks = listTasks();

  const open = (task: TaskDefinition) => {
    window.location.assign(taskHref(task, { participantId }));
  };

  return (
    <div className="launcher-shell">
      <main className="launcher-page">
        <header className="launcher-header">
          <h1>Creativity pilot</h1>
          <p className="launcher-lede">
            Three tasks, one per session. Choose the task you were asked to do.
          </p>
        </header>

        <label className="launcher-field">
          <span>Participant ID (optional here — the task will ask again)</span>
          <input
            value={participantId}
            onChange={event => setParticipantId(event.target.value)}
            placeholder="p001"
          />
        </label>

        <ul className="launcher-grid">
          {tasks.map(task => (
            <li key={task.taskId} className="launcher-card">
              <div className="launcher-card-head">
                <h2>{task.title}</h2>
                <span
                  className={
                    task.status === "available"
                      ? "launcher-badge launcher-badge--ready"
                      : "launcher-badge launcher-badge--planned"
                  }
                >
                  {task.status === "available" ? "Ready" : "In preparation"}
                </span>
              </div>
              <p className="launcher-instrument">
                {task.modality === "drawing" ? "Drawing" : "Writing"} · {task.instrument}
              </p>
              <p className="launcher-summary">{task.summary}</p>
              <ul className="launcher-outputs">
                {task.outputs.map(output => (
                  <li key={output}>{output}</li>
                ))}
              </ul>
              <button
                className={task.status === "available" ? "launcher-primary" : "launcher-secondary"}
                onClick={() => open(task)}
              >
                {task.status === "available" ? "Start this task" : "What this will be"}
              </button>
            </li>
          ))}
        </ul>

        <p className="launcher-footnote">
          The earlier Excalidraw drawing pilot is still available at{" "}
          <a href="/?mode=excalidraw-session">?mode=excalidraw-session</a>. It is not one of the
          three study tasks.
        </p>
      </main>
    </div>
  );
}

export default TaskLauncher;
