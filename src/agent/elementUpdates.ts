import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";

export type ElementPatch = {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  text?: string | null;
  fontSize?: number | null;
  labelText?: string | null;
  labelFontSize?: number | null;
  strokeColor?: string | null;
  backgroundColor?: string | null;
  points?: Array<[number, number]> | null;
  semanticRole?: string | null;
};

function measureLineWidth(line: string, fontSize: number) {
  if (typeof document === "undefined") return line.length * fontSize * 0.58;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return line.length * fontSize * 0.58;
  context.font = `${fontSize}px Virgil, sans-serif`;
  return context.measureText(line).width;
}

function wrapTextToWidth(text: string, maxWidth: number, fontSize: number) {
  return text
    .split("\n")
    .flatMap(line => {
      const wrapped: string[] = [];
      let current = "";
      for (const word of line.split(" ")) {
        const next = current ? `${current} ${word}` : word;
        if (current && measureLineWidth(next, fontSize) > maxWidth) {
          wrapped.push(current);
          current = word;
        } else {
          current = next;
        }
      }
      if (current) wrapped.push(current);
      return wrapped.length > 0 ? wrapped : [line];
    })
    .join("\n");
}

export function applyElementPatch(
  element: ExcalidrawElement,
  patch: ElementPatch
): ExcalidrawElement {
  const { labelText: _labelText, labelFontSize: _labelFontSize, ...elementPatch } = patch;
  const cleanPatch = Object.fromEntries(
    Object.entries(elementPatch).filter(([, value]) => value !== null && value !== "" && value !== undefined)
  ) as ElementPatch;
  const next = {
    ...element,
    ...cleanPatch,
    version: element.version + 1,
    versionNonce: Math.floor(Math.random() * 1_000_000_000),
    updated: Date.now(),
    customData: {
      ...(element.customData ?? {}),
      ...(cleanPatch.semanticRole ? { semanticRole: cleanPatch.semanticRole } : {})
    }
  } as ExcalidrawElement;
  delete (next as { semanticRole?: string }).semanticRole;
  return next;
}

export function boundTextForContainer(
  elements: readonly ExcalidrawElement[],
  container: ExcalidrawElement
) {
  const boundTextId = container.boundElements?.find(boundElement => boundElement.type === "text")?.id;
  return elements.find(element =>
    element.type === "text" && (
      element.id === boundTextId ||
      (element as ExcalidrawElement & { containerId?: string | null }).containerId === container.id
    )
  );
}

function applyBoundLabelPatch(
  textElement: ExcalidrawElement,
  container: ExcalidrawElement,
  patch: ElementPatch
): ExcalidrawElement {
  const typedText = textElement as ExcalidrawElement & {
    text?: string;
    originalText?: string;
    fontSize?: number;
    lineHeight?: number;
  };
  const originalText = patch.labelText?.trim() || typedText.originalText || typedText.text || "";
  const fontSize = patch.labelFontSize ?? typedText.fontSize ?? 20;
  const maxWidth = Math.max(
    20,
    container.width * (container.type === "ellipse" || container.type === "diamond" ? 0.62 : 0.8)
  );
  const text = wrapTextToWidth(originalText, maxWidth, fontSize);
  const lines = text.split("\n");
  const width = Math.min(maxWidth, Math.max(fontSize, ...lines.map(line => measureLineWidth(line, fontSize))));
  const lineHeight = typedText.lineHeight ?? 1.25;
  const height = Math.max(fontSize * lineHeight, lines.length * fontSize * lineHeight);

  return {
    ...textElement,
    text,
    originalText,
    fontSize,
    width,
    height,
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    version: textElement.version + 1,
    versionNonce: Math.floor(Math.random() * 1_000_000_000),
    updated: Date.now()
  } as ExcalidrawElement;
}

export function applyElementUpdates(
  elements: readonly ExcalidrawElement[],
  updates: Array<{ id: string; patch: ElementPatch }>
) {
  const patchById = new Map(updates.map(update => [update.id, update.patch]));
  let nextElements = elements.map(element => {
    const patch = patchById.get(element.id);
    return patch ? applyElementPatch(element, patch) : element;
  });

  for (const update of updates) {
    if (update.patch.labelText == null && update.patch.labelFontSize == null) continue;
    const container = nextElements.find(element => element.id === update.id);
    if (!container) continue;
    const textElement = boundTextForContainer(nextElements, container);
    if (!textElement) continue;
    nextElements = nextElements.map(element =>
      element.id === textElement.id ? applyBoundLabelPatch(textElement, container, update.patch) : element
    );
  }

  return nextElements;
}
