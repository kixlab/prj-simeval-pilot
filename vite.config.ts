import { SpeechClient } from "@google-cloud/speech";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { audraTaskPlugin } from "./src/audra/server/plugin";
import { taskItemsPlugin } from "./src/tasks/server/plugin";
import { timedAgentDecisionSchema } from "./src/agent/timedAgentProtocol";
import { agentPromptVersion } from "./src/data/versionInfo";

const agentSystemPrompt = `You are an AI creative agent operating Excalidraw in a timed research session. Work as a reflective visual designer responding to the assigned task and the artifact's current visible state.

You are not constrained to one tool call per decision. Return every free_draw or add_elements call that is useful for the current coherent design move in toolCalls, in execution order. There is no fixed turn count and no artificial maximum number of tool calls or paths. Use the available time to generate and refine the artifact. Do not add steps merely to consume time.

The only available tools are free_draw and add_elements. Use free_draw for every visual mark, including geometric, angular, organic, expressive, or irregular strokes. A free_draw call may contain multiple paths, and each path must contain at least two points. Use add_elements only to add text labels that make the drawing understandable; its elements array accepts text elements only. Keep labels concise and place them near the visual feature they explain. You cannot clear, move, resize, rotate, bind, delete, replace, add predefined shapes, or request observation tools. The current screenshot and scene summary are supplied automatically before each decision. Give every path and text element a task-specific semanticRole and use groupId when several items belong to one visual idea.

Make every stroke and text label easy to see on the white canvas. Use saturated, high-contrast colors such as #1c7ed6, #e03131, #2f9e44, #7048e8, #f08c00, #0b7285, or #1e1e1e. Do not use gray, near-white, pale, translucent, or low-contrast colors. Use strokeWidth 1 by default and increase it only when emphasis is necessary. Use opacity 100 and readable text sizes of at least 20 unless the task itself clearly requires a different visual treatment.

The request states elapsed and remaining time. Before the finalization window, never return status finish. Continue considering the artifact; if no meaningful edit is currently justified, return continue with an empty toolCalls array rather than inventing work. When finalizationWindow is true, stop broad exploration, inspect composition and task coverage, perform any necessary cleanup or final revision, and return status finish. You may include final cleanup tool calls in the same finish decision. If the artifact is already complete, finish without unnecessary calls.

agentThought and decisionRationale are concise externally observable decision summaries, not private chain-of-thought. Ground them in visible artifact evidence. Return an empty array for unused tool argument fields and neutral values for fields that do not apply.`;

const packageVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
const appCommit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const agentPromptHash = createHash("sha256").update(agentSystemPrompt).digest("hex");

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

function formatSttError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const authenticationFailure = /default credentials|unauthenticated|permission[_ ]denied|invalid service account|could not load the default credentials/i.test(message);
  return authenticationFailure
    ? `${message}. Check Google Cloud ADC or GOOGLE_APPLICATION_CREDENTIALS.`
    : message;
}

function googleSttCredentialError(keyFilename: string | undefined, allowAdc: boolean) {
  if (!keyFilename) {
    return allowAdc
      ? null
      : "Google STT credentials are not configured. Set GOOGLE_APPLICATION_CREDENTIALS to a readable absolute JSON path, or explicitly set GOOGLE_STT_ALLOW_ADC=true.";
  }
  if (!isAbsolute(keyFilename)) {
    return "GOOGLE_APPLICATION_CREDENTIALS must be an absolute path on the server.";
  }
  try {
    accessSync(keyFilename, constants.R_OK);
    return null;
  } catch {
    return "The GOOGLE_APPLICATION_CREDENTIALS file does not exist or is not readable by the Node process.";
  }
}

let speechClient: SpeechClient | null = null;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // This branch is intentionally a Free Draw + Text operation-feasibility experiment.
  const agentApiEnabled = true;

  return {
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageVersion),
      "import.meta.env.VITE_APP_COMMIT": JSON.stringify(appCommit),
      "import.meta.env.VITE_AGENT_PROMPT_VERSION": JSON.stringify(agentPromptVersion),
      "import.meta.env.VITE_AGENT_PROMPT_HASH": JSON.stringify(agentPromptHash),
      "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development")
    },
    plugins: [
      react(),
      // Incomplete-shapes task API. Independent of the Excalidraw session endpoints.
      audraTaskPlugin({ appVersion: packageVersion, appCommit }),
      // Item endpoints and agent trials for the two text tasks. Participant views only.
      taskItemsPlugin({ appVersion: packageVersion, appCommit }),
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
            const languageCode = env.GOOGLE_STT_LANGUAGE_CODE || process.env.GOOGLE_STT_LANGUAGE_CODE || "ko-KR";
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
              const allowAdc = (env.GOOGLE_STT_ALLOW_ADC || process.env.GOOGLE_STT_ALLOW_ADC) === "true";
              const credentialError = googleSttCredentialError(keyFilename, allowAdc);
              if (credentialError) {
                response.statusCode = 503;
                response.end(JSON.stringify({ success: false, languageCode, error: credentialError }));
                return;
              }
              speechClient ??= new SpeechClient(keyFilename ? { keyFilename } : undefined);
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
                languageCode,
                error: formatSttError(error)
              }));
            }
          });
        }
      }
    ],
    server: {
      allowedHosts: ["internal.kixlab.org"]
    }
  };
});
