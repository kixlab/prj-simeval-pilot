import type { LLMSceneElement } from "./sceneElementTypes";
import type { ElementPatch, SketchPathInput } from "./tools";

export const timedAgentToolNames = [
  "clear_canvas",
  "create_scene",
  "get_scene",
  "add_elements",
  "update_elements",
  "delete_elements",
  "move_elements",
  "replace_scene",
  "sketch_path",
  "free_draw",
  "get_scene_summary"
] as const;

export type TimedAgentToolCall = {
  toolName: (typeof timedAgentToolNames)[number];
  description: string;
  reason: string;
  replace: boolean;
  fitToContent: boolean;
  elements: LLMSceneElement[];
  updates: Array<{ id: string; patch: ElementPatch }>;
  elementIds: string[];
  moves: Array<{ id: string; x: number; y: number }>;
  paths: SketchPathInput["paths"];
};

export type TimedAgentDecision = {
  status: "continue" | "finish";
  agentThought: string;
  decisionRationale: string;
  semanticLabel: string;
  finishReason: string;
  toolCalls: TimedAgentToolCall[];
};

const pointSchema = {
  type: "array",
  minItems: 2,
  maxItems: 2,
  items: { type: "number" }
};

const elementSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "type", "x", "y", "width", "height", "text", "fontSize", "strokeColor",
    "backgroundColor", "fillStyle", "roughness", "labelText", "labelFontSize",
    "points", "semanticRole", "groupId"
  ],
  properties: {
    type: { type: "string", enum: ["rectangle", "ellipse", "diamond", "text", "arrow", "line"] },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    text: { type: "string" },
    fontSize: { type: "number" },
    strokeColor: { type: "string" },
    backgroundColor: { type: "string" },
    fillStyle: { type: "string", enum: ["hachure", "cross-hatch", "solid"] },
    roughness: { type: "number" },
    labelText: { type: "string" },
    labelFontSize: { type: "number" },
    points: { type: "array", items: pointSchema },
    semanticRole: { type: "string" },
    groupId: { type: "string" }
  }
};

const nullablePatchProperty = (type: "number" | "string") => ({ type: [type, "null"] });

const toolCallSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "toolName", "description", "reason", "replace", "fitToContent", "elements",
    "updates", "elementIds", "moves", "paths"
  ],
  properties: {
    toolName: { type: "string", enum: timedAgentToolNames },
    description: { type: "string" },
    reason: { type: "string" },
    replace: { type: "boolean" },
    fitToContent: { type: "boolean" },
    elements: { type: "array", items: elementSchema },
    updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "patch"],
        properties: {
          id: { type: "string" },
          patch: {
            type: "object",
            additionalProperties: false,
            required: [
              "x", "y", "width", "height", "text", "fontSize", "labelText",
              "labelFontSize", "strokeColor", "backgroundColor", "points", "semanticRole"
            ],
            properties: {
              x: nullablePatchProperty("number"),
              y: nullablePatchProperty("number"),
              width: nullablePatchProperty("number"),
              height: nullablePatchProperty("number"),
              text: nullablePatchProperty("string"),
              fontSize: nullablePatchProperty("number"),
              labelText: nullablePatchProperty("string"),
              labelFontSize: nullablePatchProperty("number"),
              strokeColor: nullablePatchProperty("string"),
              backgroundColor: nullablePatchProperty("string"),
              points: { type: ["array", "null"], items: pointSchema },
              semanticRole: nullablePatchProperty("string")
            }
          }
        }
      }
    },
    elementIds: { type: "array", items: { type: "string" } },
    moves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "x", "y"],
        properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" } }
      }
    },
    paths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["points", "closed", "strokeColor", "strokeWidth", "roughness", "opacity", "semanticRole", "groupId"],
        properties: {
          points: { type: "array", items: pointSchema },
          closed: { type: "boolean" },
          strokeColor: { type: "string" },
          strokeWidth: { type: "number" },
          roughness: { type: "number" },
          opacity: { type: "number" },
          semanticRole: { type: "string" },
          groupId: { type: "string" }
        }
      }
    }
  }
};

export const timedAgentDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "agentThought", "decisionRationale", "semanticLabel", "finishReason", "toolCalls"],
  properties: {
    status: { type: "string", enum: ["continue", "finish"] },
    agentThought: { type: "string" },
    decisionRationale: { type: "string" },
    semanticLabel: { type: "string" },
    finishReason: { type: "string" },
    toolCalls: { type: "array", items: toolCallSchema }
  }
};
