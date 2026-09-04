import {
  asObject,
  optionalString,
  ParseErrors,
  requireId,
  requireSource,
  requireString,
  requireStringArray,
  type ItemSource,
  type ParseResult
} from "../itemParsing";

/**
 * Constraint counts the pilot runs, in order. Each round revises the story the
 * previous round produced, in one session.
 */
export const cs4ConstraintStages = [7, 15, 23] as const;

export const cs4RoundCount = cs4ConstraintStages.length;

/** The last stage is how many constraints an instance file has to carry. */
export const cs4ConstraintCount = cs4ConstraintStages[cs4ConstraintStages.length - 1];

/**
 * One CS4 writing instance.
 *
 * The constraints are stored once, in order, and a round takes a prefix of
 * them. Cumulativity is therefore structural: round 2 cannot disagree with
 * round 1 about the first seven constraints, because they are the same seven
 * strings. An instance file cannot express a non-cumulative set at all.
 */
export type Cs4Instance = {
  instanceId: string;
  source: ItemSource;
  /** The user instruction the base story was written from. */
  instruction: string;
  /** The roughly 500-word story every round revises. */
  baseStory: string;
  /** Ordered; exactly `cs4ConstraintCount` of them. */
  constraints: readonly string[];
  datasetRef: string | null;
  notes: string | null;
};

export type Cs4Round = {
  /** 1-based position in the session. */
  round: number;
  /** How many constraints are in force, i.e. one of `cs4ConstraintStages`. */
  stage: number;
  /** Everything in force this round, earlier rounds included. */
  constraints: readonly string[];
  /** Only what this round adds, for showing what changed. */
  newConstraints: readonly string[];
};

export function cs4Rounds(instance: Cs4Instance): readonly Cs4Round[] {
  let previous = 0;
  return cs4ConstraintStages.map((stage, index) => {
    const round = {
      round: index + 1,
      stage,
      constraints: instance.constraints.slice(0, stage),
      newConstraints: instance.constraints.slice(previous, stage)
    };
    previous = stage;
    return round;
  });
}

/**
 * What a participant sees in one round. Later rounds' constraints are cut
 * rather than merely unrendered, so a round cannot leak the next one through
 * the page source or a network response.
 */
export type Cs4InstanceView = Omit<Cs4Instance, "constraints"> & {
  round: number;
  stage: number;
  totalRounds: number;
  constraints: readonly string[];
  newConstraints: readonly string[];
};

export function participantView(instance: Cs4Instance, round: number): Cs4InstanceView {
  const rounds = cs4Rounds(instance);
  const current = rounds[Math.min(Math.max(round, 1), rounds.length) - 1];
  const { constraints: _all, ...rest } = instance;
  return {
    ...rest,
    round: current.round,
    stage: current.stage,
    totalRounds: rounds.length,
    constraints: current.constraints,
    newConstraints: current.newConstraints
  };
}

export function parseCs4Instance(raw: unknown): ParseResult<Cs4Instance> {
  const errors = new ParseErrors();
  const object = asObject(raw, errors);

  const instanceId = requireId(object, "instanceId", errors);
  const source = requireSource(object, errors);
  const instruction = requireString(object, "instruction", errors);
  const baseStory = requireString(object, "baseStory", errors);
  const constraints = requireStringArray(object, "constraints", errors, {
    exactLength: cs4ConstraintCount,
    unique: true
  });

  return errors.result({
    instanceId,
    source,
    instruction,
    baseStory,
    constraints,
    datasetRef: optionalString(object, "datasetRef"),
    notes: optionalString(object, "notes")
  });
}

export function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
