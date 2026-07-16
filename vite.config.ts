import { SpeechClient } from "@google-cloud/speech";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { timedAgentDecisionSchema } from "./src/agent/timedAgentProtocol";

const agentSystemPrompt = `You are an AI creative agent operating Excalidraw in a timed research session. Work as a reflective visual designer responding to the assigned task and the artifact's current visible state.

You are not constrained to one tool call per decision. Return every tool call that is useful for the current coherent design move in toolCalls, in execution order. There is no fixed turn count and no artificial maximum number of tool calls or elements. Use the available time to generate, inspect, revise, simplify, replace, reorganize, and refine the artifact. Do not follow a fixed phase pipeline and do not add steps merely to consume time.

Available tools are clear_canvas, create_scene, get_scene, add_elements, update_elements, delete_elements, move_elements, replace_scene, sketch_path, free_draw, and get_scene_summary. Use sketch_path for angular or geometric paths and free_draw for smooth, organic, expressive, or irregular strokes. For text inside a shape, prefer labelText and labelFontSize. Give visual elements task-specific semanticRole values. Use exact element IDs from the scene summary for updates, movement, and deletion. Avoid full-scene replacement for local revisions.

The request states elapsed and remaining time. Before the finalization window, never return status finish. Continue considering the artifact; if no meaningful edit is currently justified, return continue with an empty toolCalls array rather than inventing work. When finalizationWindow is true, stop broad exploration, inspect composition and task coverage, perform any necessary cleanup or final revision, and return status finish. You may include final cleanup tool calls in the same finish decision. If the artifact is already complete, finish without unnecessary calls.

agentThought and decisionRationale are concise externally observable decision summaries, not private chain-of-thought. Ground them in visible artifact evidence. Return an empty array for unused tool argument fields and neutral values for fields that do not apply.`;

function readRequestBody(request: import("node:http").IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function durationToSeconds(duration: unknown) {
  if (!duration || typeof duration !== "object") return 0;
  const value = duration as { seconds?: number | string; nanos?: number };
  const seconds = typeof value.seconds === "string" ? Number(value.seconds) : value.seconds ?? 0;
  return seconds + (value.nanos ?? 0) / 1_000_000_000;
}

function extractOutputText(payload: { output?: unknown }) {
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as { type?: string; text?: string };
      if (typed.type === "output_text" && typeof typed.text === "string") return typed.text;
    }
  }
  return null;
}

let speechClient: SpeechClient | null = null;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const agentApiEnabled = env.ENABLE_AGENT_API === "true" || env.VITE_ENABLE_AGENT_MODE === "true";

  return {
    plugins: [
      react(),
      {
        name: "simeval-google-stt",
        configureServer(server) {
          server.middlewares.use("/api/agent-decision", async (request, response) => {
            response.setHeader("Content-Type", "application/json");
            if (!agentApiEnabled) {
              response.statusCode = 403;
              response.end(JSON.stringify({ success: false, error: "Agent API is disabled." }));
              return;
            }
            if (request.method !== "POST") {
              response.statusCode = 405;
              response.end(JSON.stringify({ success: false, error: "POST only" }));
              return;
            }

            const apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
            if (!apiKey) {
              response.statusCode = 400;
              response.end(JSON.stringify({ success: false, error: "OPENAI_API_KEY is not configured." }));
              return;
            }

            try {
              const parsed = JSON.parse(await readRequestBody(request)) as {
                instruction?: string;
                sceneSummary?: unknown;
                screenshotDataUrl?: string;
                recentTrajectory?: unknown;
                elapsedMs?: number;
                remainingMs?: number;
                finalizationWindow?: boolean;
              };
              if (!parsed.instruction?.trim()) {
                response.statusCode = 400;
                response.end(JSON.stringify({ success: false, error: "instruction is required" }));
                return;
              }

              const userContent: Array<Record<string, unknown>> = [{
                type: "input_text",
                text: `Task instruction:\n${parsed.instruction}\n\nElapsed: ${parsed.elapsedMs ?? 0} ms\nRemaining: ${parsed.remainingMs ?? 0} ms\nFinalization window: ${Boolean(parsed.finalizationWindow)}\n\nCurrent scene:\n${JSON.stringify(parsed.sceneSummary ?? {}, null, 2)}\n\nRecent trajectory:\n${JSON.stringify(parsed.recentTrajectory ?? [], null, 2)}`
              }];
              if (parsed.screenshotDataUrl) {
                userContent.push({ type: "input_image", image_url: parsed.screenshotDataUrl });
              }

              const model = env.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.1-mini";
              const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
                method: "POST",
                signal: AbortSignal.timeout(120_000),
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model,
                  input: [
                    { role: "system", content: agentSystemPrompt },
                    { role: "user", content: userContent }
                  ],
                  text: {
                    format: {
                      type: "json_schema",
                      name: "simeval_timed_agent_decision",
                      strict: true,
                      schema: timedAgentDecisionSchema
                    }
                  }
                })
              });
              const payload = await openAIResponse.json() as { error?: { message?: string }; output?: unknown };
              if (!openAIResponse.ok) {
                response.statusCode = openAIResponse.status;
                response.end(JSON.stringify({ success: false, error: payload.error?.message || `OpenAI request failed with ${openAIResponse.status}` }));
                return;
              }
              const outputText = extractOutputText(payload);
              if (!outputText) {
                response.statusCode = 502;
                response.end(JSON.stringify({ success: false, error: "OpenAI response did not include output_text." }));
                return;
              }
              response.statusCode = 200;
              response.end(JSON.stringify({ success: true, model, decision: JSON.parse(outputText) }));
            } catch (error) {
              response.statusCode = 500;
              response.end(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
            }
          });

          server.middlewares.use("/api/google-stt-transcribe", async (request, response) => {
            response.setHeader("Content-Type", "application/json");
            if (request.method !== "POST") {
              response.statusCode = 405;
              response.end(JSON.stringify({ success: false, error: "POST only" }));
              return;
            }

            try {
              const parsed = JSON.parse(await readRequestBody(request)) as {
                audioBase64?: string;
                mimeType?: string;
                chunkIndex?: number;
                chunkStartedAtMs?: number;
                chunkEndedAtMs?: number;
              };
              if (!parsed.audioBase64?.trim()) {
                response.statusCode = 400;
                response.end(JSON.stringify({ success: false, error: "audioBase64 is required" }));
                return;
              }

              const keyFilename = env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
              speechClient ??= new SpeechClient(keyFilename ? { keyFilename } : undefined);
              const languageCode = env.GOOGLE_STT_LANGUAGE_CODE || process.env.GOOGLE_STT_LANGUAGE_CODE || "ko-KR";
              const alternativeLanguageCodes = (env.GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES || process.env.GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES || "en-US")
                .split(",")
                .map(code => code.trim())
                .filter(Boolean);

              const [sttResponse] = await speechClient.recognize({
                audio: { content: parsed.audioBase64 },
                config: {
                  encoding: "WEBM_OPUS",
                  languageCode,
                  alternativeLanguageCodes,
                  enableAutomaticPunctuation: true,
                  enableWordTimeOffsets: true,
                  model: env.GOOGLE_STT_MODEL || process.env.GOOGLE_STT_MODEL || "latest_long"
                }
              });

              const segments = (sttResponse.results ?? []).map((result, index) => {
                const alternative = result.alternatives?.[0];
                return {
                  index,
                  transcript: alternative?.transcript ?? "",
                  confidence: alternative?.confidence ?? null,
                  words: (alternative?.words ?? []).map(word => ({
                    word: word.word ?? "",
                    startSec: durationToSeconds(word.startTime),
                    endSec: durationToSeconds(word.endTime),
                    confidence: word.confidence ?? null
                  }))
                };
              });

              response.statusCode = 200;
              response.end(JSON.stringify({
                success: true,
                languageCode,
                alternativeLanguageCodes,
                mimeType: parsed.mimeType ?? "",
                chunkIndex: parsed.chunkIndex ?? 0,
                chunkStartedAtMs: parsed.chunkStartedAtMs ?? 0,
                chunkEndedAtMs: parsed.chunkEndedAtMs ?? 0,
                transcript: segments.map(segment => segment.transcript).filter(Boolean).join(" "),
                segments
              }));
            } catch (error) {
              response.statusCode = 500;
              response.end(JSON.stringify({
                success: false,
                error: error instanceof Error
                  ? `${error.message}. Check Google Cloud ADC or GOOGLE_APPLICATION_CREDENTIALS.`
                  : String(error)
              }));
            }
          });
        }
      }
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development")
    }
  };
});
