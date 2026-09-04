import { useEffect, useState } from "react";
import type { TaskDefinition } from "../tasks/catalog";
import { fetchTaskItemList, type TaskItemList } from "../tasks/itemClient";
import "./launcher.css";

/**
 * Stands in for a task whose participant flow does not exist yet. It states
 * what is already decided and what is still missing, so a task that is only
 * routed and not built cannot be mistaken for one that can collect data.
 */
export function TaskPlaceholder({ task }: { task: TaskDefinition }) {
  // Items are dropped in as files, so the page reports what is actually on
  // disk rather than what the description claims. A task with no item
  // directory simply shows nothing here.
  const [items, setItems] = useState<TaskItemList | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTaskItemList(task.taskId)
      .then(list => {
        if (!cancelled) setItems(list);
      })
      .catch((error: Error) => {
        if (!cancelled) setItemsError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [task.taskId]);

  return (
    <div className="launcher-shell">
      <main className="launcher-page launcher-page--narrow">
        <header className="launcher-header">
          <h1>{task.title}</h1>
          <p className="launcher-instrument">
            {task.modality === "drawing" ? "Drawing" : "Writing"} · {task.instrument}
          </p>
        </header>

        <p className="launcher-notice">
          This task is not implemented yet. Nothing here records or exports anything.
        </p>

        <p className="launcher-summary">{task.summary}</p>

        <section className="launcher-section">
          <h2>What the trial produces</h2>
          <ul>
            {task.outputs.map(output => (
              <li key={output}>{output}</li>
            ))}
          </ul>
        </section>

        <section className="launcher-section">
          <h2>Already decided</h2>
          <ul>
            {task.design.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        {items && (
          <section className="launcher-section">
            <h2>Items loaded</h2>
            <ul>
              <li>
                <code>data/tasks</code>: {items.itemIds.length} item
                {items.itemIds.length === 1 ? "" : "s"}
                {items.fixtureCount > 0 && ` (${items.fixtureCount} development fixture${
                  items.fixtureCount === 1 ? "" : "s"
                })`}
                , {items.pilotSubset.length} in the pilot subset
              </li>
              {items.errors.map(error => (
                <li key={error} className="launcher-item-error">
                  {error}
                </li>
              ))}
            </ul>
          </section>
        )}

        {itemsError && (
          <p className="launcher-footnote">Item list unavailable: {itemsError}</p>
        )}

        <section className="launcher-section">
          <h2>Still to build</h2>
          <ul>
            {task.remaining.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <p className="launcher-footnote">{task.reference}</p>
        <a className="launcher-back" href="/">
          Back to the task list
        </a>
      </main>
    </div>
  );
}

export default TaskPlaceholder;
