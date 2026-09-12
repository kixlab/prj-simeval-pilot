import { canonicalArtboard, eraserWidth, inkColor, pencilWidth } from "./artboard";
import { normalizeActions, summarizeActions } from "./actions";
import { audraSchemaVersion, toEventsJsonl } from "./events";
import { deriveScene, type AudraTrialState } from "./reducer";
import type { Stimulus } from "./stimulus";
import { sceneToSvg, type BackgroundEmbed } from "./svg";
import type { ReplayData } from "./replayRuntime";
import {
  summarizeThinkAloud,
  toThinkAloudJsonl,
  validateThinkAloudChunks,
  type ThinkAloudChunk
} from "./thinkAloud";

export const audraExportVersion = "audra-export-v1" as const;

/**
 * AuDrA-compatible scoring profile.
 *
 * The archival raster is kept at high resolution for the record; the score
 * input is a deterministic resize of the same canonical SVG rather than a
 * resample of the archival PNG, so no intermediate rounding enters the scored
 * image. Both are plain RGB PNG on white, with no UI chrome, cursor, grid,
 * label, toolbar, or actor identity rendered into them.
 */
export const audraExportProfile = {
  profile: "audra-scoring-v1",
  archivalPixels: 2048,
  scorePixels: 224,
  colorSpace: "sRGB",
  channels: "RGB",
  background: canonicalArtboard.backgroundColor,
  strokeColor: inkColor,
  rendering: "resvg rasterization of the canonical SVG at each target width",
  resizePolicy: "rendered directly at target width, not downsampled from the archival PNG",
  embeddedMetadata: "none",
  includesUiChrome: false,
  includesActorLabel: false
} as const;

export type BundleContext = {
  state: AudraTrialState;
  stimulus: Stimulus;
  background: BackgroundEmbed | null;
  startedAt: string;
  endedAt: string;
  /** Injected so a bundle built twice from one log is byte-identical. */
  exportedAt: string;
  appVersion: string;
  appCommit: string;
  /** Agent-only. Never rendered into an image; lives in session.json alone. */
  agentRun?: Record<string, unknown> | null;
  runStats?: Record<string, unknown> | null;
  rejections?: unknown[];
  /** Time limit and how the trial ended, recorded the same way for both actors. */
  protocol?: Record<string, unknown> | null;
  /** Human process trace. Kept beside the event log, never inside it. */
  thinkAloud?: readonly ThinkAloudChunk[];
  audioFileName?: string | null;
  /** Bundled `replayRuntime.ts`, injected so this module stays pure. */
  replayRuntimeJs: string;
};

export type TextFile = { name: string; content: string };

export function bundleBaseName(state: AudraTrialState, startedAt: string) {
  const safe = (value: string) => value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "unknown";
  const stamp = startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return [
    "audra",
    `${state.actorType}-${safe(state.actorId)}`,
    `stimulus-${safe(state.stimulusId)}`,
    stamp,
    state.trialId.split("-").at(-1) ?? "trial"
  ].join("__");
}

export function buildSessionJson(context: BundleContext) {
  const { state, stimulus } = context;
  const actions = normalizeActions(state);
  return {
    schemaVersion: audraSchemaVersion,
    exportVersion: audraExportVersion,
    exportedAt: context.exportedAt,
    trial: {
      sessionId: state.sessionId,
      trialId: state.trialId,
      // Recorded here and nowhere in any exported image.
      actorType: state.actorType,
      actorId: state.actorId,
      startedAt: context.startedAt,
      endedAt: context.endedAt,
      submittedAtMs: state.submittedAtMs,
      durationMs: state.submittedAtMs ?? actions.at(-1)?.timestampMs ?? 0,
      completed: state.submittedAtMs != null,
      revision: state.revision
    },
    stimulus: {
      stimulusId: stimulus.stimulusId,
      version: stimulus.version,
      source: stimulus.source,
      backgroundAsset: stimulus.backgroundAsset,
      metadata: stimulus.metadata ?? null,
      isOfficialInstrument: stimulus.source === "official"
    },
    taskConfiguration: {
      artboard: { ...canonicalArtboard },
      inkColor,
      pencilWidth: { ...pencilWidth },
      eraserWidth: { ...eraserWidth },
      allowedOperations: ["draw_stroke", "erase_stroke", "undo", "description_update", "submit"],
      eraserImplementation: "geometry_based_swept_disc",
      undoImplementation: "event_log_revert",
      starterContourMutability: "immutable_background_layer"
    },
    versions: {
      appVersion: context.appVersion,
      appCommit: context.appCommit,
      eventSchemaVersion: audraSchemaVersion,
      exportVersion: audraExportVersion
    },
    exportProfile: audraExportProfile,
    processSummary: summarizeActions(actions),
    // Both process traces stay separate from the shared canvas event log and
    // out of every exported image.
    thinkAloud: context.thinkAloud
      ? {
          ...summarizeThinkAloud(context.thinkAloud),
          audioFileName: context.audioFileName ?? null,
          chunkDurationMs: 10000,
          validationErrors: validateThinkAloudChunks(context.thinkAloud)
        }
      : null,
    protocol: context.protocol ?? null,
    agentRun: context.agentRun ?? null,
    runStats: context.runStats ?? null,
    rejections: context.rejections ?? []
  };
}

export function buildReplayHtml(context: BundleContext) {
  const data: ReplayData = {
    trialId: context.state.trialId,
    sessionId: context.state.sessionId,
    stimulusId: context.state.stimulusId,
    actorType: context.state.actorType,
    actorId: context.state.actorId,
    background: context.background,
    events: [...context.state.events]
  };
  // `</script>` inside embedded data would close the tag early.
  const payload = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>AuDrA replay - ${context.state.trialId}</title>
<style>
  body { margin: 0; padding: 24px; background: #f4f4f2; color: #1a1a1a;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .replay { max-width: 720px; margin: 0 auto; }
  .replay-stage svg { width: 100%; height: auto; display: block;
                      border: 1px solid #d4d4d0; border-radius: 4px; background: #fff; }
  .replay-controls { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
  .replay-controls input { flex: 1; }
  .replay-controls button { padding: 8px 18px; border: 1px solid #c8c8c4; border-radius: 6px;
                            background: #fff; font: inherit; cursor: pointer; }
  .replay-meta, .replay-controls span { font-size: 12px; color: #6b6b67; }
</style>
</head>
<body>
<div id="replay-root"></div>
<script>window.__AUDRA_REPLAY__ = ${payload};</script>
<script>${context.replayRuntimeJs}</script>
</body>
</html>
`;
}

/**
 * Every text artefact for one trial. PNGs are added by the caller, which owns
 * the rasterizer; `final_canvas.svg` here is the source both PNGs render from.
 */
export function buildTextFiles(context: BundleContext): TextFile[] {
  const { state } = context;
  const actions = normalizeActions(state);
  return [
    { name: "events.jsonl", content: `${toEventsJsonl(state.events)}\n` },
    {
      name: "actions.json",
      content: `${JSON.stringify({ summary: summarizeActions(actions), actions }, null, 2)}\n`
    },
    { name: "final_canvas.svg", content: sceneToSvg(deriveScene(state), context.background) },
    { name: "description.txt", content: `${state.description}\n` },
    { name: "session.json", content: `${JSON.stringify(buildSessionJson(context), null, 2)}\n` },
    { name: "replay.html", content: buildReplayHtml(context) },
    ...(context.thinkAloud && context.thinkAloud.length > 0
      ? [{ name: "thinkaloud.jsonl", content: `${toThinkAloudJsonl(context.thinkAloud)}\n` }]
      : [])
  ];
}

export function finalCanvasSvg(context: Pick<BundleContext, "state" | "background">) {
  return sceneToSvg(deriveScene(context.state), context.background);
}
