# Task items

Items for the two text tasks. Adding one is dropping a JSON file in and naming
it in the manifest — no code change:

```
data/tasks/
  macgyver/
    manifest.json          which items exist, and which five the pilot runs
    items/<itemId>.json    one problem per file
  cs4/
    manifest.json
    items/<instanceId>.json
```

```bash
npm run test:task-items    # validates every file, the manifests, and the pilot subset
```

The dev server reads these files per request, so a new item shows up on the
next page load without a restart.

**These files are not served.** They live outside `public/` because a MacGyver
item carries its gold solution, and the agent runs against the same server a
participant does. `/api/tasks/...` can only return a participant view: no
answer key, and no CS4 constraint from a round the participant has not reached.
Scoring reads this directory from disk instead.

Every file records where it came from. `"source": "development"` marks a
fixture written for interface work — the loader and the API pass that flag
through so a fixture can never be mistaken for benchmark data. Real items are
`"source": "official"`: MacGyver holds the five pilot items, CS4 the 50
story-based instances of the benchmark (MIT-licensed; see
`docs/task-items.md`). Keep the licence position for the released datasets in
`docs/audra-scoring-and-stimuli.md` up to date.

## MacGyver item

```json
{
  "itemId": "mg-001",
  "source": "official",
  "problem": "One paragraph, exactly as the benchmark states it.",
  "objects": ["every object and tool the solver may use"],
  "constraints": ["extra conditions the item states, if any"],
  "answerKey": {
    "solvability": "solvable",
    "solutionType": "unconventional",
    "goldSolution": ["one step per entry"],
    "unsolvableJustification": null
  },
  "datasetRef": "row 412 of the released set",
  "notes": ""
}
```

An unsolvable item inverts the answer key: `"solvability": "unsolvable"`,
`"solutionType": null`, no `goldSolution`, and a non-empty
`unsolvableJustification`. Either half of that being wrong fails validation
rather than reaching a scorer.

`pilotSubset` in `manifest.json` lists the five items the study runs, in order.
Validation holds it to the planned composition: three unconventional solvable,
one conventional solvable, one unsolvable. Leave it empty until the five are
chosen.

## CS4 instance

```json
{
  "instanceId": "cs4-001",
  "source": "official",
  "instruction": "The user instruction the base story was written from.",
  "baseStory": "The roughly 500-word story every round revises.",
  "constraints": ["23 constraints, in the order they are introduced"],
  "datasetRef": "",
  "notes": ""
}
```

Constraints are stored once, in order. The pilot runs three rounds — 7, then
15, then 23 — and each round is a prefix of that list, so the rounds are
cumulative by construction: round 2 cannot disagree with round 1 about the
first seven constraints, because they are the same seven strings. A file must
carry exactly 23; the stages live in `src/tasks/cs4/item.ts`.

Official instances are written by `npm run cs4:import -- --csv <Story-based Base
Stories.csv>` rather than by hand; the importer checks the nesting of the
dataset's constraint levels before it writes anything.
