// Tolerant reader for small vision-language model replies on the
// incomplete-shapes task.
//
// 2B-class models wrap JSON in prose, fence it, and reach for key names the
// prompt never mentioned. Repairing that here keeps the *server* contract
// strict: the app still rejects anything outside the canonical tool surface.
// Every repair is counted, because leniency the driver grants an agent is
// assistance a human participant does not get.

import { extractCall, extractCallBatch, readThought, readToolName } from "./agentReplyParser.mjs";

export { extractReasoning, stripThinkTags } from "./agentReplyParser.mjs";

/**
 * Coerces only genuine numbers and numeric strings. Plain `Number()` would turn
 * null, "", [] and true into 0 and silently fabricate a coordinate the model
 * never produced.
 */
function toCoordinate(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Normalizes one already-parsed call object into the canonical call shape. */
export function normalizeAudraCall(parsed) {
  const repairs = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Reply was not an object.", repairs };
  }

  const tool = readToolName(parsed, repairs);
  if (!tool) return { ok: false, error: "Missing tool name.", repairs };

  const call = { tool };

  // The prompted rationale. Non-reasoning models have no other channel, so it
  // is read from several key names and kept beside the call rather than in it.
  const promptedThought = readThought(parsed, repairs);
  if (tool === "set_description") {
    const text = parsed.text ?? parsed.description ?? parsed.arguments?.text;
    if (parsed.text == null && text != null) repairs.push("aliased_text_key");
    if (typeof text !== "string") return { ok: false, error: "set_description needs text.", repairs };
    call.text = text.slice(0, 500);
  } else if (tool === "draw_stroke" || tool === "erase_stroke") {
    const rawPoints = parsed.points ?? parsed.arguments?.points ?? parsed.path;
    if (parsed.points == null && rawPoints != null) repairs.push("aliased_points_key");
    if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
      return { ok: false, error: `${tool} needs a points array.`, repairs };
    }
    const points = [];
    for (const point of rawPoints) {
      const pair = Array.isArray(point) && point.length >= 2
        ? [point[0], point[1]]
        : point && typeof point === "object" && "x" in point && "y" in point
          ? [point.x, point.y]
          : null;
      if (!pair) return { ok: false, error: "Points must be [x,y] pairs or {x,y} objects.", repairs };
      const x = toCoordinate(pair[0]);
      const y = toCoordinate(pair[1]);
      if (x == null || y == null) {
        return { ok: false, error: "Points must be finite numbers.", repairs };
      }
      points.push({ x, y });
    }
    if (rawPoints.some(point => Array.isArray(point))) repairs.push("converted_pair_points");
    if (rawPoints.some(point => {
      const pair = Array.isArray(point) ? point : [point?.x, point?.y];
      return typeof pair[0] === "string" || typeof pair[1] === "string";
    })) repairs.push("coerced_string_coordinates");
    // A single point is a tap; the human UI turns that into a dot too.
    if (points.length === 1) {
      points.push({ ...points[0] });
      repairs.push("duplicated_single_point");
    }
    call.points = points;
    const width = parsed.width ?? parsed.arguments?.width;
    if (typeof width === "number" && Number.isFinite(width)) call.width = width;
  }
  return { ok: true, call, repairs, promptedThought };
}

/** Reads exactly one tool call. A reply holding several is a failure, not a choice. */
export function extractToolCall(text) {
  return extractCall(text, normalizeAudraCall);
}

/** Reads an ordered list of tool calls; see extractCallBatch. */
export function extractToolCallBatch(text) {
  return extractCallBatch(text, normalizeAudraCall);
}
