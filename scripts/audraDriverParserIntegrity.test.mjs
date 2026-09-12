import assert from "node:assert/strict";
import { extractReasoning, extractToolCall, stripThinkTags } from "./audraToolCallParser.mjs";

// Replies shaped the way 2B-class vision models actually answer.

// Clean reply, no repairs needed.
{
  const result = extractToolCall('{"tool":"draw_stroke","points":[{"x":10,"y":20},{"x":30,"y":40}],"width":4}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.points, [{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  assert.equal(result.call.width, 4);
  assert.deepEqual(result.repairs, []);
}

// Fenced JSON wrapped in commentary.
{
  const result = extractToolCall(
    'Sure! I will draw the body of the lantern.\n```json\n{"tool":"draw_stroke","points":[[187,259],[150,430]]}\n```\nLet me know.'
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.points, [{ x: 187, y: 259 }, { x: 150, y: 430 }]);
  assert.ok(result.repairs.includes("stripped_code_fence"));
  assert.ok(result.repairs.includes("converted_pair_points"));
}

// Alias keys: `action` instead of `tool`, `description` instead of `text`.
{
  const result = extractToolCall('{"action":"set_description","description":"a floating lantern"}');
  assert.equal(result.ok, true);
  assert.equal(result.call.tool, "set_description");
  assert.equal(result.call.text, "a floating lantern");
  assert.ok(result.repairs.includes("aliased_tool_key"));
  assert.ok(result.repairs.includes("aliased_text_key"));
}

// Nested arguments, as emitted by models imitating function-calling.
{
  const result = extractToolCall('{"name":"draw_stroke","arguments":{"points":[[1,2],[3,4]],"width":6}}');
  assert.equal(result.ok, true);
  assert.equal(result.call.width, 6);
  assert.equal(result.call.points.length, 2);
}

// A single point becomes a drawable dot, matching the human tap path.
{
  const result = extractToolCall('{"tool":"draw_stroke","points":[[500,500]]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.points, [{ x: 500, y: 500 }, { x: 500, y: 500 }]);
  assert.ok(result.repairs.includes("duplicated_single_point"));
}

// The description is capped before it can be rejected downstream.
{
  const result = extractToolCall(JSON.stringify({ tool: "set_description", text: "x".repeat(900) }));
  assert.equal(result.ok, true);
  assert.equal(result.call.text.length, 500);
}

// Numeric strings are accepted but flagged; nothing else coerces to a number.
{
  const result = extractToolCall('{"tool":"draw_stroke","points":[["10","20"],[30,40]]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.points, [{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  assert.ok(result.repairs.includes("coerced_string_coordinates"));
}
for (const bad of ["null", "true", '""', "[]", "{}"]) {
  const result = extractToolCall(`{"tool":"draw_stroke","points":[[${bad},2],[3,4]]}`);
  assert.equal(result.ok, false, `${bad} must not coerce to a coordinate`);
}

// Failures stay failures: the driver must not invent a call.
for (const reply of [
  "I think I should draw a house next.",
  "```json\n{not json}\n```",
  '{"tool":"draw_stroke"}',
  '{"tool":"draw_stroke","points":[]}',
  '{"tool":"draw_stroke","points":["left","right"]}',
  '{"tool":"draw_stroke","points":[[null,2],[3,4]]}',
  '{"text":"no tool named"}'
]) {
  const result = extractToolCall(reply);
  assert.equal(result.ok, false, `expected failure for: ${reply}`);
  assert.equal(typeof result.error, "string");
}

// The parser never widens the tool surface: an unknown tool passes through as a
// name and is rejected by the server, not silently rewritten to a known one.
{
  const result = extractToolCall('{"tool":"insert_image","href":"data:image/png;base64,AAA"}');
  assert.equal(result.ok, true);
  assert.equal(result.call.tool, "insert_image");
  assert.equal(result.call.points, undefined);
  assert.equal(result.call.href, undefined, "unknown fields must not be forwarded");
}

// Thinking models whose chat template opens <think> in the prompt reply with
// only the closing tag. The trace is still captured, and its braces never
// become the tool call.
{
  const reply = 'The arch could be a lantern {maybe}.\n</think>\n{"tool":"draw_stroke","points":[[1,2],[3,4]]}';
  assert.deepEqual(extractReasoning(reply).thinkBlocks, ["The arch could be a lantern {maybe}."]);
  assert.equal(stripThinkTags(reply), '{"tool":"draw_stroke","points":[[1,2],[3,4]]}');
  assert.equal(extractToolCall(stripThinkTags(reply)).ok, true);
  // A complete span is left as it is.
  assert.deepEqual(extractReasoning("<think>a</think> b").thinkBlocks, ["a"]);
  assert.equal(stripThinkTags("no thinking here"), "no thinking here");
}

console.log("audra driver parser integrity tests passed");
