import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  audraExportProfile,
  bundleBaseName,
  buildTextFiles,
  finalCanvasSvg,
  type BundleContext
} from "../export";
import { replay, type AudraTrialState } from "../reducer";
import type { AudraEvent } from "../events";
import type { Stimulus } from "../stimulus";
import type { ThinkAloudChunk } from "../thinkAloud";
import { loadBackgroundEmbed, renderSvgToPng } from "./renderer";

let replayRuntimeJs: string | null = null;

/**
 * Bundles the replay runtime once per server process. Inlining the compiled
 * canonical reducer keeps exported replays exact; writing a second reducer by
 * hand would let them drift.
 */
async function getReplayRuntime(projectRoot: string) {
  if (replayRuntimeJs) return replayRuntimeJs;
  const result = await build({
    entryPoints: [join(projectRoot, "src/audra/replayRuntime.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    logLevel: "silent"
  });
  replayRuntimeJs = result.outputFiles[0].text;
  return replayRuntimeJs;
}

export type ExportRequest = {
  state: AudraTrialState;
  stimulus: Stimulus;
  startedAt: string;
  endedAt: string;
  exportedAt?: string;
  appVersion: string;
  appCommit: string;
  agentRun?: Record<string, unknown> | null;
  runStats?: Record<string, unknown> | null;
  rejections?: unknown[];
  protocol?: Record<string, unknown> | null;
  thinkAloud?: readonly ThinkAloudChunk[];
  /** Archival think-aloud audio, base64. Written verbatim; never transcoded. */
  audioBase64?: string | null;
  audioMimeType?: string | null;
};

export async function writeExportBundle(
  request: ExportRequest,
  projectRoot: string,
  publicDir: string,
  exportDir: string
) {
  const background = loadBackgroundEmbed(request.stimulus, publicDir);
  const audioFileName = request.audioBase64 ? "thinkaloud_audio.webm" : null;
  const context: BundleContext = {
    ...request,
    exportedAt: request.exportedAt ?? new Date().toISOString(),
    audioFileName,
    background,
    replayRuntimeJs: await getReplayRuntime(projectRoot)
  };

  const baseName = bundleBaseName(request.state, request.startedAt);
  const directory = join(exportDir, baseName);
  mkdirSync(directory, { recursive: true });

  const written: string[] = [];
  for (const file of buildTextFiles(context)) {
    writeFileSync(join(directory, file.name), file.content, "utf8");
    written.push(file.name);
  }

  // Both rasters come from the canonical SVG at their target width, so the
  // score input never inherits rounding from the archival PNG.
  const svg = finalCanvasSvg(context);
  for (const [name, pixels] of [
    ["final_canvas_archival.png", audraExportProfile.archivalPixels],
    ["final_canvas_score.png", audraExportProfile.scorePixels]
  ] as const) {
    writeFileSync(join(directory, name), renderSvgToPng(svg, pixels));
    written.push(name);
  }

  if (request.audioBase64 && audioFileName) {
    writeFileSync(join(directory, audioFileName), Buffer.from(request.audioBase64, "base64"));
    written.push(audioFileName);
  }

  return { baseName, directory, files: written.sort() };
}

/**
 * Rebuilds a trial from a posted event log.
 *
 * Human trials keep their state in the browser for responsiveness and hand the
 * log over at submission. Replaying it here is not a formality: it runs the
 * same validation the events originally passed, so a log that cannot be
 * reproduced is rejected instead of silently exported.
 */
export function replayPostedLog(input: {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorType: "human" | "agent";
  actorId: string;
  events: AudraEvent[];
}) {
  return replay(
    {
      sessionId: input.sessionId,
      trialId: input.trialId,
      stimulusId: input.stimulusId,
      actorType: input.actorType,
      actorId: input.actorId
    },
    input.events
  );
}
