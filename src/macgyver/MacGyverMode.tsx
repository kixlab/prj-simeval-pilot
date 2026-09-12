import { useEffect, useMemo, useState } from "react";
import { fetchMacGyverItem, fetchTaskItemList, type TaskItemList } from "../tasks/itemClient";
import type { MacGyverItemView } from "../tasks/macgyver/item";
import { formatClock, isTimed, timingFromQuery } from "../tasks/timing";
import MacGyverTask from "./MacGyverTask";
import "./macgyver.css";

const taskId = "macgyver-problem-solving";

function newId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

/**
 * Entry point for the `macgyver-problem-solving` mode: participant id, item,
 * then the task. `?item=` preselects an item; `?timeLimitSec=` /
 * `?finalizeWindowSec=` override src/tasks/taskTiming.json for one session.
 */
export function MacGyverMode() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [participantId, setParticipantId] = useState(query.get("participant") ?? "");
  const [items, setItems] = useState<TaskItemList | null>(null);
  const [itemChoice, setItemChoice] = useState(query.get("item") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [trial, setTrial] = useState<{ sessionId: string; trialId: string; item: MacGyverItemView } | null>(null);
  const { timing, overridden, problems } = useMemo(() => timingFromQuery(taskId, query), [query]);

  useEffect(() => {
    let cancelled = false;
    fetchTaskItemList(taskId)
      .then(list => {
        if (cancelled) return;
        setItems(list);
        setItemChoice(current => current || list.pilotSubset[0] || list.itemIds[0] || "");
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(`Items could not be loaded: ${reason.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (trial) {
    return (
      <MacGyverTask
        sessionId={trial.sessionId}
        trialId={trial.trialId}
        actorId={participantId.trim()}
        item={trial.item}
        timing={timing}
        timingOverridden={overridden}
      />
    );
  }

  const pilot = new Set(items?.pilotSubset ?? []);
  const ordered = items ? [...items.pilotSubset, ...items.itemIds.filter(id => !pilot.has(id))] : [];

  return (
    <div className="mg-shell">
      <section className="mg-card">
        <h1>Problem solving task</h1>
        <label className="mg-field">
          <span>Participant ID</span>
          <input value={participantId} onChange={event => setParticipantId(event.target.value)} placeholder="p001" />
        </label>
        <label className="mg-field">
          <span>Problem</span>
          <select value={itemChoice} onChange={event => setItemChoice(event.target.value)} disabled={!items}>
            {ordered.map(id => (
              <option key={id} value={id}>
                {id}
                {pilot.has(id) ? "" : " (not in the pilot subset)"}
              </option>
            ))}
          </select>
        </label>
        <p className="mg-meta">
          {isTimed(timing)
            ? `Time limit ${formatClock(timing.timeLimitSec * 1000)}, Submit open for the last ${formatClock(timing.finalizeWindowSec * 1000)}`
            : "Untimed"}
          {overridden ? " (set by this link, not the configured default)" : ""}
        </p>
        {problems.map(problem => (
          <p key={problem} className="mg-error">
            {problem}
          </p>
        ))}
        {error && <p className="mg-error">{error}</p>}
        <button
          className="mg-primary"
          disabled={participantId.trim().length === 0 || !itemChoice || starting}
          onClick={async () => {
            setStarting(true);
            try {
              const item = await fetchMacGyverItem(itemChoice);
              setTrial({ sessionId: newId("session"), trialId: newId("trial"), item });
            } catch (reason) {
              setError(`The problem could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
              setStarting(false);
            }
          }}
        >
          Begin
        </button>
      </section>
    </div>
  );
}

export default MacGyverMode;
