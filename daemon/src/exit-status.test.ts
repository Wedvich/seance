import { describe, expect, test } from "bun:test";
import { pollUntil } from "../test/fixtures.ts";
import { harvestExits, owesExit, whileRegistering } from "./exit-status.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { OOM_WINDOW_MS, type OomProbe } from "./oom-kill.ts";
import { EndedTasks } from "./session-events.ts";
import type { PaneInfo } from "./sessions.ts";

function pane(paneId: string, fields: Partial<PaneInfo> = {}): PaneInfo {
  return {
    paneId,
    windowId: `@${paneId.slice(1)}`,
    windowName: "task",
    ours: true,
    dead: true,
    deadAt: 1,
    deadStatus: 1,
    titled: true,
    command: "claude",
    path: "/wt",
    taskId: `task-${paneId.slice(1)}`,
    pid: null,
    ...fields,
  };
}

describe("harvestExits", () => {
  test("notes a dead task pane's status before closing it, and leaves every other pane alone", async () => {
    const events: string[] = [];
    await harvestExits({
      list: () =>
        Promise.resolve([
          pane("%1", { deadStatus: 3 }),
          // A signal death: nothing to note, but the pane is still ours to close.
          pane("%2", { deadStatus: null }),
          pane("%3", { dead: false, deadStatus: null }),
          // Died before registering: spawn's own, which captures it.
          pane("%4", { titled: false }),
          pane("%5", { ours: false }),
          pane("%6", { taskId: null }),
        ]),
      note: (taskId, exit) => {
        events.push(`note ${taskId} ${exit}`);
        return Promise.resolve(true);
      },
      close: (closing) => {
        events.push(`close ${closing.paneId}`);
        return Promise.resolve();
      },
    });
    expect(events.toSorted()).toEqual(["close %1", "close %2", "note task-1 3"]);
    // Closed first, the pane would take the status with it.
    expect(events.indexOf("note task-1 3")).toBeLessThan(events.indexOf("close %1"));
  });

  test("a failed pane read harvests nothing and does not throw", async () => {
    let touched = false;
    await harvestExits({
      list: () => Promise.reject(new Error("protocol version mismatch")),
      note: () => Promise.resolve((touched = true)),
      close: () => Promise.resolve((touched = true)),
    });
    expect(touched).toBe(false);
  });

  test("a pane whose task is not in this ledger is closed, its status having nowhere to go; one a spawn still awaits is left to it", async () => {
    const closed: string[] = [];
    const deps = {
      list: () => Promise.resolve([pane("%1"), pane("%2", { windowId: "@awaited" })]),
      note: (taskId: string) => Promise.resolve(taskId !== "task-1"),
      close: (p: { paneId: string }) => Promise.resolve(closed.push(p.paneId)),
    };
    await whileRegistering("@awaited", () => harvestExits(deps));
    expect(closed).toEqual(["%1"]);
    // Once the spawn is past registration its pane is harvestable again.
    await harvestExits(deps);
    expect(closed.toSorted()).toEqual(["%1", "%1", "%2"]);
  });
});

describe("the OOM verdict on a SIGKILL death", () => {
  const T0 = 1_000_000;
  const alive = (n: number): PaneInfo => pane(`%${n}`, { dead: false, deadStatus: null, deadAt: null, pid: n });

  /** The kernel's side: one cgroup per pid, counts and failures set by the test. */
  function rig(): {
    tasks: EndedTasks;
    ledger: LaunchLedger;
    counts: Map<string, number>;
    fail: { kills: boolean; cgroupOf: boolean; stall: boolean };
    exiting: Set<number>;
    closed: string[];
    clock: { now: number };
    setPanes: (next: PaneInfo[]) => void;
  } {
    const counts = new Map<string, number>();
    const fail = { kills: false, cgroupOf: false, stall: false };
    const exiting = new Set<number>();
    const closed: string[] = [];
    const clock = { now: 1 };
    let panes: PaneInfo[] = [];
    const never = Promise.withResolvers<never>().promise;
    const probe: OomProbe = {
      cgroupOf: (pid) =>
        fail.stall ? never : fail.cgroupOf ? Promise.reject(new Error("EIO")) : Promise.resolve(`/unit-${pid}`),
      kills: (cgroup) =>
        fail.stall
          ? never
          : fail.kills
            ? Promise.reject(new Error("EIO"))
            : Promise.resolve(counts.get(cgroup) ?? null),
      exiting: (pid) => Promise.resolve(exiting.has(pid)),
    };
    const ledger = LaunchLedger.memory(() => clock.now);
    const tasks = new EndedTasks(
      ledger,
      () => clock.now,
      { list: () => Promise.resolve(panes), close: (p) => Promise.resolve(closed.push(p.paneId)) },
      probe,
    );
    return {
      tasks,
      ledger,
      counts,
      fail,
      exiting,
      closed,
      clock,
      setPanes: (next) => {
        panes = next;
      },
    };
  }

  async function launched(tasks: EndedTasks, ...ids: string[]): Promise<void> {
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one launch at a time, as a machine runs them
      await (
        await tasks.launch(id)
      )(true, {});
    }
  }

  test("sampled on every pass while alive, judged once found dead, and carried to progress", async () => {
    const { tasks, counts, setPanes } = rig();
    // Panes listed only once launched: the spawn-time sample is its own test.
    await launched(tasks, "task-1", "task-2", "task-3", "task-4");
    setPanes([alive(1), alive(2), alive(3)]);
    counts.set("/unit-1", 4).set("/unit-2", 7).set("/unit-3", 0);
    await tasks.harvestExits();
    // A later pass moves the baseline: a kill counted while the pane still lived was not its death.
    counts.set("/unit-1", 5);
    await tasks.harvestExits();

    counts.set("/unit-2", 8);
    setPanes([
      pane("%1", { deadStatus: 137 }),
      pane("%2", { deadStatus: 137 }),
      pane("%3", { deadStatus: 1 }),
      // Never seen alive: no baseline, no verdict.
      pane("%4", { deadStatus: 137 }),
    ]);
    await tasks.harvestExits();
    expect(tasks.progress()).toEqual([
      { taskId: "task-1", at: 1, exit: 137, oomKill: false },
      { taskId: "task-2", at: 1, exit: 137, oomKill: true },
      { taskId: "task-3", at: 1, exit: 1 },
      { taskId: "task-4", at: 1, exit: 137 },
    ]);
  });

  test("a spawn that lands is sampled at once, without holding its launch or the sessions reply", async () => {
    const { tasks, ledger, counts, fail, setPanes } = rig();
    counts.set("/unit-1", 4);
    setPanes([alive(1)]);
    await launched(tasks, "task-1");
    await pollUntil(() => ledger.notes().some((note) => note.taskId === "task-1" && note.oom?.kills === 4), "sample");

    // Reads that never answer: the launch still settles.
    fail.stall = true;
    setPanes([alive(2)]);
    await launched(tasks, "task-2");
    expect(ledger.notes().find((note) => note.taskId === "task-2")?.oom).toBeUndefined();
  });

  test("a probe that fails costs the verdict, never the status or the close", async () => {
    const { tasks, counts, fail, closed, setPanes } = rig();
    counts.set("/unit-1", 4);
    await launched(tasks, "task-1");
    setPanes([alive(1)]);
    await tasks.harvestExits();
    fail.kills = true;
    setPanes([pane("%1", { deadStatus: 137 })]);
    await tasks.harvestExits();
    expect(tasks.progress()).toEqual([{ taskId: "task-1", at: 1, exit: 137 }]);
    expect(closed).toEqual(["%1"]);
  });

  test("a cgroupOf that rejects during harvest costs the live pane its sample, nothing else", async () => {
    const { tasks, ledger, counts, fail, closed, setPanes } = rig();
    counts.set("/unit-1", 4).set("/unit-2", 9);
    await launched(tasks, "task-1", "task-2");
    setPanes([alive(1)]);
    await tasks.harvestExits();
    fail.cgroupOf = true;
    // Task 1 died on a sample taken before; task 2 cannot be sampled this pass.
    setPanes([pane("%1", { deadStatus: 137 }), alive(2)]);
    await tasks.harvestExits();
    expect(tasks.progress()).toEqual([{ taskId: "task-1", at: 1, exit: 137, oomKill: false }]);
    expect(ledger.notes().find((note) => note.taskId === "task-2")?.oom).toBeUndefined();
    expect(closed).toEqual(["%1"]);
  });

  test("a probe that never answers delays no exit: it is noted and closed, the verdict unknown", async () => {
    const never = Promise.withResolvers<never>().promise;
    const events: string[] = [];
    const sample = { cgroup: "/unit-1", kills: 4, at: 1, paneId: "%1", windowId: "@1" };
    await harvestExits({
      list: () => Promise.resolve([pane("%1", { deadStatus: 137 }), alive(2)]),
      note: (taskId, exit, oomKill) => {
        events.push(`note ${taskId} ${exit} ${String(oomKill)}`);
        return Promise.resolve(true);
      },
      close: (closing) => Promise.resolve(events.push(`close ${closing.paneId}`)),
      oom: {
        probe: { cgroupOf: () => never, kills: () => never, exiting: () => never },
        sampled: () => sample,
        noteSamples: () => Promise.resolve(events.push("samples")),
        timeoutMs: 20,
      },
    });
    expect(events).toEqual(["note task-1 137 undefined", "close %1"]);
  });

  test("a sample taken while the pid is dying is discarded: the count it saw already held the kill", async () => {
    const { tasks, ledger, counts, exiting, setPanes } = rig();
    await launched(tasks, "task-1");
    setPanes([alive(1)]);
    counts.set("/unit-1", 4);
    await tasks.harvestExits();
    // The kernel counts the kill, then the pane is still listed alive while its process exits.
    counts.set("/unit-1", 5);
    exiting.add(1);
    await tasks.harvestExits();
    expect(ledger.notes()[0]?.oom?.kills).toBe(4);

    setPanes([pane("%1", { deadStatus: 137 })]);
    await tasks.harvestExits();
    expect(tasks.progress()).toEqual([{ taskId: "task-1", at: 1, exit: 137, oomKill: true }]);
  });

  describe("a rise confirms only within a bound of the death", () => {
    /** One task sampled at t=1000s, found dead at `deadAt` and judged at `judgedAt`, with the count risen. */
    async function verdict(deadAt: number | null, judgedAt: number, raised = true): Promise<boolean | undefined> {
      const { tasks, counts, clock, setPanes } = rig();
      clock.now = T0;
      await launched(tasks, "task-1");
      setPanes([alive(1)]);
      counts.set("/unit-1", 4);
      await tasks.harvestExits();
      if (raised) counts.set("/unit-1", 5);
      clock.now = judgedAt;
      setPanes([pane("%1", { deadStatus: 137, deadAt })]);
      await tasks.harvestExits();
      return tasks.progress()[0]?.oomKill;
    }

    test("fresh sample, prompt judge: true", async () => {
      expect(await verdict(T0 + 30_000, T0 + 60_000)).toBe(true);
    });

    test("a stale last sample, a late judge, or no death time: unknown", async () => {
      const t = T0;
      expect(await verdict(t + OOM_WINDOW_MS + 5_000, t + OOM_WINDOW_MS + 6_000)).toBeUndefined();
      expect(await verdict(t + 30_000, t + 30_000 + OOM_WINDOW_MS + 1)).toBeUndefined();
      expect(await verdict(null, t + 60_000)).toBeUndefined();
    });

    test("no change is a negative however stale", async () => {
      const t = T0;
      expect(await verdict(t + OOM_WINDOW_MS * 3, t + OOM_WINDOW_MS * 4, false)).toBe(false);
    });
  });

  test("a sample is the pane's own: a relaunch's pane is never judged on the old one's, nor the old one on the new's", async () => {
    // The new launch dies before any pass sampled it.
    const first = rig();
    await launched(first.tasks, "task-1");
    first.counts.set("/unit-1", 4);
    first.setPanes([alive(1)]);
    await first.tasks.harvestExits();
    first.setPanes([pane("%7", { windowId: "@7", taskId: "task-1", deadStatus: 137 })]);
    await first.tasks.harvestExits();
    expect(first.tasks.progress()[0]?.oomKill).toBeUndefined();

    // The old pane's death found after the new launch's pane was sampled.
    const second = rig();
    await launched(second.tasks, "task-1");
    second.counts.set("/unit-1", 4).set("/unit-7", 9);
    second.setPanes([alive(1)]);
    await second.tasks.harvestExits();
    const relaunched = pane("%7", {
      dead: false,
      deadAt: null,
      deadStatus: null,
      taskId: "task-1",
      windowId: "@7",
      pid: 7,
    });
    second.setPanes([alive(1), relaunched]);
    await second.tasks.harvestExits();
    second.setPanes([pane("%1", { deadStatus: 137 }), relaunched]);
    await second.tasks.harvestExits();
    expect(second.tasks.progress()[0]?.oomKill).toBeUndefined();
  });
});

describe("owesExit", () => {
  test("only a harvestable pane that holds a status: reap may close the rest", () => {
    expect(owesExit(pane("%1"))).toBe(true);
    expect(owesExit(pane("%1", { deadStatus: 0 }))).toBe(true);
    expect(owesExit(pane("%1", { deadStatus: null }))).toBe(false);
    expect(owesExit(pane("%1", { titled: false }))).toBe(false);
    expect(owesExit(pane("%1", { taskId: null }))).toBe(false);
  });
});
