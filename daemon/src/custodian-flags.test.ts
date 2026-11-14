import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCustodianFlags, isNewTurn } from "./custodian-flags.ts";

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-flags-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(clock: { now: number } = { now: 100 }) {
  n += 1;
  const path = join(dir, `${n}`, "sessions.json");
  const warnings: string[] = [];
  const open = () => createCustodianFlags({ path, now: () => clock.now, warn: (line) => warnings.push(line) });
  return { path, warnings, open, flags: open(), clock };
}

const live = (taskIds: readonly string[], panes: readonly string[] = []) => ({
  taskIds: new Set(taskIds),
  panes: new Set(panes),
});

describe("set", () => {
  test("a new reason is new, the same reason and note is the same, and a changed note keeps the time", async () => {
    const s = store();
    expect(await s.flags.set("t-1", "stuck", "same error")).toBe("new");
    expect(await s.flags.get("t-1")).toEqual({ reason: "stuck", note: "same error", at: 100 });
    expect(await s.flags.set("t-1", "stuck", "same error")).toBe("same");
    s.clock.now = 200;
    expect(await s.flags.set("t-1", "stuck", "still the same error")).toBe("note");
    expect(await s.flags.get("t-1")).toEqual({ reason: "stuck", note: "still the same error", at: 100 });
    expect(await s.flags.set("t-1", "look", undefined)).toBe("new");
    expect(await s.flags.get("t-1")).toEqual({ reason: "look", at: 200 });
  });

  test("a flag persists 0600 in a 0700 dir and a new instance reads it back", async () => {
    const s = store();
    await s.flags.set("t-1", "look", "a note");
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(s.path, ".."))).mode & 0o777).toBe(0o700);
    expect(await s.open().get("t-1")).toEqual({ reason: "look", note: "a note", at: 100 });
  });

  test("concurrent writes all land: each waits its turn", async () => {
    const s = store();
    await Promise.all(Array.from({ length: 12 }, (_, i) => s.flags.set(`t-${i}`, "look", undefined)));
    const again = s.open();
    for (let i = 0; i < 12; i++) expect(await again.get(`t-${i}`)).not.toBeNull();
  });

  test("a write that fails leaves memory as the disk is", async () => {
    const s = store();
    await s.flags.set("t-1", "look", undefined);
    // A file where its directory should be: the write cannot land.
    const blocked = createCustodianFlags({
      path: join(s.path, "under", "sessions.json"),
      now: () => 1,
      warn: () => {},
    });
    await expect(blocked.set("t-1", "look", undefined)).rejects.toThrow();
    expect(await blocked.get("t-1")).toBeNull();
  });
});

describe("clear", () => {
  test("says whether there was an entry, and writes nothing for a missing key", async () => {
    const s = store();
    expect(await s.flags.clear("t-1")).toBe(false);
    await expect(stat(s.path)).rejects.toThrow();
    await s.flags.set("t-1", "look", undefined);
    expect(await s.flags.clear("t-1")).toBe(true);
    expect(await s.flags.get("t-1")).toBeNull();
    expect(await s.open().get("t-1")).toBeNull();
  });
});

describe("prune", () => {
  test("drops a task whose session is gone and reports its id, and a pane whose pane is gone without one", async () => {
    const s = store();
    await s.flags.set("t-1", "stuck", undefined);
    await s.flags.set("t-2", "look", undefined);
    await s.flags.set("%7", "look", undefined);
    expect(await s.flags.prune(live(["t-2"], ["%7"]))).toEqual(["t-1"]);
    expect(await s.flags.get("t-1")).toBeNull();
    expect(await s.flags.get("t-2")).not.toBeNull();
    expect(await s.flags.get("%7")).not.toBeNull();
    expect(await s.flags.prune(live([], []))).toEqual(["t-2"]);
    expect(await s.flags.get("%7")).toBeNull();
  });

  test("writes only when something went", async () => {
    const s = store();
    await s.flags.set("t-1", "look", undefined);
    const before = (await stat(s.path)).mtimeMs;
    await Bun.sleep(15);
    expect(await s.flags.prune(live(["t-1"]))).toEqual([]);
    expect((await stat(s.path)).mtimeMs).toBe(before);
  });
});

describe("load", () => {
  test("pane-keyed entries are dropped at load: a pane id means nothing after the tmux server restarts", async () => {
    const s = store();
    await s.flags.set("t-1", "look", undefined);
    await s.flags.set("%7", "look", undefined);
    const again = s.open();
    expect(await again.get("t-1")).not.toBeNull();
    expect(await again.get("%7")).toBeNull();
  });

  test("a bad entry is dropped alone, and an unreadable file reads as empty with a warning that holds no content", async () => {
    const s = store();
    await s.flags.set("t-1", "look", "keep");
    const text = JSON.parse(await readFile(s.path, "utf8"));
    text.flags["t-2"] = { reason: "nope", at: 1 };
    await writeFile(s.path, JSON.stringify(text));
    const again = s.open();
    expect(await again.get("t-1")).not.toBeNull();
    expect(await again.get("t-2")).toBeNull();

    await writeFile(s.path, "SECRET-NOTE {not json");
    const empty = s.open();
    expect(await empty.get("t-1")).toBeNull();
    expect(s.warnings.join("\n")).toContain("malformed");
    expect(s.warnings.join("\n")).not.toContain("SECRET-NOTE");
  });
});

describe("isNewTurn", () => {
  const idle = { state: "idle", turnEnded: true } as const;

  test("a busy after an idle that ended a turn is a new turn", () => {
    expect(isNewTurn(idle, "busy")).toBe(true);
  });

  test("busy to busy, needs-input to busy, an idle that did not end a turn, and an unobserved pane are not", () => {
    expect(isNewTurn({ state: "busy", turnEnded: false }, "busy")).toBe(false);
    expect(isNewTurn({ state: "needs-input", turnEnded: false }, "busy")).toBe(false);
    expect(isNewTurn({ state: "idle", turnEnded: false }, "busy")).toBe(false);
    expect(isNewTurn({ state: null, turnEnded: false }, "busy")).toBe(false);
    expect(isNewTurn(null, "busy")).toBe(false);
  });

  test("only a busy frame starts one", () => {
    expect(isNewTurn(idle, "idle")).toBe(false);
    expect(isNewTurn(idle, "needs-input")).toBe(false);
  });
});
