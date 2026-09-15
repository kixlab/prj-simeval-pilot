# CS4 story revision task

`?mode=cs4-creative-writing`. A participant revises one short story over three
rounds whose constraints accumulate (7, then 15, then 23), in a plain notepad
area. Each round starts from the story as the previous round left it. Agents run
the same instances through `scripts/agentDriver.mjs --task cs4`; see
[agent-strategies.md](agent-strategies.md).

## The participant screen

- The writing instruction and the constraints in force are shown verbatim;
  constraints new this round are marked `NEW`. The story is a notepad-like text
  area prefilled with the instance's base story, with a running word count.
- A round's constraints are fetched only when that round begins
  (`/api/tasks/cs4-creative-writing/items/<id>?round=<n>`), so the page never
  holds a later round's constraints early.
- Think-aloud audio runs for the whole session, recorded and transcribed in
  10-second chunks, with the same dead-microphone detection as the other tasks.
- The clock is per round (`scope: "round"` in `src/tasks/taskTiming.json`: 5
  minutes, Finish round open for the final minute), started when the round's
  constraints are on screen. When a round's time runs out the round ends by
  itself - a `round_end` event with `cause: "time_limit"` - and the next round
  begins with the story as it stands; nothing is submitted for the participant.
  `?timeLimitSec=` / `?finalizeWindowSec=` override one session, `?item=`
  preselects an instance, `?participant=` prefills the id.

## Korean translation

A "한국어 번역 보기" toggle shows Korean under the English instruction and each
constraint. The English stays the text of record - it is all an agent sees - and
the story itself is never translated. The Korean for the ten pilot instances is
a machine translation not yet reviewed (`machine: true` in
`data/tasks/cs4/translations/ko.json`), and the screen says so. Translations are
sliced per round exactly as the English constraints are, so the toggle cannot
reveal a later round either. Every toggle is a `translation_toggle` event in the
log, and `protocol.translation.everShown` records whether Korean was ever shown.

## What is recorded

Every change to the story is one `text_edit` event holding the smallest
replacement that produced it (`start`, `removed`, `inserted`, and whether it was
typed or pasted). A `pause` event closes each burst of typing (700 ms without a
keystroke); `round_submit` (the participant finished the round) and `round_end`
(the round's time ran out) close the rounds. The server replays the posted log
from the instance's base story before writing anything, and refuses a log that
does not reproduce, a final text that does not match, or a session that did not
reach its last round.

## How it lines up with an agent

An agent revises through explicit sentence moves. A participant edits freely, so
the story is read the same way after the fact: at every pause it is split into
sentences, and a sentence-level alignment with the previous pause gives `added`,
`revised`, and `deleted` changes, tagged with the round they happened in
(`sentence_changes.jsonl`). That reading is a heuristic - sentence splitting on
dialogue and abbreviations is imperfect - and the think-aloud is the check on it.

## The bundle

`exports/<stamp>__cs4__human-<id>__<instance>__<trial>/`:

| File | Contents |
| --- | --- |
| `events.jsonl` | The full edit log across all rounds |
| `session.json` | Actor, instance, timing, versions, `protocol` (per-round limit, how each round ended, translation use), `humanProcess` (edits, characters typed and removed, pastes, pauses, translation toggles), think-aloud summary |
| `story_round1.txt` … `story_round3.txt`, `story_final.txt` | The story as each round ended, and the final story |
| `rounds.json` | Per round: constraint stage, how it ended, word and sentence counts |
| `sentence_changes.jsonl` | Sentence-level changes between pauses |
| `thinkaloud.jsonl`, `thinkaloud_audio.webm` | Think-aloud transcript chunks and audio, when recorded |

## Tests

```bash
npm run test:human-text     # edit log, round replay, sentence reading
npm run test:task-items     # round slicing, translation leakage
```
