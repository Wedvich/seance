import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustodianAudit } from "./audit.ts";
import { DespawnFailure } from "./backend.ts";
import { CUSTODIAN_DEFAULTS } from "./config.ts";
import type { CloseRefusal, CustodianReply, KeptWhy } from "./custodian-frame.ts";
import {
  closeVerdict,
  createCustodianVerbs,
  pruneNotes,
  type CloseVerdictInput,
  type CustodianVerbDeps,
} from "./custodian-verbs.ts";
import type { WorktreeOutcome } from "./custodian-worktree.ts";
import type { PaneActivity } from "./pane-activity.ts";
import type { PaneInfo, PaneState } from "./sessions.ts";

const NOW = 10_000_000_000;
const MIN = 60_000;
const CLOSE_AFTER = CUSTODIAN_DEFAULTS.closeAfterMinutes * MIN;
const ROUND = "%90";

const info = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  paneId: "%1",
  windowId: "@1",
  windowName: "work",
  ours: true,
  dead: false,
  deadAt: null,
  deadStatus: null,
  titled: true,
  command: "claude",
  path: "/work/repo",
  taskId: null,
  custodian: false,
  pid: 4242,
  ...over,
});

const rested = (over: Partial<PaneActivity> = {}): PaneActivity => ({
  state: "idle",
  stateSince: NOW - CLOSE_AFTER,
  turnEnded: true,
  screenSince: NOW - CLOSE_AFTER,
  sampledAt: NOW,
  ...over,
});

const verdict = (over: Partial<CloseVerdictInput> = {}): ReturnType<typeof closeVerdict> =>
  closeVerdict({
    info: info(),
    state: "live",
    activity: rested(),
    untouchable: false,
    now: NOW,
    closeAfterMs: CLOSE_AFTER,
    ...over,
  });

describe("closeVerdict", () => {
  test("a live pane whose turn ended and has stood long enough is despawned", () => {
    expect(verdict()).toBe("despawn");
  });

  test("a live pane is refused by what the daemon saw, never by the screen", () => {
    expect(verdict({ activity: null })).toBe("unobserved");
    expect(verdict({ activity: rested({ state: null, stateSince: null }) })).toBe("unobserved");
    expect(verdict({ activity: rested({ state: "ended" }) })).toBe("unobserved");
    expect(verdict({ activity: rested({ turnEnded: false }) })).toBe("unobserved");
    expect(verdict({ activity: rested({ state: "busy" }) })).toBe("busy");
    expect(verdict({ activity: rested({ state: "needs-input" }) })).toBe("waiting");
    expect(verdict({ activity: rested({ stateSince: NOW - CLOSE_AFTER + 1 }) })).toBe("too_soon");
  });

  test("foreign and the round's own pane are never touched, and a mark outranks the state", () => {
    expect(verdict({ info: info({ ours: false }) })).toBe("foreign");
    expect(verdict({ info: info({ custodian: true }) })).toBe("marked");
    expect(verdict({ untouchable: true })).toBe("marked");
    expect(verdict({ info: info({ ours: false, custodian: true }) })).toBe("marked");
  });

  test("a dead pane of a registered task is harvested, any other waits out reap's age and is then killed", () => {
    expect(verdict({ state: "dead", info: info({ dead: true, taskId: "t-1", titled: true, deadAt: NOW }) })).toBe(
      "harvest",
    );
    const bare = info({ dead: true, titled: false, deadAt: NOW - 59_999 });
    expect(verdict({ state: "dead", info: bare })).toBe("too_soon");
    expect(verdict({ state: "dead", info: { ...bare, deadAt: null } })).toBe("too_soon");
    expect(verdict({ state: "dead", info: { ...bare, deadAt: NOW - 60_000 } })).toBe("kill");
  });

  test("the other classifications: a shell or an unstarted pane is unobserved, a prompt is waiting or answered", () => {
    for (const state of ["shell", "starting"] as const) expect(verdict({ state })).toBe("unobserved");
    expect(verdict({ state: "background-prompt" })).toBe("waiting");
    expect(verdict({ state: "exit-prompt" })).toBe("despawn");
  });
});

describe("pruneNotes", () => {
  const live = { taskIds: new Set(["t-1"]), panes: new Set(["%3"]) };

  test("keeps standing, a live task and a live pane, in order, and drops everything else", () => {
    const text = [
      "stray preamble",
      "## standing",
      "lesson",
      "## t-1",
      "watching CI",
      "## t-2",
      "a task that is gone",
      "## %3",
      "pane note",
      "## %4",
      "a pane that is gone",
      "## standing",
      "a repeat",
    ].join("\n");
    const pruned = pruneNotes(text, live);
    expect(pruned.kept).toEqual(["standing", "t-1", "%3"]);
    expect(pruned.dropped).toBe(4);
    expect(pruned.text).toBe("## standing\nlesson\n\n## t-1\nwatching CI\n\n## %3\npane note\n");
  });

  test("CRLF is read as LF, and text with no section keeps nothing", () => {
    expect(pruneNotes("## standing\r\nlesson\r\n", live).text).toBe("## standing\nlesson\n");
    expect(pruneNotes("just words", live)).toEqual({ text: "", kept: [], dropped: 1 });
  });

  test("a heading with more words after the key is body text of the section before it, not a section", () => {
    expect(pruneNotes("## standing\n## t-1 extra\n", live).text).toBe("## standing\n## t-1 extra\n");
  });
});

interface Rig {
  readonly verbs: ReturnType<typeof createCustodianVerbs>;
  readonly lines: string[];
  readonly warnings: string[];
  readonly calls: string[];
  readonly counts: string[];
  readonly state: {
    panes: PaneInfo[];
    states: Map<string, PaneState>;
    screen: string | null;
    done: boolean;
    round: string | null;
    worktree: WorktreeOutcome | null;
    peersNamed: boolean;
    doneAnswer: "ok" | "too_late" | "no_round";
    despawnError: Error | null;
    killed: boolean;
  };
}

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-verbs-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RULE = "─".repeat(60);
/** Claude Code's screen: the transcript, then the input box between two full-width rules. */
const boxScreen = (box: string, after = ""): string =>
  `earlier output\n${RULE}\n${box}\n${RULE}\n  ? for shortcuts${after}`;
const EMPTY_BOX = boxScreen("❯ ");

/** Every fact a verb reads is a seam, so each test says only what it differs in. */
function rig(over: Partial<CustodianVerbDeps> = {}, notesName = "notes.md"): Rig {
  const lines: string[] = [];
  const warnings: string[] = [];
  const calls: string[] = [];
  const counts: string[] = [];
  const state: Rig["state"] = {
    panes: [info({ taskId: "t-1" })],
    states: new Map(),
    screen: EMPTY_BOX,
    done: false,
    round: ROUND,
    worktree: null,
    peersNamed: true,
    doneAnswer: "ok",
    despawnError: null,
    killed: true,
  };
  const push =
    (name: string) =>
    (...args: readonly unknown[]): Promise<void> => {
      lines.push(`${name} ${args.map((arg) => String(arg ?? "-")).join(" ")}`);
      return Promise.resolve();
    };
  const audit: CustodianAudit = {
    start: push("start"),
    kill: push("kill"),
    end: push("end"),
    close: push("close"),
    removedWorktree: push("removed"),
    keptWorktree: push("kept"),
  };
  const deps: CustodianVerbDeps = {
    roundPane: () => state.round,
    roundPanePids: () => Promise.resolve(new Map([[process.pid, ROUND]])),
    hostNamesPeers: () => state.peersNamed,
    listPanes: () => Promise.resolve(state.panes),
    paneInfo: (pane) => Promise.resolve(state.panes.find((p) => p.paneId === pane) ?? null),
    classifyPane: (pane) => Promise.resolve(state.states.get(pane.paneId) ?? "live"),
    capture: () => Promise.resolve(state.screen),
    activity: () => rested(),
    retainedSince: () => NOW - 3 * CLOSE_AFTER,
    untouchable: () => false,
    tasks: {
      worktree: () => ({ refused: "none" }),
      prUrl: () => undefined,
      closing: (taskId) => {
        calls.push(`closing ${taskId}`);
        return Promise.resolve();
      },
      harvestExits: () => {
        calls.push("harvest");
        state.panes = state.panes.filter((p) => !p.dead);
        return Promise.resolve();
      },
    },
    worktree: {
      touchedAt: () => Promise.resolve(null),
      decide: () => Promise.resolve(state.worktree),
    },
    despawn: (pane) => {
      calls.push(`despawn ${pane}`);
      if (state.despawnError !== null) return Promise.reject(state.despawnError);
      state.panes = state.panes.filter((p) => p.paneId !== pane);
      return Promise.resolve({ window: "work", outcome: "exited" });
    },
    killPane: (pane) => {
      calls.push(`kill ${pane}`);
      if (state.killed) state.panes = state.panes.filter((p) => p.paneId !== pane);
      return Promise.resolve(state.killed);
    },
    readRefusals: () => Promise.resolve({ refusals: [] }),
    notesPath: join(dir, notesName),
    seat: {
      count: (verb, ok) => counts.push(`${verb} ${ok ? "ok" : "refused"}`),
      countWorktree: (kind) => counts.push(`worktree ${kind}`),
      done: () => Promise.resolve(state.doneAnswer),
      isDone: () => state.done,
    },
    settings: CUSTODIAN_DEFAULTS,
    now: () => NOW,
    audit,
    onKept: (pane, taskId, why) => calls.push(`onKept ${pane} ${taskId} ${why}`),
    warn: (line) => warnings.push(line),
    ...over,
  };
  return { verbs: createCustodianVerbs(deps), lines, warnings, calls, counts, state };
}

const close = (pane = "%1"): unknown => ({ v: 1, kind: "custodian", verb: "close", pane });
const sessions = { v: 1, kind: "custodian", verb: "sessions" };
const notes = (text: string): unknown => ({ v: 1, kind: "custodian", verb: "notes", text });
const done = (summary: string): unknown => ({ v: 1, kind: "custodian", verb: "done", summary });

/** A process whose parent is this test's, as a round's Bash child is the round pane's descendant. */
async function childPid(): Promise<{ readonly pid: number; readonly stop: () => void }> {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  return { pid: child.pid, stop: () => child.kill() };
}

describe("who a custodian frame is acted on for", () => {
  test("a process under the round's pane is, by the real parent walk", async () => {
    const r = rig();
    const child = await childPid();
    try {
      const reply = await r.verbs.handle(sessions, child.pid);
      expect(reply).toMatchObject({ ok: true, verb: "sessions" });
    } finally {
      child.stop();
    }
  });

  test("nothing else is: no peer, a host that names none, no round, or a process under no round pane", async () => {
    const act = close();
    const refused: CustodianReply = { ok: false, code: "not_custodian" };

    const noPeer = rig();
    expect(await noPeer.verbs.handle(act, null)).toEqual(refused);

    const blind = rig();
    blind.state.peersNamed = false;
    expect(await blind.verbs.handle(act, process.pid)).toEqual(refused);

    const idle = rig();
    idle.state.round = null;
    expect(await idle.verbs.handle(act, process.pid)).toEqual(refused);

    const other = rig({ roundPanePids: () => Promise.resolve(new Map([[1, ROUND]])) });
    expect(await other.verbs.handle(act, process.pid)).toEqual(refused);

    // A pane tagged as a round that the seat record does not name as running is no round either.
    const stale = rig({ roundPanePids: () => Promise.resolve(new Map([[process.pid, "%91"]])) });
    expect(await stale.verbs.handle(act, process.pid)).toEqual(refused);

    for (const each of [noPeer, blind, idle, other, stale]) {
      expect(each.calls).toEqual([]);
      expect(each.counts).toEqual([]);
      expect(each.warnings.join("\n")).toContain("refused a close frame");
    }
    expect(noPeer.lines).toEqual(["close %1 - not_custodian"]);
  });

  test("a loop of frames from one process writes one refusal a minute, and a crowd of them a bounded number", async () => {
    const clock = { now: NOW };
    const r = rig({ now: () => clock.now, hostNamesPeers: () => false });
    for (let at = 0; at < 50; at += 1) {
      expect(await r.verbs.handle(close(), 4_000)).toEqual({ ok: false, code: "not_custodian" });
    }
    expect(r.lines).toEqual(["close %1 - not_custodian"]);
    expect(r.warnings).toHaveLength(1);

    clock.now += 61_000;
    await r.verbs.handle(close(), 4_000);
    expect(r.lines).toHaveLength(2);

    for (let pid = 5_000; pid < 5_100; pid += 1) await r.verbs.handle(close(), pid);
    expect(r.lines.length).toBeLessThanOrEqual(21);
  });

  test("an unreadable tmux is an error for the socket to answer internal, never a pane's absence", async () => {
    const r = rig({ roundPanePids: () => Promise.reject(new Error("tmux down")) });
    await expect(r.verbs.handle(sessions, process.pid)).rejects.toThrow("tmux down");
  });

  test("a frame that does not parse is invalid before anything is asked", async () => {
    const r = rig({ roundPanePids: () => Promise.reject(new Error("must not be asked")) });
    expect(await r.verbs.handle({ v: 1, kind: "custodian", verb: "close", pane: "not-a-pane" }, process.pid)).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(await r.verbs.handle({ v: 1, kind: "custodian", verb: "nudge" }, process.pid)).toEqual({
      ok: false,
      code: "invalid",
    });
  });
});

describe("sessions", () => {
  test("lists each pane with the daemon's facts and the verdict a close would get", async () => {
    const r = rig({
      tasks: {
        worktree: () => ({ repo: "/work/repo", path: "/work/repo/.claude/worktrees/a" }),
        prUrl: () => "https://github.com/o/r/pull/1",
        closing: () => Promise.resolve(),
        harvestExits: () => Promise.resolve(),
      },
    });
    r.state.panes = [
      info({ taskId: "t-1" }),
      info({ paneId: "%2", ours: false }),
      info({ paneId: "%3", custodian: true }),
    ];
    const reply = await r.verbs.handle(sessions, process.pid);
    if (!reply.ok || reply.verb !== "sessions") throw new Error("not a sessions reply");
    expect(reply.now).toBe(NOW);
    expect(reply.retainedSince).toBe(NOW - 3 * CLOSE_AFTER);
    expect(reply.reapRefusals).toEqual({ refusals: [] });
    expect(reply.panes.map((p) => [p.pane, p.owner, p.close])).toEqual([
      ["%1", "ours", "ok"],
      ["%2", "foreign", "foreign"],
      ["%3", "ours", "marked"],
    ]);
    expect(reply.panes[0]).toMatchObject({
      taskId: "t-1",
      prUrl: "https://github.com/o/r/pull/1",
      worktree: "/work/repo/.claude/worktrees/a",
      state: "idle",
      turnEnded: true,
      stateMinutes: CUSTODIAN_DEFAULTS.closeAfterMinutes,
    });
    expect(r.counts).toEqual(["sessions ok"]);
  });

  test("a failure listing the panes is internal, and counted as refused", async () => {
    const r = rig({ listPanes: () => Promise.reject(new Error("tmux")) });
    expect(await r.verbs.handle(sessions, process.pid)).toEqual({ ok: false, code: "internal" });
    expect(r.counts).toEqual(["sessions refused"]);
  });
});

describe("close", () => {
  test("a finished session is despawned gracefully, closing its task first, audited and counted", async () => {
    const r = rig();
    expect(await r.verbs.handle(close(), process.pid)).toEqual({
      ok: true,
      verb: "close",
      pane: "%1",
      taskId: "t-1",
      outcome: "exited",
      worktree: null,
    });
    expect(r.calls).toEqual(["despawn %1"]);
    expect(r.lines).toEqual(["close %1 t-1 exited"]);
    expect(r.counts).toEqual(["close ok"]);
  });

  test("each refusal is the verdict's and acts on nothing", async () => {
    const cases: readonly [string, (r: Rig) => void, CloseRefusal][] = [
      ["gone", (r) => (r.state.panes = []), "gone"],
      ["foreign", (r) => (r.state.panes = [info({ ours: false })]), "foreign"],
      ["round's own", (r) => (r.state.panes = [info({ custodian: true })]), "marked"],
      ["busy", () => {}, "busy"],
    ];
    for (const [label, arrange, code] of cases) {
      const r = rig(label === "busy" ? { activity: () => rested({ state: "busy" }) } : {});
      arrange(r);
      expect(await r.verbs.handle(close(), process.pid)).toEqual({ ok: false, code });
      expect(r.calls).toEqual([]);
      expect(r.counts).toEqual(["close refused"]);
    }
  });

  test("a hand-off, pass or drain mark refuses it, and so does a close already in flight for the pane", async () => {
    const marked = rig({ untouchable: () => true });
    expect(await marked.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "marked" });

    const gate = Promise.withResolvers<void>();
    const slow = rig({
      despawn: async () => {
        await gate.promise;
        return { window: "work", outcome: "exited" };
      },
    });
    const first = slow.verbs.handle(close(), process.pid);
    await Bun.sleep(20);
    expect(await slow.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "marked" });
    gate.resolve();
    expect(await first).toMatchObject({ ok: true });
  });

  test("a session with a draft in its input box is waiting: the despawn's Escape and Ctrl+C would clear it", async () => {
    for (const screen of [boxScreen("❯ half a reply the owner is typing"), boxScreen("❯ x")]) {
      const r = rig();
      r.state.screen = screen;
      expect(await r.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "waiting" });
      expect(r.calls).toEqual([]);
    }
  });

  test("a prompt suggestion, drawn faint, is not a draft: the session is closed, a typed draft beside it is not", async () => {
    const ghost = rig();
    ghost.state.screen = boxScreen("❯ \u001B[7mc\u001B[0m\u001B[2mommit and push the changes\u001B[0m");
    expect(await ghost.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, outcome: "exited" });

    const typed = rig();
    typed.state.screen = boxScreen("❯ half a reply\u001B[2m and a suggestion\u001B[0m");
    expect(await typed.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "waiting" });
    expect(typed.calls).toEqual([]);
  });

  test("a pane that turns busy while the close reads its worktree is refused before any key goes in", async () => {
    let seen: PaneActivity = rested();
    const r = rig({
      activity: () => seen,
      worktree: {
        touchedAt: () => {
          seen = rested({ state: "busy", turnEnded: false });
          return Promise.resolve(null);
        },
        decide: () => Promise.resolve(null),
      },
    });
    r.state.panes = [info({ taskId: "t-1" })];
    expect(await r.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "busy" });
    expect(r.calls).toEqual([]);
  });

  test("a box that cannot be found, or a screen that cannot be read, fails closed the same way", async () => {
    for (const screen of ["a permission dialog\n1. Yes\n2. No\n", null]) {
      const r = rig();
      r.state.screen = screen;
      expect(await r.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "waiting" });
      expect(r.calls).toEqual([]);
    }
  });

  test("the draft check applies to a live pane only: an exit prompt is answered, a dead pane has no box", async () => {
    const prompt = rig();
    prompt.state.states.set("%1", "exit-prompt");
    prompt.state.screen = "Keep or remove this worktree?\n";
    expect(await prompt.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, outcome: "exited" });

    const dead = rig();
    dead.state.panes = [info({ dead: true, titled: false, deadAt: NOW - 61_000 })];
    dead.state.states.set("%1", "dead");
    dead.state.screen = null;
    expect(await dead.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, outcome: "killed" });
    expect(dead.calls).toEqual(["kill %1"]);
  });

  test("a dead task pane is harvested, so its exit status is noted before it is closed", async () => {
    const r = rig();
    r.state.panes = [info({ dead: true, titled: true, taskId: "t-1", deadAt: NOW })];
    r.state.states.set("%1", "dead");
    expect(await r.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, outcome: "harvested" });
    expect(r.calls).toEqual(["harvest"]);
  });

  test("a kill of an untasked dead pane closes the task first when it has one, and a kill that fails is internal", async () => {
    const r = rig();
    r.state.panes = [info({ dead: true, titled: false, taskId: "t-1", deadAt: NOW - 61_000 })];
    r.state.states.set("%1", "dead");
    r.state.killed = false;
    expect(await r.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "internal" });
    expect(r.calls).toEqual(["closing t-1", "kill %1"]);
    expect(r.warnings.join("\n")).toContain("close of %1 failed");
  });

  test("a despawn that finds the session gone is gone, and any other failure is internal without its text", async () => {
    const gone = rig();
    gone.state.despawnError = new DespawnFailure("session_not_found", "no such pane SECRET-PATH");
    expect(await gone.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "gone" });

    const broke = rig();
    broke.state.despawnError = new Error("tmux said SECRET-PATH");
    expect(await broke.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "internal" });
    expect(`${broke.warnings.join("\n")}${broke.lines.join("\n")}`).not.toContain("SECRET-PATH");
    expect(broke.lines).toEqual(["close %1 t-1 internal"]);
  });

  test("a close after done is refused round_done, and a pane id the daemon cannot parse never gets that far", async () => {
    const r = rig();
    r.state.done = true;
    expect(await r.verbs.handle(close(), process.pid)).toEqual({ ok: false, code: "round_done" });
    expect(r.calls).toEqual([]);
  });

  test("the worktree's outcome is audited and tallied, and only a rule failure reaches the flag seam", async () => {
    const removed = rig();
    removed.state.worktree = { removed: true, how: "merged" };
    expect(await removed.verbs.handle(close(), process.pid)).toMatchObject({
      worktree: { removed: true, how: "merged" },
    });
    expect(removed.lines).toEqual(["close %1 t-1 exited", "removed %1 t-1 merged"]);
    expect(removed.counts).toEqual(["worktree removed", "close ok"]);

    for (const why of [
      "dirty",
      "unpushed",
      "unevaluated",
      "locked",
      "touched",
      "in-use",
    ] as const satisfies readonly KeptWhy[]) {
      const r = rig();
      r.state.worktree = { kept: why };
      expect(await r.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, worktree: { kept: why } });
      expect(r.lines).toEqual(["close %1 t-1 exited", `kept %1 t-1 ${why}`]);
      expect(r.counts).toEqual(["worktree kept", "close ok"]);
      expect(r.calls.filter((c) => c.startsWith("onKept"))).toEqual(
        why === "dirty" || why === "unpushed" ? [`onKept %1 t-1 ${why}`] : [],
      );
    }
  });

  test("the worktree is measured before the session closes and decided after, with the turn's end", async () => {
    const order: string[] = [];
    const r = rig({
      worktree: {
        touchedAt: () => {
          order.push("touched");
          return Promise.resolve(NOW - 1);
        },
        decide: (_task, seen) => {
          order.push(`decide ${seen.turnEndedAt} ${seen.touchedAt}`);
          return Promise.resolve(null);
        },
      },
      despawn: () => {
        order.push("despawn");
        return Promise.resolve({ window: "work", outcome: "exited" });
      },
    });
    await r.verbs.handle(close(), process.pid);
    expect(order).toEqual(["touched", "despawn", `decide ${NOW - CLOSE_AFTER} ${NOW - 1}`]);
  });

  test("a worktree decision that throws keeps the worktree as unevaluated, and the session is still closed", async () => {
    const r = rig({
      worktree: { touchedAt: () => Promise.resolve(null), decide: () => Promise.reject(new Error("git SECRET-PATH")) },
    });
    expect(await r.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, worktree: { kept: "unevaluated" } });
    expect(r.warnings.join("\n")).not.toContain("SECRET-PATH");
  });

  test("an untasked session has no worktree to decide", async () => {
    const r = rig();
    r.state.panes = [info({ taskId: null })];
    r.state.worktree = { removed: true, how: "merged" };
    expect(await r.verbs.handle(close(), process.pid)).toMatchObject({ ok: true, taskId: null, worktree: null });
    expect(r.lines).toEqual(["close %1 - exited"]);
  });
});

describe("notes", () => {
  test("writes the pruned notes 0600 beside a 0700 dir, and says what it kept and dropped", async () => {
    const r = rig({}, "sub/notes.md");
    const reply = await r.verbs.handle(notes("## standing\nlesson\n## t-9\ngone\n## t-1\nwatching\n"), process.pid);
    expect(reply).toEqual({ ok: true, verb: "notes", kept: ["standing", "t-1"], dropped: 1 });
    const path = join(dir, "sub/notes.md");
    expect(await readFile(path, "utf8")).toBe("## standing\nlesson\n\n## t-1\nwatching\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "sub"))).mode & 0o777).toBe(0o700);
    expect(r.counts).toEqual(["notes ok"]);
  });

  test("over the cap, empty, or after done, nothing is written", async () => {
    const r = rig({}, "never.md");
    expect(await r.verbs.handle(notes("x".repeat(8_193)), process.pid)).toEqual({ ok: false, code: "too_long" });
    expect(await r.verbs.handle(notes("  \n"), process.pid)).toEqual({ ok: false, code: "invalid" });
    r.state.done = true;
    expect(await r.verbs.handle(notes("## standing\nx\n"), process.pid)).toEqual({ ok: false, code: "round_done" });
    expect(await Bun.file(join(dir, "never.md")).exists()).toBe(false);
    expect(r.counts).toEqual(["notes refused", "notes refused", "notes refused"]);
  });

  test("a write that fails is internal, and its warning has no text or path", async () => {
    const r = rig({ notesPath: join(dir, "notes.md", "under-a-file") }, "notes.md");
    await Bun.write(join(dir, "notes.md"), "a file where a dir should be");
    expect(await r.verbs.handle(notes("## standing\nSECRET-NOTE\n"), process.pid)).toEqual({
      ok: false,
      code: "internal",
    });
    expect(r.warnings.join("\n")).not.toContain("SECRET-NOTE");
    expect(r.warnings.join("\n")).not.toContain(dir);
  });
});

describe("done", () => {
  test("answers the seat's word: ok, too late, or no round", async () => {
    const r = rig();
    expect(await r.verbs.handle(done("closed one"), process.pid)).toEqual({ ok: true, verb: "done" });
    r.state.doneAnswer = "too_late";
    expect(await r.verbs.handle(done("late"), process.pid)).toEqual({ ok: false, code: "too_late" });
    r.state.doneAnswer = "no_round";
    expect(await r.verbs.handle(done("none"), process.pid)).toEqual({ ok: false, code: "not_custodian" });
    expect(r.counts).toEqual(["done ok", "done refused", "done refused"]);
  });

  test("a summary over 1 KiB is refused before the seat is asked", async () => {
    const r = rig({
      seat: {
        count: () => {},
        countWorktree: () => {},
        done: () => Promise.reject(new Error("must not be asked")),
        isDone: () => false,
      },
    });
    expect(await r.verbs.handle(done("x".repeat(1_025)), process.pid)).toEqual({ ok: false, code: "too_long" });
  });
});

describe("what a screen, the notes and a summary never reach", () => {
  test("no audit line, warning or reply of a close, notes or done holds their text", async () => {
    const r = rig({}, "audit-notes.md");
    r.state.screen = boxScreen("❯ ", "\nSECRET-SCREEN");
    const replies = [
      await r.verbs.handle(close(), process.pid),
      await r.verbs.handle(notes("## standing\nSECRET-NOTE\n"), process.pid),
      await r.verbs.handle(done("SECRET-SUMMARY"), process.pid),
    ];
    const seen = [...r.lines, ...r.warnings, JSON.stringify(replies)].join("\n");
    for (const secret of ["SECRET-SCREEN", "SECRET-NOTE", "SECRET-SUMMARY"]) expect(seen).not.toContain(secret);
  });
});
