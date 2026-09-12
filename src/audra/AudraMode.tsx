import { useMemo, useState } from "react";
import { formatClock, isTimed, timingFromQuery } from "../tasks/timing";
import AgentTrialHost from "./AgentTrialHost";
import "./audra.css";
import AudraTask from "./AudraTask";
import { developmentStimulus, listStimuli, stimulusById } from "./stimulus";

function newId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

/**
 * Entry point for the `audra-incomplete-shapes` mode. Deliberately separate
 * from the Excalidraw session app: this mode shares no canvas, no toolbar, and
 * no scene state with it.
 *
 * The time limit comes from src/tasks/taskTiming.json, the file the agent
 * driver reads too; `?timeLimitSec=` / `?finalizeWindowSec=` override it for one
 * session.
 */
export function AudraMode() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [participantId, setParticipantId] = useState(query.get("participant") ?? "");
  const [stimulusChoice, setStimulusChoice] = useState(
    query.get("stimulus") ?? developmentStimulus.stimulusId
  );
  const [trial, setTrial] = useState<{ sessionId: string; trialId: string } | null>(null);
  const { timing, overridden, problems } = useMemo(
    () => timingFromQuery("audra-incomplete-shapes", query),
    [query]
  );

  const stimulus = stimulusById(stimulusChoice) ?? developmentStimulus;

  // An agent-driven trial is created over HTTP and its id and render token are
  // handed to this page. The page then acts purely as that trial's renderer.
  const hostTrialId = query.get("trialId");
  const hostToken = query.get("token");
  if (hostTrialId && hostToken) return <AgentTrialHost trialId={hostTrialId} token={hostToken} />;

  if (!trial) {
    return (
      <div className="audra-shell">
        <section className="audra-instructions">
          <h1>Incomplete shapes task</h1>
          <label className="audra-field">
            <span>Participant ID</span>
            <input
              value={participantId}
              onChange={event => setParticipantId(event.target.value)}
              placeholder="p001"
            />
          </label>
          <label className="audra-field">
            <span>Stimulus</span>
            <select value={stimulusChoice} onChange={event => setStimulusChoice(event.target.value)}>
              {listStimuli().map(item => (
                <option key={item.stimulusId} value={item.stimulusId}>
                  {item.stimulusId} ({item.source})
                </option>
              ))}
            </select>
          </label>
          <p className="audra-meta">
            {isTimed(timing)
              ? `Time limit ${formatClock(timing.timeLimitSec * 1000)}, Submit open for the last ${formatClock(timing.finalizeWindowSec * 1000)}`
              : "Untimed"}
            {overridden ? " (set by this link, not the configured default)" : ""}
          </p>
          {problems.map(problem => (
            <p key={problem} className="audra-error">
              {problem}
            </p>
          ))}
          <button
            className="audra-primary"
            disabled={participantId.trim().length === 0}
            onClick={() => setTrial({ sessionId: newId("session"), trialId: newId("trial") })}
          >
            Begin trial
          </button>
        </section>
      </div>
    );
  }

  return (
    <AudraTask
      sessionId={trial.sessionId}
      trialId={trial.trialId}
      actorId={participantId.trim()}
      stimulus={stimulus}
      timing={timing}
      timingOverridden={overridden}
    />
  );
}

export default AudraMode;
