import {
  cleanText,
  invalid,
  readCall,
  rejected,
  type Applied,
  type CallParse,
  type TextTaskEngine
} from "../agent/textTrial";
import type { MacGyverItemView } from "./item";

/**
 * A MacGyver answer: a solvable / unsolvable judgement, an ordered list of
 * solution steps, and a justification for calling the problem unsolvable.
 *
 * The atomic unit is one step. Every change to the answer is one call, so an
 * agent's process is a sequence of step-level moves; a human's free-text answer
 * is compared at the same unit by diffing its step list.
 *
 * The state holds the participant view of the item only. The answer key never
 * enters this module, so no observation can carry it.
 */

export const macgyverAnswerLimits = {
  maxSteps: 20,
  maxStepChars: 600,
  maxJustificationChars: 2000
} as const;

export type Judgement = "solvable" | "unsolvable";

export type MacGyverAnswerState = {
  item: MacGyverItemView;
  judgement: Judgement | null;
  steps: readonly string[];
  justification: string;
  submitted: boolean;
};

export type MacGyverCall =
  | { tool: "set_judgement"; value: Judgement }
  | { tool: "add_step"; text: string; position?: number }
  | { tool: "revise_step"; step: number; text: string }
  | { tool: "delete_step"; step: number }
  | { tool: "set_justification"; text: string }
  | { tool: "submit_answer" };

const allowedFields = {
  set_judgement: ["value"],
  add_step: ["text", "position"],
  revise_step: ["step", "text"],
  delete_step: ["step"],
  set_justification: ["text"],
  submit_answer: []
} as const;

function parseMacGyverCall(raw: unknown): CallParse<MacGyverCall> {
  const read = readCall(raw, allowedFields);
  if (!read.ok) return read;
  const { tool, args } = read;
  switch (tool) {
    case "set_judgement":
      if (args.value !== "solvable" && args.value !== "unsolvable") {
        return invalid('set_judgement needs value "solvable" or "unsolvable".');
      }
      return { ok: true, call: { tool, value: args.value } };
    case "add_step":
      if (typeof args.text !== "string") return invalid("add_step needs text: string.");
      if (args.position != null && !Number.isInteger(args.position)) return invalid("add_step position must be a whole number.");
      return { ok: true, call: { tool, text: args.text, position: args.position as number | undefined } };
    case "revise_step":
      if (!Number.isInteger(args.step)) return invalid("revise_step needs step: a whole number.");
      if (typeof args.text !== "string") return invalid("revise_step needs text: string.");
      return { ok: true, call: { tool, step: args.step as number, text: args.text } };
    case "delete_step":
      if (!Number.isInteger(args.step)) return invalid("delete_step needs step: a whole number.");
      return { ok: true, call: { tool, step: args.step as number } };
    case "set_justification":
      if (typeof args.text !== "string") return invalid("set_justification needs text: string.");
      return { ok: true, call: { tool, text: args.text } };
    case "submit_answer":
      return { ok: true, call: { tool } };
  }
}

function checkText(text: string, maxChars: number, what: string): string | { ok: false; code: string; error: string } {
  const cleaned = cleanText(text);
  if (cleaned.length === 0) return rejected("empty_text", `The ${what} is empty.`);
  if (cleaned.length > maxChars) return rejected("text_too_long", `The ${what} is longer than ${maxChars} characters.`);
  return cleaned;
}

function stepOutOfRange(step: number, count: number) {
  return rejected(
    "step_out_of_range",
    count === 0 ? "There are no steps yet." : `Step ${step} does not exist; steps run from 1 to ${count}.`
  );
}

function applyMacGyverCall(state: MacGyverAnswerState, call: MacGyverCall): Applied<MacGyverAnswerState> {
  if (state.submitted) return rejected("already_submitted", "The answer has been submitted; nothing can change it now.");
  const { maxSteps, maxStepChars, maxJustificationChars } = macgyverAnswerLimits;
  switch (call.tool) {
    case "set_judgement":
      return { ok: true, state: { ...state, judgement: call.value }, eventType: "judgement_set", payload: { value: call.value } };
    case "add_step": {
      if (state.steps.length >= maxSteps) return rejected("too_many_steps", `An answer has at most ${maxSteps} steps.`);
      const text = checkText(call.text, maxStepChars, "step");
      if (typeof text !== "string") return text;
      const position = call.position ?? state.steps.length + 1;
      if (position < 1 || position > state.steps.length + 1) {
        return rejected("step_out_of_range", `A new step can go at positions 1 to ${state.steps.length + 1}.`);
      }
      const steps = [...state.steps];
      steps.splice(position - 1, 0, text);
      return { ok: true, state: { ...state, steps }, eventType: "step_added", payload: { position, text } };
    }
    case "revise_step": {
      if (call.step < 1 || call.step > state.steps.length) return stepOutOfRange(call.step, state.steps.length);
      const text = checkText(call.text, maxStepChars, "step");
      if (typeof text !== "string") return text;
      const steps = [...state.steps];
      const previous = steps[call.step - 1];
      steps[call.step - 1] = text;
      return { ok: true, state: { ...state, steps }, eventType: "step_revised", payload: { step: call.step, text, previous } };
    }
    case "delete_step": {
      if (call.step < 1 || call.step > state.steps.length) return stepOutOfRange(call.step, state.steps.length);
      const steps = [...state.steps];
      const [removed] = steps.splice(call.step - 1, 1);
      return { ok: true, state: { ...state, steps }, eventType: "step_deleted", payload: { step: call.step, removed } };
    }
    case "set_justification": {
      const text = checkText(call.text, maxJustificationChars, "justification");
      if (typeof text !== "string") return text;
      return { ok: true, state: { ...state, justification: text }, eventType: "justification_set", payload: { text } };
    }
    case "submit_answer":
      // Enforced here rather than in a UI, so a refusal is recorded and is the
      // same for every actor.
      if (!state.judgement) return rejected("no_judgement", "Set the judgement (solvable or unsolvable) before submitting.");
      if (state.judgement === "solvable" && state.steps.length === 0) {
        return rejected("no_steps", "A solvable answer needs at least one step.");
      }
      if (state.judgement === "unsolvable" && !state.justification) {
        return rejected("no_justification", "An unsolvable answer needs a justification.");
      }
      return {
        ok: true,
        state: { ...state, submitted: true },
        eventType: "answer_submitted",
        payload: { judgement: state.judgement, stepCount: state.steps.length }
      };
  }
}

function answerLines(state: MacGyverAnswerState) {
  const lines = [`Judgement: ${state.judgement ?? "not set yet"}`, "Steps:"];
  if (state.steps.length === 0) lines.push("(no steps yet)");
  state.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push(`Justification: ${state.justification || "(none yet)"}`);
  return lines;
}

/**
 * The problem is shown verbatim and alone: the item's `problem` is the complete
 * text a solver gets, objects and conditions included, exactly as the benchmark
 * states it.
 */
function observation(state: MacGyverAnswerState) {
  const lines = ["Problem:", state.item.problem, "", "Your answer so far:", ...answerLines(state)];
  if (state.submitted) lines.push("", "The answer has been submitted.");
  return lines.join("\n");
}

export const macgyverAnswerEngine: TextTaskEngine<MacGyverAnswerState, MacGyverCall> & {
  initial(item: MacGyverItemView): MacGyverAnswerState;
} = {
  taskId: "macgyver-problem-solving",
  toolNames: Object.keys(allowedFields),
  initial: item => ({ item, judgement: null, steps: [], justification: "", submitted: false }),
  parseCall: parseMacGyverCall,
  apply: applyMacGyverCall,
  observation,
  status: state => ({
    round: 1,
    totalRounds: 1,
    complete: state.submitted,
    summary: { judgement: state.judgement, stepCount: state.steps.length, hasJustification: state.justification.length > 0 }
  }),
  finalFiles: state => [
    { name: "answer.md", content: `${answerLines(state).join("\n")}\n` },
    {
      name: "answer.json",
      content: `${JSON.stringify(
        { judgement: state.judgement, steps: state.steps, justification: state.justification || null, submitted: state.submitted },
        null,
        2
      )}\n`
    }
  ],
  details: state => ({
    judgement: state.judgement,
    stepCount: state.steps.length,
    justificationChars: state.justification.length,
    submitted: state.submitted
  })
};
