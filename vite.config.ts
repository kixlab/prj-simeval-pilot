import { SpeechClient } from "@google-cloud/speech";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

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

let speechClient: SpeechClient | null = null;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      {
        name: "simeval-google-stt",
        configureServer(server) {
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
                  confidence: alternative?.confidence ?? 0,
                  words: (alternative?.words ?? []).map(word => ({
                    word: word.word ?? "",
                    startSec: durationToSeconds(word.startTime),
                    endSec: durationToSeconds(word.endTime),
                    confidence: word.confidence ?? 0
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
