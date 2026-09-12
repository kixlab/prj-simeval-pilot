import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatClock, isTimed, remainingMs, submitOpen, type TaskTiming } from "../tasks/timing";
import { canonicalArtboard, eraserWidth, maxDescriptionLength, pencilWidth } from "./artboard";
import { eraseFromStrokes, type ForegroundStroke } from "./eraser";
import type { StrokePoint } from "./events";
import {
  controlDraft,
  defaultWidthFor,
  ensureDrawablePoints,
  strokeDraft,
  toArtboardPoint,
  type HumanTool
} from "./humanInput";
import type { AudraTrialState } from "./reducer";
import { loadStimulusImage, renderTrial } from "./render";
import { descriptionPrompt, taskInstruction, type Stimulus } from "./stimulus";
import { koreanDuration } from "../textTasks/shared";
import { useAudraTrial } from "./useAudraTrial";
import { useThinkAloud } from "./useThinkAloud";

type TrialPhase = "instructions" | "drawing" | "confirming" | "submitted" | "time_up";

type EndedBy = "submitted" | "time_limit";

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

// Korean shown under the English on request. The English stays the instruction
// of record, as it is the only text an agent sees.
const ko = {
  instruction: "시작 선들을 하나의 창의적인 그림의 일부로 사용하세요. 최대한 창의적으로 그려 보세요.",
  list: [
    "캔버스에는 이미 네 개의 시작 선이 있습니다. 이 선들은 옮기거나 지울 수 없습니다.",
    "네 개의 시작 선 모두가 그림의 일부가 되어야 합니다.",
    "연필, 지우개, 마지막 획 취소(Undo Last)만 사용할 수 있습니다.",
    "그림을 마친 뒤 무엇을 그렸는지 적게 됩니다."
  ],
  timed: (limit: number, window: number) =>
    `시간은 ${koreanDuration(limit)}입니다. 시간 내내 그림을 계속 그려 주세요. 제출(Submit)은 마지막 ${koreanDuration(window)}에만 할 수 있습니다. 시간이 끝나면 그때까지의 그림이 그대로 저장됩니다.`,
  consent:
    "그림을 그리는 동안 생각을 소리 내어 말해 주세요. 목소리는 연구를 위해 녹음되어 그림과 함께 저장됩니다. 마이크에 문제가 있어도 그림을 그리고 제출하는 데는 지장이 없습니다.",
  description: "무엇을 그렸나요?"
};

export type AudraTaskProps = {
  sessionId: string;
  trialId: string;
  actorId: string;
  stimulus: Stimulus;
  /** The clock this trial runs under; see src/tasks/taskTiming.json. */
  timing: TaskTiming;
  /** Whether the session overrode the configured timing; recorded with the trial. */
  timingOverridden?: boolean;
  onSubmitted?: (payload: { trialId: string }) => void;
};

export function AudraTask({ sessionId, trialId, actorId, stimulus, timing, timingOverridden = false, onSubmitted }: AudraTaskProps) {
  const [phase, setPhase] = useState<TrialPhase>("instructions");
  const [tool, setTool] = useState<HumanTool>("pencil");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [startedAtEpochMs] = useState(() => Date.now());
  const [background, setBackground] = useState<HTMLImageElement | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  // The clock starts when the participant presses Start, as an agent's does at
  // its first observation - not when the page loads.
  const [clockStartedAtEpochMs, setClockStartedAtEpochMs] = useState<number | null>(null);
  const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());
  const [showKorean, setShowKorean] = useState(false);
  // Kept beside the canonical log rather than in it: that log is the one the
  // agent's reducer replays, and an agent has no translation to toggle.
  const koreanTogglesRef = useRef<{ atMs: number; visible: boolean }[]>([]);

  const toggleKorean = useCallback(() => {
    setShowKorean(visible => {
      koreanTogglesRef.current.push({ atMs: Date.now() - startedAtEpochMs, visible: !visible });
      return !visible;
    });
  }, [startedAtEpochMs]);

  const trial = useAudraTrial({
    sessionId,
    trialId,
    stimulusId: stimulus.stimulusId,
    actorType: "human",
    actorId,
    startedAtEpochMs
  });

  const thinkAloudChunksRef = useRef<unknown[]>([]);
  const trialStateRef = useRef(trial.state);
  trialStateRef.current = trial.state;
  const descriptionDraftRef = useRef(descriptionDraft);
  descriptionDraftRef.current = descriptionDraft;
  const endingRef = useRef(false);

  const thinkAloud = useThinkAloud({
    sessionId,
    trialId,
    actorId,
    elapsedMs: trial.elapsedMs,
    currentRevision: () => trialStateRef.current.revision
  });

  thinkAloudChunksRef.current = thinkAloud.chunks as unknown[];

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const livePointsRef = useRef<StrokePoint[]>([]);
  const activePointerRef = useRef<number | null>(null);

  const timed = isTimed(timing);
  const clockElapsedMs = clockStartedAtEpochMs == null ? 0 : nowEpochMs - clockStartedAtEpochMs;
  const timeLeftMs = remainingMs(timing, clockElapsedMs);
  const canSubmitNow = submitOpen(timing, clockElapsedMs);

  useEffect(() => {
    let cancelled = false;
    loadStimulusImage(stimulus)
      .then(image => {
        if (!cancelled) setBackground(image);
      })
      .catch((error: Error) => {
        if (!cancelled) setBackgroundError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [stimulus]);

  // The countdown ticks only while the participant can still act.
  useEffect(() => {
    if (!timed || (phase !== "drawing" && phase !== "confirming")) return;
    const interval = window.setInterval(() => setNowEpochMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [phase, timed]);

  const strokeWidth = tool === "pencil" ? pencilWidth.default : eraserWidth.default;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const size = { width: canvas.width, height: canvas.height };
    const live = livePointsRef.current;

    // The in-progress gesture is previewed through the same geometry the
    // reducer will apply on release, so what the participant sees mid-stroke is
    // what they get. No preview ever mutates trial state.
    let strokes: readonly ForegroundStroke[] = trial.scene.strokes;
    if (live.length > 0) {
      if (tool === "eraser") {
        strokes = eraseFromStrokes(strokes, live, eraserWidth.default);
      } else {
        strokes = [
          ...strokes,
          { strokeId: "live", width: pencilWidth.default, points: ensureDrawablePoints(live) }
        ];
      }
    }
    renderTrial(ctx, { scene: { strokes }, background, size });
  }, [background, tool, trial.scene]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Keep the backing store matched to the displayed box so strokes stay crisp
  // on high-density screens. The artboard coordinate system is unaffected.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || phase === "instructions") return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const pixels = Math.round(rect.width * ratio);
      if (canvas.width !== pixels || canvas.height !== pixels) {
        canvas.width = pixels;
        canvas.height = pixels;
      }
      redraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [phase, redraw]);

  const samplePoint = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return toArtboardPoint(event.clientX, event.clientY, rect, {
        tMs: trial.elapsedMs(),
        pressure: event.pressure
      });
    },
    [trial]
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (phase !== "drawing" || activePointerRef.current != null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerRef.current = event.pointerId;
      livePointsRef.current = [samplePoint(event)];
      setNotice(null);
      redraw();
    },
    [phase, redraw, samplePoint]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointerRef.current !== event.pointerId) return;
      // Coalesced events preserve the full pointer trace on devices that batch
      // samples, which is what makes the human process record comparable in
      // resolution to an agent's explicit polyline.
      const native = event.nativeEvent;
      const samples =
        typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
      const rect = event.currentTarget.getBoundingClientRect();
      if (samples.length > 0) {
        for (const sample of samples) {
          livePointsRef.current.push(
            toArtboardPoint(sample.clientX, sample.clientY, rect, {
              tMs: trial.elapsedMs(),
              pressure: sample.pressure
            })
          );
        }
      } else {
        livePointsRef.current.push(samplePoint(event));
      }
      redraw();
    },
    [redraw, samplePoint, trial]
  );

  const endStroke = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointerRef.current !== event.pointerId) return;
      activePointerRef.current = null;
      const points = ensureDrawablePoints(livePointsRef.current);
      livePointsRef.current = [];
      if (points.length === 0) {
        redraw();
        return;
      }
      const result = trial.dispatch(
        strokeDraft(tool, points, defaultWidthFor(tool), {
          sessionId,
          trialId,
          stimulusId: stimulus.stimulusId,
          actorId,
          timestampMs: trial.elapsedMs(),
          strokeSequence: trial.nextStrokeSequence()
        })
      );
      if (!result.ok) setNotice(result.error);
      redraw();
    },
    [actorId, redraw, sessionId, stimulus.stimulusId, tool, trial, trialId]
  );

  const context = useMemo(
    () => ({
      sessionId,
      trialId,
      stimulusId: stimulus.stimulusId,
      actorId,
      strokeSequence: 0
    }),
    [actorId, sessionId, stimulus.stimulusId, trialId]
  );

  const onUndo = useCallback(() => {
    const result = trial.dispatch(controlDraft("undo", { ...context, timestampMs: trial.elapsedMs() }));
    setNotice(result.ok ? null : result.error);
  }, [context, trial]);

  const commitDescription = useCallback(
    (text: string) => {
      if (text === trialStateRef.current.description) return trialStateRef.current;
      const result = trial.dispatch(
        controlDraft("description_update", { ...context, timestampMs: trial.elapsedMs() }, text)
      );
      return result.ok ? result.state : trialStateRef.current;
    },
    [context, trial]
  );

  /**
   * Hands the final log to the server, which writes the export bundle. The
   * trial is already final when this runs; a failure here cannot alter it.
   */
  const exportTrial = useCallback(
    async (finalState: AudraTrialState, endedBy: EndedBy) => {
      const endedAtEpochMs = Date.now();
      try {
        setExportStatus("Finishing the audio recording…");
        await thinkAloud.stop();
        const audio = thinkAloud.audioBlob();
        setExportStatus("Saving…");
        const response = await fetch("/api/audra/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            trialId,
            stimulusId: stimulus.stimulusId,
            actorType: "human",
            actorId,
            events: finalState.events,
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
              activeMs: clockStartedAtEpochMs == null ? null : endedAtEpochMs - clockStartedAtEpochMs,
              translation: {
                language: "ko",
                available: true,
                everShown: koreanTogglesRef.current.some(toggle => toggle.visible),
                toggles: koreanTogglesRef.current
              }
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
    [actorId, clockStartedAtEpochMs, sessionId, startedAtEpochMs, stimulus.stimulusId, thinkAloud, timed, timing, timingOverridden, trialId]
  );

  const requestSubmit = useCallback(() => {
    if (!trial.hasDrawingAttempt) {
      setNotice("Draw something using the starting lines before submitting.");
      return;
    }
    if (!submitOpen(timing, Date.now() - (clockStartedAtEpochMs ?? Date.now()))) {
      setNotice(`Keep drawing. Submit opens in the last ${spokenDuration(timing.finalizeWindowSec)}.`);
      return;
    }
    commitDescription(descriptionDraft);
    setPhase("confirming");
  }, [clockStartedAtEpochMs, commitDescription, descriptionDraft, timing, trial.hasDrawingAttempt]);

  const confirmSubmit = useCallback(async () => {
    if (endingRef.current) return;
    const result = trial.dispatch(controlDraft("submit", { ...context, timestampMs: trial.elapsedMs() }));
    if (!result.ok) {
      setNotice(result.error);
      setPhase("drawing");
      return;
    }
    endingRef.current = true;
    setPhase("submitted");
    onSubmitted?.({ trialId });
    await exportTrial(result.state, "submitted");
  }, [context, exportTrial, onSubmitted, trial, trialId]);

  /**
   * Time is up. Nothing is submitted on the participant's behalf, as nothing is
   * for an agent: the canvas locks and the drawing is saved as it stands. A
   * stroke still in progress is cut off rather than recorded; a typed answer is
   * the participant's own and is committed rather than lost.
   */
  const endByTime = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    activePointerRef.current = null;
    livePointsRef.current = [];
    const finalState = commitDescription(descriptionDraftRef.current);
    setPhase("time_up");
    await exportTrial(finalState, "time_limit");
  }, [commitDescription, exportTrial]);

  useEffect(() => {
    if (timed && (phase === "drawing" || phase === "confirming") && timeLeftMs <= 0) void endByTime();
  }, [endByTime, phase, timeLeftMs, timed]);

  if (phase === "instructions") {
    return (
      <div className="audra-shell">
        <section className="audra-instructions">
          <h1>Drawing task</h1>
          <button type="button" className="audra-toggle audra-toggle--block" onClick={toggleKorean} aria-pressed={showKorean}>
            {showKorean ? "한국어 번역 숨기기" : "한국어 번역 보기"}
          </button>
          <p className="audra-instruction-text">
            {taskInstruction}
            {showKorean && <span className="audra-ko">{ko.instruction}</span>}
          </p>
          <ul className="audra-instruction-list">
            <li>The canvas already contains four starting lines. They cannot be moved or erased.</li>
            <li>All four starting lines must be part of your drawing.</li>
            <li>You have a pencil, an eraser, and Undo Last. Nothing else.</li>
            <li>Afterwards you will be asked what you drew.</li>
            {timed && (
              <li>
                You have {spokenDuration(timing.timeLimitSec)}. Keep working on the drawing for the whole
                time; Submit opens in the last {spokenDuration(timing.finalizeWindowSec)}. When time runs
                out, the drawing is saved as it is.
              </li>
            )}
          </ul>
          {showKorean && (
            <ul className="audra-instruction-list audra-ko">
              {ko.list.map(line => (
                <li key={line}>{line}</li>
              ))}
              {timed && <li>{ko.timed(timing.timeLimitSec, timing.finalizeWindowSec)}</li>}
            </ul>
          )}
          {stimulus.source === "development" && (
            <p className="audra-dev-notice">
              Development fixture — not an official CAP/MTCI stimulus.
            </p>
          )}
          <p className="audra-consent">
            Please think aloud while you draw. Your voice is recorded for the study and stored
            with your drawing. A microphone problem will not stop you from drawing or submitting.
            {showKorean && <span className="audra-ko">{ko.consent}</span>}
          </p>
          {thinkAloud.error && <p className="audra-error">{thinkAloud.error}</p>}
          <button
            className="audra-primary"
            onClick={async () => {
              // A refused or broken microphone must never cost the participant
              // the trial, so the error is surfaced and the trial starts anyway.
              await thinkAloud.start();
              const now = Date.now();
              setClockStartedAtEpochMs(now);
              setNowEpochMs(now);
              setPhase("drawing");
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
      <div className="audra-shell">
        <section className="audra-instructions">
          <h1>{phase === "submitted" ? "Submitted" : "Time is up"}</h1>
          <p>
            {phase === "submitted"
              ? "Thank you. Your drawing has been recorded and can no longer be changed."
              : "Thank you. Your drawing has been recorded as it was when time ran out."}
          </p>
          {exportStatus && <p className="audra-meta">{exportStatus}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="audra-shell">
      <section className="audra-stage">
        <div className="audra-banner-row">
          <p className="audra-instruction-banner">
            {taskInstruction}
            {showKorean && <span className="audra-ko">{ko.instruction}</span>}
          </p>
          <button type="button" className="audra-toggle" onClick={toggleKorean} aria-pressed={showKorean}>
            {showKorean ? "한국어 번역 숨기기" : "한국어 번역 보기"}
          </button>
        </div>
        {/* Canvas and controls are one row on wide screens and stack on narrow
            ones. The artboard is square, so on a short, wide window a stacked
            layout would shrink the drawing surface to fit the controls under
            it. */}
        <div className="audra-workspace">
          <div className="audra-canvas-frame">
            <canvas
              ref={canvasRef}
              className={`audra-canvas audra-canvas--${tool}`}
              style={{ touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onContextMenu={event => event.preventDefault()}
            />
            {backgroundError && (
              <p className="audra-error">Starter image failed to load: {backgroundError}</p>
            )}
          </div>

          <div className="audra-controls">
            {timed && (
              <p className={canSubmitNow ? "audra-timer audra-timer--final" : "audra-timer"} role="timer">
                <strong>{formatClock(timeLeftMs)}</strong> left
                <span className="audra-timer-hint">
                  {canSubmitNow
                    ? " · finish your answer and submit"
                    : ` · Submit opens in the last ${formatClock(timing.finalizeWindowSec * 1000)}`}
                </span>
              </p>
            )}

            <div className="audra-toolbar" role="toolbar" aria-label="Drawing tools">
              <button
                className={tool === "pencil" ? "audra-tool audra-tool--active" : "audra-tool"}
                aria-pressed={tool === "pencil"}
                onClick={() => setTool("pencil")}
              >
                Pencil
              </button>
              <button
                className={tool === "eraser" ? "audra-tool audra-tool--active" : "audra-tool"}
                aria-pressed={tool === "eraser"}
                onClick={() => setTool("eraser")}
              >
                Eraser
              </button>
              <button className="audra-tool" onClick={onUndo} disabled={!trial.canUndo}>
                Undo Last
              </button>
              {thinkAloud.isRecording && (
                <span className="audra-recording" role="status">
                  ● recording
                  <span className="audra-meter" aria-hidden="true">
                    <span
                      className="audra-meter-fill"
                      style={{ width: `${Math.min(100, Math.round(thinkAloud.inputLevel * 300))}%` }}
                    />
                  </span>
                </span>
              )}
            </div>

            {thinkAloud.isRecording && thinkAloud.noInputSignal && (
              // MediaRecorder produces valid audio from a dead microphone, so a
              // silent input would otherwise be invisible until the data is analysed.
              <p className="audra-warning" role="alert">
                No sound is reaching the microphone. Check that the browser is allowed to use it
                in your system settings and that the right input device is selected. You can keep
                drawing — the drawing is recorded either way.
              </p>
            )}

            <label className="audra-description">
              <span>
                {descriptionPrompt}
                {showKorean && ` (${ko.description})`}
              </span>
              <input
                type="text"
                value={descriptionDraft}
                maxLength={maxDescriptionLength}
                onChange={event => setDescriptionDraft(event.target.value)}
                onBlur={event => commitDescription(event.target.value)}
                disabled={phase === "confirming"}
              />
            </label>

            {notice && <p className="audra-notice">{notice}</p>}

            {phase === "confirming" ? (
              <div className="audra-confirm">
                <p>Submit this drawing? It cannot be changed afterwards.</p>
                <div className="audra-confirm-actions">
                  <button className="audra-primary" onClick={() => void confirmSubmit()}>
                    Yes, submit
                  </button>
                  <button className="audra-tool" onClick={() => setPhase("drawing")}>
                    Keep drawing
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="audra-primary"
                onClick={requestSubmit}
                disabled={!trial.hasDrawingAttempt || !canSubmitNow}
              >
                Submit
              </button>
            )}

            <p className="audra-meta">
              Artboard {canonicalArtboard.width}x{canonicalArtboard.height} · stimulus{" "}
              {stimulus.stimulusId} ({stimulus.source}) · pencil {strokeWidth === pencilWidth.default ? pencilWidth.default : strokeWidth}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

export default AudraTask;
