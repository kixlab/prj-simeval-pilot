# MacGyver problem-solving task

`?mode=macgyver-problem-solving`. A participant reads one MacGyver problem,
decides whether it can be solved with what the problem describes, and writes the
answer in a plain note area - steps if it can be solved, the reason if it cannot.
Agents run the same items through `scripts/agentDriver.mjs --task macgyver`; see
[agent-strategies.md](agent-strategies.md).

## The participant screen

- The problem is shown verbatim, exactly as the benchmark states it.
- One question - "Can this problem be solved with what it describes?" - with two
  choices, and a notepad-like text area underneath. Nothing shapes how the
  answer is written; one step per line is suggested, not required.
- Think-aloud audio is recorded and transcribed in 10-second chunks, with the
  same dead-microphone detection as the drawing task.
- The clock is the shared one in `src/tasks/taskTiming.json` (5 minutes, Submit
  open for the final minute), started at Start. When time runs out the note area
  locks and the answer is saved as it stands; nothing is submitted for the
  participant. `?timeLimitSec=` / `?finalizeWindowSec=` override one session,
  `?item=` preselects an item, `?participant=` prefills the id.
- Submitting needs a judgement and some text - the same guard an agent's
  `submit_answer` meets.
- A "한국어 번역 보기" toggle shows the Korean problem (from the earlier
  MacGyver pilot, `data/tasks/macgyver/translations/ko.json`) and Korean
  instructions under the English. The English stays the problem of record - it
  is all an agent sees.

## What is recorded

Every change to the note is one `text_edit` event holding the smallest
replacement that produced it (`start`, `removed`, `inserted`, and whether it was
typed or pasted), so the log replays to the exact final text. A `pause` event
closes each burst of typing (700 ms without a keystroke); `judgement_set`,
`translation_toggle` (Korean shown or hidden), and `submit` complete the log. The server replays the posted log before writing
anything and refuses one that does not reproduce.

## How it lines up with an agent

An agent's answer is built from explicit step moves (`add_step`, `revise_step`,
`delete_step`). A participant writes freely, so the note is read the same way
after the fact: at every pause its non-blank lines, with numbering and bullets
removed, are the steps, and a line-level alignment with the previous pause gives
`added`, `revised`, and `deleted` changes (`step_changes.jsonl`). That reading is
a heuristic - a participant who writes one long paragraph has one step - and the
think-aloud is the check on it.

## The bundle

`exports/macgyver__human-<id>__item-<item>__<stamp>__<trial>/`, laid out like an
agent's:

| File | Contents |
| --- | --- |
| `events.jsonl` | The full edit log |
| `session.json` | Actor, item, timing, versions, `protocol` (time limit, how it ended), `answer`, `humanProcess` (edits, characters typed and removed, pastes, pauses), think-aloud summary |
| `answer.md`, `answer.json` | The judgement, the note verbatim, and the steps read from it |
| `step_changes.jsonl` | Step-level changes between pauses |
| `thinkaloud.jsonl`, `thinkaloud_audio.webm` | Think-aloud transcript chunks and audio, when recorded |

The answer key never reaches the screen or the bundle; scoring joins on the item
id against `data/tasks`.

## Tests

```bash
npm run test:human-text     # edit log, replay, step reading
```
