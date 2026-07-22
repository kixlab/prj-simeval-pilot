import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { CompactElementState, ElementMutationOperation } from "../data/sessionTypes";

const trackedProperties = [
  "x", "y", "width", "height", "angle", "text", "originalText", "points",
  "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "roundness", "opacity",
  "fontSize", "fontFamily", "textAlign", "verticalAlign", "lineHeight", "startArrowhead", "endArrowhead",
  "groupIds", "containerId", "frameId", "boundElements", "startBinding", "endBinding", "locked", "link", "isDeleted"
] as const;

function copyValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

function valuesEqual(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (before === null || after === null || before === undefined || after === undefined) return false;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((value, index) => valuesEqual(value, after[index]));
  }
  if (typeof before === "object" && typeof after === "object") {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const beforeKeys = Object.keys(beforeRecord);
    const afterKeys = Object.keys(afterRecord);
    return beforeKeys.length === afterKeys.length
      && beforeKeys.every(key => Object.prototype.hasOwnProperty.call(afterRecord, key) && valuesEqual(beforeRecord[key], afterRecord[key]));
  }
  return false;
}

export function compactElement(element: ExcalidrawElement): CompactElementState {
  const candidate = element as ExcalidrawElement & Record<string, unknown>;
  return {
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle,
    text: typeof candidate.text === "string" ? candidate.text : null,
    originalText: typeof candidate.originalText === "string" ? candidate.originalText : null,
    points: copyValue(candidate.points ?? null),
    strokeColor: element.strokeColor,
    backgroundColor: element.backgroundColor,
    fillStyle: element.fillStyle,
    strokeWidth: element.strokeWidth,
    strokeStyle: element.strokeStyle,
    roughness: element.roughness,
    roundness: copyValue(element.roundness),
    opacity: element.opacity,
    fontSize: typeof candidate.fontSize === "number" ? candidate.fontSize : null,
    fontFamily: typeof candidate.fontFamily === "number" ? candidate.fontFamily : null,
    textAlign: typeof candidate.textAlign === "string" ? candidate.textAlign : null,
    verticalAlign: typeof candidate.verticalAlign === "string" ? candidate.verticalAlign : null,
    lineHeight: typeof candidate.lineHeight === "number" ? candidate.lineHeight : null,
    startArrowhead: typeof candidate.startArrowhead === "string" ? candidate.startArrowhead : null,
    endArrowhead: typeof candidate.endArrowhead === "string" ? candidate.endArrowhead : null,
    groupIds: [...element.groupIds],
    containerId: typeof candidate.containerId === "string" ? candidate.containerId : null,
    frameId: typeof candidate.frameId === "string" ? candidate.frameId : null,
    boundElements: copyValue(candidate.boundElements ?? null),
    startBinding: copyValue(candidate.startBinding ?? null),
    endBinding: copyValue(candidate.endBinding ?? null),
    locked: element.locked,
    link: element.link,
    isDeleted: element.isDeleted
  };
}

export function compactElementMap(elements: readonly ExcalidrawElement[]) {
  return new Map(elements.map(element => [element.id, compactElement(element)]));
}

function operationFor(properties: string[]): ElementMutationOperation {
  const categories = new Set<ElementMutationOperation>();
  if (properties.includes("isDeleted")) categories.add("delete");
  if (properties.some(property => property === "x" || property === "y")) categories.add("move");
  if (properties.some(property => property === "width" || property === "height")) categories.add("resize");
  if (properties.includes("angle")) categories.add("rotate");
  if (properties.some(property => property === "text" || property === "originalText")) categories.add("change_text");
  if (properties.some(property => [
    "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "roundness", "opacity",
    "fontSize", "fontFamily", "textAlign", "verticalAlign", "lineHeight", "startArrowhead", "endArrowhead"
  ].includes(property))) categories.add("change_style");
  if (properties.includes("points")) categories.add("change_points");
  if (properties.some(property => ["containerId", "boundElements", "startBinding", "endBinding"].includes(property))) categories.add("change_binding");
  if (properties.some(property => ["groupIds", "frameId", "locked", "link"].includes(property))) categories.add("out_of_scope_change");
  if (categories.size === 0) return "unclassified_change";
  return categories.size === 1 ? [...categories][0] : "compound_change";
}

export type ElementMutationDraft = {
  elementId: string;
  elementType: string;
  operation: ElementMutationOperation;
  changedProperties: Array<{ property: string; before: unknown; after: unknown }>;
  beforeElement: CompactElementState | null;
  afterElement: CompactElementState | null;
};

export function diffElementMaps(
  previous: ReadonlyMap<string, CompactElementState>,
  current: ReadonlyMap<string, CompactElementState>
): ElementMutationDraft[] {
  const mutations: ElementMutationDraft[] = [];
  for (const [elementId, afterElement] of current) {
    const beforeElement = previous.get(elementId) ?? null;
    if (!beforeElement) {
      mutations.push({
        elementId,
        elementType: afterElement.type,
        operation: "create",
        changedProperties: Object.entries(afterElement)
          .filter(([property]) => property !== "id" && property !== "type")
          .map(([property, after]) => ({ property, before: null, after: copyValue(after) })),
        beforeElement: null,
        afterElement
      });
      continue;
    }
    const changedProperties = trackedProperties
      .filter(property => !valuesEqual(beforeElement[property], afterElement[property]))
      .map(property => ({
        property,
        before: copyValue(beforeElement[property]),
        after: copyValue(afterElement[property])
      }));
    if (changedProperties.length === 0) continue;
    mutations.push({
      elementId,
      elementType: afterElement.type,
      operation: operationFor(changedProperties.map(change => change.property)),
      changedProperties,
      beforeElement,
      afterElement
    });
  }
  for (const [elementId, beforeElement] of previous) {
    if (current.has(elementId)) continue;
    mutations.push({
      elementId,
      elementType: beforeElement.type,
      operation: "delete",
      changedProperties: [{ property: "isDeleted", before: beforeElement.isDeleted, after: true }],
      beforeElement,
      afterElement: null
    });
  }
  return mutations;
}
