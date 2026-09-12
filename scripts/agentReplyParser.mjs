// Task-independent reading of model replies: the reasoning trace, and the JSON
// that carries one tool call or an ordered list of them.
//
// Each task supplies a `normalize(object)` that turns one parsed call object
// into its canonical call shape. The repairs a normalizer makes are counted,
// because leniency the driver grants an agent is assistance a human
// participant does not get. The app server re-validates every call regardless.

/**
 * Pulls the model's reasoning out of one reply.
 *
 * Three channels, because open-weight servers expose thinking differently:
 *   - `reasoning_content` on the message (vLLM with --reasoning-parser, and
 *     DeepSeek-style APIs)
 *   - <think>...</think> spans inside the content (Qwen3 and friends when the
 *     parser is off, so the tags arrive verbatim)
 *   - a `thought` field the prompt asks for, which is all a non-reasoning model
 *     such as Gemma or InternVL can give
 *
 * The trace is process data about the actor, like a human think-aloud. It is
 * kept out of the task's event log and out of every scoring input.
 */
export function extractReasoning(content, message = {}) {
  const thinkBlocks = [];
  const pattern = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi;
  const text = restoreOpeningThink(content ?? "");
  let match;
  while ((match = pattern.exec(text)) != null) {
    const text = match[2].trim();
    if (text) thinkBlocks.push(text);
  }
  const reasoningContent =
    typeof message.reasoning_content === "string" && message.reasoning_content.trim()
      ? message.reasoning_content.trim()
      : typeof message.reasoning === "string" && message.reasoning.trim()
        ? message.reasoning.trim()
        : null;
  return {
    reasoningContent,
    thinkBlocks,
    // Where the trace came from, so a mixed-model dataset stays interpretable.
    channels: [
      reasoningContent ? "reasoning_content" : null,
      thinkBlocks.length > 0 ? "think_tags" : null
    ].filter(Boolean)
  };
}

/**
 * Thinking models' chat templates (Qwen3's among them) often open the <think>
 * span in the prompt, so the reply starts inside the thinking and only closes
 * it. Without the opening tag the whole trace would be lost - and its braces
 * could be read as the tool call - so the tag is restored before either step.
 */
function restoreOpeningThink(content) {
  const close = /<\/(think|thinking|reasoning)>/i.exec(content);
  if (!close) return content;
  const open = new RegExp(`<${close[1]}>`, "i").exec(content);
  return open && open.index < close.index ? content : `<${close[1]}>${content}`;
}

/** Removes think spans so they are never mistaken for the tool call itself. */
export function stripThinkTags(content) {
  return restoreOpeningThink(content ?? "").replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
}

/** Strips a code fence, then isolates the outermost JSON value of the wanted kind. */
function locateJson(text, { allowArray }) {
  const repairs = [];
  let candidate = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate);
  if (fenced) {
    candidate = fenced[1].trim();
    repairs.push("stripped_code_fence");
  }

  const objectStart = candidate.indexOf("{");
  const arrayStart = allowArray ? candidate.indexOf("[") : -1;
  const isArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  const start = isArray ? arrayStart : objectStart;
  const end = candidate.lastIndexOf(isArray ? "]" : "}");
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: allowArray ? "No JSON object or array in the reply." : "No JSON object in the reply.", repairs };
  }
  if (start > 0 || end < candidate.length - 1) repairs.push("trimmed_surrounding_prose");
  candidate = candidate.slice(start, end + 1);

  try {
    return { ok: true, value: JSON.parse(candidate), repairs };
  } catch (error) {
    return { ok: false, error: `Unparseable JSON: ${error.message}`, repairs };
  }
}

/** The prompted rationale, read from the key names models reach for. */
export function readThought(parsed, repairs) {
  const thought = parsed.thought ?? parsed.reasoning ?? parsed.rationale ?? parsed.explanation;
  const promptedThought = typeof thought === "string" && thought.trim() ? thought.trim() : null;
  if (promptedThought && parsed.thought == null) repairs.push("aliased_thought_key");
  return promptedThought;
}

/** Reads the tool name from `tool` or the aliases models use instead. */
export function readToolName(parsed, repairs) {
  const tool = parsed.tool ?? parsed.action ?? parsed.name ?? parsed.function;
  if (parsed.tool == null && tool != null) repairs.push("aliased_tool_key");
  return typeof tool === "string" ? tool.trim() : null;
}

/** The top-level JSON objects in a text, as source strings; braces inside strings are ignored. */
function topLevelObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) objects.push(text.slice(start, index + 1));
    }
  }
  return objects;
}

/**
 * Several batches in a row - `{"calls":[...]}` then another - is how models
 * most often break the one-object format when they may send many actions. The
 * intent is unambiguous, so the batches are joined in order and the repair is
 * counted. Anything else in that shape stays unreadable.
 */
function mergeCallObjects(text) {
  const sources = topLevelObjects(text.replace(/```(?:json)?/gi, ""));
  if (sources.length < 2) return null;
  const calls = [];
  let thought = null;
  for (const source of sources) {
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      return null;
    }
    const listed = value?.calls ?? value?.actions ?? value?.tool_calls;
    if (Array.isArray(listed)) calls.push(...listed);
    else if (value && (value.tool != null || value.action != null || value.name != null)) calls.push(value);
    else return null;
    thought ??= typeof value?.thought === "string" ? value.thought : null;
  }
  return { ok: true, value: thought ? { thought, calls } : { calls }, repairs: ["merged_call_batches"] };
}

/**
 * Reads exactly one tool call. A reply holding several is a failure, not a
 * choice - but the error says so plainly, because it is shown to the agent and
 * "Unexpected non-whitespace character after JSON" is not something a model
 * can act on.
 */
export function extractCall(text, normalize) {
  const located = locateJson(text, { allowArray: false });
  if (!located.ok) {
    const count = topLevelObjects(text).length;
    if (count > 1) {
      return {
        ok: false,
        code: "multiple_actions",
        error: `The reply held ${count} actions; send exactly one action per reply.`,
        repairs: located.repairs
      };
    }
    return { ok: false, error: located.error, repairs: located.repairs };
  }
  if (Array.isArray(located.value?.calls)) {
    return {
      ok: false,
      code: "multiple_actions",
      error: `The reply held a list of ${located.value.calls.length} actions; send exactly one action per reply.`,
      repairs: located.repairs
    };
  }
  const normalized = normalize(located.value);
  return { ...normalized, repairs: [...located.repairs, ...normalized.repairs] };
}

/**
 * Reads an ordered list of tool calls: `{"calls": [...]}`, or the looser shapes
 * models produce instead - a bare array, or one call object on its own.
 *
 * Parsing stops at the first call that cannot be read, and only the calls before
 * it are returned. That mirrors execution, which stops at the first rejected
 * call, so the driver never runs an action that came after a broken one.
 */
export function extractCallBatch(text, normalize) {
  let located = locateJson(text, { allowArray: true });
  if (!located.ok) {
    const merged = mergeCallObjects(text);
    if (!merged) return { ok: false, error: located.error, repairs: located.repairs };
    located = merged;
  }
  const repairs = [...located.repairs];
  const value = located.value;

  let rawCalls;
  let promptedThought = null;
  if (Array.isArray(value)) {
    rawCalls = value;
    repairs.push("bare_call_array");
  } else if (value && typeof value === "object") {
    const listed = value.calls ?? value.actions ?? value.tool_calls;
    if (Array.isArray(listed)) {
      rawCalls = listed;
      if (value.calls == null) repairs.push("aliased_calls_key");
      promptedThought = readThought(value, repairs);
    } else if (value.tool != null || value.action != null || value.name != null || value.function != null) {
      rawCalls = [value];
      repairs.push("wrapped_single_call");
    }
  }
  if (!rawCalls) return { ok: false, error: "Reply has no calls array.", repairs };
  if (rawCalls.length === 0) return { ok: false, error: "The calls array is empty.", repairs };

  const calls = [];
  const callThoughts = [];
  let invalidCall = null;
  for (let index = 0; index < rawCalls.length; index += 1) {
    const normalized = normalize(rawCalls[index]);
    repairs.push(...normalized.repairs);
    if (!normalized.ok) {
      invalidCall = { index, error: normalized.error };
      break;
    }
    calls.push(normalized.call);
    callThoughts.push(normalized.promptedThought ?? null);
  }
  if (calls.length === 0) {
    return { ok: false, error: `Call 0 is unreadable: ${invalidCall.error}`, repairs };
  }
  return {
    ok: true,
    calls,
    repairs,
    promptedThought,
    callThoughts,
    invalidCall,
    // Calls the model wrote but the driver will not run, because an earlier one was unreadable.
    unreadCallCount: invalidCall ? rawCalls.length - invalidCall.index : 0
  };
}

/**
 * A normalizer for tasks whose calls are flat JSON arguments (MacGyver, CS4).
 *
 * `toolFields` maps each tool to its argument fields and their kind. Only those
 * fields are forwarded, so a smuggled field never reaches the server; an unknown
 * tool passes through by name and is rejected there. Missing or out-of-range
 * arguments are left for the server to reject, so agent and human input hit the
 * same validation.
 */
export function makeFlatCallNormalizer(toolFields, { aliases = {} } = {}) {
  return parsed => {
    const repairs = [];
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Reply was not an object.", repairs };
    }
    const tool = readToolName(parsed, repairs);
    if (!tool) return { ok: false, error: "Missing tool name.", repairs };
    const promptedThought = readThought(parsed, repairs);
    const call = { tool };
    const fields = toolFields[tool];
    if (!fields) return { ok: true, call, repairs, promptedThought };

    const nested = parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments);
    const source = nested ? { ...parsed, ...parsed.arguments } : parsed;
    for (const [field, kind] of Object.entries(fields)) {
      let value = source[field];
      if (value == null) {
        for (const alias of aliases[field] ?? []) {
          if (source[alias] != null) {
            value = source[alias];
            repairs.push(`aliased_${field}_key`);
            break;
          }
        }
      }
      if (value == null) continue;
      if (kind === "integer" && typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) {
        value = Number(value);
        repairs.push("coerced_numeric_string");
      }
      if (kind === "boolean" && (value === "true" || value === "false")) {
        value = value === "true";
        repairs.push("coerced_boolean_string");
      }
      call[field] = value;
    }
    return { ok: true, call, repairs, promptedThought };
  };
}
