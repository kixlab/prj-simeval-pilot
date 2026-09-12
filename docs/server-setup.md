# Running the pilot on a GPU server

Everything runs from one checkout: the app server (task API, trial state,
export bundles), one model server per local model, and the agent driver.

```
app server      npm run dev                        :5173   task API, trials, exports/
model servers   vllm serve / hf_chat_server.py     :8001…  one port per model
driver          npm run agent:matrix               -       runs/, talks to both
```

## 1. Install

Node.js 20 or later and npm; Python 3.10+ for the model servers.

```bash
git clone https://github.com/kixlab/prj-simeval-pilot.git
cd prj-simeval-pilot
git checkout audra-set
npm ci
cp .env.example .env.local          # keys only matter for hosted models
```

The renderer's native binary (`@resvg/resvg-js`) ships for Linux x64 and arm64
in the lockfile; `npm ci` picks the right one.

## 2. Start the app server

```bash
tmux new -s app
npm run dev                          # 0.0.0.0:5173
```

The task and agent APIs exist only in the dev server; a static `npm run build`
does not serve them. Keep it running for the whole matrix, and **do not
`git pull` or edit anything under `src/` while runs are going**: Vite restarts
on server-code changes and drops every trial it holds (the affected runs end with
`trial_lost` and `--resume` reruns them).

## 3. Serve the models

Models downloaded from Hugging Face are served over an OpenAI-compatible
endpoint, one port per model. Pin each to a GPU with `CUDA_VISIBLE_DEVICES`.

**vLLM (preferred)** reads the same Hugging Face cache (`HF_HOME`), so nothing
is downloaded twice:

```bash
CUDA_VISIBLE_DEVICES=0 vllm serve Qwen/Qwen3-VL-2B-Thinking --port 8001 --max-model-len 32768
CUDA_VISIBLE_DEVICES=1 vllm serve <hub id or local path> --port 8002 --trust-remote-code
```

**`scripts/hf_chat_server.py`** for a model vLLM does not run. It uses
transformers' generic path (processor, chat template, `generate`):

```bash
CUDA_VISIBLE_DEVICES=2 python scripts/hf_chat_server.py --model <hub id or path> --port 8003
```

A model that needs its own loading code - as the earlier `cs4_pilot` scripts
had - plugs in through an adapter file:

```python
# my_adapter.py
def load(model_path):
    model, processor = ...            # your existing loading code

    class Adapter:
        def generate(self, messages, params):
            # messages: OpenAI-style; params: max_tokens, temperature, top_p, seed
            # images arrive as {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
            return reply_text             # verbatim, <think> spans included

    return Adapter()
```

```bash
python scripts/hf_chat_server.py --adapter my_adapter.py --model /models/AndesVL --port 8004
```

Check each one before running anything:

```bash
curl http://127.0.0.1:8001/v1/models
```

Replies must reach the driver verbatim. The thinking stays in the reply as
`<think>…</think>` text (or in `reasoning_content` if vLLM runs with
`--reasoning-parser`); both are captured, and so is a reply whose template
opened `<think>` in the prompt and only closes it.

## 4. Register the models

One entry per model in `config/agentModels.json`; keys are driver options.

```json
"internvl3_5-2b": {
  "provider": "local",
  "endpoint": "http://127.0.0.1:8002/v1/chat/completions",
  "model": "<the name the server reports in /v1/models>",
  "maxTokens": 8192,
  "temperature": 0.7,
  "topP": 0.9,
  "serve": "vllm serve <hub id> --port 8002 --trust-remote-code"
}
```

`maxTokens` bounds thinking plus answer. Small thinking models can think past
any budget; a reply cut off at the limit shows `finishReason: "length"` in the
trace and counts as a parse failure, so raise it rather than lower it.

## 5. Run

```bash
# one trial, to check a model end to end
node scripts/agentDriver.mjs --profile qwen3-vl-2b-thinking --task macgyver --strategy multi --out runs/

# the plan and its worst-case duration, without running anything
npm run agent:matrix -- --profiles qwen3-vl-2b-thinking,internvl3_5-2b --dry-run

# everything: all tasks, pilot items, all three strategies
tmux new -s matrix
npm run agent:matrix -- --profiles qwen3-vl-2b-thinking,internvl3_5-2b

# rerun whatever did not finish cleanly
npm run agent:matrix -- --resume runs/matrix-<stamp>
```

The matrix checks every model endpoint and API key first and refuses to start if
one is missing. Profiles run side by side; each profile's runs go in sequence.
`--tasks`, `--strategies`, `--repeats`, `--items` (`pilot`, `all`, or ids) and
`--items-<task>` narrow it.

**Time.** A trial is 5 minutes (a CS4 trial 15: three rounds), so one model
under one strategy on the pilot items - AuDrA 1, MacGyver 5, CS4 10 - is at most
about 3 hours, and all three strategies about 9 hours per model. Run models in
parallel, or narrow the items. The limits are in `src/tasks/taskTiming.json`.

## 6. What it leaves

```
runs/matrix-<stamp>/matrix.json      the plan and one row per run
runs/matrix-<stamp>/matrix.csv       the same rows, for a spreadsheet
runs/matrix-<stamp>/<profile>/       <trialId>.run.json and <trialId>.reasoning.jsonl
exports/                             one bundle per trial, as for human participants
```

See [agent-strategies.md](agent-strategies.md) for what each record holds.

## Human participants on the same server

The drawing task's participant screen is served by the same `npm run dev`.
Browsers allow the microphone only on HTTPS or localhost, so put the dev server
behind a TLS reverse proxy for remote participants; the proxy's host name must be
in `server.allowedHosts` in `vite.config.ts` (`internal.kixlab.org` is).
