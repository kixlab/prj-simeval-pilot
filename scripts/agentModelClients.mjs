// Model providers for the agent driver.
//
//   mock       canned replies from the task adapter, verifies the loop with no model
//   local      any OpenAI-compatible /v1/chat/completions server (vLLM,
//              llama.cpp, LM Studio, Ollama) - open-weight models
//   anthropic  Claude through the Messages API
//   openai     OpenAI models through the Responses API
//
// Every client returns the same shape, so the strategy loop never branches on
// the provider. A call carries an image only on tasks whose observation is an
// image. What differs, and is recorded rather than hidden, is what kind of
// reasoning trace a provider can give at all:
//
//   raw      the model's own thinking text (<think> spans, reasoning_content)
//   summary  a provider-written summary of thinking the provider does not
//            release - Claude and OpenAI reasoning models
//   none     no trace channel on this reply

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { extractReasoning } from "./agentReplyParser.mjs";

export const providerNames = ["mock", "local", "anthropic", "openai"];

const providerDefaults = {
  mock: { model: () => "mock-script", maxTokens: null },
  // Thinking models spend part of the budget before the JSON appears.
  local: { model: () => "qwen3-vl-2b", maxTokens: 4096 },
  anthropic: { model: () => "claude-opus-5", maxTokens: 16000 },
  openai: { model: () => process.env.OPENAI_MODEL || "gpt-5.5", maxTokens: 16000 }
};

// Used when the driver sets no deadline (untimed runs).
const defaultRequestTimeoutMs = 600_000;

/** Fills keys from .env.local that the environment does not already set. */
export function loadEnvLocal(path = ".env.local") {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (process.env[key] == null && value !== "") process.env[key] = value;
  }
}

export function resolveProviderOptions(options) {
  if (!providerNames.includes(options.provider)) {
    throw new Error(`Unknown provider: ${options.provider}. Choose one of ${providerNames.join(", ")}.`);
  }
  const defaults = providerDefaults[options.provider];
  return {
    ...options,
    model: options.model ?? defaults.model(),
    maxTokens: options.maxTokens ?? defaults.maxTokens
  };
}

/**
 * Recorded with the run. Only what was actually sent: Claude and OpenAI
 * reasoning models reject sampling parameters, so none are claimed for them.
 */
export function decodingParametersFor(options) {
  switch (options.provider) {
    case "mock":
      return null;
    case "local":
      return { temperature: options.temperature, top_p: options.topP, max_tokens: options.maxTokens };
    case "anthropic":
      return {
        max_tokens: options.maxTokens,
        thinking: { type: "adaptive", display: "summarized" },
        effort: options.effort ?? "default",
        fallbacks: options.fallbacks
      };
    case "openai":
      return {
        max_output_tokens: options.maxTokens,
        reasoning_effort: options.effort ?? "default",
        reasoning_summary: options.reasoningSummary
      };
  }
}

export function createModelClient(options, task) {
  switch (options.provider) {
    case "mock":
      return mockClient(task.mockReplies(options.strategy));
    case "local":
      return localClient(options);
    case "anthropic":
      return anthropicClient(options);
    case "openai":
      return openaiClient(options);
    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}

function traceFrom({ reasoningContent = null, thinkBlocks = [], channels = [] }, kindWhenPresent) {
  const present = Boolean(reasoningContent) || thinkBlocks.length > 0;
  return { reasoningContent, thinkBlocks, channels, kind: present ? kindWhenPresent : "none" };
}

function localClient(options) {
  return {
    async call({ system, userText, imageBase64, timeoutMs }) {
      const content = imageBase64
        ? [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
          ]
        : userText;
      const body = {
        model: options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content }
        ],
        temperature: options.temperature,
        top_p: options.topP,
        max_tokens: options.maxTokens
      };
      if (options.seed != null && Number.isFinite(options.seed)) body.seed = options.seed;

      const headers = { "Content-Type": "application/json" };
      if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
      const startedAt = Date.now();
      const response = await fetch(options.endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs ?? defaultRequestTimeoutMs),
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Model server returned ${response.status}: ${await response.text()}`);
      const payload = await response.json();
      const choice = payload.choices?.[0] ?? {};
      const message = choice.message ?? {};
      const text = message.content ?? "";
      return {
        content: text,
        reasoning: traceFrom(extractReasoning(text, message), "raw"),
        finishReason: choice.finish_reason ?? null,
        usage: payload.usage ?? null,
        latencyMs: Date.now() - startedAt,
        servedBy: payload.model ?? options.model,
        fallbackRan: false
      };
    }
  };
}

function anthropicClient(options) {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : undefined);
  return {
    async call({ system, userText, imageBase64, timeoutMs }) {
      const content = [];
      if (imageBase64) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } });
      content.push({ type: "text", text: userText });
      const request = {
        model: options.model,
        max_tokens: options.maxTokens,
        // The raw chain of thought is never returned; "summarized" is the most
        // a Claude run can contribute to the trace. The default, "omitted",
        // would return thinking blocks with empty text.
        thinking: { type: "adaptive", display: "summarized" },
        system,
        messages: [{ role: "user", content }]
      };
      if (options.effort) request.output_config = { effort: options.effort };
      const requestOptions = { timeout: timeoutMs ?? defaultRequestTimeoutMs };

      const startedAt = Date.now();
      // A declined request is re-run on Anthropic's recommended fallback model.
      // That swaps the model mid-trial, so `servedBy` and `fallbackRan` are kept
      // on every turn; pass --fallbacks off to get the refusal instead.
      const message = options.fallbacks === "off"
        ? await client.messages.stream(request, requestOptions).finalMessage()
        : await client.beta.messages
            .stream({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, requestOptions)
            .finalMessage();

      const summaries = message.content
        .filter(block => block.type === "thinking")
        .map(block => block.thinking.trim())
        .filter(Boolean);
      return {
        content: message.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
        reasoning: traceFrom(
          { reasoningContent: summaries.join("\n\n") || null, channels: summaries.length ? ["thinking_summary"] : [] },
          "summary"
        ),
        finishReason: message.stop_reason,
        stopDetails: message.stop_details ?? null,
        usage: message.usage ?? null,
        latencyMs: Date.now() - startedAt,
        servedBy: message.model,
        fallbackRan: (message.usage?.iterations ?? []).some(entry => entry.type === "fallback_message")
      };
    }
  };
}

function openaiClient(options) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (checked --api-key, the environment, and .env.local).");
  return {
    async call({ system, userText, imageBase64, timeoutMs }) {
      const content = [{ type: "input_text", text: userText }];
      if (imageBase64) content.push({ type: "input_image", image_url: `data:image/png;base64,${imageBase64}` });
      const body = {
        model: options.model,
        input: [
          { role: "system", content: system },
          { role: "user", content }
        ],
        max_output_tokens: options.maxTokens
      };
      const reasoning = {};
      if (options.effort) reasoning.effort = options.effort;
      // Raw reasoning tokens are not released; a summary is the only trace.
      if (options.reasoningSummary !== "off") reasoning.summary = "auto";
      if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;

      const startedAt = Date.now();
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs ?? defaultRequestTimeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`OpenAI returned ${response.status}: ${payload.error?.message ?? "unknown error"}`);
      }
      const output = Array.isArray(payload.output) ? payload.output : [];
      const summaries = output
        .filter(item => item.type === "reasoning")
        .flatMap(item => (item.summary ?? []).map(part => part.text))
        .filter(text => typeof text === "string" && text.trim());
      const text = output
        .filter(item => item.type === "message")
        .flatMap(item => item.content ?? [])
        .filter(part => part.type === "output_text")
        .map(part => part.text)
        .join("\n");
      return {
        content: text,
        reasoning: traceFrom(
          { reasoningContent: summaries.join("\n\n") || null, channels: summaries.length ? ["reasoning_summary"] : [] },
          "summary"
        ),
        finishReason: payload.status === "incomplete"
          ? `incomplete:${payload.incomplete_details?.reason ?? "unknown"}`
          : payload.status ?? null,
        usage: payload.usage ?? null,
        latencyMs: Date.now() - startedAt,
        servedBy: payload.model ?? options.model,
        fallbackRan: false
      };
    }
  };
}

/**
 * Plays canned replies through the same reasoning extraction a real local model
 * gets, so a mock run exercises the whole trace path. The last reply repeats
 * once the list runs out.
 */
export function mockClient(replies) {
  let turn = 0;
  return {
    async call() {
      const content = replies[Math.min(turn, replies.length - 1)];
      turn += 1;
      return {
        content,
        reasoning: traceFrom(extractReasoning(content), "raw"),
        finishReason: "stop",
        usage: null,
        latencyMs: 0,
        servedBy: "mock-script",
        fallbackRan: false
      };
    }
  };
}
