import { useCallback, useEffect, useRef, useState } from "react";
import { useThinkAloud } from "../audra/useThinkAloud";
import {
  applyHumanCs4Event,
  initialHumanCs4State,
  textDiff,
  type HumanCs4Event,
  type HumanCs4EventType,
  type HumanCs4State
} from "../tasks/cs4/humanRevision";
import { wordCount, type Cs4InstanceView } from "../tasks/cs4/item";
import { fetchCs4Round } from "../tasks/itemClient";
import { formatClock, isTimed, remainingMs, submitOpen, type TaskTiming } from "../tasks/timing";
import { blobToBase64, consentKo, koreanDuration, pauseAfterMs, spokenDuration } from "../textTasks/shared";

type Phase = "instructions" | "writing" | "confirming" | "loading_round" | "done";

const ko = {
  instructions: (rounds: number) => [
    `짧은 이야기를 ${rounds}라운드에 걸쳐 고쳐 씁니다.`,
    "라운드마다 지켜야 할 제약이 주어집니다. 이전 라운드의 제약에 새 제약이 더해집니다. 이야기가 지금 주어진 모든 제약을 만족하면서 약 500단어의 하나의 일관된 이야기가 되도록 고쳐 쓰세요.",
    "메모장에서처럼 이야기를 자유롭게 고치면 됩니다. 다음 라운드는 이번 라운드에서 남긴 이야기에서 시작합니다.",
    "이야기와 제약의 기준은 영어 원문입니다."
  ],
  timed: (limit: number, window: number) =>
    `각 라운드는 ${koreanDuration(limit)}입니다. 라운드 시간 내내 계속 작업해 주세요. 라운드 마치기는 그 라운드의 마지막 ${koreanDuration(window)}에만 할 수 있습니다. 라운드 시간이 끝나면 그때의 이야기로 다음 라운드가 시작됩니다.`,
  instruction: "쓰기 지시",
  constraints: "지금 적용되는 제약",
  machine: "제약과 지시의 한국어 번역은 검토 전 기계 번역입니다. 기준은 영어 원문입니다.",
  reviewed: "한국어 번역은 이해를 돕기 위한 것입니다. 기준은 영어 원문입니다."
};

export type Cs4TaskProps = {
  sessionId: string;
  trialId: string;
  actorId: string;
  /** The first round's participant view; later rounds are fetched only when they begin. */
  firstRound: Cs4InstanceView;
  timing: TaskTiming;
  timingOverridden?: boolean;
};

export function Cs4Task({ sessionId, trialId, actorId, firstRound, timing, timingOverridden = false }: Cs4TaskProps) {
  const [phase, setPhase] = useState<Phase>("instructions");
  const [view, setView] = useState<Cs4InstanceView>(firstRound);
  const [story, setStory] = useState<HumanCs4State>(() => initialHumanCs4State(firstRound.baseStory));
  const [notice, setNotice] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [startedAtEpochMs] = useState(() => Date.now());
  const [sessionClockStartedAt, setSessionClockStartedAt] = useState<number | null>(null);
  const [roundStartedAtEpochMs, setRoundStartedAtEpochMs] = useState<number | null>(null);
  const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());
  const [showKorean, setShowKorean] = useState(false);

  const eventsRef = useRef<HumanCs4Event[]>([]);
  const storyRef = useRef<HumanCs4State>(story);
  const pauseTimerRef = useRef<number | null>(null);
  const pastedRef = useRef(false);
  const endingRef = useRef(false);
  const advancingRef = useRef(false);
  const koreanShownRef = useRef(false);
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

  const translation = view.translations?.ko ?? null;
  const timed = isTimed(timing);
  const roundElapsedMs = roundStartedAtEpochMs == null ? 0 : nowEpochMs - roundStartedAtEpochMs;
  const timeLeftMs = remainingMs(timing, roundElapsedMs);
  const canFinishNow = submitOpen(timing, roundElapsedMs);
  const fresh = new Set(view.round > 1 ? view.newConstraints : []);

  useEffect(() => {
    if (!timed || (phase !== "writing" && phase !== "confirming")) return;
    const interval = window.setInterval(() => setNowEpochMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [phase, timed]);

  const record = useCallback(
    (eventType: HumanCs4EventType, payload: Record<string, unknown>) => {
      const event: HumanCs4Event = { eventIndex: eventsRef.current.length, timestampMs: elapsedMs(), eventType, payload };
      const result = applyHumanCs4Event(storyRef.current, event);
      if (!result.ok) {
        setNotice(result.error);
        return null;
      }
      eventsRef.current.push(event);
      storyRef.current = result.state;
      setStory(result.state);
      return result.state;
    },
    [elapsedMs]
  );

  const flushPause = useCallback(() => {
    if (pauseTimerRef.current != null) {
      window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    if (eventsRef.current.at(-1)?.eventType === "text_edit") record("pause", { length: storyRef.current.text.length });
  }, [record]);

  useEffect(() => () => {
    if (pauseTimerRef.current != null) window.clearTimeout(pauseTimerRef.current);
  }, []);

  const toggleKorean = useCallback(() => {
    const visible = !showKorean;
    setShowKorean(visible);
    if (visible) koreanShownRef.current = true;
    if (phase === "writing" || phase === "confirming") {
      flushPause();
      record("translation_toggle", { language: "ko", visible });
    }
  }, [flushPause, phase, record, showKorean]);

  const onTextChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (phase !== "writing") return;
      const edit = textDiff(storyRef.current.text, event.target.value);
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

  const exportSession = useCallback(
    async (finalState: HumanCs4State) => {
      const endedAtEpochMs = Date.now();
      const lastRound = finalState.results.at(-1);
      try {
        setExportStatus("Finishing the audio recording…");
        await thinkAloud.stop();
        const audio = thinkAloud.audioBlob();
        setExportStatus("Saving…");
        const response = await fetch("/api/tasks/cs4-creative-writing/human/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            trialId,
            itemId: firstRound.instanceId,
            actorId,
            events: eventsRef.current,
            finalText: finalState.text,
            startedAt: new Date(startedAtEpochMs).toISOString(),
            endedAt: new Date(endedAtEpochMs).toISOString(),
            protocol: {
              scope: "round",
              timeLimitSec: timing.timeLimitSec,
              finalizeWindowSec: timed ? timing.finalizeWindowSec : null,
              overridden: timingOverridden,
              endedBy: lastRound?.endedBy ?? null,
              rounds: finalState.results.map(result => ({ round: result.round, endedBy: result.endedBy, endedAtMs: result.endedAtMs })),
              clockStartedAtMs: sessionClockStartedAt == null ? null : sessionClockStartedAt - startedAtEpochMs,
              activeMs: sessionClockStartedAt == null ? null : endedAtEpochMs - sessionClockStartedAt,
              translation: { language: "ko", available: translation != null, everShown: koreanShownRef.current }
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
    [actorId, firstRound.instanceId, sessionClockStartedAt, sessionId, startedAtEpochMs, thinkAloud, timed, timing, timingOverridden, translation, trialId]
  );

  /**
   * Moves on after a round has ended, however it ended. The next round's
   * constraints are fetched only now, so the page never holds them early; the
   * round clock starts once they are on screen.
   */
  const advance = useCallback(
    async (state: HumanCs4State) => {
      if (state.complete) {
        endingRef.current = true;
        setPhase("done");
        await exportSession(state);
        return;
      }
      setPhase("loading_round");
      try {
        const next = await fetchCs4Round(firstRound.instanceId, state.round);
        setView(next);
        const now = Date.now();
        setRoundStartedAtEpochMs(now);
        setNowEpochMs(now);
        setNotice(null);
        setPhase("writing");
      } catch (error) {
        setNotice(`The next round could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        advancingRef.current = false;
      }
    },
    [exportSession, firstRound.instanceId]
  );

  const requestFinish = useCallback(() => {
    if (storyRef.current.text.trim().length === 0) {
      setNotice("The story is empty.");
      return;
    }
    if (!submitOpen(timing, Date.now() - (roundStartedAtEpochMs ?? Date.now()))) {
      setNotice(`Keep working. Finish round opens in the last ${spokenDuration(timing.finalizeWindowSec)} of the round.`);
      return;
    }
    flushPause();
    setNotice(null);
    setPhase("confirming");
  }, [flushPause, roundStartedAtEpochMs, timing]);

  const confirmFinish = useCallback(async () => {
    if (advancingRef.current || endingRef.current) return;
    advancingRef.current = true;
    const state = record("round_submit", {});
    if (!state) {
      advancingRef.current = false;
      setPhase("writing");
      return;
    }
    await advance(state);
  }, [advance, record]);

  /** The round's clock ran out: the protocol ends the round, and the story carries on. */
  const endRoundByTime = useCallback(async () => {
    if (advancingRef.current || endingRef.current) return;
    advancingRef.current = true;
    flushPause();
    const state = record("round_end", { cause: "time_limit" });
    if (!state) {
      advancingRef.current = false;
      return;
    }
    await advance(state);
  }, [advance, flushPause, record]);

  useEffect(() => {
    if (timed && (phase === "writing" || phase === "confirming") && timeLeftMs <= 0) void endRoundByTime();
  }, [endRoundByTime, phase, timeLeftMs, timed]);

  const koreanButton = (
    <button type="button" className="tt-toggle" onClick={toggleKorean} aria-pressed={showKorean}>
      {showKorean ? "한국어 번역 숨기기" : "한국어 번역 보기"}
    </button>
  );

  if (phase === "instructions") {
    return (
      <div className="tt-shell">
        <section className="tt-card">
          <h1>Story revision task</h1>
          {koreanButton}
          <ul className="tt-list">
            <li>You will revise a short story over {view.totalRounds} rounds.</li>
            <li>
              Each round shows the constraints in force: the previous round's plus new ones. Revise the story so that it
              satisfies every constraint in force and stays one coherent story of about 500 words.
            </li>
            <li>Edit the story freely, the way you would in a notepad. The next round starts from the story as you leave it.</li>
            {timed && (
              <li>
                Each round lasts {spokenDuration(timing.timeLimitSec)}. Keep working for the whole round; Finish round opens in its
                last {spokenDuration(timing.finalizeWindowSec)}. When a round's time runs out, the next round begins with the story as it is.
              </li>
            )}
          </ul>
          {showKorean && (
            <ul className="tt-list tt-ko">
              {ko.instructions(view.totalRounds).map(line => (
                <li key={line}>{line}</li>
              ))}
              {timed && <li>{ko.timed(timing.timeLimitSec, timing.finalizeWindowSec)}</li>}
            </ul>
          )}
          {view.source === "development" && (
            <p className="tt-dev-notice">Development fixture - not a CS4 benchmark instance.</p>
          )}
          <p className="tt-consent">
            Please think aloud while you work. Your voice is recorded for the study and stored with your story. A
            microphone problem will not stop you from writing or finishing.
            {showKorean && <span className="tt-ko">{consentKo}</span>}
          </p>
          {thinkAloud.error && <p className="tt-error">{thinkAloud.error}</p>}
          <button
            className="tt-primary"
            onClick={async () => {
              await thinkAloud.start();
              const now = Date.now();
              setSessionClockStartedAt(now);
              setRoundStartedAtEpochMs(now);
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

  if (phase === "done") {
    const last = story.results.at(-1);
    return (
      <div className="tt-shell">
        <section className="tt-card">
          <h1>{last?.endedBy === "time_limit" ? "Time is up" : "Finished"}</h1>
          <p>Thank you. Your story and every round of it have been recorded.</p>
          {exportStatus && <p className="tt-meta">{exportStatus}</p>}
        </section>
      </div>
    );
  }

  const locked = phase !== "writing";

  return (
    <div className="tt-shell">
      <section className="tt-stage tt-stage--wide">
        <div className="tt-status">
          <span className="tt-round">
            Round {view.round} of {view.totalRounds}
          </span>
          {timed && phase !== "loading_round" && (
            <span className={canFinishNow ? "tt-timer tt-timer--final" : "tt-timer"} role="timer">
              <strong>{formatClock(timeLeftMs)}</strong> left in this round
              {canFinishNow ? " · finish the round" : ` · Finish round opens in the last ${formatClock(timing.finalizeWindowSec * 1000)}`}
            </span>
          )}
          {thinkAloud.isRecording && (
            <span className="tt-recording" role="status">
              ● recording
              <span className="tt-meter" aria-hidden="true">
                <span className="tt-meter-fill" style={{ width: `${Math.min(100, Math.round(thinkAloud.inputLevel * 300))}%` }} />
              </span>
            </span>
          )}
          {koreanButton}
        </div>

        {thinkAloud.isRecording && thinkAloud.noInputSignal && (
          <p className="tt-warning" role="alert">
            No sound is reaching the microphone. Check that the browser may use it and that the right input device is
            selected. You can keep writing - your story is recorded either way.
          </p>
        )}

        <article className="tt-panel">
          <h2>Writing instruction{showKorean && ` · ${ko.instruction}`}</h2>
          <p>{view.instruction}</p>
          {showKorean && translation && <p className="tt-ko">{translation.instruction}</p>}
        </article>

        <div className="tt-cs4-grid">
          <article className="tt-panel">
            <h2>
              Constraints in force ({view.constraints.length})
              {view.round > 1 && ` · ${view.newConstraints.length} new this round`}
              {showKorean && ` · ${ko.constraints}`}
            </h2>
            <ol className="tt-constraints">
              {view.constraints.map((constraint, index) => (
                <li key={constraint}>
                  {fresh.has(constraint) && <span className="tt-new">NEW</span>}
                  {constraint}
                  {showKorean && translation && <span className="tt-ko">{translation.constraints[index]}</span>}
                </li>
              ))}
            </ol>
            {showKorean && translation && <p className="tt-ko-note">{translation.machine ? ko.machine : ko.reviewed}</p>}
          </article>

          <div>
            <label className="tt-memo tt-memo--story">
              <span>Your story</span>
              <textarea
                value={story.text}
                onChange={onTextChange}
                onPaste={() => {
                  pastedRef.current = true;
                }}
                readOnly={locked}
                spellCheck
              />
            </label>
            <p className="tt-wordcount">{wordCount(story.text)} words · about 500 is the target</p>
          </div>
        </div>

        {notice && <p className="tt-notice">{notice}</p>}
        {phase === "loading_round" && !notice && <p className="tt-meta">Loading the next round…</p>}

        {phase === "confirming" ? (
          <div className="tt-confirm">
            <p>
              Finish round {view.round}?{" "}
              {view.round < view.totalRounds ? "The next round starts from this story." : "This is the last round."}
            </p>
            <div className="tt-confirm-actions">
              <button className="tt-primary" onClick={() => void confirmFinish()}>
                Yes, finish the round
              </button>
              <button className="tt-secondary" onClick={() => setPhase("writing")}>
                Keep working
              </button>
            </div>
          </div>
        ) : phase === "loading_round" ? (
          notice && (
            <button className="tt-secondary" onClick={() => void advance(storyRef.current)}>
              Try again
            </button>
          )
        ) : (
          <button className="tt-primary" onClick={requestFinish} disabled={!canFinishNow}>
            Finish round
          </button>
        )}

        <p className="tt-meta">
          instance {view.instanceId} ({view.source})
        </p>
      </section>
    </div>
  );
}

export default Cs4Task;
