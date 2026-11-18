import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedWatches, type SavedWatch, writeSavedWatches } from "./watches-store.ts";

const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const ID2 = "6f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c12";
const HEAD = "a".repeat(40);

const pr: SavedWatch = {
  id: ID,
  kind: "pr",
  url: "https://github.com/octo/widgets/pull/42",
  head: HEAD,
  seen: ["merged", `checks:${HEAD}:pass`],
  pane: "%3",
  panePid: 1234,
  paneStart: "Wed Nov 18 10:00:00 2026",
  session: "1240:Wed Nov 18 10:00:01 2026",
  task: "t-0123456789abcdef",
  madeAt: 1_000,
  expiresAt: 2_000,
  noLeaderTold: false,
  fleetFullTold: true,
};
const run: SavedWatch = {
  ...pr,
  id: ID2,
  kind: "run",
  url: "https://github.com/octo/widgets/actions/runs/123",
  seen: [],
  task: null,
};
const { head: _head, ...runNoHead } = run;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-watches-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const warnings: string[] = [];
const warn = (line: string): void => {
  warnings.push(line);
};
beforeEach(() => {
  warnings.length = 0;
});

describe("watches.json", () => {
  test("round-trips, at mode 0600", async () => {
    const path = join(dir, "nested", "watches.json");
    await writeSavedWatches(path, [pr, runNoHead]);
    expect(await readSavedWatches(path, warn)).toEqual([pr, runNoHead]);
    expect(warnings).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a missing file is an empty table, without a warning", async () => {
    expect(await readSavedWatches(join(dir, "none.json"), warn)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("a corrupt file warns, with no content in the line, and reads empty", async () => {
    const path = join(dir, "watches.json");
    await writeFile(path, "SECRET-NOT-JSON{");
    expect(await readSavedWatches(path, warn)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("SECRET");
    await writeFile(path, JSON.stringify({ v: 2, watches: [] }));
    expect(await readSavedWatches(path, warn)).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  test("each malformed field drops that entry alone", async () => {
    const bad: Record<string, unknown>[] = [
      { id: "nope" },
      { url: "https://github.com/octo/widgets/pull/x" },
      { url: "https://example.com/octo/widgets/pull/42" },
      { kind: "issue" },
      { head: "abc" },
      { seen: ["checks:bad"] },
      { seen: ["merged", "closed", "merged", "closed", "merged", "closed", "merged", "closed", "merged"] },
      { seen: ["no_leader"] },
      { seen: "merged" },
      { pane: "3" },
      { panePid: 0 },
      { panePid: 1.5 },
      { paneStart: "" },
      { session: "nocolon" },
      { task: 3 },
      { madeAt: "1" },
      { expiresAt: 1.5 },
      { noLeaderTold: "no" },
      { fleetFullTold: undefined },
    ];
    const path = join(dir, "watches.json");
    for (const patch of bad) {
      // oxlint-disable-next-line no-await-in-loop -- one file per case
      await writeFile(path, JSON.stringify({ v: 1, watches: [{ ...pr, ...patch }, runNoHead] }));
      // oxlint-disable-next-line no-await-in-loop -- one file per case
      expect(await readSavedWatches(path, warn)).toEqual([runNoHead]);
    }
    expect(warnings).toEqual([]);
  });

  test("a URL whose kind disagrees, and a head beside a run, drop the entry", async () => {
    const path = join(dir, "watches.json");
    const mismatched = [
      { ...pr, kind: "run" },
      { ...run, kind: "pr" },
      { ...run, head: HEAD },
    ];
    await writeFile(path, JSON.stringify({ v: 1, watches: [...mismatched, pr] }));
    expect(await readSavedWatches(path, warn)).toEqual([pr]);
  });
});
