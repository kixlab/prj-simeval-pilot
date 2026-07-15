import type { ExcalidrawElement } from "@excalidraw/excalidraw/types/element/types";
import type { SceneSummary } from "./tools";

export type SceneSemanticRole =
  | "boundary"
  | "play_zone"
  | "rest_zone"
  | "shared_seating"
  | "walking_route"
  | "rainwater_feature"
  | "trade_off_callout"
  | "user_figure"
  | "mechanism"
  | "annotation"
  | "sketch_detail"
  | string;

export type ExpectedSceneChangeRef = {
  semanticRole: string;
  description: string;
};

export type ExpectedSceneChanges = {
  add?: ExpectedSceneChangeRef[];
  update?: ExpectedSceneChangeRef[];
  delete?: ExpectedSceneChangeRef[];
  move?: ExpectedSceneChangeRef[];
  preserve?: ExpectedSceneChangeRef[];
};

export type SceneValidationIssueCode =
  | "UNINTENDED_ELEMENT_LOSS"
  | "REPLACE_ON_NONEMPTY_SCENE"
  | "MISSING_PRESERVED_ELEMENT"
  | "INTENT_ACTION_MISMATCH"
  | "MISSING_REQUESTED_ELEMENT"
  | "FALSE_TEXT_OVERFLOW"
  | "DUPLICATE_ELEMENT"
  | "INVALID_SKETCH_PATH"
  | "EMPTY_TEXT"
  | "HIGH_CONFIDENCE_OVERFLOW"
  | "MISSING_REQUIRED_ROLE";

export type SceneValidationIssue = {
  code: SceneValidationIssueCode;
  elementIds?: string[];
  message: string;
  recoverable: boolean;
};

export type SceneDiff = {
  added: string[];
  updated: string[];
  deleted: string[];
  moved: string[];
  unchanged: string[];
  semanticRolesAdded: string[];
  semanticRolesRemoved: string[];
};

export type ObservedSceneChanges = {
  add: string[];
  update: string[];
  delete: string[];
  move: string[];
  preserve: string[];
};

export type ObserverActionAssessment = {
  intentSatisfied: boolean;
  observedChanges: ObservedSceneChanges;
  missingExpectedChanges: ObservedSceneChanges;
  declaredInputMissingRoles: string[];
  unresolvedReferences: string[];
  issues: SceneValidationIssue[];
};

export type SceneCompletionCheck = {
  requirementCoverage: {
    complete: boolean;
    missingRoles: string[];
  };
  artifactIntegrity: {
    clean: boolean;
    issues: SceneValidationIssueCode[];
  };
};

export type TextOverflowWarning = {
  elementId: string;
  confidence: "low" | "medium" | "high";
  measuredWidth: number;
  availableWidth: number;
  renderedBounds?: {
    width: number;
    height: number;
  };
  reason: string;
};

export type RepairType =
  | "none"
  | "retry"
  | "update"
  | "delete"
  | "restore"
  | "replace"
  | "sanitize"
  | "validator_override";

export type SemanticLabel =
  | "problem_framing"
  | "layout"
  | "idea_generation"
  | "creative_revision"
  | "execution_repair"
  | "validation_cleanup"
  | "artifact_restoration"
  | "sketch_detailing"
  | "annotation"
  | "critique"
  | "idea_pruning"
  | "concept_replacement"
  | "constraint_resolution"
  | "final_synthesis"
  | "validation"
  | string;

export function getSemanticRole(element: Pick<ExcalidrawElement, "customData">) {
  const role = element.customData?.semanticRole;
  return typeof role === "string" ? role : "";
}

export function withSemanticRole<T extends { customData?: Record<string, unknown> }>(
  element: T,
  semanticRole?: string
) {
  if (!semanticRole?.trim()) return element;
  return {
    ...element,
    customData: {
      ...(element.customData ?? {}),
      semanticRole: semanticRole.trim()
    }
  };
}

export function roleCounts(elements: readonly ExcalidrawElement[]) {
  const bySemanticRole: Record<string, number> = {};
  for (const element of elements) {
    if (element.isDeleted) continue;
    const role = getSemanticRole(element);
    if (role) bySemanticRole[role] = (bySemanticRole[role] ?? 0) + 1;
  }
  return bySemanticRole;
}

export function estimateTextOverflow(element: ExcalidrawElement): TextOverflowWarning | null {
  if (element.type !== "text") return null;
  const text = ((element as { text?: string }).text ?? "").trim();
  if (!text) {
    return {
      elementId: element.id,
      confidence: "high",
      measuredWidth: 0,
      availableWidth: element.width,
      reason: "empty text element"
    };
  }

  const fontSize = (element as { fontSize?: number }).fontSize ?? 20;
  const lineHeight = (element as { lineHeight?: number }).lineHeight ?? 1.25;
  const lines = text.split("\n");
  const longestLine = Math.max(...lines.map(line => line.length));
  const measuredWidth = longestLine * fontSize * 0.5;
  const measuredHeight = lines.length * fontSize * lineHeight;
  const availableWidth = Math.max(element.width, 1);
  const availableHeight = Math.max(element.height, fontSize * lineHeight);

  const widthRatio = measuredWidth / availableWidth;
  const heightRatio = measuredHeight / availableHeight;
  const ratio = Math.max(widthRatio, heightRatio);
  if (ratio <= 1.35) return null;

  return {
    elementId: element.id,
    confidence: ratio > 2 ? "high" : ratio > 1.6 ? "medium" : "low",
    measuredWidth,
    availableWidth,
    renderedBounds: {
      width: measuredWidth,
      height: measuredHeight
    },
    reason: `estimated text bounds exceed element box by ratio ${ratio.toFixed(2)}`
  };
}

export function highConfidenceOverflowIssues(summary: SceneSummary): SceneValidationIssue[] {
  return summary.warnings
    .filter(warning => {
      const typed = warning as Partial<TextOverflowWarning>;
      return typed.confidence === "high";
    })
    .map(warning => {
      const typed = warning as Partial<TextOverflowWarning>;
      return {
        code: "HIGH_CONFIDENCE_OVERFLOW" as const,
        elementIds: typed.elementId ? [typed.elementId] : [],
        message: typed.reason ?? "high-confidence text overflow warning",
        recoverable: true
      };
    });
}

export function diffScenes(before: readonly ExcalidrawElement[], after: readonly ExcalidrawElement[]): SceneDiff {
  const beforeMap = new Map(before.filter(element => !element.isDeleted).map(element => [element.id, element]));
  const afterMap = new Map(after.filter(element => !element.isDeleted).map(element => [element.id, element]));
  const added: string[] = [];
  const updated: string[] = [];
  const moved: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];
  const semanticRolesAdded = new Set<string>();
  const semanticRolesRemoved = new Set<string>();

  for (const [id, afterElement] of afterMap) {
    const beforeElement = beforeMap.get(id);
    if (!beforeElement) {
      added.push(id);
      const role = getSemanticRole(afterElement);
      if (role) semanticRolesAdded.add(role);
      continue;
    }
    if (beforeElement.x !== afterElement.x || beforeElement.y !== afterElement.y) moved.push(id);
    if (
      beforeElement.version !== afterElement.version ||
      JSON.stringify(beforeElement.customData ?? {}) !== JSON.stringify(afterElement.customData ?? {}) ||
      (beforeElement as { text?: string }).text !== (afterElement as { text?: string }).text
    ) {
      updated.push(id);
    } else {
      unchanged.push(id);
    }
  }

  for (const [id, beforeElement] of beforeMap) {
    if (!afterMap.has(id)) {
      deleted.push(id);
      const role = getSemanticRole(beforeElement);
      if (role) semanticRolesRemoved.add(role);
    }
  }

  return {
    added,
    updated,
    deleted,
    moved,
    unchanged,
    semanticRolesAdded: [...semanticRolesAdded],
    semanticRolesRemoved: [...semanticRolesRemoved]
  };
}

export function validateReplacePreflight({
  currentSummary,
  nextElementCount,
  expectedSceneChanges
}: {
  currentSummary: SceneSummary;
  nextElementCount: number;
  expectedSceneChanges?: ExpectedSceneChanges;
}): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = [];
  if (currentSummary.total > 0) {
    issues.push({
      code: "REPLACE_ON_NONEMPTY_SCENE",
      message: `replace_scene/create_scene replace=true requested on non-empty scene with ${currentSummary.total} existing elements.`,
      recoverable: true
    });
  }
  const preservedRoles = expectedSceneChanges?.preserve ?? [];
  for (const change of preservedRoles) {
    const role = change.semanticRole;
    if ((currentSummary.bySemanticRole[role] ?? 0) > 0 && nextElementCount < currentSummary.total) {
      issues.push({
        code: "MISSING_PRESERVED_ELEMENT",
        message: `replace input may drop preserved role: ${role}`,
        recoverable: true
      });
    }
  }
  return issues;
}

function rolesForElementIds(summary: SceneSummary, ids: readonly string[]) {
  const idSet = new Set(ids);
  return [...new Set(
    summary.elements
      .filter(element => idSet.has(element.id))
      .map(element => element.semanticRole)
      .filter((role): role is string => Boolean(role))
  )];
}

export function observeIntentCoverage({
  beforeSummary,
  afterSummary,
  sceneDiff,
  expectedSceneChanges,
  declaredElementRoles = []
}: {
  beforeSummary: SceneSummary;
  afterSummary: SceneSummary;
  sceneDiff: SceneDiff;
  expectedSceneChanges?: ExpectedSceneChanges;
  declaredElementRoles?: string[];
}): ObserverActionAssessment {
  const observedChanges: ObservedSceneChanges = {
    add: rolesForElementIds(afterSummary, sceneDiff.added),
    update: rolesForElementIds(afterSummary, sceneDiff.updated),
    delete: sceneDiff.semanticRolesRemoved,
    move: rolesForElementIds(afterSummary, sceneDiff.moved),
    preserve: []
  };
  const missingExpectedChanges: ObservedSceneChanges = {
    add: [],
    update: [],
    delete: [],
    move: [],
    preserve: []
  };
  const unresolvedReferences: string[] = [];
  const issues: SceneValidationIssue[] = [];

  for (const changeType of ["add", "update", "delete", "move"] as const) {
    for (const change of expectedSceneChanges?.[changeType] ?? []) {
      const role = change.semanticRole;
      const knownBefore = (beforeSummary.bySemanticRole[role] ?? 0) > 0;
      const knownAfter = (afterSummary.bySemanticRole[role] ?? 0) > 0;
      if (changeType !== "add" && !knownBefore && !knownAfter) {
        unresolvedReferences.push(`${changeType}:${role}`);
        continue;
      }
      if (!observedChanges[changeType].includes(role)) {
        missingExpectedChanges[changeType].push(role);
        issues.push({
          code: "MISSING_REQUESTED_ELEMENT",
          message: `Observer did not find expected ${changeType} role in the current scene diff: ${role}`,
          recoverable: true
        });
      }
    }
  }

  for (const change of expectedSceneChanges?.preserve ?? []) {
    const role = change.semanticRole;
    const knownBefore = (beforeSummary.bySemanticRole[role] ?? 0) > 0;
    if (!knownBefore) {
      unresolvedReferences.push(`preserve:${role}`);
      continue;
    }
    if ((afterSummary.bySemanticRole[role] ?? 0) > 0) {
      observedChanges.preserve.push(role);
    } else {
      missingExpectedChanges.preserve.push(role);
      issues.push({
        code: "MISSING_PRESERVED_ELEMENT",
        message: `Observer did not find a previously present preserved role after the action: ${role}`,
        recoverable: true
      });
    }
  }

  const declaredRoleSet = new Set(declaredElementRoles.filter(Boolean));
  const declaredInputMissingRoles = (expectedSceneChanges?.add ?? [])
    .map(change => change.semanticRole)
    .filter(role => !declaredRoleSet.has(role));
  for (const role of declaredInputMissingRoles) {
    issues.push({
      code: "INTENT_ACTION_MISMATCH",
      message: `Expected add role was declared but absent from this tool call's element input: ${role}`,
      recoverable: true
    });
  }

  return {
    intentSatisfied: issues.length === 0,
    observedChanges,
    missingExpectedChanges,
    declaredInputMissingRoles,
    unresolvedReferences,
    issues
  };
}

export function checkSceneCompletion(summary: SceneSummary, userInstruction: string): SceneCompletionCheck {
  void userInstruction;
  const requiredRoles: string[] = [];
  const missingRoles = requiredRoles.filter(role => (summary.bySemanticRole[role] ?? 0) === 0);
  const integrityIssues = [
    ...summary.validationWarnings
      .filter(warning => warning.includes("outside the visible"))
      .map(() => "MISSING_REQUESTED_ELEMENT" as const)
  ];

  return {
    requirementCoverage: {
      complete: missingRoles.length === 0,
      missingRoles
    },
    artifactIntegrity: {
      clean: integrityIssues.length === 0,
      issues: integrityIssues
    }
  };
}

export function classifySceneSemanticLabel(label: string, toolName: string, hadValidationError: boolean): SemanticLabel {
  if (hadValidationError) return "execution_repair";
  if (toolName === "replace_scene" && label === "revision") return "artifact_restoration";
  if (toolName === "update_elements" || toolName === "move_elements") return label === "revision" ? "creative_revision" : label;
  if (toolName === "delete_elements") return label === "idea_pruning" ? "idea_pruning" : "validation_cleanup";
  if (toolName === "sketch_path" || toolName === "free_draw") return "sketch_detailing";
  if (label === "revision") return "creative_revision";
  return label;
}

export function validateSketchPath(points: Array<[number, number]>, closed?: boolean): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = [];
  if (points.length < 2 || (closed && points.length < 3)) {
    issues.push({
      code: "INVALID_SKETCH_PATH",
      message: "sketch path needs at least 2 points, or 3 points when closed.",
      recoverable: true
    });
  }
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    issues.push({
      code: "INVALID_SKETCH_PATH",
      message: "sketch path contains NaN or infinite coordinates.",
      recoverable: true
    });
  }
  if (points.some(([x, y]) => Math.abs(x) > 5000 || Math.abs(y) > 5000)) {
    issues.push({
      code: "INVALID_SKETCH_PATH",
      message: "sketch path contains coordinates far outside expected canvas bounds.",
      recoverable: true
    });
  }
  const unique = new Set(points.map(([x, y]) => `${x},${y}`));
  if (unique.size < 2 || (closed && unique.size < 3)) {
    issues.push({
      code: "INVALID_SKETCH_PATH",
      message: "sketch path contains too few unique points.",
      recoverable: true
    });
  }
  return issues;
}
