import { useCallback, useEffect, useRef, useState } from "react";
import { useThinkAloud } from "../audra/useThinkAloud";
import type { Judgement } from "../tasks/macgyver/answer";
import {
  applyHumanEvent,
  initialHumanState,
  textDiff,
  type HumanMacGyverEvent,
  type HumanMacGyverEventType,
  type HumanMacGyverState
} from "../tasks/macgyver/humanAnswer";
import type { MacGyverItemView } from "../tasks/macgyver/item";
import { formatClock, isTimed, remainingMs, submitOpen, type TaskTiming } from "../tasks/timing";

type Phase = "instructions" | "writing" | "confirming" | "submitted" | "time_up";

type EndedBy = "submitted" | "time_limit";

// Typing that stops for this long closes an edit burst: the boundary at which
// the memo's lines are read as steps. The same idle window as the Excalidraw
// session's human action log.
const pauseAfterMs = 700;

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function spokenDuration(seconds: number) {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${formatClock(seconds * 1000)} (minutes:seconds)`;
}

export type MacGyverTaskProps = {
  sessionId: string;
  trialId: string;
  actorId: string;
  item: MacGyverItemView;
  timing: TaskTiming;
  timingOverridden?: boolean;
};

export function MacGyverTask({ sessionId, trialId, actorId, item, timing, timingOverridden = false }: MacGyverTaskProps) {
  const [phase, setPhase] = useState<Phase>("instructions");
  const [answer, setAnswer] = useState<HumanMacGyverState>(initialHumanState);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [startedAtEpochMs] = useState(() => Date.now());
  const [clockStartedAtEpochMs, setClockStartedAtEpochMs] = useState<number | null>(null);
  const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());

  const eventsRef = useRef<HumanMacGyverEvent[]>([]);
  // The log's own copy of the answer, updated synchronously so consecutive
  // keystrokes never diff against a stale render.
  const answerRef = useRef<HumanMacGyverState>(answer);
  const pauseTimerRef = useRef<number | null>(null);
  const pastedRef = useRef(false);
  const endingRef = useRef(false);
  const thinkAloudChunksRef = useRef<unknown[]>([]);

  const elapsedMs = useCallback(() => Math.max(0, Date.now() - startedAtEpochMs), [startedAtEpochMs]);

  const thinkAloud = useThinkAloud({
    sessionId,
    trialId,
    actorId,
    elapsedMs,
    currentRevision: () => eventsRef.current.length
  });
  thinkAloudChunksRef.current = thinkAloud.chunks as unknown[];

  const timed = isTimed(timing);
  const clockElapsedMs = clockStartedAtEpochMs == null ? 0 : nowEpochMs - clockStartedAtEpochMs;
  const timeLeftMs = remainingMs(timing, clockElapsedMs);
  const canSubmitNow = submitOpen(timing, clockElapsedMs);

  useEffect(() => {
    if (!timed || (phase !== "writing" && phase !== "confirming")) return;
    const interval = window.setInterval(() => setNowEpochMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [phase, timed]);

  /** Appends one event, through the same rules the server replays it with. */
  const record = useCallback(
    (eventType: HumanMacGyverEventType, payload: Record<string, unknown>) => {
      const event: HumanMacGyverEvent = { eventIndex: eventsRef.current.length, timestampMs: elapsedMs(), eventType, payload };
      const result = applyHumanEvent(answerRef.current, event);
      if (!result.ok) {
        setNotice(result.error);
        return null;
      }
      eventsRef.current.push(event);
      answerRef.current = result.state;
      setAnswer(result.state);
      return result.state;
    },
    [elapsedMs]
  );

  const flushPause = useCallback(() => {
    if (pauseTimerRef.current != null) {
      window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    if (eventsRef.current.at(-1)?.eventType === "text_edit") record("pause", { length: answerRef.current.text.length });
  }, [record]);

  useEffect(() => () => {
    if (pauseTimerRef.current != null) window.clearTimeout(pauseTimerRef.current);
  }, []);

  const onTextChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (phase !== "writing") return;
      const edit = textDiff(answerRef.current.text, event.target.value);
      if (!edit) return;
      if (record("text_edit", { ...edit, source: pastedRef.current ? "paste" : "typing" })) setNotice(null);
      pastedRef.current = false;
      if (pauseTimerRef.current != null) window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = window.setTimeout(() => {
        pauseTimerRef.current = null;
        flushPause();
      }, pauseAfterMs);
    },
    [flushPause, phase, record]
  );

  const chooseJudgement = useCallback(
    (value: Judgement) => {
      if (phase !== "writing" || answerRef.current.judgement === value) return;
      flushPause();
      record("judgement_set", { value });
    },
    [flushPause, phase, record]
  );

  const exportTrial = useCallback(
    async (endedBy: EndedBy) => {
      const endedAtEpochMs = Date.now();
      try {
        setExportStatus("Finishing the audio recording…");
        await thinkAloud.stop();
        const audio = thinkAloud.audioBlob();
        setExportStatus("Saving…");
        const response = await fetch("/api/tasks/macgyver-problem-solving/human/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            trialId,
            itemId: item.itemId,
            actorId,
            events: eventsRef.current,
            // Checked against the replayed log on the server.
            finalText: answerRef.current.text,
            startedAt: new Date(startedAtEpochMs).toISOString(),
            endedAt: new Date(endedAtEpochMs).toISOString(),
            // The same block an agent run records, so the two can be compared.
            protocol: {
              scope: "trial",
              timeLimitSec: timing.timeLimitSec,
              finalizeWindowSec: timed ? timing.finalizeWindowSec : null,
              overridden: timingOverridden,
              endedBy,
              clockStartedAtMs: clockStartedAtEpochMs == null ? null : clockStartedAtEpochMs - startedAtEpochMs,
              activeMs: clockStartedAtEpochMs == null ? null : endedAtEpochMs - clockStartedAtEpochMs
            },
            thinkAloud: thinkAloudChunksRef.current,
            audioBase64: audio ? await blobToBase64(audio) : null,
            audioMimeType: audio?.type ?? null
          })
        });
        const payload = await response.json();
        setExportStatus(payload.ok ? `Saved to ${payload.baseName}` : `Export failed: ${payload.error}`);
      } catch (error) {
        setExportStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [actorId, clockStartedAtEpochMs, item.itemId, sessionId, startedAtEpochMs, thinkAloud, timed, timing, timingOverridden, trialId]
  );

  const requestSubmit = useCallback(() => {
    if (!answerRef.current.judgement) {
      setNotice("Choose whether the problem can be solved.");
      return;
    }
    if (answerRef.current.text.trim().length === 0) {
      setNotice("Write your answer before submitting.");
      return;
    }
    if (!submitOpen(timing, Date.now() - (clockStartedAtEpochMs ?? Date.now()))) {
      setNotice(`Keep working. Submit opens in the last ${spokenDuration(timing.finalizeWindowSec)}.`);
      return;
    }
    flushPause();
    setNotice(null);
    setPhase("confirming");
  }, [clockStartedAtEpochMs, flushPause, timing]);

  const confirmSubmit = useCallback(async () => {
    if (endingRef.current) return;
    if (!record("submit", {})) {
      setPhase("writing");
      return;
    }
    endingRef.current = true;
    setPhase("submitted");
    await exportTrial("submitted");
  }, [exportTrial, record]);

  /**
   * Time is up. Nothing is submitted on the participant's behalf, as nothing is
   * for an agent: the memo locks and is saved as it stands.
   */
  const endByTime = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    flushPause();
    setPhase("time_up");
    await exportTrial("time_limit");
  }, [exportTrial, flushPause]);

  useEffect(() => {
    if (timed && (phase === "writing" || phase === "confirming") && timeLeftMs <= 0) void endByTime();
  }, [endByTime, phase, timeLeftMs, timed]);

  if (phase === "instructions") {
    return (
      <div className="mg-shell">
        <section className="mg-card">
          <h1>Problem solving task</h1>
          <ul className="mg-list">
            <li>You will read a practical problem. Decide whether it can be solved using only what the problem describes.</li>
            <li>If it can, write the steps you would take. If it cannot, explain why.</li>
            <li>Write in the note area the way you would in a notepad - one step per line works well, but any layout is fine.</li>
            <li>Do not look anything up.</li>
            {timed && (
              <li>
                You have {spokenDuration(timing.timeLimitSec)}. Keep working for the whole time; Submit opens in
                the last {spokenDuration(timing.finalizeWindowSec)}. When time runs out, your answer is saved as it is.
              </li>
            )}
          </ul>
          {item.source === "development" && (
            <p className="mg-dev-notice">Development fixture - not a MacGyver benchmark item.</p>
          )}
          <p className="mg-consent">
            Please think aloud while you work. Your voice is recorded for the study and stored with your
            answer. A microphone problem will not stop you from answering or submitting.
          </p>
          {thinkAloud.error && <p className="mg-error">{thinkAloud.error}</p>}
          <button
            className="mg-primary"
            onClick={async () => {
              // A refused or broken microphone must never cost the participant the trial.
              await thinkAloud.start();
              const now = Date.now();
              setClockStartedAtEpochMs(now);
              setNowEpochMs(now);
              setPhase("writing");
            }}
          >
            Start
          </button>
        </section>
      </div>
    );
  }

  if (phase === "submitted" || phase === "time_up") {
    return (
      <div className="mg-shell">
        <section className="mg-card">
          <h1>{phase === "submitted" ? "Submitted" : "Time is up"}</h1>
          <p>
            {phase === "submitted"
              ? "Thank you. Your answer has been recorded and can no longer be changed."
              : "Thank you. Your answer has been recorded as it was when time ran out."}
          </p>
          {exportStatus && <p className="mg-meta">{exportStatus}</p>}
        </section>
      </div>
    );
  }

  const locked = phase !== "writing";

  return (
    <div className="mg-shell">
      <section className="mg-stage">
        <article className="mg-problem">
          <h2>Problem</h2>
          <p>{item.problem}</p>
        </article>

        <div className="mg-status">
          {timed && (
            <span className={canSubmitNow ? "mg-timer mg-timer--final" : "mg-timer"} role="timer">
              <strong>{formatClock(timeLeftMs)}</strong> left
              {canSubmitNow ? " · finish your answer and submit" : ` · Submit opens in the last ${formatClock(timing.finalizeWindowSec * 1000)}`}
            </span>
          )}
          {thinkAloud.isRecording && (
            <span className="mg-recording" role="status">
              ● recording
              <span className="mg-meter" aria-hidden="true">
                <span className="mg-meter-fill" style={{ width: `${Math.min(100, Math.round(thinkAloud.inputLevel * 300))}%` }} />
              </span>
            </span>
          )}
        </div>

        {thinkAloud.isRecording && thinkAloud.noInputSignal && (
          <p className="mg-warning" role="alert">
            No sound is reaching the microphone. Check that the browser may use it and that the right input
            device is selected. You can keep writing - your answer is recorded either way.
          </p>
        )}

        <fieldset className="mg-judgement" disabled={locked}>
          <legend>Can this problem be solved with what it describes?</legend>
          <label>
            <input
              type="radio"
              name="judgement"
              checked={answer.judgement === "solvable"}
              onChange={() => chooseJudgement("solvable")}
            />
            Yes, it can be solved
          </label>
          <label>
            <input
              type="radio"
              name="judgement"
              checked={answer.judgement === "unsolvable"}
              onChange={() => chooseJudgement("unsolvable")}
            />
            No, it cannot be solved
          </label>
        </fieldset>

        <label className="mg-memo">
          <span>
            {answer.judgement === "unsolvable" ? "Why can it not be solved?" : "Your answer - the steps you would take"}
          </span>
          <textarea
            value={answer.text}
            onChange={onTextChange}
            onPaste={() => {
              pastedRef.current = true;
            }}
            readOnly={locked}
            spellCheck
            placeholder="Write here as you would in a notepad."
          />
        </label>

        {notice && <p className="mg-notice">{notice}</p>}

        {phase === "confirming" ? (
          <div className="mg-confirm">
            <p>Submit this answer? It cannot be changed afterwards.</p>
            <div className="mg-confirm-actions">
              <button className="mg-primary" onClick={() => void confirmSubmit()}>
                Yes, submit
              </button>
              <button className="mg-secondary" onClick={() => setPhase("writing")}>
                Keep working
              </button>
            </div>
          </div>
        ) : (
          <button className="mg-primary" onClick={requestSubmit} disabled={!canSubmitNow}>
            Submit
          </button>
        )}

        <p className="mg-meta">
          item {item.itemId} ({item.source})
        </p>
      </section>
    </div>
  );
}

export default MacGyverTask;
