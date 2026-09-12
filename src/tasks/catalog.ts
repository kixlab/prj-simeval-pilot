/**
 * The three creativity tasks this pilot collects, declared once.
 *
 * The launcher, the mode router, and each task's own entry point all read this
 * catalog, so a task's identity, URL, and readiness live in one place instead
 * of being restated per surface. A task is `available` only when a participant
 * can complete a trial and leave an export bundle behind; anything short of
 * that is `planned` and routes to a description page rather than a dead card.
 */
export type TaskStatus = "available" | "planned";
export type TaskModality = "drawing" | "text";

export type TaskDefinition = {
  /** Stable identity, expected to appear in this task's export bundles. */
  taskId: string;
  /** `?mode=` value that loads this task. */
  mode: string;
  title: string;
  /** Published instrument the task items come from. */
  instrument: string;
  summary: string;
  modality: TaskModality;
  status: TaskStatus;
  /** What one completed trial produces. */
  outputs: readonly string[];
  /** Design decisions already fixed for this task. */
  design: readonly string[];
  /** What is still missing before this task can collect analysable data. */
  remaining: readonly string[];
  reference: string;
};

const catalog: readonly TaskDefinition[] = [
  {
    taskId: "audra-incomplete-shapes",
    mode: "audra-incomplete-shapes",
    title: "Incomplete shapes",
    instrument: "MTCI-style incomplete-shape drawing (CAP / AuDrA)",
    summary:
      "Complete one creative drawing from four fixed starting lines, then say what you drew.",
    modality: "drawing",
    status: "available",
    outputs: ["A finished drawing", "A short description of the drawing", "A think-aloud recording"],
    design: [
      "Human and agent share one action reducer, so both are limited to pencil, eraser, and Undo Last.",
      "The starting lines are an immutable background layer and cannot be moved or erased by either actor.",
      "The export bundle carries the event log, the canonical SVG, and both AuDrA-profile PNGs."
    ],
    remaining: [
      "The bundled stimulus is a development fixture; the official contour set has to replace it before data collection."
    ],
    reference:
      "Patterson et al. (2024), AuDrA; Patterson et al. (2025), CAP: The Creativity Assessment Platform."
  },
  {
    taskId: "macgyver-problem-solving",
    mode: "macgyver-problem-solving",
    title: "Creative problem solving",
    instrument: "MacGyver (NAACL 2024)",
    summary:
      "Decide whether a real-world problem can be solved with the objects at hand, then write the solution or say why there is none.",
    modality: "text",
    status: "planned",
    outputs: [
      "A solvable / unsolvable judgement",
      "A step-by-step solution, or a justification for calling the problem unsolvable",
      "A think-aloud recording"
    ],
    design: [
      "Benchmark items are shown to human and agent verbatim: problem, available objects and tools, constraints.",
      "External search and any tool beyond the listed objects are forbidden on both sides.",
      "Pilot subset of five items: three unconventional solvable, one conventional solvable, one unsolvable, all chosen to need no domain knowledge.",
      "Scoring: feasibility / safety / effectiveness by the multi-agent judge, plus a pairwise novelty judge."
    ],
    remaining: [
      "The five pilot items are loaded, and the agent environment runs them under all three strategies; the participant screen, think-aloud capture, and the human export bundle still have to be built.",
      "The licence position for using the released MacGyver items has not been recorded yet."
    ],
    reference: "Tian et al. (2024), MacGyver: Are Large Language Models Creative Problem Solvers?"
  },
  {
    taskId: "cs4-creative-writing",
    mode: "cs4-creative-writing",
    title: "Constrained creative writing",
    instrument: "CS4 (constrained story writing)",
    summary:
      "Revise one roughly 500-word story through rounds of constraints that keep accumulating.",
    modality: "text",
    status: "planned",
    outputs: [
      "One revised story per constraint round",
      "The full revision history across rounds",
      "A think-aloud recording"
    ],
    design: [
      "Progressive single session, three rounds: 7 constraints, then 15, then 23, each round revising the story the previous round produced.",
      "One session rather than independent sessions, so the human and the agent keep comparable context.",
      "Scoring: LitBench pairwise preference as the primary outcome, CS4 constraint satisfaction as the validity check, CS4 coherence as secondary."
    ],
    remaining: [
      "The 50 official story-based instances are loaded (pilot subset: the ten from the earlier CS4 pilot), and the agent environment runs the three rounds under all three strategies.",
      "The revision editor, think-aloud capture, and the human export bundle still have to be built."
    ],
    reference:
      "Atmakuru et al. (2024), CS4; Fein et al. (2026), LitBench."
  }
];

export function listTasks(): readonly TaskDefinition[] {
  return catalog;
}

export function taskByMode(mode: string): TaskDefinition | null {
  return catalog.find(task => task.mode === mode) ?? null;
}

export function taskById(taskId: string): TaskDefinition | null {
  return catalog.find(task => task.taskId === taskId) ?? null;
}

/**
 * URL that loads one task. A participant id typed on the launcher is carried
 * over so the task screen starts prefilled rather than asking twice.
 */
export function taskHref(task: TaskDefinition, options?: { participantId?: string }) {
  const params = new URLSearchParams({ mode: task.mode });
  const participantId = options?.participantId?.trim();
  if (participantId) params.set("participant", participantId);
  return `/?${params.toString()}`;
}
