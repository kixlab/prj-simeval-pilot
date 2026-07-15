import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/types/data/transform";

export type LLMSceneElement = {
  type: "rectangle" | "ellipse" | "diamond" | "text" | "arrow" | "line";
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  fontSize?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "hachure" | "cross-hatch" | "solid";
  roughness?: number;
  labelText?: string;
  labelFontSize?: number;
  points?: [number, number][];
  semanticRole?: string;
  groupId?: string;
};

function optionalString(value?: string) {
  return value && value.trim().length > 0 ? value : undefined;
}

function optionalPositiveNumber(value?: number) {
  return typeof value === "number" && value > 0 ? value : undefined;
}

export function toSkeletonElement(element: LLMSceneElement): ExcalidrawElementSkeleton {
  const customData = element.semanticRole
    ? { semanticRole: element.semanticRole, groupId: element.groupId }
    : element.groupId
      ? { groupId: element.groupId }
      : undefined;

  if (element.type === "text") {
    return {
      type: "text",
      text: element.text ?? "",
      x: element.x,
      y: element.y,
      width: optionalPositiveNumber(element.width),
      fontSize: optionalPositiveNumber(element.fontSize),
      strokeColor: optionalString(element.strokeColor),
      customData
    };
  }

  if (element.type === "arrow" || element.type === "line") {
    const points =
      element.points && element.points.length >= 2
        ? element.points
        : [
            [0, 0],
            [element.width || 100, element.height || 0]
          ];

    return {
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      points,
      strokeColor: optionalString(element.strokeColor),
      customData,
      label: optionalString(element.labelText)
        ? {
            text: element.labelText ?? "",
            fontSize: optionalPositiveNumber(element.labelFontSize) ?? 16
          }
        : undefined
    };
  }

  return {
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width ?? 120,
    height: element.height ?? 80,
    strokeColor: optionalString(element.strokeColor),
    backgroundColor: optionalString(element.backgroundColor),
    fillStyle: element.fillStyle || undefined,
    roughness: element.roughness,
    label: optionalString(element.labelText)
      ? {
          text: element.labelText ?? "",
          fontSize: optionalPositiveNumber(element.labelFontSize) ?? 16
        }
      : undefined,
    customData
  };
}
