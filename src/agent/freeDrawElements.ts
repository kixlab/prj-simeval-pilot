import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement
} from "@excalidraw/excalidraw/types/element/types";

export type FreeDrawPath = {
  points: Array<[number, number]>;
  closed?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
  opacity?: number;
  semanticRole?: string;
  groupId?: string;
};

export function toFreeDrawElement(
  baseElement: ExcalidrawElement,
  path: FreeDrawPath
): ExcalidrawFreeDrawElement {
  const absolutePoints = path.closed && path.points.length > 0
    ? [...path.points, path.points[0]]
    : path.points;
  const minX = Math.min(...absolutePoints.map(([x]) => x));
  const minY = Math.min(...absolutePoints.map(([, y]) => y));
  const points = absolutePoints.map(([x, y]) => [x - minX, y - minY] as [number, number]);
  const width = Math.max(...points.map(([x]) => x));
  const height = Math.max(...points.map(([, y]) => y));

  return {
    ...baseElement,
    type: "freedraw",
    x: minX,
    y: minY,
    width,
    height,
    points,
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: points.at(-1) ?? null,
    strokeColor: path.strokeColor ?? baseElement.strokeColor,
    strokeWidth: path.strokeWidth ?? baseElement.strokeWidth,
    opacity: path.opacity ?? baseElement.opacity,
    customData: {
      ...(baseElement.customData ?? {}),
      semanticRole: path.semanticRole,
      groupId: path.groupId,
      freeDraw: true,
      closed: path.closed ?? false
    }
  } as ExcalidrawFreeDrawElement;
}
