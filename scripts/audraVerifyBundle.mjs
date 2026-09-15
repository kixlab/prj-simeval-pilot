#!/usr/bin/env node
// Checks an exported trial bundle is complete and ready for AuDrA scoring.
//
//   node scripts/audraVerifyBundle.mjs exports/              # every bundle
//   node scripts/audraVerifyBundle.mjs exports/20260915-0412Z__audra__human-p001__…/

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const required = [
  "events.jsonl", "actions.json", "final_canvas.svg", "final_canvas_score.png",
  "final_canvas_archival.png", "description.txt", "session.json", "replay.html"
];

function pngHeader(path) {
  const buffer = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => buffer[index] === byte)) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25]
  };
}

function verify(dir) {
  const problems = [];
  const notes = [];
  const files = new Set(readdirSync(dir));

  for (const name of required) {
    if (!files.has(name)) problems.push(`missing ${name}`);
    else if (statSync(join(dir, name)).size === 0) problems.push(`${name} is empty`);
  }
  if (problems.length > 0) return { problems, notes };

  const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const actions = JSON.parse(readFileSync(join(dir, "actions.json"), "utf8"));
  const description = readFileSync(join(dir, "description.txt"), "utf8").trim();

  // AuDrA preprocesses with PIL.ImageOps.invert, which rejects RGBA.
  for (const name of ["final_canvas_score.png", "final_canvas_archival.png"]) {
    const header = pngHeader(join(dir, name));
    if (!header) problems.push(`${name} is not a PNG`);
    else if (header.colorType !== 2) problems.push(`${name} is colour type ${header.colorType}, AuDrA needs 2 (RGB)`);
    else if (header.width !== header.height) problems.push(`${name} is not square (${header.width}x${header.height})`);
  }

  // Event log integrity: contiguous indices, non-decreasing time, one submit last.
  events.forEach((event, index) => {
    if (event.eventIndex !== index) problems.push(`events.jsonl index ${index} declares eventIndex ${event.eventIndex}`);
  });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].timestampMs < events[index - 1].timestampMs) {
      problems.push(`events.jsonl timestamp goes backwards at index ${index}`);
    }
  }
  const submits = events.filter(event => event.eventType === "submit");
  if (submits.length !== 1) problems.push(`expected exactly one submit event, found ${submits.length}`);
  else if (events.at(-1).eventType !== "submit") problems.push("submit is not the final event");
  if (!session.trial.completed) problems.push("session.json reports the trial as not completed");
  if (actions.actions.length !== events.length) problems.push("actions.json and events.jsonl disagree on length");

  const strokes = events.filter(event => event.eventType === "draw_stroke");
  if (strokes.length === 0) problems.push("no draw_stroke events");
  if (description.length === 0) notes.push('description.txt is empty — no answer to "What did you draw?"');

  // Human trials should carry pointer sample times; agents never do.
  if (session.trial.actorType === "human") {
    const timed = strokes.filter(event => event.payload.points?.some(point => point.tMs != null));
    if (strokes.length > 0 && timed.length === 0) {
      notes.push("no stroke carries pointer sample times (tMs) — gesture timing will be null");
    }
    if (!files.has("thinkaloud.jsonl")) notes.push("no thinkaloud.jsonl — think-aloud was not captured");
    else {
      const chunks = readFileSync(join(dir, "thinkaloud.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      const failed = chunks.filter(chunk => chunk.transcriptionStatus === "failed").length;
      const done = chunks.filter(chunk => chunk.transcriptionStatus === "completed").length;
      const silent = chunks.filter(chunk => chunk.audio.silent).length;
      const peak = chunks.reduce((max, chunk) => Math.max(max, chunk.audio.peakLevel ?? 0), 0);
      notes.push(
        `think-aloud: ${chunks.length} chunks, ${done} transcribed, ${failed} failed, ` +
        `peak input ${peak.toFixed(4)}`
      );
      // A dead microphone produces valid audio and an empty transcript, which
      // looks identical to a participant who said nothing. Fail loudly.
      if (silent === chunks.length && chunks.length > 0) {
        problems.push(`all ${chunks.length} think-aloud chunks recorded no microphone signal`);
      } else if (silent > 0) {
        notes.push(`${silent} of ${chunks.length} chunks recorded no microphone signal`);
      }
      if (chunks.some(chunk => chunk.audio.peakLevel === undefined)) {
        notes.push("chunks predate input-level metering, so silence cannot be distinguished from a quiet participant");
      }
      for (const error of session.thinkAloud?.validationErrors ?? []) problems.push(`think-aloud: ${error}`);
      if (!files.has("thinkaloud_audio.webm")) notes.push("think-aloud transcripts present but no archival audio file");
    }
  }
  if (session.stimulus.source === "development") {
    notes.push("development fixture — not an official MTCI stimulus, not for analysable data");
  }

  notes.push(
    `${session.trial.actorType}/${session.trial.actorId} · ${events.length} events · ` +
    `${actions.summary.drawCount} draws, ${actions.summary.eraseCount} erases, ${actions.summary.undoCount} undos · ` +
    `${Math.round(actions.summary.trialDurationMs / 1000)}s`
  );
  if (description) notes.push(`answer: "${description}"`);
  return { problems, notes };
}

const target = process.argv[2] ?? "exports";
const bundles = readdirSync(target, { withFileTypes: true }).some(entry => entry.isDirectory())
  ? readdirSync(target, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(target, entry.name))
  : [target];

let failed = 0;
for (const dir of bundles) {
  const { problems, notes } = verify(dir);
  console.log(`\n${problems.length === 0 ? "PASS" : "FAIL"}  ${basename(dir)}`);
  for (const note of notes) console.log(`      · ${note}`);
  for (const problem of problems) console.log(`      ✗ ${problem}`);
  if (problems.length > 0) failed += 1;
}
console.log(`\n${bundles.length - failed}/${bundles.length} bundles passed`);
process.exitCode = failed > 0 ? 1 : 0;
