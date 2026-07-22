import type {
  ExcalidrawElement,
  PointBinding
} from "@excalidraw/excalidraw/types/element/types";

export type ElementRotation = {
  id: string;
  angleDegrees: number;
};

export type ElementBinding = {
  arrowId: string;
  startElementId: string | null;
  endElementId: string | null;
};

const fullTurnDegrees = 360;

function nextVersionMetadata(element: ExcalidrawElement) {
  return {
    version: element.version + 1,
    versionNonce: Math.floor(Math.random() * 1_000_000_000),
    updated: Date.now()
  };
}

function normalizedRadians(angleDegrees: number) {
  const normalizedDegrees = ((angleDegrees % fullTurnDegrees) + fullTurnDegrees) % fullTurnDegrees;
  return normalizedDegrees * Math.PI / 180;
}

export function applyElementRotations(
  elements: readonly ExcalidrawElement[],
  rotations: readonly ElementRotation[]
) {
  const rotationById = new Map(rotations.map(rotation => [rotation.id, rotation]));
  return elements.map(element => {
    const rotation = rotationById.get(element.id);
    if (!rotation) return element;
    return {
      ...element,
      angle: normalizedRadians(rotation.angleDegrees),
      ...nextVersionMetadata(element)
    } as ExcalidrawElement;
  });
}

function pointBinding(elementId: string): PointBinding {
  return { elementId, focus: 0, gap: 1 };
}

function sameBoundElements(
  left: ExcalidrawElement["boundElements"],
  right: ExcalidrawElement["boundElements"]
) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function applyElementBindings(
  elements: readonly ExcalidrawElement[],
  bindings: readonly ElementBinding[]
) {
  const bindingByArrowId = new Map(bindings.map(binding => [binding.arrowId, binding]));
  const updatedArrowIds = new Set(bindingByArrowId.keys());
  const targetToArrowIds = new Map<string, Set<string>>();

  for (const binding of bindings) {
    for (const targetId of [binding.startElementId, binding.endElementId]) {
      if (!targetId) continue;
      const arrowIds = targetToArrowIds.get(targetId) ?? new Set<string>();
      arrowIds.add(binding.arrowId);
      targetToArrowIds.set(targetId, arrowIds);
    }
  }

  return elements.map(element => {
    const binding = bindingByArrowId.get(element.id);
    let next = binding
      ? {
          ...element,
          startBinding: binding.startElementId ? pointBinding(binding.startElementId) : null,
          endBinding: binding.endElementId ? pointBinding(binding.endElementId) : null,
          ...nextVersionMetadata(element)
        } as ExcalidrawElement
      : element;

    const retainedBoundElements = (next.boundElements ?? []).filter(boundElement =>
      boundElement.type !== "arrow" || !updatedArrowIds.has(boundElement.id)
    );
    const addedArrowIds = targetToArrowIds.get(element.id) ?? new Set<string>();
    const nextBoundElements = [
      ...retainedBoundElements,
      ...[...addedArrowIds].map(id => ({ id, type: "arrow" as const }))
    ];
    const normalizedBoundElements = nextBoundElements.length > 0 ? nextBoundElements : null;

    if (!sameBoundElements(next.boundElements, normalizedBoundElements)) {
      next = {
        ...next,
        boundElements: normalizedBoundElements,
        ...nextVersionMetadata(next)
      } as ExcalidrawElement;
    }
    return next;
  });
}
