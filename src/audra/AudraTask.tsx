import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { loadStimulusImage, renderTrial } from "./render";
import { descriptionPrompt, taskInstruction, type Stimulus } from "./stimulus";
import { useAudraTrial } from "./useAudraTrial";
import { useThinkAloud } from "./useThinkAloud";

type TrialPhase = "instructions" | "drawing" | "confirming" | "submitted";

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type AudraTaskProps = {
  sessionId: string;
  trialId: string;
  actorId: string;
  stimulus: Stimulus;
  onSubmitted?: (payload: { trialId: string }) => void;
};

export function AudraTask({ sessionId, trialId, actorId, stimulus, onSubmitted }: AudraTaskProps) {
  const [phase, setPhase] = useState<TrialPhase>("instructions");
  const [tool, setTool] = useState<HumanTool>("pencil");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [startedAtEpochMs] = useState(() => Date.now());
  const [background, setBackground] = useState<HTMLImageElement | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

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
      if (text === trial.state.description) return;
      trial.dispatch(
        controlDraft("description_update", { ...context, timestampMs: trial.elapsedMs() }, text)
      );
    },
    [context, trial]
  );

  const requestSubmit = useCallback(() => {
    if (!trial.hasDrawingAttempt) {
      setNotice("Draw something using the starting lines before submitting.");
      return;
    }
    commitDescription(descriptionDraft);
    setPhase("confirming");
  }, [commitDescription, descriptionDraft, trial.hasDrawingAttempt]);

  const confirmSubmit = useCallback(async () => {
    const result = trial.dispatch(controlDraft("submit", { ...context, timestampMs: trial.elapsedMs() }));
    if (!result.ok) {
      setNotice(result.error);
      setPhase("drawing");
      return;
    }
    setPhase("submitted");
    onSubmitted?.({ trialId });

    // The trial is already final at this point. Handing the log to the server
    // writes the export bundle; it cannot alter the drawing, and a failure here
    // leaves the submitted state untouched.
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
          events: result.state.events,
          startedAt: new Date(startedAtEpochMs).toISOString(),
          endedAt: new Date().toISOString(),
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
  }, [actorId, context, onSubmitted, sessionId, startedAtEpochMs, stimulus.stimulusId, thinkAloud, trial, trialId]);

  if (phase === "instructions") {
    return (
      <div className="audra-shell">
        <section className="audra-instructions">
          <h1>Drawing task</h1>
          <p className="audra-instruction-text">{taskInstruction}</p>
          <ul className="audra-instruction-list">
            <li>The canvas already contains four starting lines. They cannot be moved or erased.</li>
            <li>All four starting lines must be part of your drawing.</li>
            <li>You have a pencil, an eraser, and Undo Last. Nothing else.</li>
            <li>Afterwards you will be asked what you drew.</li>
          </ul>
          {stimulus.source === "development" && (
            <p className="audra-dev-notice">
              Development fixture — not an official CAP/MTCI stimulus.
            </p>
          )}
          <p className="audra-consent">
            Please think aloud while you draw. Your voice is recorded for the study and stored
            with your drawing. A microphone problem will not stop you from drawing or submitting.
          </p>
          {thinkAloud.error && <p className="audra-error">{thinkAloud.error}</p>}
          <button
            className="audra-primary"
            onClick={async () => {
              // A refused or broken microphone must never cost the participant
              // the trial, so the error is surfaced and the trial starts anyway.
              await thinkAloud.start();
              setPhase("drawing");
            }}
          >
            Start
          </button>
        </section>
      </div>
    );
  }

  if (phase === "submitted") {
    return (
      <div className="audra-shell">
        <section className="audra-instructions">
          <h1>Submitted</h1>
          <p>Thank you. Your drawing has been recorded and can no longer be changed.</p>
          {exportStatus && <p className="audra-meta">{exportStatus}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="audra-shell">
      <section className="audra-stage">
        <p className="audra-instruction-banner">{taskInstruction}</p>
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
              <span>{descriptionPrompt}</span>
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
                disabled={!trial.hasDrawingAttempt}
              >
                Submit
              </button>
            )}

            <p className="audra-meta">
              Artboard {canonicalArtboard.width}x{canonicalArtboard.height} · stimulus{" "}
              {stimulus.stimulusId} ({stimulus.source})
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

export default AudraTask;
