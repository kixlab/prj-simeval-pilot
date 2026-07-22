import type { AgentTools, SceneElementSummary, SceneSummary, ToolOutput } from "../agent/tools";

export type ArtifactActorMode = "human_interactive" | "agent_reactive";

export type SceneArtifactDiff = {
  added: string[];
  updated: string[];
  moved: string[];
  resized: string[];
  rotated: string[];
  bindingChanged: string[];
  deleted: string[];
};

export type SceneStateDigest = Omit<SceneSummary, "elements">;

export type SceneElementChange = {
  id: string;
  changeTypes: Array<keyof SceneArtifactDiff>;
  before?: SceneElementSummary;
  after?: SceneElementSummary;
};

export type ArtifactActionEntry = {
  eventId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  actorType: "human" | "agent";
  actorMode: ArtifactActorMode;
  tool: "excalidraw";
  source: "editor_change" | "agent_tool";
  rawEventType: string;
  normalizedAction: string;
  targetObjectIds: string[];
  beforeState: SceneStateDigest;
  afterState: SceneStateDigest;
  artifactDiff: SceneArtifactDiff;
  elementChanges: SceneElementChange[];
  toolInput?: unknown;
  decisionNumber?: number;
  toolCallIndex?: number;
  toolExecutionId?: string;
  success: boolean;
  error?: string;
};

export type ArtifactActionDraft = Omit<
  ArtifactActionEntry,
  "eventId" | "sessionId" | "sequence" | "timestamp" | "durationMs" | "tool"
>;

const mutatingToolNames = [
  "clear_canvas",
  "create_scene",
  "add_elements",
  "update_elements",
  "delete_elements",
  "move_elements",
  "rotate_elements",
  "bind_elements",
  "replace_scene",
  "sketch_path",
  "free_draw"
] as const;

type MutatingToolName = (typeof mutatingToolNames)[number];

export type AgentToolExecutionContext = {
  decisionNumber: number;
  toolCallIndex: number;
  toolExecutionId: string;
};

const agentToolExecutionContexts = new WeakMap<AgentTools, AgentToolExecutionContext>();

export function setAgentToolExecutionContext(tools: AgentTools, context: AgentToolExecutionContext | null) {
  if (context) agentToolExecutionContexts.set(tools, context);
  else agentToolExecutionContexts.delete(tools);
}

function byId(elements: readonly SceneElementSummary[]) {
  return new Map(elements.map(element => [element.id, element]));
}

export function diffSceneSummaries(before: SceneSummary, after: SceneSummary): SceneArtifactDiff {
  const beforeById = byId(before.elements);
  const afterById = byId(after.elements);
  const diff: SceneArtifactDiff = {
    added: [],
    updated: [],
    moved: [],
    resized: [],
    rotated: [],
    bindingChanged: [],
    deleted: []
  };

  for (const [id, next] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      diff.added.push(id);
      continue;
    }
    if (previous.x !== next.x || previous.y !== next.y) diff.moved.push(id);
    if (previous.width !== next.width || previous.height !== next.height) diff.resized.push(id);
    if (previous.angle !== next.angle) diff.rotated.push(id);
    if (
      JSON.stringify(previous.startBinding ?? null) !== JSON.stringify(next.startBinding ?? null) ||
      JSON.stringify(previous.endBinding ?? null) !== JSON.stringify(next.endBinding ?? null) ||
      JSON.stringify(previous.boundElementIds ?? []) !== JSON.stringify(next.boundElementIds ?? []) ||
      previous.containerId !== next.containerId
    ) {
      diff.bindingChanged.push(id);
    }
    if (
      previous.text !== next.text ||
      previous.type !== next.type ||
      previous.semanticRole !== next.semanticRole ||
      previous.strokeColor !== next.strokeColor ||
      previous.backgroundColor !== next.backgroundColor ||
      previous.fillStyle !== next.fillStyle ||
      previous.strokeWidth !== next.strokeWidth ||
      previous.strokeStyle !== next.strokeStyle ||
      previous.roughness !== next.roughness ||
      previous.opacity !== next.opacity ||
      JSON.stringify(previous.points ?? null) !== JSON.stringify(next.points ?? null) ||
      JSON.stringify(previous.groupIds ?? []) !== JSON.stringify(next.groupIds ?? [])
    ) {
      diff.updated.push(id);
    }
  }

  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) diff.deleted.push(id);
  }
  return diff;
}

export function hasSceneChanges(diff: SceneArtifactDiff) {
  return Object.values(diff).some(ids => ids.length > 0);
}

export function sceneActionLabel(diff: SceneArtifactDiff) {
  const changedKinds = Object.entries(diff).filter(([, ids]) => ids.length > 0).map(([kind]) => kind);
  if (changedKinds.length !== 1) return "compound_edit";
  if (diff.added.length) return "create_object";
  if (diff.deleted.length) return "delete_object";
  if (diff.moved.length) return "move_object";
  if (diff.resized.length) return "resize_object";
  if (diff.rotated.length) return "rotate_object";
  if (diff.bindingChanged.length) return "change_binding";
  return "update_object";
}

export function sceneTargetIds(diff: SceneArtifactDiff) {
  return [...new Set([
    ...diff.added,
    ...diff.updated,
    ...diff.moved,
    ...diff.resized,
    ...diff.rotated,
    ...diff.bindingChanged,
    ...diff.deleted
  ])];
}

export function sceneStateDigest(summary: SceneSummary): SceneStateDigest {
  const { elements: _elements, ...digest } = summary;
  return digest;
}

export function sceneElementChanges(
  before: SceneSummary,
  after: SceneSummary,
  diff: SceneArtifactDiff
): SceneElementChange[] {
  const beforeById = byId(before.elements);
  const afterById = byId(after.elements);
  return sceneTargetIds(diff).map(id => ({
    id,
    changeTypes: (Object.keys(diff) as Array<keyof SceneArtifactDiff>)
      .filter(changeType => diff[changeType].includes(id)),
    before: beforeById.get(id),
    after: afterById.get(id)
  }));
}

export function compactSceneTransition(
  before: SceneSummary,
  after: SceneSummary,
  artifactDiff: SceneArtifactDiff
) {
  return {
    beforeState: sceneStateDigest(before),
    afterState: sceneStateDigest(after),
    artifactDiff,
    elementChanges: sceneElementChanges(before, after, artifactDiff)
  };
}

export function toArtifactActionJsonl(entries: readonly ArtifactActionEntry[]) {
  return entries.map(entry => JSON.stringify(entry)).join("\n");
}

export function instrumentExcalidrawAgentTools({
  tools,
  actorMode,
  nowMs,
  onAction
}: {
  tools: AgentTools;
  actorMode: Exclude<ArtifactActorMode, "human_interactive">;
  nowMs: () => number;
  onAction: (draft: ArtifactActionDraft) => void;
}): AgentTools {
  const instrumented = { ...tools } as AgentTools;

  for (const toolName of mutatingToolNames) {
    const original = tools[toolName] as (input: never) => ToolOutput;
    (instrumented as unknown as Record<string, (input: never) => ToolOutput>)[toolName] = input => {
      const before = tools.get_scene_summary({}).sceneSummaryAfter;
      const startedAtMs = nowMs();
      const output = original(input);
      const endedAtMs = nowMs();
      const after = output.sceneSummaryAfter ?? before;
      if (before && after) {
        const artifactDiff = diffSceneSummaries(before, after);
        if (hasSceneChanges(artifactDiff)) {
          const executionContext = agentToolExecutionContexts.get(instrumented);
          onAction({
            startedAtMs,
            endedAtMs,
            actorType: "agent",
            actorMode,
            source: "agent_tool",
            rawEventType: toolName,
            normalizedAction: sceneActionLabel(artifactDiff),
            targetObjectIds: sceneTargetIds(artifactDiff),
            ...compactSceneTransition(before, after, artifactDiff),
            toolInput: input,
            decisionNumber: executionContext?.decisionNumber,
            toolCallIndex: executionContext?.toolCallIndex,
            toolExecutionId: executionContext?.toolExecutionId,
            success: output.success,
            error: output.error
          });
        }
      }
      return output;
    };
  }

  return instrumented;
}
