import { useEffect, useMemo, useState } from "react";
import type { Cs4InstanceView } from "../tasks/cs4/item";
import { fetchCs4Round, fetchTaskItemList, type TaskItemList } from "../tasks/itemClient";
import { formatClock, isTimed, timingFromQuery } from "../tasks/timing";
import { newId } from "../textTasks/shared";
import "../textTasks/textTask.css";
import Cs4Task from "./Cs4Task";

const taskId = "cs4-creative-writing";

/**
 * Entry point for the `cs4-creative-writing` mode: participant id, instance,
 * then the three-round session. `?item=` preselects an instance;
 * `?timeLimitSec=` / `?finalizeWindowSec=` override src/tasks/taskTiming.json
 * (per round) for one session.
 */
export function Cs4Mode() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [participantId, setParticipantId] = useState(query.get("participant") ?? "");
  const [items, setItems] = useState<TaskItemList | null>(null);
  const [itemChoice, setItemChoice] = useState(query.get("item") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<{ sessionId: string; trialId: string; firstRound: Cs4InstanceView } | null>(null);
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
        if (!cancelled) setError(`Instances could not be loaded: ${reason.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (session) {
    return (
      <Cs4Task
        sessionId={session.sessionId}
        trialId={session.trialId}
        actorId={participantId.trim()}
        firstRound={session.firstRound}
        timing={timing}
        timingOverridden={overridden}
      />
    );
  }

  const pilot = new Set(items?.pilotSubset ?? []);
  const ordered = items ? [...items.pilotSubset, ...items.itemIds.filter(id => !pilot.has(id))] : [];

  return (
    <div className="tt-shell">
      <section className="tt-card">
        <h1>Story revision task</h1>
        <label className="tt-field">
          <span>Participant ID</span>
          <input value={participantId} onChange={event => setParticipantId(event.target.value)} placeholder="p001" />
        </label>
        <label className="tt-field">
          <span>Story</span>
          <select value={itemChoice} onChange={event => setItemChoice(event.target.value)} disabled={!items}>
            {ordered.map(id => (
              <option key={id} value={id}>
                {id}
                {pilot.has(id) ? "" : " (not in the pilot subset)"}
              </option>
            ))}
          </select>
        </label>
        <p className="tt-meta">
          {isTimed(timing)
            ? `${formatClock(timing.timeLimitSec * 1000)} per round, Finish round open for the last ${formatClock(timing.finalizeWindowSec * 1000)}`
            : "Untimed"}
          {overridden ? " (set by this link, not the configured default)" : ""}
        </p>
        {problems.map(problem => (
          <p key={problem} className="tt-error">
            {problem}
          </p>
        ))}
        {error && <p className="tt-error">{error}</p>}
        <button
          className="tt-primary"
          disabled={participantId.trim().length === 0 || !itemChoice || starting}
          onClick={async () => {
            setStarting(true);
            try {
              const firstRound = await fetchCs4Round(itemChoice, 1);
              setSession({ sessionId: newId("session"), trialId: newId("trial"), firstRound });
            } catch (reason) {
              setError(`The story could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`);
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

export default Cs4Mode;
