import { describe, expect, test } from "bun:test";
import { harvestExits, owesExit, whileRegistering } from "./exit-status.ts";
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

describe("owesExit", () => {
  test("only a harvestable pane that holds a status: reap may close the rest", () => {
    expect(owesExit(pane("%1"))).toBe(true);
    expect(owesExit(pane("%1", { deadStatus: 0 }))).toBe(true);
    expect(owesExit(pane("%1", { deadStatus: null }))).toBe(false);
    expect(owesExit(pane("%1", { titled: false }))).toBe(false);
    expect(owesExit(pane("%1", { taskId: null }))).toBe(false);
  });
});
