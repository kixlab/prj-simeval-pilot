# AuDrA-style Incomplete Shapes Drawing Task

A task mode for comparing human and agent creative drawing processes on the
same stimulus, under the same allowed operations.

> **The bundled stimulus is a development fixture.** `dev-fixture-01` was drawn
> for interface development. It is **not** an official MTCI stimulus, is not
> derived from or validated against any published incomplete-shapes instrument,
> and must not be used for analysable data collection. Replace it with the
> official contour set first — see
> [audra-scoring-and-stimuli.md](audra-scoring-and-stimuli.md) for where the
> official stimuli come from and what CAP, MTCI, and AuDrA each actually are.

## Running it

```
npm run dev
# human trial
open 'http://localhost:5173/?mode=audra-incomplete-shapes'
```

`/` without a mode opens the task launcher, from which a participant picks
this task; `?mode=audra-incomplete-shapes` remains the direct link and is what
the agent host URL uses. The Excalidraw session app now lives at
`?mode=excalidraw-session`. Every mode is a separate page and shares no canvas,
toolbar, or scene state with the others. See [task-launcher.md](task-launcher.md).

## Architecture of the shared action reducer

Everything that can change a canvas is a **canonical event**. Human pointer
input and agent tool calls both compile to the same event shapes and are
applied by the same pure reducer. Neither path can write canvas state any other
way.

```
human pointer ──> humanInput.strokeDraft ──┐
                                           ├──> reducer.applyEvent ──> AudraTrialState
agent tool call ─> agentTools.toEventDraft ┘         (validate, index, append)
                                                              │
                                                    reducer.deriveScene
                                                              │
                                                        render.renderTrial
                                                    [white | starter image | strokes]
```

State *is* the event log. The visible scene is derived by folding the non-undone
events in order, so any state is reproducible from the log alone. That is what
makes replay and the export bundle deterministic.

| Module | Role |
| --- | --- |
| `src/audra/artboard.ts` | Canonical artboard size, ink colour, width and length limits |
| `src/audra/events.ts` | Canonical event schema and JSONL helpers |
| `src/audra/reducer.ts` | Validation, event indexing, undo, scene derivation, `replay` |
| `src/audra/eraser.ts` | Geometry-based eraser |
| `src/audra/geometry.ts` | Polyline densification and distance helpers |
| `src/audra/render.ts` | Layered browser canvas renderer (human UI) |
| `src/audra/svg.ts` | Canonical scene → SVG, the shared geometry definition |
| `src/audra/actions.ts` | Normalized action chunks and process summary |
| `src/audra/thinkAloud.ts` | Human think-aloud types, summary, validation |
| `src/audra/useThinkAloud.ts` | Microphone capture and chunked transcription |
| `src/audra/export.ts` | Bundle builder: events, actions, SVG, session, replay |
| `src/audra/replayRuntime.ts` | Replay runtime inlined into `replay.html` |
| `src/audra/stimulus.ts` | `Stimulus` interface and registry |
| `src/audra/humanInput.ts` | Pointer samples → canonical events |
| `src/audra/agentTools.ts` | Agent tool surface → canonical events |
| `src/audra/server/renderer.ts` | Headless SVG → PNG rasterizer (resvg) |
| `src/audra/server/png.ts` | RGB PNG encoder, required by AuDrA's preprocessing |
| `src/audra/server/exportBundle.ts` | Writes a bundle to disk; replays posted logs |
| `src/audra/server/` | Authoritative trial registry and HTTP endpoints |
| `scripts/agentDriver.mjs` | The shared agent driver (`--task audra`); see [agent-strategies.md](agent-strategies.md) |
| `scripts/agentTasks/audra.mjs` | This task's prompt, tools, and mock trajectory for the driver |
| `scripts/audraToolCallParser.mjs` | Tolerant reader for small-model replies |

### Coordinate system

A fixed **1024 × 1024** artboard, origin top-left, x right, y down, for every
trial and both actors. The displayed canvas is only a scaled window onto it;
`humanInput.toArtboardPoint` is the single place display pixels become canonical
units.

### Undo

`undo` reverts the most recent non-undone `draw_stroke` or `erase_stroke`.
Description edits and submission are not undoable. Because undo appends an
event and marks a target index rather than mutating a stack, the log stays a
complete record and replay reproduces the undo exactly. Both actors use this one
implementation.

### Eraser

The eraser is a swept disc along a polyline. Stroke geometry inside the swept
area is removed and the surviving parts remain as separate fragments
(`s1` → `s1~0`, `s1~1`). It is deliberately **not** delete-by-id: an agent
cannot remove a mark it could not reach with a pointer path, and it never
paints white pixels, so starter contours survive an eraser pass across them.

## Immutability of starter contours

The stimulus is referenced only as an **opaque background asset**. No module
holds contour geometry, so there is no code path by which a starter contour
could be hit-tested, selected, erased, moved, or transformed — for either actor.
Immutability is structural rather than a convention or a `locked` flag.

The renderer redraws the background from the asset on every frame, and it is
never derived from trial state, so no sequence of events can alter it.

## Human versus agent interfaces

| | Human | Agent |
| --- | --- | --- |
| Input | Pointer (mouse / pen / touch), coalesced samples | `draw_stroke` / `erase_stroke` polylines |
| Sees | The rendered canvas | A PNG of the same rendered canvas |
| Tools | Pencil, Eraser, Undo Last, description, Submit | The six tools below |
| Validation | `reducer.applyEvent` | `parseAgentToolCall` → `reducer.applyEvent` |

Colours, shape libraries, text boxes, image import, copy/paste, selection and
transform tools, layers, templates, and AI assistance are absent from both.

### Agent tool API

```
observe_canvas()                  → rendered PNG + visible status only
draw_stroke(points, width?)
erase_stroke(points, width?)
undo_last()
set_description(text)
submit_task()
```

`agentToolDefinitions` in `agentTools.ts` is provider-neutral; a local
open-weight server, a hosted API, or a scripted harness each translate it into
their own function schema.

`parseAgentToolCall` rejects unknown tools **and unknown argument fields**, so
an attempt to pass `svg`, `elements`, `href`, `strokeId`, or an `elementId` on a
point fails loudly rather than being silently dropped. Range and width checks
are left to the reducer so agent and human input hit byte-identical validation.

`observe_canvas` returns an image and the status a human could read off the
screen (`canUndo`, `hasDrawingAttempt`, `description`, `submitted`) — never
event counts, element ids, or scene structure.

### HTTP endpoints

Two disjoint groups:

**Agent-facing** — tool calls and rendered observations only:

```
POST /api/audra/trial      {actorId, stimulusId?, agentRun?} → {trialId, contract, renderToken, hostUrl}
POST /api/audra/tool       {trialId, call, isRetry?}          → {revision, status, image}
GET  /api/audra/contract?trialId=
```

**Host-only** — gated by a render token issued once at trial creation and never
returned in a tool response:

```
GET  /api/audra/_host/state?trialId=&token=
POST /api/audra/_host/frame  {trialId, token, revision, base64}
GET  /api/audra/_host/run?trialId=&token=
```

The server holds authoritative state, re-validates every tool call, and renders
observations itself with resvg. **No browser is required for an agent trial**,
which is what makes batch runs across several models practical. Every accepted
call returns the canvas as it now stands, so an agent never acts on a stale
observation.

Opening `hostUrl` in a browser is optional and gives a live view of a running
agent trial; it is no longer part of the render path.

### Two rasterizers, one geometry

`svg.ts` produces the canonical vector definition of a trial. The human UI
rasterizes it through the browser canvas because it needs interactive redraw;
the server rasterizes the same markup with resvg. The geometry, stroke order,
widths, and layer order are identical by construction — only the rasterizing
engine differs, which shows up as sub-pixel antialiasing differences. See the
fairness limitations below.

**The `_host/*` endpoints carry the raw event log and must not be reachable from
the agent's network namespace.** The render token is the control; network
isolation is the backstop.

### Running an agent

This task runs under the shared agent driver. The action strategies, the
five-minute limit, the providers and their trace kinds, and what each run
records are described once, for every task, in
[agent-strategies.md](agent-strategies.md).

```bash
npm run dev                       # terminal 1

# canned replies - verifies the whole loop with no model
node scripts/agentDriver.mjs --task audra --provider mock --strategy multi --actor-id mock-1

# a local open-weight model behind any OpenAI-compatible server
node scripts/agentDriver.mjs --task audra \
  --provider local --strategy single \
  --endpoint http://127.0.0.1:8000/v1/chat/completions \
  --model Qwen3-VL-2B-Thinking \
  --actor-id qwen3vl2b-run1 \
  --temperature 0.7 --top-p 0.9 --seed 1234 \
  --observation-size 768 \
  --out runs/

# every strategy against one model, interleaved, with a summary table
npm run agent:sweep -- --task audra --provider openai --repeats 2
```

The driver is a client like any other: the app server validates everything it
sends. `--provider mock` replaces the model with a fixed drawing, cut into
replies to fit each strategy, which is the fastest way to check the loop after
a change.

Small vision models rarely emit clean JSON, so
`scripts/audraToolCallParser.mjs` accepts fenced blocks, surrounding prose, key
aliases (`action`/`name` for `tool`, `description` for `text`), `[x, y]` pairs
as well as `{x, y}` objects, and numeric strings. It never widens the tool
surface: an unrecognised tool name is passed through untouched and rejected by
the server. **Every repair is counted and reported as `driverAssistance` in the
run log**, because leniency the driver grants an agent is help a human
participant does not get.

Each turn sends the system prompt, one image of the current canvas, a short text
history of previous actions, and the agent's currently recorded answer to
"What did you draw?" — not an accumulating stack of images, which 2B-class
models handle badly. Echoing the answer back mirrors the participant's answer
box, which stays visible on screen for the whole trial.

### The final answer

The prompt requires the run to finish in a fixed order: `set_description` once,
with a single final answer naming the whole picture, then `submit_task`. The run
log reports `finalAnswer.recorded` and `finalAnswer.setDescriptionCalls`, and
the driver prints a warning when a trial is submitted with no answer.

This is prompt-level only. The reducer accepts a submission with an empty
description — the sole submission guard is that a drawing attempt exists — so
small models will sometimes skip the answer. Check `finalAnswer.recorded` before
treating a run as complete, or make the description a hard submission
requirement in the reducer if the protocol needs one.

### Run metadata

Model, checkpoint, decoding parameters, seed, driver, tool-call count, accepted
and rejected counts, observation count, retries, and wall-clock time are kept in
the trial registry and served by `_host/run`, deliberately **separate from the
shared canvas event log**. Rejections are retained with their code and message.

## Event schema

```jsonc
{
  "sessionId": "session-…", "trialId": "trial-…", "stimulusId": "dev-fixture-01",
  "actorType": "human" | "agent", "actorId": "p001",
  "eventIndex": 0,          // assigned by the reducer, never by the actor
  "timestampMs": 1240,      // milliseconds since trial start
  "eventType": "draw_stroke" | "erase_stroke" | "undo" | "submit" | "description_update",
  "payload": {
    "tool": "pencil" | "eraser",
    "strokeId": "human-3",
    "width": 3,
    "points": [{ "x": 200, "y": 200, "tMs": 1240, "pressure": 0.42 }],
    "description": "a lantern over water"
  }
}
```

Human strokes carry raw pointer samples including coalesced ones, with `tMs` per
sample and `pressure` only where the device genuinely reports it. Agent
polylines are recorded in the same coordinate space, without fabricated timing
or pressure.

## Human UI rules

- Instructions are shown before the trial begins.
- During the trial only Pencil, Eraser, Undo Last, the description field, and
  Submit are present.
- Submit opens an explicit confirmation before the trial ends.
- The trial is timed like an agent's: the limit comes from
  `src/tasks/taskTiming.json` (5 minutes, Submit open for the final minute), and
  the clock starts at Start. A countdown stays on screen. When time runs out the
  canvas locks, a stroke in progress is cut off, a typed answer is committed, and
  the drawing is exported as it stands - nothing is submitted on the
  participant's behalf. `?timeLimitSec=` / `?finalizeWindowSec=` override one
  session; `session.json` records the `protocol` block, including whether the
  timing was overridden and whether the trial ended by `submitted` or
  `time_limit`.
- Submission is refused without at least one visible mark. This rule is
  enforced in the reducer (`no_drawing_attempt`) and the refusal is recorded, so
  it is available as a behavioural signal rather than only a UI guard.
- After `submit`, the reducer rejects every further event, so nothing can alter
  the drawing afterwards. There is no auto-save.

## Adding the official starter-contour dataset

1. Put each contour asset in `public/audra/stimuli/`. SVG or PNG, exactly
   1024 × 1024, white background, near-black contours at the same stroke weight
   as the pencil (`#111111`, width 3) so the contours carry no colour, weight,
   or label cue.
2. Register it:

```ts
registerStimulus({
  stimulusId: "cap-03",
  version: "1.0.0",
  source: "official",
  backgroundAsset: "/audra/stimuli/cap-03.svg",
  metadata: { instrument: "CAP", plate: 3 }
});
```

3. Leave `developmentStimulus` registered or remove it; `source` distinguishes
   the two in every export, and the human instruction screen shows a development
   notice whenever `source === "development"`.

No other module needs to change: nothing downstream knows contour geometry.

## Known fairness limitations

These are real and should be reported alongside any comparison.

- **Motor channel.** Humans produce continuous pointer traces; agents emit
  explicit coordinate polylines. Equivalence is claimed for *visible
  information, allowed operations, state transitions, and output constraints* —
  not for motor behaviour. An agent cannot express stroke dynamics, and a human
  cannot specify an exact coordinate.
- **Timing.** Human `tMs` reflects real gesture time; agent timestamps reflect
  when a tool call arrived. Human and agent process durations are not directly
  comparable.
- **Pressure.** Recorded for humans only where the device reports it; never
  synthesised for agents.
- **Observation cost.** A human sees the canvas continuously; an agent must
  spend a tool call on `observe_canvas`. The observation count is logged so this
  asymmetry is measurable rather than hidden.
- **Rasterization.** Humans see a browser-canvas rasterization; agents see a
  resvg rasterization of the same canonical SVG. Geometry is identical;
  antialiasing is not. Scoring inputs should be produced by one engine for the
  whole dataset.
- **Driver leniency.** The tolerant reply parser gives agents retries and
  repairs that a human's pointer does not need. `driverAssistance` and the
  server's `rejections` list quantify it; report both.
- **Trace elicitation.** Humans are asked to speak; agents are asked for a
  `thought` field. Both are prompted self-reports produced while acting, but
  they are not the same instrument, and neither is a record of internal
  process.
- **Prompt scaffolding.** Agents receive the coordinate system and an output
  format in text. This is the information a human gets from simply seeing the
  canvas, but it is not the *same* information, and prompt wording is a real
  experimental variable.
- **Endpoint isolation.** The `_host/*` endpoints are protected by a render
  token, not by authentication. In a deployment where the agent driver shares
  the app's network namespace, that isolation must be enforced at the network
  layer.

## Tests

```
npm run test:audra          # canonical layer
npm run test:audra-driver   # tolerant reply parser
npm run test:agent-strategies  # one-shot / single / multi protocols, every task
npm run test:audra-export   # bundle contents and determinism
npm run test:audra-scoring-image  # RGB scoring PNG
```

`scripts/audraCanonicalIntegrity.test.mjs` covers: human and agent dispatch of
the same actions producing identical geometry and event ordering; replay
determinism; undo semantics and reach; the eraser splitting rather than
deleting; starter contours being unreachable from state; rejection of
unsupported tools and smuggled fields; bounds, width, and submission-guard
parity across actors; and immutability after submission.

`scripts/audraDriverParserIntegrity.test.mjs` covers the reply parser against
the shapes small models actually emit, including the cases that must stay
failures — a reply with no JSON, empty or non-numeric points, and values like
`null`, `true`, or `""` that plain `Number()` would silently turn into `0`.

`scripts/audraExportIntegrity.test.mjs` covers export determinism, event-log
round-tripping, human and agent runs of the same actions exporting an identical
canvas, the scoring image carrying no text/actor/task leakage, `session.json`
recording the actor without it reaching the image, action-chunk correctness
including undo attribution, and `replay.html` surviving a description that tries
to close its own script tag.

TypeScript modules are bundled for the test with `scripts/loadTsBundle.mjs`
(esbuild), because the audra modules import each other at runtime rather than
type-only.

## Reasoning trace

The model's reasoning is the point of an agent run, so the driver asks for it
and captures it from every channel an open-weight server might use:

| Channel | Where it comes from |
| --- | --- |
| `reasoning_content` | vLLM with `--reasoning-parser`, DeepSeek-style APIs |
| `<think>…</think>` | Qwen3 and similar when the reasoning parser is off |
| `thought` | A field the prompt requests; the only channel a non-reasoning model such as Gemma or InternVL has |

Think spans are stripped before the tool call is read, so a stray brace inside
reasoning can never be parsed as the action.

Each model reply is written to `<trialId>.reasoning.jsonl` as one record,
whatever the strategy. The calls it held and the revision range they moved the
canvas through tie the trace to the marks it was about; call geometry stays in
the run log and the event log.

```jsonc
{
  "trialId": "trial-…", "actorType": "agent", "actorId": "qwen3vl2b-multi-r1",
  "provider": "local", "model": "Qwen3-VL-2B-Thinking", "servedBy": "Qwen3-VL-2B-Thinking",
  "fallbackRan": false, "strategy": "multi", "turn": 3,
  "revisionBefore": 4, "revisionAfter": 6,
  "calls": [
    { "index": 0, "tool": "draw_stroke", "pointCount": 9, "status": "accepted", "revision": 5 },
    { "index": 1, "tool": "draw_stroke", "pointCount": 4, "status": "accepted", "revision": 6 },
    { "index": 2, "tool": "draw_stroke", "pointCount": 3, "status": "rejected", "code": "out_of_bounds" },
    { "index": 3, "tool": "undo_last", "pointCount": null, "status": "skipped", "skipReason": "earlier_call_rejected" }
  ],
  "parseError": null,
  "traceKind": "raw", "reasoningContent": null,
  "thinkBlocks": ["The zigzag can be a folded paper shade …"], "channels": ["think_tags"],
  "promptedThought": null,
  "finishReason": "stop", "usage": { "prompt_tokens": 1204, "completion_tokens": 388 },
  "latencyMs": 1830, "rawReply": "…"
}
```

`traceKind` is `raw` for a model's own thinking, `summary` for a hosted
provider's summary of it, and `none` when the reply carried neither.

The trace is **process data about the actor**, like a human think-aloud. It is
kept out of the canonical event log and out of every exported image, so it can
never reach a scoring pipeline.

## Human think-aloud

The human counterpart to the agent reasoning trace. Participants are asked to
think aloud; audio is captured for the whole trial and, in parallel, split into
10-second chunks that are transcribed independently through the existing
`/api/google-stt-transcribe` endpoint.

Chunks are transcribed independently so one failed request costs one chunk
rather than the whole trace, and a failure is kept with its reason and its
audio rather than dropped. Each chunk records `revisionAtStart` and
`revisionAtEnd`, which is what lets a spoken remark be aligned with the marks
it was about — the same role the agent's `revision` field plays in
`reasoning.jsonl`.

Exported as `thinkaloud.jsonl` plus `thinkaloud_audio.webm`, with a summary and
validation errors in `session.json`.

**A microphone failure never costs a participant the trial.** Permission is
requested at the instruction screen; if it is refused or unavailable, the error
is shown and the trial proceeds without audio.

### Detecting a dead microphone

`MediaRecorder` produces perfectly valid Opus from a muted input device, and
speech-to-text then returns an empty transcript — indistinguishable from a
participant who simply said nothing. A pilot trial hit exactly this: four
well-formed chunks, successful STT calls, and 32 seconds of samples that were
all exactly zero.

So the input level is measured continuously through an `AnalyserNode`:

- a live meter sits beside the recording indicator;
- after roughly three seconds with no signal the UI warns that nothing is
  reaching the microphone, while making clear the drawing is unaffected;
- each chunk stores `peakLevel`, `rmsLevel`, and `silent`, so a dead microphone
  is visible in the exported data rather than inferred;
- `validateThinkAloudChunks` reports a silent chunk as an error, and
  `npm run audra:verify` fails a bundle whose chunks are all silent.

A live microphone in a quiet room still reads a noise floor, so a peak of zero
means no signal ever arrived — never a quiet participant.

### Trace symmetry

| | Human | Agent |
| --- | --- | --- |
| Trace file | `thinkaloud.jsonl` | `reasoning.jsonl` |
| Unit | 10-second audio chunk | one turn |
| Canvas anchor | `revisionAtStart` / `revisionAtEnd` | `revision` |
| Content | transcript plus word timings | prompted thought, `reasoning_content`, think spans |
| In the event log? | No | No |
| In any exported image? | No | No |

Both traces are process data about the actor and sit beside the canonical event
log, never inside it, so neither can reach a scoring pipeline.

## Export bundle

Exports are written server-side for both actors, so a lab machine ends a
session with the files already on disk rather than in a browser download.

```
POST /api/audra/export
  agent:  {trialId, token}                       - exported from server state
  human:  {sessionId, trialId, stimulusId,       - the browser posts its log
           actorType, actorId, events, startedAt, endedAt}
```

A posted human log is **replayed through the reducer before anything is
written**. That is not a formality: it re-runs the same validation the events
originally passed, so a log that cannot be reproduced — a tampered
`eventIndex`, an out-of-bounds point — is refused rather than silently
exported.

Bundles land in `exports/<baseName>/` (override with the plugin's `exportDir`):

| File | Contents |
| --- | --- |
| `events.jsonl` | Complete ordered raw event log |
| `actions.json` | Normalized action chunks plus a process summary |
| `final_canvas.svg` | Canonical vector state; both PNGs render from this |
| `final_canvas_archival.png` | 2048 px archival raster |
| `final_canvas_score.png` | 224 px AuDrA score input |
| `description.txt` | The participant's or agent's answer |
| `session.json` | Actor, task configuration, stimulus, timing, versions, export profile, agent run metadata, think-aloud summary |
| `thinkaloud.jsonl` | Human think-aloud transcript chunks (human trials with audio) |
| `thinkaloud_audio.webm` | Archival think-aloud audio (human trials with audio) |
| `replay.html` | Self-contained deterministic replay |

### Action chunks

One record per event, enriched with process measures and the canvas state that
resulted from it: `pointCount`, `pathLengthUnits`, `boundingBox`,
`gestureDurationMs`, `meanPressure`, `sincePreviousMs`, `strokeCountAfter`,
`inkLengthAfterUnits`, plus `undone` and `undoneEventIndex` so revisions are
legible without replaying.

Fields an actor cannot supply are `null`, never filled with a plausible number.
`gestureDurationMs` and `meanPressure` are always null for agents, because a
tool call has no gesture and no pressure.

### AuDrA scoring profile

The score input is rendered **directly from the canonical SVG at 224 px**, not
downsampled from the archival PNG, so no intermediate rounding enters the
scored image. Both rasters are **3-channel RGB** PNG on white with no UI chrome,
cursor, grid, label, toolbar, or embedded metadata, and the actor identity
appears only in `session.json`. Dimensions, scaling, and preprocessing choices
are recorded in `session.json.exportProfile`.

RGB is a hard requirement, not a preference: AuDrA preprocesses with
`PIL.ImageOps.invert`, which fails on a 4-channel image. resvg renders RGBA, so
`src/audra/server/png.ts` encodes the flattened RGB PNG itself.

Stroke widths are set so a mark survives the 224 px render as solid ink — at the
original default of 3 units, no pixel in the scoring image was solid. See
[audra-scoring-and-stimuli.md](audra-scoring-and-stimuli.md) for the
measurements, AuDrA's exact preprocessing, and how to run the scorer.

### Replay

`replay.html` embeds the event log and a bundled copy of the **canonical
reducer and SVG serializer** — not a second implementation — so an exported
replay cannot drift from the reducer that produced the trial. It scrubs and
plays through every event boundary and needs no network access.

## Not yet implemented

- The official MTCI stimulus set.
