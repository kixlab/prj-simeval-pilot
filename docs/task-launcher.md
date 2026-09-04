# Task launcher and mode routing

The pilot collects three creativity tasks. A participant lands on the launcher,
picks the task they were asked to do, and is handed to that task's own screen.

> Two of the three tasks are **not implemented**. `macgyver-problem-solving`
> and `cs4-creative-writing` currently resolve to a description page that states
> what is decided and what is missing. Nothing on those pages records or exports
> anything.

## Screens

| Mode | Screen | Status |
| --- | --- | --- |
| *(none)* or `launcher` | Task launcher | Ready |
| `audra-incomplete-shapes` | Incomplete-shapes drawing task (`src/audra`) | Ready |
| `macgyver-problem-solving` | Description page | Planned |
| `cs4-creative-writing` | Description page | Planned |
| `excalidraw-session` | The earlier Excalidraw session app (`src/App.tsx`) | Unchanged, not a study task |

An unknown mode falls back to the launcher rather than guessing a task.

## Layout

```
src/tasks/catalog.ts     the three tasks: id, mode, instrument, status, outputs,
                         decided design, remaining work, reference
src/tasks/macgyver/, src/tasks/cs4/, src/tasks/server/
                         item formats, loader, and endpoints for the two text
                         tasks — see task-items.md
src/tasks/routing.ts     readMode(location) and resolveRoute(mode, implemented)
                         — pure, no DOM, covered by scripts/taskLauncherIntegrity.test.mjs
src/main.tsx             maps a resolved route to a React screen
src/launcher/            the launcher page and the placeholder page
```

The catalog says which tasks *exist*; the `taskScreens` map in `src/main.tsx`
says which of them can *run*. A task marked `available` with no screen behind it
is reported to the console and rendered as a description page, so the mismatch
cannot pass as a working task. The integrity test asserts the two agree.

The launcher owns no trial state and never touches a task's session. A task
behaves identically whether it was opened from the launcher or from its own
deep link — including the host URL `/api/audra/trial` issues for agent runs,
which still carries `mode=audra-incomplete-shapes` with `trialId` and `token`.

A participant id typed on the launcher is forwarded as `?participant=` and only
prefills the task's own field; each task still asks for it.

## Adding a task

1. Add the entry to `src/tasks/catalog.ts` with `status: "planned"`. It is now
   routed and described, and appears on the launcher as in preparation.
2. Build the task under its own directory, following `src/audra`: one canonical
   event log, one reducer, its own export bundle.
3. Register its screen in `taskScreens` in `src/main.tsx` and flip the catalog
   entry to `status: "available"`.
4. Run `npm run test:task-launcher`.

Items for the two text tasks are already loadable: see
[task-items.md](task-items.md). The description pages report how many items are
on disk, so a task that is only described cannot look ready by accident.

## Language

Participant-facing text is English throughout, matching the existing task
screens. Speech-to-text still defaults to `ko-KR` with `en-US` as an
alternative; see the README.
