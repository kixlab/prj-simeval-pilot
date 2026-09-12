# Text-task items

Items for the two text tasks are data, not code: adding one is dropping a JSON
file into `data/tasks/<task>/items/` and naming it in that task's
`manifest.json`. `data/tasks/README.md` is the reference for the two file
formats; this page is how the pieces fit together.

```
data/tasks/macgyver/                items on disk, never served
data/tasks/cs4/
src/tasks/itemParsing.ts            shared field checks, collects every problem in one pass
src/tasks/macgyver/item.ts          item type, parser, answer key, pilot composition
src/tasks/cs4/item.ts               instance type, parser, the 7 / 15 / 23 rounds
src/tasks/server/itemStore.ts       Node-only reader: parses files, checks the manifest
src/tasks/server/plugin.ts          GET /api/tasks/:taskId/items[/:itemId]
src/tasks/itemClient.ts             browser side of those two endpoints
scripts/taskItemsIntegrity.test.mjs npm run test:task-items
```

## What a solver may see

MacGyver ships a gold solution and a solvability label with every problem, and
the agent runs against the same dev server a participant does. So the items sit
outside `public/`, the store is the only reader, and the HTTP layer can return
nothing but a participant view:

- `answerKey` is a nested field, so withholding it is one structural step
  rather than a list of fields each caller has to remember to drop.
- A CS4 round returns the constraints in force and no others. Round 1 does not
  carry rounds 2 and 3 anywhere in the response, and an out-of-range round
  number clamps instead of opening a later one.
- There is no endpoint for an answer key at all. Scoring reads `data/tasks`
  from disk.

The integrity test asserts both of these by searching the serialised view for
the withheld strings, not by trusting the shape.

## CS4 rounds

The pilot runs three rounds in one session: **7 constraints, then 15, then 23**,
each round revising the story the previous round produced. An instance file
stores its 23 constraints once, in order, and a round takes a prefix — so the
rounds are cumulative by construction and a file cannot express a
non-cumulative set. The stages live in `cs4ConstraintStages`.

## Translations

`data/tasks/<task>/translations/ko.json` holds Korean for the participant
screens' "한국어 번역 보기" toggle, kept apart from the items so an item file
stays the benchmark text and nothing else:

```json
{ "language": "ko", "machine": false, "source": "…", "items": { "<itemId>": { … } } }
```

- MacGyver: `{ "problem": "…" }`, taken from the earlier MacGyver pilot's
  `prompt_ko` (human-written).
- CS4: `{ "instruction": "…", "constraints": ["…", …] }`, one Korean line per
  English constraint and in the same order. These are machine translations, not
  yet reviewed (`"machine": true`), and the screen says so.

The loader attaches a translation to its item and refuses one for an unknown
item or, for CS4, with a constraint count that differs from the instance's. A
CS4 round slices the Korean constraints exactly as it slices the English, so the
integrity test checks that no round's view carries a later round's constraint in
either language. The agent never receives a translation.

## MacGyver pilot subset

`pilotSubset` in the manifest lists the items the study runs, in order.
Validation holds a populated subset to the planned composition — three
unconventional solvable, one conventional solvable, one unsolvable — and stays
quiet while it is empty.

## Fixtures

Both directories hold one `"source": "development"` fixture, written for
interface work, exactly as `src/audra` carries a development stimulus. The flag
travels with the item through the loader and the API, so a fixture cannot be
mistaken for benchmark data.

MacGyver also holds the five official pilot items (`mg-1655`, `mg-1923`,
`mg-2008`, `mg-2042`, `mg-1079`), copied verbatim from the released dataset via
`Macgyver Pilot/macgyver_think_aloud_selected_candidates.md`, and they form the
pilot subset. A MacGyver `problem` is the complete text a solver sees, objects
and conditions included; `objects` and `constraints` are analysis metadata.
Record the licence position for the MacGyver release alongside the existing
note in `audra-scoring-and-stimuli.md` before collecting anything.

CS4 holds the 50 official instances of the benchmark's story-based set
(`cs4-sb000` to `cs4-sb049`), imported from
[github.com/anirudhlakkaraju/cs4_benchmark](https://github.com/anirudhlakkaraju/cs4_benchmark),
which is MIT-licensed:

```bash
git clone https://github.com/anirudhlakkaraju/cs4_benchmark
npm run cs4:import -- --csv "cs4_benchmark/CS4_dataset/Story-based Base Stories.csv"
```

In that set every instruction has one base story and constraint lists of 7, 15,
23, 31, and 39 entries, each beginning with the whole of the shorter one - so
the pilot's rounds are the dataset's own levels, and the importer refuses an
instruction where that nesting does not hold. The pilot subset is the ten
instructions the earlier CS4 pilot used (`SimEval/Data/CS4`), so the two runs can
be compared item for item; pass `--pilot` to choose others.

## Agent trials

The same server runs agent trials on these items through
`/api/tasks/:taskId/agent/*`, built from participant views only. See
[agent-strategies.md](agent-strategies.md).
