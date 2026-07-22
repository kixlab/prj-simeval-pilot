# SimEval Drawing Pilot

SimEval Drawing Pilot is an Excalidraw-based research application for collecting and comparing human and AI-agent creative drawing processes. Human and agent sessions use the same tasks, seeds, canvas, artifact-action schema, snapshots, and final export format while retaining actor-specific process traces.

The application exports `simeval-drawing-session-v4` ZIP archives containing session JSON, selected snapshot PNGs, and optional WebM think-aloud audio.

## Features

- Four creativity tasks with manual or randomized seed assignment
- Human element/property-level mutation logging on every Excalidraw `onChange`
- Backward-compatible human artifact actions grouped after 700 ms of inactivity
- Human audio think-aloud capture with independent, approximately 10-second WebM/Opus STT chunks
- Google Cloud Speech-to-Text transcription with failure metadata preserved
- Timed autonomous drawing agent using the OpenAI Responses API
- Structured agent decisions containing one or more sequential tool calls
- Agent batch interruption and re-observation after a tool failure
- Initial, periodic, action, phase-boundary, and final scene snapshots
- Mouse, pen, and touch modality logging
- Human-readable ZIP export with session JSON, selected snapshot PNGs, and optional raw audio

## Requirements

- Node.js 20 or later
- npm
- A modern browser with Excalidraw and `MediaRecorder` support
- HTTPS or localhost when microphone access is required
- Optional Google Cloud credentials for speech transcription
- Optional OpenAI API credentials for agent sessions

## Installation

```bash
npm install
cp .env.example .env.local
npm run dev
```

The development server listens on all interfaces and uses port `5173` by default:

```text
http://localhost:5173
```

Vite reads `.env.local` when the server starts. Restart `npm run dev` after changing environment variables. A browser hard refresh may also be necessary after changing `VITE_ENABLE_AGENT_MODE`.

## Environment configuration

Create `.env.local` from `.env.example`. The file is ignored by Git and must not be committed.

```env
# OpenAI agent runtime
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.1-mini
VITE_ENABLE_AGENT_MODE=false
ENABLE_AGENT_API=false

# Google Cloud Speech-to-Text
GOOGLE_APPLICATION_CREDENTIALS=
GOOGLE_STT_LANGUAGE_CODE=ko-KR
GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES=en-US
GOOGLE_STT_MODEL=latest_long
```

### Environment variable reference

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Agent mode only | None | Server-side credential used by `/api/agent-decision`. Never prefix it with `VITE_`. |
| `OPENAI_MODEL` | No | `gpt-5.1-mini` | OpenAI model used for structured agent decisions. |
| `VITE_ENABLE_AGENT_MODE` | No | `false` | Client-side build flag that shows the Human/Agent picker and starts agent sessions. |
| `ENABLE_AGENT_API` | No | `false` | Server-side flag for the agent decision endpoint. |
| `GOOGLE_APPLICATION_CREDENTIALS` | STT only | Google ADC lookup | Absolute path to a Google Cloud service-account JSON file. |
| `GOOGLE_STT_LANGUAGE_CODE` | No | `ko-KR` | Primary recognition language. |
| `GOOGLE_STT_ALTERNATIVE_LANGUAGE_CODES` | No | `en-US` | Comma-separated alternative recognition languages. |
| `GOOGLE_STT_MODEL` | No | `latest_long` | Google Speech-to-Text recognition model. |

`VITE_ENABLE_AGENT_MODE` is exposed to browser code because all `VITE_` variables are client-visible. API keys and credential contents must remain server-side.

The current middleware enables `/api/agent-decision` when either `ENABLE_AGENT_API` or `VITE_ENABLE_AGENT_MODE` is `true`. For predictable deployments, set both flags to the same value.

### Human-only participant deployment

Use the following configuration for participant-facing human sessions:

```env
VITE_ENABLE_AGENT_MODE=false
ENABLE_AGENT_API=false
```

The application opens directly in Human setup mode, and `/api/agent-decision` returns `403`. Drawing, logging, raw audio recording, and ZIP export remain available without OpenAI credentials.

### Agent research and development

Enable both flags and provide an API key:

```env
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-5.1-mini
VITE_ENABLE_AGENT_MODE=true
ENABLE_AGENT_API=true
```

The model value is configurable; use the exact model selected for an experiment and record configuration changes as part of the research protocol.

### Google Speech-to-Text

Set `GOOGLE_APPLICATION_CREDENTIALS` to an absolute file path accessible to the Node process:

```env
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

Without valid Google credentials, human drawing and complete WebM audio export still work. Each affected transcription chunk is retained with `transcriptionStatus: "failed"`, its byte size, MIME type, chunk index, language metadata when available, and the actual error message.

## Tasks

1. **Free Creation** — baseline creative generation on an empty canvas
2. **Open-ended Interpretation** — reinterpretation of pre-positioned visual seed elements
3. **Conceptual Synthesis** — integration of two concepts so that one changes the function or meaning of the other
4. **Adaptive Reframing** — revision of a Phase 1 artifact after an unexpected Phase 2 constraint is revealed

Open-ended Interpretation seed elements carry stable seed metadata. Actions that affect those elements include the relevant IDs in `seedElementImpacts`.

## Human sessions

Human sessions require only a participant ID. The application collects:

- `elementMutations`: synchronous element/property-level changes from every eligible Excalidraw callback
- `actions`: 700 ms idle-flush artifact summaries retained for backward compatibility
- `thinkAloudChunks`: pending/completed/empty/failed STT records bound to standalone WebM chunks
- `thinkAloudNotes`: supported non-audio task responses
- `pointerModalities`: observed mouse, pen, or touch input
- full scene snapshots and the final artifact

Think-aloud recording is optional and independent of drawing capture. A continuous recorder creates the downloadable full-session WebM, while fresh recorders create independently decodable STT chunks. Session completion waits for the final partial chunk and all pending transcription requests.

## Agent sessions

Agent sessions do not require a participant ID. The default time budget is five minutes, configurable from 1 to 30 minutes. There is no fixed turn limit. Finalization begins with 30 seconds remaining, and early `finish` decisions are deferred until that window.

Each decision receives:

- the current task instruction
- elapsed and remaining time
- the current symbolic scene summary
- a PNG screenshot when the scene is non-empty
- recent trajectory entries

The OpenAI response uses a strict JSON schema and may contain multiple tool calls. Calls execute synchronously in array order. If a call throws or returns `success: false`:

1. the failed call is logged immediately;
2. remaining calls are logged as `skipped` and are not executed;
3. skipped calls do not create artifact actions;
4. the next decision cycle captures a fresh scene summary and screenshot before replanning.

Agent trajectory entries include decision and tool ordering metadata such as `decisionNumber`, `toolCallIndex`, `toolCallCount`, `toolExecutionId`, `executionStatus`, and execution timing. Mutating artifact actions retain the linking decision/tool metadata when a scene diff is produced.

## Agent tools

The timed agent can use:

- `clear_canvas`
- `create_scene`
- `get_scene`
- `add_elements`
- `update_elements`
- `delete_elements`
- `move_elements`
- `rotate_elements`
- `bind_elements`
- `replace_scene`
- `sketch_path`
- `free_draw`
- `get_scene_summary`

`rotate_elements` uses absolute clockwise degrees. `bind_elements` connects an existing arrow's start and end to existing bindable shapes; a `null` endpoint removes that binding.

The browser also exposes `window.simevalAgentApi` when agent mode is enabled:

```js
const agent = window.simevalAgentApi;

agent.addShape("rectangle", 100, 100, 240, 120, {
  backgroundColor: "#ffd43b",
  semanticRole: "main_device"
});

agent.addLine([[0, 0], [30, 20], [80, 10]], {
  freeDraw: true,
  strokeColor: "#1971c2"
});

agent.addText(130, 130, "Concept label");
agent.submitThinkAloud("I am connecting the two visual ideas.");
```

Manual browser calls and autonomous execution use the same instrumented Excalidraw tool layer.

## Export format

Completed sessions download one archive named like:

`simeval__participant-p001__task-free_creation__seed-daily_object__20260722T123456Z__abcd1234.zip`

The archive has a matching root directory containing `session.json`, `README.txt`, selected `screenshots/*.png`, and `audio/think-aloud.webm` when audio is available. Snapshot PNGs are rendered sequentially only during export; periodic snapshots remain scene JSON only to limit archive size.

The JSON schema version is `simeval-drawing-session-v4`. Important top-level fields include:

- `session`
- `task`
- `phaseTransitions`
- `actions`
- `elementMutations`
- `thinkAloudChunks`
- `thinkAloudNotes`
- `rationaleRecords`
- `agentTrajectory`
- `pointerModalities`
- `snapshots`
- `outcomeEvaluation`
- `validationErrors`
- `finalArtifact`

Think-aloud chunks are sorted by sequence before export, and duplicate sequences are detected separately. Validation errors are stored in `validationErrors`; they do not block the ZIP download.

See [docs/data-format.md](docs/data-format.md) for field-level behavior and [docs/agent_performance_discussion_context.md](docs/agent_performance_discussion_context.md) for the current agent architecture and research discussion context.

## Architecture

```text
src/App.tsx                         Session orchestration, UI, recording, and export
src/data/tasks.ts                  Tasks, constructs, instructions, and seeds
src/data/sessionTypes.ts           Export and session types
src/logging/elementMutations.ts    Human element/property mutation diffing
src/logging/artifactActions.ts     Shared human/agent artifact-action logging
src/agent/timedAgent.ts            Timed observation-decision-execution loop
src/agent/timedAgentProtocol.ts    Strict structured decision schema
src/agent/tools.ts                 Excalidraw agent tools and scene summaries
vite.config.ts                     Vite middleware for OpenAI and Google STT
scripts/                           Integrity and regression tests
```

Both API routes currently live in Vite development middleware. A static `dist/` deployment alone does not provide `/api/agent-decision` or `/api/google-stt-transcribe`; production hosting must provide an equivalent Node/serverless backend or run the Vite server in the intended research environment.

`vite.config.ts` currently allows the host `internal.kixlab.org` for the internal deployment route.

## Scripts

```bash
npm run dev                    # Start Vite on 0.0.0.0
npm run typecheck              # Run TypeScript checks
npm run test:think-aloud       # Validate audio/STT chunk integrity
npm run test:element-mutations # Validate Human element mutation ordering
npm run test:data-collection   # Validate ZIP, rationale timing, and collection metadata
npm run test:agent-batch       # Validate sequential Agent batch failure handling
npm run build                  # Typecheck and create the production bundle
```

Recommended pre-commit verification:

```bash
npm run test:think-aloud
npm run test:element-mutations
npm run test:agent-batch
npm run typecheck
npm run build
```

## Tablet and touch input

The interface supports mouse, touch, and pen input without disabling Excalidraw's native interaction behavior. On narrow screens, the task panel moves above the canvas. Observed pointer modalities are detected and stored automatically.

## Security and data handling

- Never commit `.env.local`, API keys, service-account JSON files, or participant exports.
- Keep `OPENAI_API_KEY` and Google credentials on the server.
- Treat exported audio, transcripts, participant identifiers, and drawing traces as research data.
- Use HTTPS for remote microphone access.
- Verify organization access controls before moving the repository or sharing exported sessions.
