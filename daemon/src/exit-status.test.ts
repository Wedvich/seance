import { describe, expect, test } from "bun:test";
import { harvestExits, owesExit, whileRegistering } from "./exit-status.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import type { OomProbe } from "./oom-kill.ts";
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
  /** The kernel's side: one cgroup per pid, counts set by the test. */
  function kernel(): { probe: OomProbe; counts: Map<string, number>; failing: { on: boolean } } {
    const counts = new Map<string, number>();
    const failing = { on: false };
    const probe: OomProbe = {
      cgroupOf: (pid) => Promise.resolve(`/unit-${pid}`),
      kills: (cgroup) => (failing.on ? Promise.reject(new Error("EIO")) : Promise.resolve(counts.get(cgroup) ?? null)),
    };
    return { probe, counts, failing };
  }

  async function launched(tasks: EndedTasks, ...ids: string[]): Promise<void> {
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one launch at a time, as a machine runs them
      await (
        await tasks.launch(id)
      )(true, {});
    }
  }

  test("sampled at launch and on every pass while alive, judged once found dead, and carried to progress", async () => {
    const { probe, counts } = kernel();
    let panes: PaneInfo[] = [
      pane("%1", { dead: false, deadStatus: null, pid: 1 }),
      pane("%2", { dead: false, deadStatus: null, pid: 2 }),
      pane("%3", { dead: false, deadStatus: null, pid: 3 }),
    ];
    const tasks = new EndedTasks(
      LaunchLedger.memory(() => 1),
      () => 1,
      { list: () => Promise.resolve(panes), close: () => Promise.resolve() },
      probe,
    );
    counts.set("/unit-1", 4).set("/unit-2", 7).set("/unit-3", 0);
    await launched(tasks, "task-1", "task-2", "task-3", "task-4");
    // A later pass moves the baseline: a kill counted while the pane still lived was not its death.
    counts.set("/unit-1", 5);
    await tasks.harvestExits();

    counts.set("/unit-2", 8);
    panes = [
      pane("%1", { deadStatus: 137 }),
      pane("%2", { deadStatus: 137 }),
      pane("%3", { deadStatus: 1 }),
      // Never seen alive: no baseline, no verdict.
      pane("%4", { deadStatus: 137 }),
    ];
    await tasks.harvestExits();
    const progress = tasks.progress();
    expect(progress).toEqual([
      { taskId: "task-1", at: 1, exit: 137, oomKill: false },
      { taskId: "task-2", at: 1, exit: 137, oomKill: true },
      { taskId: "task-3", at: 1, exit: 1 },
      { taskId: "task-4", at: 1, exit: 137 },
    ]);
  });

  test("a probe that fails costs the verdict, never the status or the close", async () => {
    const { probe, counts, failing } = kernel();
    const closed: string[] = [];
    let panes: PaneInfo[] = [pane("%1", { dead: false, deadStatus: null, pid: 1 })];
    const tasks = new EndedTasks(
      LaunchLedger.memory(() => 1),
      () => 1,
      { list: () => Promise.resolve(panes), close: (p) => Promise.resolve(closed.push(p.paneId)) },
      probe,
    );
    counts.set("/unit-1", 4);
    await launched(tasks, "task-1");
    failing.on = true;
    panes = [pane("%1", { deadStatus: 137 })];
    await tasks.harvestExits();
    expect(tasks.progress()).toEqual([{ taskId: "task-1", at: 1, exit: 137 }]);
    expect(closed).toEqual(["%1"]);
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
