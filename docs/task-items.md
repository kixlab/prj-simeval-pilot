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

## MacGyver pilot subset

`pilotSubset` in the manifest lists the items the study runs, in order.
Validation holds a populated subset to the planned composition — three
unconventional solvable, one conventional solvable, one unsolvable — and stays
quiet while it is empty.

## Fixtures

Both directories currently hold one `"source": "development"` fixture, written
for interface work, exactly as `src/audra` carries a development stimulus. The
flag travels with the item through the loader and the API, so a fixture cannot
be mistaken for benchmark data. Replace them with `"source": "official"` items
before collecting anything, and record the licence position for the released
datasets alongside the existing note in `audra-scoring-and-stimuli.md`.
