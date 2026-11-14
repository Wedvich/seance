import { describe, expect, test } from "bun:test";
import type { RepoEntry } from "@seance/shared";
import { createWorktreeRule, TOUCH_SLACK_MS, type WorktreeIo } from "./custodian-worktree.ts";
import type { NothingLost, NothingLostInput, WorktreeRecord } from "./reap-git.ts";
import type { PaneInfo } from "./sessions.ts";

const REPO = "/work/repo";
const TREE = `${REPO}/.claude/worktrees/a`;
const ENTRY: RepoEntry = { name: "repo", path: REPO, defaultBranch: "main" };
const TURN_END = 10_000_000_000;

const record = (over: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  path: TREE,
  head: "abc123",
  branch: "feat",
  locked: false,
  prunable: false,
  ...over,
});

interface Rig {
  readonly rule: ReturnType<typeof createWorktreeRule>;
  readonly calls: string[];
  readonly input: { nothingLost: NothingLostInput | null };
}

function rig(
  over: Partial<WorktreeIo> = {},
  opts: {
    readonly noted?: { repo: string; path: string } | { refused: string };
    readonly panes?: () => readonly PaneInfo[];
    readonly verdict?: NothingLost;
    readonly record?: WorktreeRecord;
    readonly lock?: string;
  } = {},
): Rig {
  const calls: string[] = [];
  const input: Rig["input"] = { nothingLost: null };
  const tree = opts.record ?? record();
  const io: Partial<WorktreeIo> = {
    canonical: (path) => Promise.resolve(path),
    listWorktrees: () =>
      Promise.resolve({
        records: [tree],
        lock: () => (opts.lock === undefined ? null : { reason: opts.lock }),
      }),
    unlock: () => {
      calls.push("unlock");
      return Promise.resolve(true);
    },
    gitDirOf: () => Promise.resolve(`${REPO}/.git/worktrees/a`),
    lastTouched: () => Promise.resolve(TURN_END),
    githubOf: () => Promise.resolve({ owner: "o", name: "r" }),
    nothingLost: (given) => {
      input.nothingLost = given;
      calls.push("nothingLost");
      return Promise.resolve(opts.verdict ?? { kind: "safe", how: "origin" });
    },
    stopMonitor: () => {
      calls.push("stopMonitor");
      return Promise.resolve();
    },
    remove: () => {
      calls.push("remove");
      return Promise.resolve(true);
    },
    ...over,
  };
  const rule = createWorktreeRule({
    tasks: { worktree: () => opts.noted ?? { repo: REPO, path: TREE } },
    repos: () => [ENTRY],
    listPanes: () => Promise.resolve(opts.panes?.() ?? []),
    io,
  });
  return { rule, calls, input };
}

const quiet = { turnEndedAt: TURN_END, touchedAt: TURN_END };
const pane = (path: string): PaneInfo => ({
  paneId: "%1",
  windowId: "@1",
  windowName: "w",
  ours: true,
  dead: false,
  deadAt: null,
  deadStatus: null,
  titled: true,
  command: "claude",
  path,
  taskId: "t-1",
  custodian: false,
  pid: 1,
});

/** A pid that has exited: what a killed claude's lock names. */
async function gonePid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

describe("the worktree a close removes", () => {
  test("is removed when the nothing-lost rule is safe, with the fsmonitor stopped first and never --force", async () => {
    const r = rig();
    expect(await r.rule.decide("t-1", quiet)).toEqual({ removed: true, how: "origin" });
    expect(r.calls).toEqual(["nothingLost", "stopMonitor", "remove"]);
    expect(r.input.nothingLost).toMatchObject({
      repoPath: REPO,
      worktree: TREE,
      tip: "abc123",
      branch: "feat",
      github: { owner: "o", name: "r" },
      fetch: true,
    });
    // The close has no classifyTip verdict.
    expect(r.input.nothingLost).not.toHaveProperty("merged");
  });

  test("a failed rule keeps it with the rule's own reason, an unknown one as unevaluated", async () => {
    expect(await rig({}, { verdict: { kind: "fails", why: "dirty", changes: 2 } }).rule.decide("t-1", quiet)).toEqual({
      kept: "dirty",
    });
    expect(await rig({}, { verdict: { kind: "fails", why: "unpushed" } }).rule.decide("t-1", quiet)).toEqual({
      kept: "unpushed",
    });
    const unknown = rig({}, { verdict: { kind: "unknown", why: "remote" } });
    expect(await unknown.rule.decide("t-1", quiet)).toEqual({ kept: "unevaluated" });
    expect(unknown.calls).toEqual(["nothingLost"]);
  });

  test("a failed git removal keeps it", async () => {
    const r = rig({ remove: () => Promise.resolve(false) });
    expect(await r.rule.decide("t-1", quiet)).toEqual({ kept: "remove-failed" });
  });

  test("nothing is decided for a task with no worktree noted here, or one already gone", async () => {
    expect(await rig({}, { noted: { refused: "here" } }).rule.decide("t-1", quiet)).toBeNull();
    const gone = rig({ listWorktrees: () => Promise.resolve({ records: [], lock: () => null }) });
    expect(await gone.rule.decide("t-1", quiet)).toBeNull();
    expect(gone.calls).toEqual([]);
  });

  test("a path outside its repo's .claude/worktrees, or a symlinked one, or an unscanned repo, is kept untouched", async () => {
    const outside = rig({}, { noted: { repo: REPO, path: "/elsewhere/a" } });
    expect(await outside.rule.decide("t-1", quiet)).toEqual({ kept: "outside" });
    const linked = rig({ canonical: () => Promise.resolve("/real/place") });
    expect(await linked.rule.decide("t-1", quiet)).toEqual({ kept: "outside" });
    const unscanned = rig({}, { noted: { repo: "/other/repo", path: TREE } });
    expect(await unscanned.rule.decide("t-1", quiet)).toEqual({ kept: "unscanned" });
    for (const each of [outside, linked, unscanned]) expect(each.calls).toEqual([]);
  });

  test("a git that cannot list the worktrees keeps it as unevaluated", async () => {
    const r = rig({ listWorktrees: () => Promise.resolve(null) });
    expect(await r.rule.decide("t-1", quiet)).toEqual({ kept: "unevaluated" });
  });
});

describe("a worktree touched after the turn ended (plan review F3)", () => {
  test("is kept when its newest signal is more than the slack past the turn's end, and nothing else runs", async () => {
    const r = rig();
    const seen = { turnEndedAt: TURN_END, touchedAt: TURN_END + TOUCH_SLACK_MS + 1 };
    expect(await r.rule.decide("t-1", seen)).toEqual({ kept: "touched" });
    expect(r.calls).toEqual([]);
  });

  test("is not when it is within the slack, or when no turn end was observed", async () => {
    expect(
      await rig().rule.decide("t-1", { turnEndedAt: TURN_END, touchedAt: TURN_END + TOUCH_SLACK_MS }),
    ).toMatchObject({ removed: true });
    expect(await rig().rule.decide("t-1", { turnEndedAt: null, touchedAt: TURN_END * 2 })).toMatchObject({
      removed: true,
    });
    expect(await rig().rule.decide("t-1", { turnEndedAt: TURN_END, touchedAt: null })).toMatchObject({ removed: true });
  });

  test("touchedAt reads reap's own signals for the ledger's worktree, and null where none can be found", async () => {
    const asked: string[] = [];
    const r = rig({
      lastTouched: (tree, gitDir, aliases) => {
        asked.push(`${tree} ${gitDir} ${aliases.join(",")}`);
        return Promise.resolve(123);
      },
    });
    expect(await r.rule.touchedAt("t-1")).toBe(123);
    expect(asked).toEqual([`${TREE} ${REPO}/.git/worktrees/a ${TREE}`]);
    expect(await rig({ gitDirOf: () => Promise.resolve(null) }).rule.touchedAt("t-1")).toBeNull();
    expect(await rig({}, { noted: { refused: "here" } }).rule.touchedAt("t-1")).toBeNull();
    expect(await rig({}, { noted: { repo: REPO, path: "/elsewhere/a" } }).rule.touchedAt("t-1")).toBeNull();
  });
});

describe("a worktree locked in git (plan review F2)", () => {
  test("Claude's own lock whose process is gone is cleared and the worktree goes through the rule", async () => {
    const pid = await gonePid();
    const r = rig({}, { record: record({ locked: true }), lock: `claude agent agent-1 (pid ${pid})` });
    expect(await r.rule.decide("t-1", quiet)).toMatchObject({ removed: true });
    expect(r.calls).toEqual(["unlock", "nothingLost", "stopMonitor", "remove"]);
  });

  test("a live claude's lock, another reason or an unparseable one is kept, and never unlocked", async () => {
    for (const lock of [`claude agent agent-1 (pid ${process.pid})`, "held by the owner for a reason", ""]) {
      const r = rig({}, { record: record({ locked: true }), lock });
      expect(await r.rule.decide("t-1", quiet)).toEqual({ kept: "locked" });
      expect(r.calls).toEqual([]);
    }
  });

  test("a lock that cannot be cleared is kept locked", async () => {
    const pid = await gonePid();
    const r = rig(
      { unlock: () => Promise.resolve(false) },
      { record: record({ locked: true }), lock: `claude agent agent-1 (pid ${pid})` },
    );
    expect(await r.rule.decide("t-1", quiet)).toEqual({ kept: "locked" });
  });

  test("a touched worktree is kept before its stale lock is cleared", async () => {
    const pid = await gonePid();
    const r = rig({}, { record: record({ locked: true }), lock: `claude agent agent-1 (pid ${pid})` });
    expect(await r.rule.decide("t-1", { turnEndedAt: TURN_END, touchedAt: TURN_END + TOUCH_SLACK_MS + 1 })).toEqual({
      kept: "touched",
    });
    expect(r.calls).toEqual([]);
  });
});

describe("a pane in the worktree", () => {
  test("keeps it before the rule runs, and again if one arrives while the rule's network reads ran", async () => {
    const before = rig({}, { panes: () => [pane(`${TREE}/src`)] });
    expect(await before.rule.decide("t-1", quiet)).toEqual({ kept: "in-use" });
    expect(before.calls).toEqual([]);

    let listed = 0;
    const late = rig({}, { panes: () => (++listed >= 2 ? [pane(TREE)] : []) });
    expect(await late.rule.decide("t-1", quiet)).toEqual({ kept: "in-use" });
    expect(late.calls).toEqual(["nothingLost"]);
  });

  test("a pane in a sibling directory with the same prefix is not in it", async () => {
    const r = rig({}, { panes: () => [pane(`${TREE}-other`)] });
    expect(await r.rule.decide("t-1", quiet)).toMatchObject({ removed: true });
  });
});
