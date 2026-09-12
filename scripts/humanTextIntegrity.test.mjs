import assert from "node:assert/strict";
import { loadTsBundle } from "./loadTsBundle.mjs";

// A participant's MacGyver memo: the edit log replays to the exact text, a
// tampered log is refused, and the memo's lines are read as steps whose
// changes between typing pauses line up with an agent's step moves.

const human = await loadTsBundle(new URL("../src/tasks/macgyver/humanAnswer.ts", import.meta.url).pathname);
const {
  applyHumanEvent,
  initialHumanState,
  replayHumanEvents,
  stepChangesFromEvents,
  stepsFromText,
  summarizeHumanProcess,
  textDiff
} = human;

/** Builds a log the way the screen does: one diff per change, a pause where asked. */
function logBuilder() {
  const events = [];
  let text = "";
  let clock = 0;
  const push = (eventType, payload) => events.push({ eventIndex: events.length, timestampMs: (clock += 50), eventType, payload });
  return {
    events,
    type(next, source = "typing") {
      const edit = textDiff(text, next);
      if (edit) push("text_edit", { ...edit, source });
      text = next;
    },
    pause: () => push("pause", { length: text.length }),
    judge: value => push("judgement_set", { value }),
    submit: () => push("submit", {}),
    get text() {
      return text;
    }
  };
}

// The smallest replacement, in every direction.
assert.equal(textDiff("abc", "abc"), null);
assert.deepEqual(textDiff("abc", "abXc"), { start: 2, removed: "", inserted: "X" });
assert.deepEqual(textDiff("abXc", "abc"), { start: 2, removed: "X", inserted: "" });
assert.deepEqual(textDiff("hello world", "hello there"), { start: 6, removed: "world", inserted: "there" });
assert.deepEqual(textDiff("aaa", "aaaa"), { start: 3, removed: "", inserted: "a" });

// Lossless: hundreds of random edits replay to exactly the final text.
{
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const log = logBuilder();
  const alphabet = "abc de\nf1.";
  for (let step = 0; step < 400; step += 1) {
    const text = log.text;
    const at = Math.floor(random() * (text.length + 1));
    const cut = Math.floor(random() * Math.min(4, text.length - at + 1));
    const insert = Array.from({ length: Math.floor(random() * 4) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    log.type(text.slice(0, at) + insert + text.slice(at + cut));
    if (random() < 0.1) log.pause();
  }
  assert.equal(replayHumanEvents(log.events).text, log.text);

  // A tampered edit, a gap, or a reordering is refused.
  const edits = log.events.filter(event => event.eventType === "text_edit" && event.payload.removed.length > 0);
  const tampered = structuredClone(log.events);
  tampered[edits[0].eventIndex].payload.removed = "#".repeat(edits[0].payload.removed.length);
  assert.throws(() => replayHumanEvents(tampered), /does not match/);
  const gap = structuredClone(log.events);
  gap.splice(3, 1);
  assert.throws(() => replayHumanEvents(gap), /eventIndex/);
  const backwards = structuredClone(log.events);
  backwards[5].timestampMs = 0;
  assert.throws(() => replayHumanEvents(backwards), /before/);
}

// The memo's lines as steps: blank lines dropped, numbering and bullets removed.
assert.deepEqual(
  stepsFromText("1. Dig a trench\n\n2) Lash the stakes\n- Drape the sheet\n   \n• Weigh the edges\n3.Tie the corners"),
  ["Dig a trench", "Lash the stakes", "Drape the sheet", "Weigh the edges", "Tie the corners"]
);

// Step changes between pauses, in the vocabulary of an agent's step moves.
{
  const log = logBuilder();
  log.judge("solvable");
  log.type("1. Dig a trench\n2. Lash stakes");
  log.pause();
  log.type("1. Dig a trench\n2. Lash the short stakes together");
  log.pause();
  log.type("1. Dig a trench\n2. Lash the short stakes together\n3. Drape the sheet");
  log.pause();
  log.type("2. Lash the short stakes together\n3. Drape the sheet");
  log.submit();
  const changes = stepChangesFromEvents(log.events).map(({ change, step, text, previous }) => ({ change, step, text, previous }));
  assert.deepEqual(changes, [
    { change: "added", step: 1, text: "Dig a trench", previous: null },
    { change: "added", step: 2, text: "Lash stakes", previous: null },
    { change: "revised", step: 2, text: "Lash the short stakes together", previous: "Lash stakes" },
    { change: "added", step: 3, text: "Drape the sheet", previous: null },
    { change: "deleted", step: 1, text: null, previous: "Dig a trench" }
  ]);
  const state = replayHumanEvents(log.events);
  assert.equal(state.submitted, true);
  assert.deepEqual(summarizeHumanProcess(log.events).pauses, 3);
}

// Text typed after the last pause - a trial cut off by the clock - still counts.
{
  const log = logBuilder();
  log.type("Tie the stakes");
  const changes = stepChangesFromEvents(log.events);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].change, "added");
}

// The submission guard an agent's submit_answer meets, and finality after it.
{
  const at = (eventType, payload, eventIndex = 0) => ({ eventIndex, timestampMs: 0, eventType, payload });
  let state = initialHumanState();
  assert.equal(applyHumanEvent(state, at("submit", {})).ok, false, "no judgement yet");
  state = applyHumanEvent(state, at("judgement_set", { value: "unsolvable" })).state;
  assert.equal(applyHumanEvent(state, at("submit", {})).ok, false, "no text yet");
  assert.equal(applyHumanEvent(state, at("judgement_set", { value: "maybe" })).ok, false);
  state = applyHumanEvent(state, at("text_edit", { start: 0, removed: "", inserted: "Nothing holds the weight." })).state;
  state = applyHumanEvent(state, at("submit", {})).state;
  assert.equal(state.submitted, true);
  assert.equal(applyHumanEvent(state, at("text_edit", { start: 0, removed: "", inserted: "late" })).ok, false);
}

// Pasted text is marked, so it can be told apart from typing.
{
  const log = logBuilder();
  log.type("typed ");
  log.type("typed and pasted", "paste");
  assert.equal(summarizeHumanProcess(log.events).pastes, 1);
}

// A translation toggle is a process marker: counted, but it changes nothing.
{
  const log = logBuilder();
  log.type("Tie the stakes");
  log.events.push({ eventIndex: log.events.length, timestampMs: 9_999, eventType: "translation_toggle", payload: { visible: true } });
  assert.equal(replayHumanEvents(log.events).text, "Tie the stakes");
  assert.equal(summarizeHumanProcess(log.events).translationToggles, 1);
}

// --- CS4: one story revised freely through the rounds ------------------------------

const cs4 = await loadTsBundle(new URL("../src/tasks/cs4/humanRevision.ts", import.meta.url).pathname);
{
  const base = "The ferry left. Mira waved.\n\nThe gulls stayed.";
  const events = [];
  let text = base;
  let clock = 0;
  const push = (eventType, payload) => events.push({ eventIndex: events.length, timestampMs: (clock += 100), eventType, payload });
  const type = next => {
    const edit = cs4.textDiff(text, next);
    if (edit) push("text_edit", { ...edit, source: "typing" });
    text = next;
  };

  // Round 1: revise a sentence, then submit.
  type("The ferry left late. Mira waved.\n\nThe gulls stayed.");
  push("pause", {});
  push("round_submit", {});
  // Round 2: add a sentence; the clock runs out.
  type("The ferry left late. Mira waved. She smiled.\n\nThe gulls stayed.");
  push("round_end", { cause: "time_limit" });
  // Round 3: delete a sentence, then submit.
  type("The ferry left late. Mira waved. She smiled.");
  push("round_submit", {});

  const state = cs4.replayHumanCs4Events(base, events);
  assert.equal(state.complete, true);
  assert.equal(state.text, text);
  assert.deepEqual(
    state.results.map(result => [result.round, result.stage, result.endedBy, result.sentences]),
    [[1, 7, "submitted", 3], [2, 15, "time_limit", 4], [3, 23, "submitted", 3]],
    "each round's story is kept, with how the round ended"
  );

  const changes = cs4.sentenceChangesFromEvents(base, events).map(({ round, change, sentence, text: now, previous }) => ({ round, change, sentence, now, previous }));
  assert.deepEqual(changes, [
    { round: 1, change: "revised", sentence: 1, now: "The ferry left late.", previous: "The ferry left." },
    { round: 2, change: "added", sentence: 3, now: "She smiled.", previous: null },
    { round: 3, change: "deleted", sentence: 4, now: null, previous: "The gulls stayed." }
  ]);

  // A finished session is final; a tampered log and a bad cause are refused.
  assert.equal(cs4.applyHumanCs4Event(state, { eventIndex: 99, timestampMs: 1e6, eventType: "pause", payload: {} }).ok, false);
  const tampered = structuredClone(events);
  tampered[0].payload.removed = "#";
  assert.throws(() => cs4.replayHumanCs4Events(base, tampered), /does not match/);
  const fresh = cs4.initialHumanCs4State(base);
  assert.equal(cs4.applyHumanCs4Event(fresh, { eventIndex: 0, timestampMs: 0, eventType: "round_end", payload: { cause: "boredom" } }).ok, false);
  // The replay starts from the base story, so a log for another story fails.
  assert.throws(() => cs4.replayHumanCs4Events("A different story.", events));
}

console.log("human text integrity tests passed");
