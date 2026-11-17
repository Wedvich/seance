import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedActivity, writeSavedActivity, type SavedActivity } from "./pane-activity-store.ts";

let base: string;
let path: string;
let warnings: string[];
const warn = (line: string): void => {
  warnings.push(line);
};

const entry: SavedActivity = {
  pane: "%3",
  pid: 4242,
  start: "1731840000.123456",
  state: "idle",
  stateSince: 1_000,
  turnEnded: true,
  hash: "12345678901234567890",
  screenSince: 900,
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-act-store-"));
  path = join(base, "custodian", "activity.json");
  warnings = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test("a write reads back, as a 0600 file in a 0700 dir", async () => {
  await writeSavedActivity(path, [entry]);
  expect(await readSavedActivity(path, warn)).toEqual([entry]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(base, "custodian"))).mode & 0o777).toBe(0o700);
  expect(warnings).toEqual([]);
});

test("no file is an empty start, said nothing about", async () => {
  expect(await readSavedActivity(path, warn)).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a corrupt file or one of another shape is an empty start, warned about once", async () => {
  await writeSavedActivity(path, []);
  for (const text of ["{not json", JSON.stringify({ v: 2, panes: [entry] }), JSON.stringify([entry])]) {
    warnings = [];
    // oxlint-disable-next-line no-await-in-loop -- one file, rewritten per case
    await writeFile(path, text);
    // oxlint-disable-next-line no-await-in-loop -- as above
    expect(await readSavedActivity(path, warn)).toEqual([]);
    expect(warnings).toHaveLength(1);
  }
});

test("a malformed entry is dropped alone", async () => {
  await writeSavedActivity(path, []);
  const bad = [
    { ...entry, pane: "3" },
    { ...entry, pid: -1 },
    { ...entry, start: "" },
    { ...entry, state: "done" },
    { ...entry, stateSince: "1000" },
    { ...entry, hash: 7 },
    { ...entry, turnEnded: "yes" },
    { ...entry, screenSince: null },
  ];
  await writeFile(path, JSON.stringify({ v: 1, panes: [...bad, entry] }));
  expect(await readSavedActivity(path, warn)).toEqual([entry]);
  expect(warnings).toEqual([]);
});
