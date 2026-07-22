import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/types/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI
} from "@excalidraw/excalidraw/types/types";
import {
  diffScenes,
  estimateTextOverflow,
  getSemanticRole,
  roleCounts,
  validateSketchPath,
  withSemanticRole,
  type ExpectedSceneChanges,
  type SceneDiff
} from "./sceneQuality";
import {
  applyElementPatch,
  applyElementUpdates,
  boundTextForContainer,
  type ElementPatch
} from "./elementUpdates";
import { toFreeDrawElement, type FreeDrawPath } from "./freeDrawElements";
import {
  applyElementBindings,
  applyElementRotations,
  type ElementBinding,
  type ElementRotation
} from "./elementTransforms";

export type { ElementPatch } from "./elementUpdates";

export type SceneSummary = {
  total: number;
  byType: Record<string, number>;
  bySemanticRole: Record<string, number>;
  validationWarnings: string[];
  warnings: unknown[];
  elements: SceneElementSummary[];
};

export type ToolOutput = {
  success: boolean;
  result?: unknown;
  error?: string;
  sceneSummaryAfter?: SceneSummary;
};

export type AddRectanglesInput = {
  count: number;
  layout?: "grid" | "row";
};

export type CreateSceneInput = {
  elements: ExcalidrawElementSkeleton[];
  replace?: boolean;
  fitToContent?: boolean;
  description?: string;
  expectedSceneChanges?: ExpectedSceneChanges;
};

export type SceneElementSummary = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  semanticRole?: string;
  groupIds?: string[];
  containerId?: string;
  boundElementIds?: string[];
  startBinding?: { elementId: string; focus: number; gap: number } | null;
  endBinding?: { elementId: string; focus: number; gap: number } | null;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  points?: unknown;
  version?: number;
  isDeleted?: boolean;
};

export type AddElementsInput = {
  description: string;
  elements: ExcalidrawElementSkeleton[];
  fitToContent?: boolean;
};

export type UpdateElementsInput = {
  description: string;
  updates: Array<{ id: string; patch: ElementPatch }>;
};

export type DeleteElementsInput = {
  description: string;
  elementIds: string[];
};

export type MoveElementsInput = {
  description: string;
  moves: Array<{ id: string; x: number; y: number }>;
};

export type RotateElementsInput = {
  description: string;
  rotations: ElementRotation[];
};

export type BindElementsInput = {
  description: string;
  bindings: ElementBinding[];
};

export type ReplaceSceneInput = {
  reason: string;
  elements: ExcalidrawElementSkeleton[];
  expectedPreservedRoles?: string[];
  fitToContent?: boolean;
};

export type SketchPathInput = {
  description: string;
  paths: Array<{
    points: Array<[number, number]>;
    closed?: boolean;
    strokeColor?: string;
    strokeWidth?: number;
    roughness?: number;
    opacity?: number;
    semanticRole?: string;
    groupId?: string;
  }>;
};

export type FreeDrawInput = {
  description: string;
  paths: FreeDrawPath[];
};

export type AgentTools = {
  clear_canvas: (input: Record<string, never>) => ToolOutput;
  add_rectangles: (input: AddRectanglesInput) => ToolOutput;
  create_scene: (input: CreateSceneInput) => ToolOutput;
  get_scene: (input: Record<string, never>) => ToolOutput;
  add_elements: (input: AddElementsInput) => ToolOutput;
  update_elements: (input: UpdateElementsInput) => ToolOutput;
  delete_elements: (input: DeleteElementsInput) => ToolOutput;
  move_elements: (input: MoveElementsInput) => ToolOutput;
  rotate_elements: (input: RotateElementsInput) => ToolOutput;
  bind_elements: (input: BindElementsInput) => ToolOutput;
  replace_scene: (input: ReplaceSceneInput) => ToolOutput;
  sketch_path: (input: SketchPathInput) => ToolOutput;
  free_draw: (input: FreeDrawInput) => ToolOutput;
  get_scene_summary: (input: Record<string, never>) => ToolOutput;
  export_scene_json: (input: Record<string, never>) => ToolOutput;
};

const rectangleWidth = 120;
const rectangleHeight = 80;
const startX = 100;
const startY = 100;
const gapX = 150;
const gapY = 120;
const visibleCanvasWidth = 1400;
const visibleCanvasHeight = 1000;

function getElementText(element: ExcalidrawElement) {
  return (element as { text?: string }).text ?? "";
}

function getFontSize(element: ExcalidrawElement) {
  return (element as { fontSize?: number }).fontSize ?? 20;
}

function estimateTextSize(text: string, fontSize: number) {
  const lines = text.split("\n");
  const maxLineLength = Math.max(0, ...lines.map(line => line.length));
  return {
    width: maxLineLength * fontSize * 0.58,
    height: Math.max(1, lines.length) * fontSize * 1.25
  };
}

function measureLineWidth(line: string, fontSize: number) {
  if (typeof document === "undefined") return line.length * fontSize * 0.58;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return line.length * fontSize * 0.58;
  context.font = `${fontSize}px Virgil, sans-serif`;
  return context.measureText(line).width;
}

function validationWarningsForElements(elements: readonly ExcalidrawElement[]) {
  const warnings: string[] = [];

  for (const [index, element] of elements.entries()) {
    if (element.isDeleted) continue;

    const width = element.width ?? 0;
    const height = element.height ?? 0;
    if (
      element.x < 0 ||
      element.y < 0 ||
      element.x + width > visibleCanvasWidth ||
      element.y + height > visibleCanvasHeight
    ) {
      warnings.push(
        `element ${index} (${element.type}) may be outside the visible 0-${visibleCanvasWidth} x 0-${visibleCanvasHeight} canvas bounds`
      );
    }

    if (element.type === "text") {
      const overflow = estimateTextOverflow(element);
      if (overflow && overflow.confidence !== "low") {
        warnings.push(
          `text element ${index} (${element.id}) may overflow (${overflow.confidence}): ${overflow.reason}`
        );
      }
    }
  }

  return warnings;
}

function wrapTextToWidth(text: string, maxWidth: number, fontSize: number) {
  if (maxWidth <= 0) return text;
  return text
    .split("\n")
    .flatMap(line => {
      const words = line.split(" ");
      const lines: string[] = [];
      let current = "";

      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (measureLineWidth(next, fontSize) > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = next;
        }
      }

      if (current) lines.push(current);
      return lines.length > 0 ? lines : [line];
    })
    .join("\n");
}

function normalizeTextSkeletons(
  skeletons: ExcalidrawElementSkeleton[]
): ExcalidrawElementSkeleton[] {
  return skeletons.map(skeleton => {
    if (skeleton.type !== "text") return skeleton;

    const typed = skeleton as ExcalidrawElementSkeleton & {
      text?: string;
      fontSize?: number;
      width?: number;
    };
    const text = typed.text ?? "";
    const fontSize = typed.fontSize ?? 20;
    const width = Math.max(typed.width ?? 0, 140);
    const safeWidth = Math.min(Math.max(width, 140), 360);
    const wrappedText = wrapTextToWidth(text, safeWidth, fontSize);
    const lineCount = Math.max(1, wrappedText.split("\n").length);
    const fittedHeight = Math.ceil(lineCount * fontSize * 1.25);

    return {
      ...typed,
      width: safeWidth,
      height: Math.max(typed.height ?? 0, fittedHeight),
      text: wrappedText
    };
  });
}

export function summarizeElements(
  elements: readonly ExcalidrawElement[]
): SceneSummary {
  const byType: Record<string, number> = {};
  const warnings: unknown[] = [];

  for (const element of elements) {
    if (element.isDeleted) continue;
    byType[element.type] = (byType[element.type] ?? 0) + 1;
    const overflow = estimateTextOverflow(element);
    if (overflow) warnings.push(overflow);
  }

  return {
    total: Object.values(byType).reduce((sum, count) => sum + count, 0),
    byType,
    bySemanticRole: roleCounts(elements),
    validationWarnings: validationWarningsForElements(elements),
    warnings,
    elements: elements.filter(element => !element.isDeleted).map(summarizeElement)
  };
}

function summarizeElement(element: ExcalidrawElement): SceneElementSummary {
  const visual = element as ExcalidrawElement & {
    points?: unknown;
    strokeColor?: string;
    backgroundColor?: string;
    fillStyle?: string;
    strokeWidth?: number;
    strokeStyle?: string;
    roughness?: number;
    opacity?: number;
  };
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    text: getElementText(element) || undefined,
    semanticRole: getSemanticRole(element) || undefined,
    groupIds: [...element.groupIds],
    containerId: (element as ExcalidrawElement & { containerId?: string | null }).containerId ?? undefined,
    boundElementIds: element.boundElements?.map(boundElement => boundElement.id),
    startBinding: element.type === "arrow" || element.type === "line" ? element.startBinding : undefined,
    endBinding: element.type === "arrow" || element.type === "line" ? element.endBinding : undefined,
    angle: element.angle,
    strokeColor: visual.strokeColor,
    backgroundColor: visual.backgroundColor,
    fillStyle: visual.fillStyle,
    strokeWidth: visual.strokeWidth,
    strokeStyle: visual.strokeStyle,
    roughness: visual.roughness,
    opacity: visual.opacity,
    points: visual.points,
    version: element.version,
    isDeleted: element.isDeleted
  };
}

function sceneResult({
  before,
  after,
  extra
}: {
  before: readonly ExcalidrawElement[];
  after: readonly ExcalidrawElement[];
  extra?: Record<string, unknown>;
}) {
  const diff = diffScenes(before, after);
  return {
    ...extra,
    sceneDiff: diff
  };
}

function updateSceneAndSummarize(
  excalidrawAPI: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
  fitToContent?: boolean
) {
  excalidrawAPI.updateScene({ elements: elements as ExcalidrawElement[] });
  if (fitToContent !== false && elements.length > 0) {
    excalidrawAPI.scrollToContent(elements as ExcalidrawElement[], {
      fitToContent: true,
      animate: false
    });
  }
  return summarizeElements(elements);
}

function fixedElementIds(elements: readonly ExcalidrawElement[], ids: readonly string[]) {
  const idSet = new Set(ids);
  return elements
    .filter(element => idSet.has(element.id) && element.customData?.fixed === true)
    .map(element => element.id);
}

function convertSkeletons(elements: ExcalidrawElementSkeleton[]) {
  return convertToExcalidrawElements(normalizeTextSkeletons(elements)).map(element =>
    withSemanticRole(element, (element.customData?.semanticRole as string | undefined))
  ) as ExcalidrawElement[];
}

function pathToSkeleton(path: SketchPathInput["paths"][number]): ExcalidrawElementSkeleton {
  const points = path.closed ? [...path.points, path.points[0]] : path.points;
  const minX = Math.min(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const localPoints = points.map(([x, y]) => [x - minX, y - minY] as [number, number]);
  const maxX = Math.max(...localPoints.map(([x]) => x));
  const maxY = Math.max(...localPoints.map(([, y]) => y));
  return {
    type: "line",
    x: minX,
    y: minY,
    width: maxX,
    height: maxY,
    points: localPoints,
    strokeColor: path.strokeColor,
    strokeWidth: path.strokeWidth,
    roughness: path.roughness ?? 2,
    opacity: path.opacity,
    customData: {
      semanticRole: path.semanticRole,
      groupId: path.groupId,
      sketchPath: true,
      closed: path.closed ?? false
    }
  } as ExcalidrawElementSkeleton;
}

function buildRectangleSkeletons({
  count,
  layout = "grid"
}: AddRectanglesInput): ExcalidrawElementSkeleton[] {
  const safeCount = Math.max(0, Math.floor(count));
  const columns =
    layout === "row" ? Math.max(1, safeCount) : Math.ceil(Math.sqrt(safeCount));

  return Array.from({ length: safeCount }, (_, index) => {
    const row = layout === "row" ? 0 : Math.floor(index / columns);
    const column = layout === "row" ? index : index % columns;

    return {
      type: "rectangle",
      x: startX + column * gapX,
      y: startY + row * gapY,
      width: rectangleWidth,
      height: rectangleHeight
    };
  });
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function runTool(operation: () => ToolOutput): ToolOutput {
  try {
    return operation();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function createExcalidrawTools(
  excalidrawAPI: ExcalidrawImperativeAPI
): AgentTools {
  return {
    clear_canvas: () =>
      runTool(() => {
        excalidrawAPI.updateScene({ elements: [] });

        return {
          success: true,
          result: { cleared: true },
          sceneSummaryAfter: { total: 0, byType: {}, bySemanticRole: {}, validationWarnings: [], warnings: [], elements: [] }
        };
      }),

    add_rectangles: (input) =>
      runTool(() => {
        const skeletons = buildRectangleSkeletons(input);
        const elements = convertToExcalidrawElements(skeletons);

        excalidrawAPI.updateScene({ elements });
        excalidrawAPI.scrollToContent(elements, {
          fitToContent: true,
          animate: false
        });

        return {
          success: true,
          result: {
            added: elements.length,
            layout: input.layout ?? "grid"
          },
          sceneSummaryAfter: summarizeElements(elements)
        };
      }),

    create_scene: (input) =>
      runTool(() => {
        if (input.replace !== false && excalidrawAPI.getSceneElements().filter(element => !element.isDeleted).length > 0) {
          return {
            success: false,
            error: "create_scene replace=true is blocked on a non-empty scene. Use add_elements/update_elements/delete_elements, or replace_scene with an explicit full-redesign reason.",
            sceneSummaryAfter: summarizeElements(excalidrawAPI.getSceneElements())
          };
        }
        const before = excalidrawAPI.getSceneElements();
        const nextElements = convertSkeletons(input.elements);
        const existingElements =
          input.replace === false ? before : [];
        const elements = [...existingElements, ...nextElements];

        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, input.fitToContent);

        return {
          success: true,
          result: {
            description: input.description,
            created: nextElements.length,
            ids: nextElements.map(element => element.id),
            replacedScene: input.replace !== false,
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    get_scene: () =>
      runTool(() => {
        const elements = excalidrawAPI.getSceneElements();
        const sceneSummaryAfter = summarizeElements(elements);
        return {
          success: true,
          result: sceneSummaryAfter,
          sceneSummaryAfter
        };
      }),

    add_elements: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const nextElements = convertSkeletons(input.elements);
        const elements = [...before, ...nextElements];
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, input.fitToContent);
        return {
          success: true,
          result: {
            description: input.description,
            added: nextElements.length,
            ids: nextElements.map(element => element.id),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    update_elements: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const beforeById = new Map(before.map(element => [element.id, element]));
        const missing = input.updates.filter(update => !beforeById.has(update.id)).map(update => update.id);
        const fixed = fixedElementIds(before, input.updates.map(update => update.id));
        if (missing.length > 0) {
          return {
            success: false,
            error: `Cannot update missing element IDs: ${missing.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (fixed.length > 0) {
          return {
            success: false,
            error: `Cannot update fixed constraint elements: ${fixed.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const invalidLabelTargets = input.updates
          .filter(update => update.patch.labelText != null || update.patch.labelFontSize != null)
          .filter(update => {
            const container = beforeById.get(update.id);
            return !container || !boundTextForContainer(before, container);
          })
          .map(update => update.id);
        if (invalidLabelTargets.length > 0) {
          return {
            success: false,
            error: `Cannot update bound label for elements without native bound text: ${invalidLabelTargets.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const elements = applyElementUpdates(before, input.updates);
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, false);
        return {
          success: true,
          result: {
            description: input.description,
            updated: input.updates.map(update => update.id),
            before: input.updates.map(update => summarizeElement(beforeById.get(update.id)!)),
            after: input.updates.map(update => summarizeElement(elements.find(element => element.id === update.id)!)),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    delete_elements: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const ids = new Set(input.elementIds);
        const missing = input.elementIds.filter(id => !before.some(element => element.id === id && !element.isDeleted));
        const fixed = fixedElementIds(before, input.elementIds);
        if (missing.length > 0) {
          return {
            success: false,
            error: `Cannot delete missing element IDs: ${missing.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (fixed.length > 0) {
          return {
            success: false,
            error: `Cannot delete fixed constraint elements: ${fixed.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const deletedBefore = before.filter(element => ids.has(element.id)).map(summarizeElement);
        const elements = before.filter(element => !ids.has(element.id));
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, false);
        return {
          success: true,
          result: {
            description: input.description,
            deleted: input.elementIds,
            deletedBefore,
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    move_elements: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const beforeById = new Map(before.map(element => [element.id, element]));
        const missing = input.moves.filter(move => !beforeById.has(move.id)).map(move => move.id);
        const fixed = fixedElementIds(before, input.moves.map(move => move.id));
        if (missing.length > 0) {
          return {
            success: false,
            error: `Cannot move missing element IDs: ${missing.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (fixed.length > 0) {
          return {
            success: false,
            error: `Cannot move fixed constraint elements: ${fixed.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const moveById = new Map(input.moves.map(move => [move.id, move]));
        const elements = before.map(element => {
          const move = moveById.get(element.id);
          return move ? applyElementPatch(element, { x: move.x, y: move.y }) : element;
        });
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, false);
        return {
          success: true,
          result: {
            description: input.description,
            moved: input.moves.map(move => move.id),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    rotate_elements: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const beforeById = new Map(before.map(element => [element.id, element]));
        const missing = input.rotations.filter(rotation => !beforeById.has(rotation.id)).map(rotation => rotation.id);
        const fixed = fixedElementIds(before, input.rotations.map(rotation => rotation.id));
        const invalidAngles = input.rotations
          .filter(rotation => !Number.isFinite(rotation.angleDegrees))
          .map(rotation => rotation.id);
        if (missing.length > 0) {
          return {
            success: false,
            error: `Cannot rotate missing element IDs: ${missing.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (fixed.length > 0) {
          return {
            success: false,
            error: `Cannot rotate fixed constraint elements: ${fixed.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (invalidAngles.length > 0) {
          return {
            success: false,
            error: `Rotation angles must be finite numbers: ${invalidAngles.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const elements = applyElementRotations(before, input.rotations);
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, false);
        return {
          success: true,
          result: {
            description: input.description,
            rotated: input.rotations.map(rotation => rotation.id),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    bind_elements: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const beforeById = new Map(before.map(element => [element.id, element]));
        const missingArrows = input.bindings
          .filter(binding => !beforeById.has(binding.arrowId))
          .map(binding => binding.arrowId);
        const nonArrows = input.bindings
          .filter(binding => {
            const element = beforeById.get(binding.arrowId);
            return element && element.type !== "arrow";
          })
          .map(binding => binding.arrowId);
        const targetIds = input.bindings.flatMap(binding =>
          [binding.startElementId, binding.endElementId].filter((id): id is string => Boolean(id))
        );
        const missingTargets = targetIds.filter(id => !beforeById.has(id));
        const invalidTargets = targetIds.filter(id => {
          const target = beforeById.get(id);
          return target && !["rectangle", "diamond", "ellipse", "text", "image", "embeddable", "frame"].includes(target.type);
        });
        const selfBindings = input.bindings
          .filter(binding => binding.startElementId === binding.arrowId || binding.endElementId === binding.arrowId)
          .map(binding => binding.arrowId);
        const fixed = fixedElementIds(before, input.bindings.map(binding => binding.arrowId));
        if (missingArrows.length > 0 || missingTargets.length > 0) {
          return {
            success: false,
            error: `Cannot bind missing element IDs: ${[...new Set([...missingArrows, ...missingTargets])].join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (nonArrows.length > 0) {
          return {
            success: false,
            error: `Only arrow elements can be bound: ${[...new Set(nonArrows)].join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (invalidTargets.length > 0 || selfBindings.length > 0) {
          return {
            success: false,
            error: `Invalid binding targets: ${[...new Set([...invalidTargets, ...selfBindings])].join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (fixed.length > 0) {
          return {
            success: false,
            error: `Cannot change bindings for fixed constraint arrows: ${fixed.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const elements = applyElementBindings(before, input.bindings);
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, false);
        return {
          success: true,
          result: {
            description: input.description,
            bound: input.bindings.map(binding => binding.arrowId),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    replace_scene: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const existingRoles = roleCounts(before);
        const missingPreserved = (input.expectedPreservedRoles ?? []).filter(role => (existingRoles[role] ?? 0) > 0);
        if (before.length > 0 && !/full|redesign|reset|replace/i.test(input.reason)) {
          return {
            success: false,
            error: "replace_scene requires an explicit full redesign/reset reason when the scene is non-empty.",
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        if (missingPreserved.length > 0) {
          return {
            success: false,
            error: `replace_scene would not preserve existing roles: ${missingPreserved.join(", ")}`,
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const elements = convertSkeletons(input.elements);
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, input.fitToContent);
        return {
          success: true,
          result: {
            reason: input.reason,
            ids: elements.map(element => element.id),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    sketch_path: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const allIssues = input.paths.flatMap(path => validateSketchPath(path.points, path.closed));
        if (allIssues.length > 0) {
          return {
            success: false,
            error: allIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "),
            result: { issues: allIssues },
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const skeletons = input.paths.map(pathToSkeleton);
        const nextElements = convertSkeletons(skeletons);
        const elements = [...before, ...nextElements];
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, true);
        return {
          success: true,
          result: {
            description: input.description,
            ids: nextElements.map(element => element.id),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    free_draw: (input) =>
      runTool(() => {
        const before = excalidrawAPI.getSceneElements();
        const allIssues = input.paths.flatMap(path => validateSketchPath(path.points, path.closed));
        if (allIssues.length > 0) {
          return {
            success: false,
            error: allIssues.map(issue => `${issue.code}: ${issue.message}`).join("; "),
            result: { issues: allIssues },
            sceneSummaryAfter: summarizeElements(before)
          };
        }
        const baseElements = convertSkeletons(input.paths.map(path => pathToSkeleton({
          ...path,
          roughness: 0
        })));
        const nextElements = baseElements.map((element, index) =>
          toFreeDrawElement(element, input.paths[index])
        );
        const elements = [...before, ...nextElements];
        const sceneSummaryAfter = updateSceneAndSummarize(excalidrawAPI, elements, true);
        return {
          success: true,
          result: {
            description: input.description,
            ids: nextElements.map(element => element.id),
            ...sceneResult({ before, after: elements })
          },
          sceneSummaryAfter
        };
      }),

    get_scene_summary: () =>
      runTool(() => {
        const elements = excalidrawAPI.getSceneElements();
        const sceneSummaryAfter = summarizeElements(elements);

        return {
          success: true,
          result: sceneSummaryAfter,
          sceneSummaryAfter
        };
      }),

    export_scene_json: () =>
      runTool(() => {
        const elements = excalidrawAPI.getSceneElements();
        const appState = excalidrawAPI.getAppState() as Partial<AppState>;
        const sceneSummaryAfter = summarizeElements(elements);
        const payload = {
          type: "excalidraw-agent-smoke-test-scene",
          elements,
          appState,
          summary: sceneSummaryAfter
        };

        console.log("Excalidraw scene JSON", payload);
        downloadJson("excalidraw_scene.json", payload);

        return {
          success: true,
          result: payload,
          sceneSummaryAfter
        };
      })
  };
}
