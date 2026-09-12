#!/usr/bin/env node
// Imports CS4 story-based instances into data/tasks/cs4.
//
// Source: github.com/anirudhlakkaraju/cs4_benchmark (MIT), file
// CS4_dataset/Story-based Base Stories.csv. Each instruction there has one base
// story and constraint lists of 7, 15, 23, 31, and 39 entries, and every list
// begins with the whole of the shorter one. An instance file stores the
// 23-entry list, so the pilot's 7 / 15 / 23 rounds are exactly the dataset's
// own levels. The nesting is checked, not assumed.
//
//   node scripts/importCs4.mjs --csv "<clone>/CS4_dataset/Story-based Base Stories.csv" \
//     [--pilot sb000,sb001,...]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const directory = join(projectRoot, "data/tasks/cs4");
const fixtureId = "cs4-dev-fixture-01";
const stages = [7, 15, 23];
// The ten instructions the earlier CS4 pilot used (SimEval/Data/CS4), so the
// two runs can be compared item for item.
const defaultPilot = ["sb000", "sb001", "sb002", "sb012", "sb016", "sb021", "sb029", "sb039", "sb042", "sb047"];

function parseArgs(argv) {
  const options = { csv: null, pilot: defaultPilot.join(",") };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!(key in options)) throw new Error(`Unknown option: ${argv[index]}`);
    options[key] = argv[index + 1];
  }
  if (!options.csv) throw new Error("--csv is required: the path to Story-based Base Stories.csv.");
  return options;
}

/** RFC 4180: quoted fields may hold commas, quotes, and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') inQuotes = false;
      else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter(entry => entry.some(value => value.trim() !== ""));
  const names = header.map(name => name.replace(/^﻿/, "").trim());
  return body.map(entry => Object.fromEntries(names.map((name, index) => [name, entry[index] ?? ""])));
}

/** "1. ...\n2. ..." into its entries, without the numbers. */
function constraintList(text) {
  return `\n${text.trim()}`
    .split(/\n\s*(?=\d+\.\s)/)
    .map(entry => entry.replace(/^\d+\.\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = parseCsv(readFileSync(options.csv, "utf8"));

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.Instruction)) groups.set(row.Instruction, []);
    groups.get(row.Instruction).push(row);
  }

  const ids = [];
  let index = 0;
  for (const [instruction, group] of groups) {
    const sourceId = `sb${String(index).padStart(3, "0")}`;
    const instanceId = `cs4-${sourceId}`;
    const byLevel = new Map(group.map(row => [Number(row.Number_of_Constraints), constraintList(row.SelectedConstraints)]));
    const stories = new Set(group.map(row => row.BaseStory));
    if (stories.size !== 1) throw new Error(`${sourceId}: its rows carry different base stories.`);
    const lists = stages.map(stage => byLevel.get(stage));
    lists.forEach((list, position) => {
      if (!list || list.length !== stages[position]) throw new Error(`${sourceId}: no ${stages[position]}-constraint list.`);
      if (position > 0 && lists[position - 1].some((entry, at) => list[at] !== entry)) {
        throw new Error(`${sourceId}: the ${stages[position]}-list does not begin with the ${stages[position - 1]}-list.`);
      }
    });
    const constraints = lists.at(-1);
    if (new Set(constraints).size !== constraints.length) throw new Error(`${sourceId}: repeated constraint.`);

    const instance = {
      instanceId,
      source: "official",
      instruction: instruction.trim(),
      baseStory: [...stories][0].trim(),
      constraints,
      datasetRef: `CS4 story-based set, instruction ${index + 1} (${sourceId}); CS4_dataset/Story-based Base Stories.csv, github.com/anirudhlakkaraju/cs4_benchmark (MIT)`,
      notes: "Constraints are the dataset's 23-constraint list for this instruction; its 7- and 15-constraint lists are exact prefixes of it, which the round stages rely on."
    };
    writeFileSync(join(directory, "items", `${instanceId}.json`), `${JSON.stringify(instance, null, 2)}\n`);
    ids.push(instanceId);
    index += 1;
  }

  const pilot = options.pilot
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => (id.startsWith("cs4-") ? id : `cs4-${id}`));
  for (const id of pilot) if (!ids.includes(id)) throw new Error(`--pilot names ${id}, which the CSV does not have.`);

  const manifest = { taskId: "cs4-creative-writing", items: [fixtureId, ...ids], pilotSubset: pilot };
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${ids.length} instances; pilot subset ${pilot.length}: ${pilot.join(", ")}`);
}

main();
