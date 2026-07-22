import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/types/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types/types";
import { createExcalidrawTools, type AgentTools, type ElementPatch, type ToolOutput } from "./tools";
import { instrumentExcalidrawAgentTools, type ArtifactActionDraft } from "../logging/artifactActions";

type ShapeType = "rectangle" | "ellipse" | "diamond";
type ShapeStyle = {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "hachure" | "cross-hatch" | "solid";
  roughness?: number;
  semanticRole?: string;
};

export type PilotAgentApi = {
  addShape: (type: ShapeType, x: number, y: number, width: number, height: number, style?: ShapeStyle) => ToolOutput;
  addLine: (points: Array<[number, number]>, style?: ShapeStyle & { strokeWidth?: number; freeDraw?: boolean; closed?: boolean }) => ToolOutput;
  addText: (x: number, y: number, text: string, style?: ShapeStyle & { fontSize?: number; width?: number }) => ToolOutput;
  moveObject: (objectId: string, x: number, y: number) => ToolOutput;
  resizeObject: (objectId: string, width: number, height: number) => ToolOutput;
  rotateObject: (objectId: string, angleDegrees: number) => ToolOutput;
  bindArrow: (arrowId: string, startElementId: string | null, endElementId: string | null) => ToolOutput;
  updateStyle: (objectId: string, style: ElementPatch) => ToolOutput;
  deleteObject: (objectId: string) => ToolOutput;
  getCanvasState: () => ToolOutput;
  submitThinkAloud: (text: string) => void;
  finishTask: () => void;
  tools: AgentTools;
};

declare global {
  interface Window {
    simevalAgentApi?: PilotAgentApi;
  }
}

export function createPilotAgentApi({
  api,
  nowMs,
  onBeforeMutation,
  onAction,
  onThinkAloud,
  onFinish
}: {
  api: ExcalidrawImperativeAPI;
  nowMs: () => number;
  onBeforeMutation: () => void;
  onAction: (draft: ArtifactActionDraft) => void;
  onThinkAloud: (text: string) => void;
  onFinish: () => void;
}): PilotAgentApi {
  const baseTools = createExcalidrawTools(api);
  const instrumented = instrumentExcalidrawAgentTools({
    tools: baseTools,
    actorMode: "agent_reactive",
    nowMs,
    onAction
  });
  const mutate = <T extends unknown[]>(operation: (...args: T) => ToolOutput) => (...args: T) => {
    onBeforeMutation();
    return operation(...args);
  };

  return {
    addShape: mutate((type, x, y, width, height, style = {}) => {
      const skeleton: ExcalidrawElementSkeleton = {
        type,
        x,
        y,
        width,
        height,
        strokeColor: style.strokeColor,
        backgroundColor: style.backgroundColor,
        fillStyle: style.fillStyle,
        roughness: style.roughness,
        customData: { semanticRole: style.semanticRole }
      };
      return instrumented.add_elements({ description: `Add ${type}`, elements: [skeleton], fitToContent: false });
    }),
    addLine: mutate((points, style = {}) => {
      const input = {
        description: style.freeDraw ? "Add freehand path" : "Add line path",
        paths: [{
          points,
          closed: style.closed,
          strokeColor: style.strokeColor,
          strokeWidth: style.strokeWidth,
          roughness: style.roughness,
          semanticRole: style.semanticRole
        }]
      };
      return style.freeDraw ? instrumented.free_draw(input) : instrumented.sketch_path(input);
    }),
    addText: mutate((x, y, text, style = {}) => instrumented.add_elements({
      description: "Add text",
      fitToContent: false,
      elements: [{
        type: "text",
        x,
        y,
        width: style.width,
        text,
        fontSize: style.fontSize,
        strokeColor: style.strokeColor,
        customData: { semanticRole: style.semanticRole }
      }]
    })),
    moveObject: mutate((objectId, x, y) => instrumented.move_elements({
      description: "Move object",
      moves: [{ id: objectId, x, y }]
    })),
    resizeObject: mutate((objectId, width, height) => instrumented.update_elements({
      description: "Resize object",
      updates: [{ id: objectId, patch: { width, height } }]
    })),
    rotateObject: mutate((objectId, angleDegrees) => instrumented.rotate_elements({
      description: "Rotate object",
      rotations: [{ id: objectId, angleDegrees }]
    })),
    bindArrow: mutate((arrowId, startElementId, endElementId) => instrumented.bind_elements({
      description: "Bind arrow endpoints",
      bindings: [{ arrowId, startElementId, endElementId }]
    })),
    updateStyle: mutate((objectId, style) => instrumented.update_elements({
      description: "Update object style",
      updates: [{ id: objectId, patch: style }]
    })),
    deleteObject: mutate(objectId => instrumented.delete_elements({
      description: "Delete object",
      elementIds: [objectId]
    })),
    getCanvasState: () => instrumented.get_scene({}),
    submitThinkAloud: onThinkAloud,
    finishTask: onFinish,
    tools: instrumented
  };
}
