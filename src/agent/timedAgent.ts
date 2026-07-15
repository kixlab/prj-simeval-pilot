import { toSkeletonElement } from "./sceneElementTypes";
import type { AgentTools, SceneSummary, ToolOutput } from "./tools";
import type { TimedAgentDecision, TimedAgentToolCall } from "./timedAgentProtocol";

export type AgentTrajectoryEntry = {
  eventId: string;
  timestamp: string;
  elapsedMs: number;
  remainingMs: number;
  decision: number;
  model?: string;
  kind: "decision" | "tool_call" | "error" | "finish";
  agentThought?: string;
  decisionRationale?: string;
  semanticLabel?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  success: boolean;
  message?: string;
};

function compactSummary(summary?: SceneSummary) {
  if (!summary) return undefined;
  return {
    total: summary.total,
    byType: summary.byType,
    bySemanticRole: summary.bySemanticRole,
    warnings: summary.warnings,
    elements: summary.elements
  };
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function executeTool(tools: AgentTools, call: TimedAgentToolCall): { input: unknown; output: ToolOutput } {
  if (call.toolName === "clear_canvas") return { input: {}, output: tools.clear_canvas({}) };
  if (call.toolName === "get_scene") return { input: {}, output: tools.get_scene({}) };
  if (call.toolName === "get_scene_summary") return { input: {}, output: tools.get_scene_summary({}) };
  if (call.toolName === "create_scene") {
    const input = { description: call.description, replace: call.replace, fitToContent: call.fitToContent, elements: call.elements.map(toSkeletonElement) };
    return { input, output: tools.create_scene(input) };
  }
  if (call.toolName === "add_elements") {
    const input = { description: call.description, fitToContent: call.fitToContent, elements: call.elements.map(toSkeletonElement) };
    return { input, output: tools.add_elements(input) };
  }
  if (call.toolName === "update_elements") {
    const input = { description: call.description, updates: call.updates };
    return { input, output: tools.update_elements(input) };
  }
  if (call.toolName === "delete_elements") {
    const input = { description: call.description, elementIds: call.elementIds };
    return { input, output: tools.delete_elements(input) };
  }
  if (call.toolName === "move_elements") {
    const input = { description: call.description, moves: call.moves };
    return { input, output: tools.move_elements(input) };
  }
  if (call.toolName === "replace_scene") {
    const input = { reason: call.reason, fitToContent: call.fitToContent, elements: call.elements.map(toSkeletonElement), expectedPreservedRoles: [] };
    return { input, output: tools.replace_scene(input) };
  }
  const input = { description: call.description, paths: call.paths };
  return call.toolName === "free_draw"
    ? { input, output: tools.free_draw(input) }
    : { input, output: tools.sketch_path(input) };
}

async function requestDecision({
  instruction,
  sceneSummary,
  screenshotDataUrl,
  recentTrajectory,
  elapsedMs,
  remainingMs,
  finalizationWindow,
  signal
}: {
  instruction: string;
  sceneSummary: SceneSummary;
  screenshotDataUrl?: string;
  recentTrajectory: AgentTrajectoryEntry[];
  elapsedMs: number;
  remainingMs: number;
  finalizationWindow: boolean;
  signal: AbortSignal;
}) {
  const response = await fetch("/api/agent-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      instruction,
      sceneSummary: compactSummary(sceneSummary),
      screenshotDataUrl,
      recentTrajectory: recentTrajectory.slice(-12),
      elapsedMs,
      remainingMs,
      finalizationWindow
    })
  });
  const payload = await response.json() as { success: boolean; decision?: TimedAgentDecision; model?: string; error?: string };
  if (!response.ok || !payload.success || !payload.decision) {
    throw new Error(payload.error ?? `Agent decision failed with ${response.status}`);
  }
  return { decision: payload.decision, model: payload.model };
}

export async function runTimedAgent({
  tools,
  getInstruction,
  captureScreenshot,
  timeBudgetMs = 300_000,
  finalizationWindowMs = 30_000,
  signal,
  onLog
}: {
  tools: AgentTools;
  getInstruction: () => string;
  captureScreenshot: () => Promise<string | undefined>;
  timeBudgetMs?: number;
  finalizationWindowMs?: number;
  signal: AbortSignal;
  onLog: (entry: AgentTrajectoryEntry) => void;
}) {
  const startedAt = performance.now();
  const deadline = startedAt + timeBudgetMs;
  const trajectory: AgentTrajectoryEntry[] = [];
  let decisionNumber = 0;

  const append = (entry: Omit<AgentTrajectoryEntry, "eventId" | "timestamp">) => {
    const complete: AgentTrajectoryEntry = {
      ...entry,
      eventId: `agent-trajectory:${trajectory.length + 1}`,
      timestamp: new Date().toISOString()
    };
    trajectory.push(complete);
    onLog(complete);
  };

  while (!signal.aborted && performance.now() < deadline) {
    decisionNumber += 1;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const remainingMs = Math.max(0, Math.round(deadline - performance.now()));
    const summary = tools.get_scene_summary({}).sceneSummaryAfter;
    if (!summary) throw new Error("Canvas summary is unavailable.");

    try {
      const screenshotDataUrl = await captureScreenshot();
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      signal.addEventListener("abort", abortRequest, { once: true });
      const timeout = window.setTimeout(abortRequest, remainingMs);
      const { decision, model } = await requestDecision({
        instruction: getInstruction(),
        sceneSummary: summary,
        screenshotDataUrl,
        recentTrajectory: trajectory,
        elapsedMs,
        remainingMs,
        finalizationWindow: remainingMs <= finalizationWindowMs,
        signal: requestController.signal
      });
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abortRequest);

      append({
        elapsedMs,
        remainingMs,
        decision: decisionNumber,
        model,
        kind: "decision",
        agentThought: decision.agentThought,
        decisionRationale: decision.decisionRationale,
        semanticLabel: decision.semanticLabel,
        success: true,
        message: `${decision.toolCalls.length} tool call(s) planned`
      });

      for (const call of decision.toolCalls) {
        if (signal.aborted || performance.now() >= deadline) break;
        const callElapsedMs = Math.round(performance.now() - startedAt);
        const { input, output } = executeTool(tools, call);
        append({
          elapsedMs: callElapsedMs,
          remainingMs: Math.max(0, Math.round(deadline - performance.now())),
          decision: decisionNumber,
          kind: "tool_call",
          semanticLabel: decision.semanticLabel,
          toolName: call.toolName,
          toolInput: input,
          toolOutput: { success: output.success, error: output.error, result: output.result },
          success: output.success,
          message: call.description
        });
      }

      const inFinalizationWindow = remainingMs <= finalizationWindowMs;
      if (decision.status === "finish" && inFinalizationWindow) {
        append({
          elapsedMs: Math.round(performance.now() - startedAt),
          remainingMs: Math.max(0, Math.round(deadline - performance.now())),
          decision: decisionNumber,
          kind: "finish",
          agentThought: decision.agentThought,
          decisionRationale: decision.decisionRationale,
          semanticLabel: "final_synthesis",
          success: true,
          message: decision.finishReason || "Agent finalized the artifact."
        });
        return { trajectory, reason: "agent_finish" as const };
      }

      if (decision.status === "finish" && !inFinalizationWindow) {
        append({
          elapsedMs: Math.round(performance.now() - startedAt),
          remainingMs: Math.max(0, Math.round(deadline - performance.now())),
          decision: decisionNumber,
          kind: "decision",
          semanticLabel: decision.semanticLabel,
          success: true,
          message: "Early finish was deferred until the finalization window."
        });
      }

      if (decision.toolCalls.length === 0 && !inFinalizationWindow) {
        await abortableDelay(Math.min(5000, Math.max(0, deadline - performance.now())), signal);
      }
    } catch (error) {
      const aborted = signal.aborted || performance.now() >= deadline;
      append({
        elapsedMs: Math.round(performance.now() - startedAt),
        remainingMs: Math.max(0, Math.round(deadline - performance.now())),
        decision: decisionNumber,
        kind: aborted ? "finish" : "error",
        success: aborted,
        message: aborted ? "Time budget ended; current artifact was finalized." : error instanceof Error ? error.message : String(error)
      });
      if (aborted) return { trajectory, reason: "time_budget" as const };
      await abortableDelay(Math.min(3000, Math.max(0, deadline - performance.now())), signal);
    }
  }

  return { trajectory, reason: signal.aborted ? "cancelled" as const : "time_budget" as const };
}
