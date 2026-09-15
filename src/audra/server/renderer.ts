import { Resvg } from "@resvg/resvg-js";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { canonicalArtboard } from "../artboard";
import { deriveScene, type AudraTrialState } from "../reducer";
import type { Stimulus } from "../stimulus";
import { sceneToSvg, svgDeclaredSize, svgInnerMarkup, type BackgroundEmbed } from "../svg";
import { encodeRgbPng, parseHexColor } from "./png";

/**
 * Headless rasterizer for agent observations and exports.
 *
 * Renders the canonical SVG - the same markup the human canvas draws from - so
 * an agent trial needs no browser attached. The human UI still rasterizes
 * through the browser canvas for interactivity; the two engines differ, the
 * geometry does not.
 */

export const defaultObservationSize = 1024;

const rasterMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const backgroundCache = new Map<string, BackgroundEmbed>();

export function loadBackgroundEmbed(stimulus: Stimulus, publicDir: string): BackgroundEmbed {
  const cached = backgroundCache.get(stimulus.stimulusId);
  if (cached) return cached;

  const relative = stimulus.backgroundAsset.replace(/^\/+/, "");
  const absolute = normalize(join(publicDir, relative));
  if (!absolute.startsWith(normalize(publicDir))) {
    throw new Error(`Stimulus asset escapes the public directory: ${stimulus.backgroundAsset}`);
  }

  const extension = absolute.slice(absolute.lastIndexOf(".")).toLowerCase();
  let embed: BackgroundEmbed;
  if (extension === ".svg") {
    const source = readFileSync(absolute, "utf8");
    const size = svgDeclaredSize(source);
    // A mis-sized stimulus would silently shift every contour, so refuse it.
    if (!size || size.width !== canonicalArtboard.width || size.height !== canonicalArtboard.height) {
      throw new Error(
        `Stimulus ${stimulus.stimulusId} must be ${canonicalArtboard.width}x${canonicalArtboard.height}, got ${
          size ? `${size.width}x${size.height}` : "an undeclared size"
        }.`
      );
    }
    embed = { kind: "svg_fragment", markup: svgInnerMarkup(source) };
  } else {
    const mimeType = rasterMimeTypes[extension];
    if (!mimeType) throw new Error(`Unsupported stimulus asset type: ${extension}`);
    const base64 = readFileSync(absolute).toString("base64");
    embed = { kind: "data_uri", href: `data:${mimeType};base64,${base64}` };
  }

  backgroundCache.set(stimulus.stimulusId, embed);
  return embed;
}

export function trialToSvg(state: AudraTrialState, stimulus: Stimulus, publicDir: string) {
  return sceneToSvg(deriveScene(state), loadBackgroundEmbed(stimulus, publicDir));
}

export function renderSvgToPng(svg: string, size: number) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: canonicalArtboard.backgroundColor
  }).render();
  // resvg emits RGBA. AuDrA's preprocessing inverts with PIL, which rejects a
  // 4-channel image, so scoring inputs are flattened to RGB here.
  return encodeRgbPng(
    rendered.pixels,
    rendered.width,
    rendered.height,
    parseHexColor(canonicalArtboard.backgroundColor)
  );
}

export function renderTrialToPng(
  state: AudraTrialState,
  stimulus: Stimulus,
  publicDir: string,
  size = defaultObservationSize
) {
  return renderSvgToPng(trialToSvg(state, stimulus, publicDir), size);
}

export function clearBackgroundCache() {
  backgroundCache.clear();
}
