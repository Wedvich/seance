import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearOnNewTurn,
  createCustodianFlags,
  deliverEvent,
  isNewTurn,
  isTurnFlag,
  liftEntry,
  retainFrame,
} from "./custodian-flags.ts";

let dir = "";
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-flags-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(start = 100) {
  const clock = { now: start };
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

describe("clear with `only`", () => {
  test("leaves an entry a round changed while the caller's send was out", async () => {
    const s = store();
    await s.flags.set("t-1", "stuck", "a");
    const seen = await s.flags.get("t-1");
    if (seen === null) throw new Error("no entry");
    await s.flags.set("t-1", "stuck", "b");
    expect(await s.flags.clear("t-1", seen)).toBe(false);
    expect(await s.flags.get("t-1")).toEqual({ reason: "stuck", note: "b", at: 100 });
    const now = await s.flags.get("t-1");
    if (now === null) throw new Error("no entry");
    expect(await s.flags.clear("t-1", now)).toBe(true);
  });
});

describe("stale", () => {
  test("names the entries whose session is gone and deletes none, writing nothing", async () => {
    const s = store();
    await s.flags.set("t-1", "stuck", undefined);
    await s.flags.set("t-2", "look", undefined);
    await s.flags.set("%7", "look", undefined);
    const before = (await stat(s.path)).mtimeMs;
    await Bun.sleep(15);
    expect((await s.flags.stale(live(["t-2"], ["%7"]))).map(([key]) => key)).toEqual(["t-1"]);
    expect(await s.flags.get("t-1")).not.toBeNull();
    expect((await s.flags.stale(live([], []))).map(([key]) => key)).toEqual(["t-1", "t-2", "%7"]);
    expect((await stat(s.path)).mtimeMs).toBe(before);
  });

  test("nothing when every session is live", async () => {
    const s = store();
    await s.flags.set("t-1", "look", undefined);
    expect(await s.flags.stale(live(["t-1"]))).toEqual([]);
  });
});

describe("liftEntry", () => {
  test("clears the entry only once the unflag was taken; a send nothing took keeps it", async () => {
    const s = store();
    await s.flags.set("t-1", "stuck", undefined);
    const entry = await s.flags.get("t-1");
    if (entry === null) throw new Error("no entry");
    const sent: unknown[] = [];
    let taken = false;
    const deps = {
      flags: s.flags,
      now: () => 7,
      send: (event: unknown): Promise<boolean> => {
        sent.push(event);
        return Promise.resolve(taken);
      },
    };
    expect(await liftEntry(deps, "t-1", entry)).toBe(false);
    expect(await s.flags.get("t-1")).not.toBeNull();
    taken = true;
    expect(await liftEntry(deps, "t-1", entry)).toBe(true);
    expect(await s.flags.get("t-1")).toBeNull();
    expect(sent).toEqual([
      { kind: "unflag", taskId: "t-1", at: 7 },
      { kind: "unflag", taskId: "t-1", at: 7 },
    ]);
  });

  test("a pane-keyed entry has no record to tell: it is cleared and nothing is sent", async () => {
    const s = store();
    await s.flags.set("%7", "look", undefined);
    const entry = await s.flags.get("%7");
    if (entry === null) throw new Error("no entry");
    const send = (): Promise<boolean> => Promise.reject(new Error("must not send"));
    expect(await liftEntry({ flags: s.flags, now: () => 1, send }, "%7", entry)).toBe(true);
    expect(await s.flags.get("%7")).toBeNull();
  });
});

describe("liftEntry against a repeat flag", () => {
  test("an entry a round flagged again while the unflag was out stays, though the repeat changed nothing", async () => {
    const s = store();
    await s.flags.set("t-1", "stuck", "same");
    const entry = await s.flags.get("t-1");
    if (entry === null) throw new Error("no entry");
    const deps = {
      flags: s.flags,
      now: () => 7,
      // The round's identical flag lands while the unflag is out: the entry is byte for byte what it was.
      send: async (): Promise<boolean> => {
        expect(await s.flags.set("t-1", "stuck", "same")).toBe("same");
        return true;
      },
    };
    expect(await liftEntry(deps, "t-1", entry)).toBe(true);
    expect(await s.flags.get("t-1")).toEqual(entry);
  });
});

describe("clearOnNewTurn", () => {
  function rig(over: { send?: ((event: unknown) => Promise<boolean>) | null; taken?: boolean } = {}) {
    const s = store();
    const sent: unknown[] = [];
    const warnings: string[] = [];
    const taken = over.taken ?? true;
    const send =
      over.send === null
        ? undefined
        : (over.send ??
          ((event: unknown): Promise<boolean> => {
            sent.push(event);
            return Promise.resolve(taken);
          }));
    const run = (key: string, taskId: string | null) =>
      clearOnNewTurn({ flags: s.flags, send, now: () => 9, warn: (line) => warnings.push(line) }, key, taskId);
    return { s, sent, warnings, run };
  }

  test("a stuck or look flag is unflagged and its entry goes", async () => {
    for (const reason of ["stuck", "look"] as const) {
      const r = rig();
      await r.s.flags.set("t-1", reason, "n");
      await r.run("t-1", "t-1");
      expect(r.sent).toEqual([{ kind: "unflag", taskId: "t-1", at: 9 }]);
      expect(await r.s.flags.get("t-1")).toBeNull();
    }
  });

  test("dirty and unpushed are about the worktree: a new turn sends nothing and keeps them", async () => {
    for (const reason of ["dirty", "unpushed"] as const) {
      const r = rig();
      await r.s.flags.set("t-1", reason, undefined);
      await r.run("t-1", "t-1");
      expect(r.sent).toEqual([]);
      expect(await r.s.flags.get("t-1")).toMatchObject({ reason });
    }
  });

  test("an untasked pane's entry is cleared with nothing sent: it has no record", async () => {
    const r = rig();
    await r.s.flags.set("%3", "look", undefined);
    await r.run("%3", null);
    expect(r.sent).toEqual([]);
    expect(await r.s.flags.get("%3")).toBeNull();
  });

  test("no entry sends nothing, and no seat to send through changes nothing", async () => {
    const none = rig();
    await none.run("t-1", "t-1");
    expect(none.sent).toEqual([]);

    const noSeat = rig({ send: null });
    await noSeat.s.flags.set("t-1", "stuck", undefined);
    await noSeat.run("t-1", "t-1");
    expect(await noSeat.s.flags.get("t-1")).not.toBeNull();
  });

  test("an unflag nothing took keeps the entry and warns; one that throws only warns, without its text", async () => {
    const down = rig({ taken: false });
    await down.s.flags.set("t-1", "stuck", undefined);
    await down.run("t-1", "t-1");
    expect(await down.s.flags.get("t-1")).not.toBeNull();
    expect(down.warnings.join("\n")).toContain("was not taken");

    const throws = rig({ send: () => Promise.reject(new Error("SECRET-NOTE")) });
    await throws.s.flags.set("t-1", "stuck", undefined);
    await throws.run("t-1", "t-1");
    expect(await throws.s.flags.get("t-1")).not.toBeNull();
    expect(throws.warnings.join("\n")).not.toContain("SECRET-NOTE");
  });
});

describe("isTurnFlag", () => {
  test("stuck and look are about the turn; dirty and unpushed are about the worktree", () => {
    expect(isTurnFlag({ reason: "stuck", at: 1 })).toBe(true);
    expect(isTurnFlag({ reason: "look", at: 1 })).toBe(true);
    expect(isTurnFlag({ reason: "dirty", at: 1 })).toBe(false);
    expect(isTurnFlag({ reason: "unpushed", at: 1 })).toBe(false);
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

describe("session counts", () => {
  test("survive a restart, beside the flags, and hold only for the pid they were counted for", async () => {
    const s = store();
    await s.flags.set("t-1", "stuck", "hung");
    await s.flags.setCounts("t-1", { pid: 41, nudges: 2, interrupted: true, round: "%90" });
    await s.flags.setCounts("%7", { pid: 42, nudges: 0, interrupted: true, round: null });
    const again = s.open();
    expect(await again.counts("t-1", 41)).toEqual({ pid: 41, nudges: 2, interrupted: true, round: "%90" });
    // A pane-keyed count survives a load, unlike a pane-keyed flag: the pid says whether it is the same session.
    expect(await again.counts("%7", 42)).toEqual({ pid: 42, nudges: 0, interrupted: true, round: null });
    // Another pid is another session (a continuation in a new pane, a reused pane id): it starts at zero.
    expect(await again.counts("t-1", 99)).toEqual({ pid: 99, nudges: 0, interrupted: false, round: null });
    expect(await again.get("t-1")).toMatchObject({ reason: "stuck" });
    expect((await stat(s.path)).mode & 0o777).toBe(0o600);
  });

  test("a file from before custodian 8 has none, and a bad count is dropped alone", async () => {
    const s = store();
    await s.flags.setCounts("t-1", { pid: 41, nudges: 1, interrupted: false, round: null });
    const text = JSON.parse(await readFile(s.path, "utf8"));
    text.counts["t-2"] = { pid: 41, nudges: -1, interrupted: false, round: null };
    text.counts["not a key"] = { pid: 41, nudges: 1, interrupted: false, round: null };
    await writeFile(s.path, JSON.stringify(text));
    const again = s.open();
    expect((await again.counts("t-1", 41)).nudges).toBe(1);
    expect((await again.counts("t-2", 41)).nudges).toBe(0);

    await writeFile(s.path, JSON.stringify({ v: 1, flags: {} }));
    expect((await s.open().counts("t-1", 41)).nudges).toBe(0);
  });

  test("a prune drops every count no live pane carries with that pid, and leaves the flags", async () => {
    const s = store();
    await s.flags.set("t-gone", "look", undefined);
    await s.flags.setCounts("t-live", { pid: 41, nudges: 1, interrupted: false, round: null });
    await s.flags.setCounts("t-gone", { pid: 42, nudges: 1, interrupted: false, round: null });
    await s.flags.setCounts("t-moved", { pid: 43, nudges: 3, interrupted: true, round: null });
    const pruned = await s.flags.pruneCounts(
      new Map([
        ["t-live", new Set([41])],
        ["t-moved", new Set([77])],
      ]),
    );
    expect(pruned).toBe(2);
    const again = s.open();
    expect((await again.counts("t-live", 41)).nudges).toBe(1);
    expect((await again.counts("t-gone", 42)).nudges).toBe(0);
    expect((await again.counts("t-moved", 43)).nudges).toBe(0);
    expect(await again.get("t-gone")).not.toBeNull();
    await s.flags.setCounts("t-live", null);
    expect((await s.open().counts("t-live", 41)).nudges).toBe(0);
  });
});

describe("isNewTurn", () => {
  test("a busy after an idle is a new turn, whether or not the idle ended one (a respawn's does not)", () => {
    expect(isNewTurn({ state: "idle" }, "busy")).toBe(true);
  });

  test("a busy with no state retained is not one: a restart, a reload or a failed seat leaves none, and a stuck session sends busy after every permission", () => {
    expect(isNewTurn(null, "busy")).toBe(false);
    expect(isNewTurn({ state: null }, "busy")).toBe(false);
  });

  test("busy to busy and needs-input to busy are the same turn", () => {
    expect(isNewTurn({ state: "busy" }, "busy")).toBe(false);
    expect(isNewTurn({ state: "needs-input" }, "busy")).toBe(false);
  });

  test("only a busy frame starts one", () => {
    expect(isNewTurn({ state: "idle" }, "idle")).toBe(false);
    expect(isNewTurn({ state: "idle" }, "needs-input")).toBe(false);
    expect(isNewTurn(null, "idle")).toBe(false);
  });
});

describe("retainFrame", () => {
  const pane = (ours: boolean) => ({ id: "%1", ours, taskId: "t-1" });
  function rig(held: { state: "idle" | "busy" | "needs-input" | null } | null) {
    const calls: string[] = [];
    let lift: ((p: ReturnType<typeof pane>) => void) | undefined = (p) => calls.push(`lift ${p.id}`);
    const retain = retainFrame({
      activity: () => {
        calls.push("read");
        return held;
      },
      observe: () => calls.push("observe"),
      onNewTurn: () => lift,
    });
    return { retain, calls, noStore: () => (lift = undefined) };
  }

  test("reads the retained state before observe replaces it, then lifts on a new turn", () => {
    const r = rig({ state: "idle" });
    r.retain(pane(true), "busy", false);
    expect(r.calls).toEqual(["read", "observe", "lift %1"]);
  });

  test("the same turn lifts nothing, and a pane séance did not start is neither read nor lifted", () => {
    const same = rig({ state: "busy" });
    same.retain(pane(true), "busy", false);
    expect(same.calls).toEqual(["read", "observe"]);

    const foreign = rig({ state: "idle" });
    foreign.retain(pane(false), "busy", false);
    expect(foreign.calls).toEqual(["observe"]);

    // A pane this process has no state for is unobserved, never a new turn.
    const unobserved = rig(null);
    unobserved.retain(pane(true), "busy", false);
    expect(unobserved.calls).toEqual(["read", "observe"]);
  });

  test("frames are still retained while no seat holds the flag store", () => {
    const r = rig({ state: "idle" });
    r.noStore();
    r.retain(pane(true), "busy", false);
    expect(r.calls).toEqual(["read", "observe"]);
  });
});

describe("deliverEvent", () => {
  const event = { kind: "failing", at: 1 } as const;

  test("a leading machine answers with what its running term said, and never touches the relay", async () => {
    const relay = (): Promise<boolean> => Promise.reject(new Error("must not go to the relay"));
    expect(await deliverEvent({ leads: () => true, inProcess: () => Promise.resolve(false), relay }, event)).toBe(
      false,
    );
    expect(await deliverEvent({ leads: () => true, inProcess: () => Promise.resolve(true), relay }, event)).toBe(true);
  });

  test("a following machine seals it to the scheduler", async () => {
    const sent: unknown[] = [];
    const reply = await deliverEvent(
      {
        leads: () => false,
        inProcess: () => {
          throw new Error("no term here");
        },
        relay: (e) => {
          sent.push(e);
          return Promise.resolve(true);
        },
      },
      event,
    );
    expect(reply).toBe(true);
    expect(sent).toEqual([event]);
  });
});
