import { canonicalArtboard } from "./artboard";

/**
 * A starter image for one trial.
 *
 * The stimulus is referenced only as an opaque background asset. Neither the
 * renderer, the reducer, nor any tool knows the contours' geometry, so there is
 * no code path through which a starter contour could be hit-tested, selected,
 * erased, moved, or transformed. Immutability is structural, not a convention.
 */
export type Stimulus = {
  stimulusId: string;
  version: string;
  source: "development" | "official";
  /** URL of the immutable background image, resolved against the app origin. */
  backgroundAsset: string;
  metadata?: Record<string, unknown>;
};

/**
 * The stimulus a trial uses when none is named. Traced by hand from an image
 * supplied for testing: two short diagonals and two arcs of one circle, broken
 * at the bottom.
 */
export const developmentStimulus: Stimulus = {
  stimulusId: "dev-fixture-02",
  version: "0.1.0",
  source: "development",
  backgroundAsset: "/audra/stimuli/dev-fixture-02.svg",
  metadata: {
    contourCount: 4,
    artboardWidth: canonicalArtboard.width,
    artboardHeight: canonicalArtboard.height,
    notice:
      "Development fixture only. Traced from a supplied test image, not an official CAP/MTCI stimulus and not validated for scoring. Replace before data collection."
  }
};

const stimulusRegistry: Stimulus[] = [developmentStimulus];

export function listStimuli(): readonly Stimulus[] {
  return stimulusRegistry;
}

export function stimulusById(stimulusId: string): Stimulus | null {
  return stimulusRegistry.find(stimulus => stimulus.stimulusId === stimulusId) ?? null;
}

/**
 * Registers an additional stimulus at runtime. The official contour set is
 * expected to arrive as a batch of assets plus one call per stimulus; see
 * docs/audra-incomplete-shapes.md.
 */
export function registerStimulus(stimulus: Stimulus) {
  if (stimulusById(stimulus.stimulusId)) {
    throw new Error(`Stimulus ${stimulus.stimulusId} is already registered.`);
  }
  stimulusRegistry.push(stimulus);
  return stimulus;
}

export const taskInstruction =
  "Use the starting lines as part of one creative drawing. Be as creative as you can.";

export const descriptionPrompt = "What did you draw?";
