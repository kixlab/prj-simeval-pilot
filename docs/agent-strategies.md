# Running agents: tasks, strategies, time limits

One driver runs an agent on every task in the pilot, under one of three action
strategies, against one model provider. The point is to compare which protocol
leaves the most usable material for a linkograph, with the task held fixed.

```
scripts/agentDriver.mjs        one trial: task x strategy x provider, within a time limit
scripts/agentSweep.mjs         every strategy (x items x repeats), interleaved, with a summary table
scripts/agentStrategies.mjs    the three protocols and the per-turn text
scripts/agentTasks/            one adapter per task: task text, tools, what the solver sees
scripts/agentModelClients.mjs  mock, local (OpenAI-compatible), anthropic, openai
scripts/agentReplyParser.mjs   reasoning extraction and tolerant JSON reading
```

The app server validates every call; the driver is deliberately not trusted.

## Running

```bash
npm run dev                                   # terminal 1

# canned replies - checks the whole loop with no model
node scripts/agentDriver.mjs --task macgyver --provider mock --strategy multi

# one trial
node scripts/agentDriver.mjs --task audra    --provider openai --strategy single   --out runs/
node scripts/agentDriver.mjs --task macgyver --provider openai --strategy one-shot --item mg-1655 --out runs/
node scripts/agentDriver.mjs --task cs4      --provider anthropic --strategy multi --out runs/

# every strategy, interleaved
npm run agent:sweep -- --task macgyver --provider openai --items mg-1655,mg-2042,mg-1079
npm run agent:sweep -- --task cs4 --provider local \
  --endpoint http://127.0.0.1:11434/v1/chat/completions --model <model>
```

Keys come from the environment or `.env.local` (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`). `--driver mock` still works as an alias for
`--provider mock`.

## Strategies

| Strategy | One reply holds | The solver sees its work again | Trace per reply covers |
| --- | --- | --- | --- |
| `one-shot` | every action, ending with the finishing call | never (CS4: at the next round) | the whole answer / round |
| `single` | exactly one action; a reply with several is unreadable | after every action | one action |
| `multi` | as many actions as the model chooses | after every reply | that reply's batch |

All strategies share the task text, the tools, and server validation; only the
protocol section of the prompt differs. A reply runs in order and stops at the
first rejected or unreadable call, and anything after the finishing call is
skipped, so an edit written after `submit_round` never lands in the next round.
One-shot resamples only a reply that cannot be read at all (`--parse-retries`,
default 2). `--max-calls-per-turn` (default 64) caps one reply.

Two reply shapes come up constantly with hosted models and are handled
explicitly. Under `single`, a reply that holds several actions is refused with
a plain reason ("The reply held 12 actions; send exactly one action per
reply.") - gpt-5.5 does this on most `single` turns, which is itself a finding
about that protocol. Such a reply is **refused, not trimmed** to its first
action: trimming would run one step of a plan the model never got to carry out,
and would hide how often the one-move rule is broken. Refusals are counted as
`ruleViolations` in the run summary and the matrix, so compliance can be
reported per model and task. Under `multi` and `one-shot`, several `{"calls":[...]}`
objects in one reply are joined in order and counted as a repair
(`merged_call_batches`).

## Time limit

Every real run is timed. The limits live in **`src/tasks/taskTiming.json`**,
which the human screens read too, so one edit changes both actors: 300 s per
trial, and **per round** on CS4, so a CS4 session is three five-minute rounds.
`--time-limit-sec` / `--finalize-window-sec` override it for one run (a human
session uses `?timeLimitSec=` / `?finalizeWindowSec=`). The mock provider is
untimed unless given a limit. Durations are written in words ("4 min 47 s"): a clock
format such as `1:00` was read by models as an hour.

- `single` and `multi` keep working for the whole limit. The finishing call
  (`submit_task`, `submit_answer`, `submit_round`) is refused by the driver until
  the final window (`--finalize-window-sec`, default 60) and the refusal is shown
  to the agent (`skipReason: "too_early"`).
- No model call starts after the limit. A reply still in flight is given 60 s
  so its trace is kept, but its actions are not carried out (`late: true`).
- `one-shot` gets one reply per round; the limit is its deadline, not a duration
  to fill.
- A CS4 round whose clock runs out, or whose one-shot reply did not submit, is
  ended by the protocol through a host-only endpoint and logged as a **system**
  event (`round_ended`, with its cause). The story carries into the next round.
  The driver never submits for the agent.

A failed model request costs one turn (`modelError`); `--max-model-errors`
(default 3) in a row end the run. `maxTurns` (default 200) is only a safety cap.

**Keep the host awake.** A laptop that sleeps mid-run stops the timers but not
the clock, so a model call appears to take many minutes and the trial's timing
no longer reflects what the agent experienced. A call that outlasts its own
timeout by more than 30 s is flagged (`stalled`, `hostStalls` in the summary)
with a warning to rerun. Run long sweeps on mains power under
`caffeinate -ims`.

**Do not edit server code during a sweep.** Vite restarts the dev server when
`vite.config.ts` or any file it imports changes - `src/**/server/`,
`src/tasks/agent/`, the task engines - and a restart drops every trial held in
memory. The run then ends with `endedBy: "trial_lost"` (or `"server_error"` if a
round could not be closed) and still writes its run log; rerun it. Editing the
driver itself (`scripts/`) is safe: the server never loads it.

## Tasks

| `--task` | Solver sees | Atomic action | Finishes with |
| --- | --- | --- | --- |
| `audra` | a PNG of the canvas | one stroke, erase, or undo | `set_description`, then `submit_task` |
| `macgyver` | the problem verbatim and the answer so far | one step (add, revise, delete), the judgement, the justification | `submit_answer` |
| `cs4` | the round's constraints (new ones marked) and the numbered story | one sentence (replace, insert, delete) | `submit_round`, three times |

The atomic action is the unit a linkograph inherits from the artifact side.
Human participants will edit freely; their answers are compared at the same
unit by diffing the step list or the sentence list between snapshots.

The text tasks run on `/api/tasks/:taskId/agent/*` (see
`src/tasks/server/plugin.ts`). Their engines are pure
(`src/tasks/macgyver/answer.ts`, `src/tasks/cs4/revision.ts`): strict call
parsing, range and length checks, and submission guards - a MacGyver answer
needs a judgement and at least one step, or a justification if unsolvable.
Agent trials are built from participant views only, so no observation can carry
a MacGyver answer key or a later CS4 round's constraints.

## What a run leaves

- `runs/.../<trialId>.run.json` - the run summary: strategy, rounds and how each
  ended, calls per reply, driver assistance, trace statistics, every turn.
- `runs/.../<trialId>.reasoning.jsonl` - one record per model reply: the trace,
  `traceKind`, the calls it held with their status, the round, and the revision
  range they moved the answer through.
- `exports/<task>__agent-.../` - the server-side bundle. Drawing: see
  [audra-incomplete-shapes.md](audra-incomplete-shapes.md). Text tasks:
  `events.jsonl`, `session.json`, and the answer - `answer.md` / `answer.json`,
  or `story_round{1,2,3}.txt`, `story_final.txt`, `rounds.json`.

Every bundle's `session.json` carries a `protocol` block - the time limit, the
final window, whether it was overridden, and how the trial ended - written the
same way by human and agent trials, so the two can be filtered and compared on
the same fields.

`reasoningTrace.artifactActionsPerTracedReply` in the summary is how many
accepted changes one reply's trace has to account for - about 1 under single,
the batch size under multi, everything under one-shot.

## Providers and what their trace is

| `--provider` | Endpoint | Trace kind |
| --- | --- | --- |
| `mock` | none | `raw` (canned `<think>` spans) |
| `local` | OpenAI-compatible `/v1/chat/completions` | `raw` - `<think>` spans or `reasoning_content`, when the model has a thinking mode |
| `anthropic` | Messages API via `@anthropic-ai/sdk`, default `claude-opus-5` | `summary` - adaptive thinking with `display: "summarized"` |
| `openai` | Responses API, default `OPENAI_MODEL` | `summary` - `reasoning.summary: "auto"` |

**Hosted models never release their raw chain of thought.** A hosted trace is a
provider-written summary, not the model's own tokens; compare strategies within
one trace kind and do not pool the two in one linkograph analysis.

No `thought` field is requested by default, because the trace under study is the
model's own thinking. `--prompted-thought on` adds one for models without a
thinking mode; it is recorded separately as `promptedThought`.

Claude rejects sampling parameters, so `--temperature`, `--top-p`, and `--seed`
apply only to `local`; use `--effort` for Claude and OpenAI. Claude requests
carry Anthropic's server-side `fallbacks: "default"`, which re-runs a declined
request on a recommended fallback model; each turn records `servedBy` and
`fallbackRan`, and `--fallbacks off` returns the refusal instead.

## Tests

```bash
npm run test:agent-strategies   # the loop, on every task: protocols, time limit, rounds
npm run test:text-tasks         # MacGyver and CS4 engines and the text-trial registry
npm run test:audra-driver       # tolerant reply parser
```

## Not yet in place

- The human screens for MacGyver and CS4 are not built yet; only the drawing
  task collects both actors.
- The licence position for using the released MacGyver items is not recorded.
- Text-task bundles have no replay page yet; the event log is complete, so one
  can be built from it.
- Sentence splitting is punctuation-based; an abbreviation such as "Mr." splits
  a sentence in two. That only makes a unit smaller and never loses text.
