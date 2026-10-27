import { describe, expect, test } from "bun:test";
import { pollUntil } from "../test/fixtures.ts";
import { harvestable, harvestExits, parseRecordedExits, whileRegistering } from "./exit-status.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { OOM_WINDOW_MS, type OomProbe } from "./oom-kill.ts";
import { EndedTasks } from "./session-events.ts";
import type { PaneInfo } from "./sessions.ts";

/** The parts of harvest these cases do not exercise: no candidates, no server, nothing recorded. */
const idle = {
  closing: () => Promise.resolve(),
  unaccounted: () => [],
  vanished: () => Promise.resolve(),
  server: () => Promise.resolve(null),
  recordedExits: () => Promise.resolve([]),
  clearExit: () => Promise.resolve(),
};

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
      ...idle,
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
      ...idle,
      list: () => Promise.reject(new Error("protocol version mismatch")),
      note: () => Promise.resolve((touched = true)),
      close: () => Promise.resolve((touched = true)),
    });
    expect(touched).toBe(false);
  });

  test("a pane whose task is not in this ledger is closed, its status having nowhere to go; one a spawn still awaits is left to it", async () => {
    const closed: string[] = [];
    const deps = {
      ...idle,
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
    fail: { kills: boolean; cgroupOf: boolean };
    exiting: Set<number>;
    closed: string[];
    clock: { now: number };
    setPanes: (next: PaneInfo[]) => void;
  } {
    const counts = new Map<string, number>();
    const fail = { kills: false, cgroupOf: false };
    const exiting = new Set<number>();
    const closed: string[] = [];
    const clock = { now: 1 };
    let panes: PaneInfo[] = [];
    const probe: OomProbe = {
      cgroupOf: (pid) => (fail.cgroupOf ? Promise.reject(new Error("EIO")) : Promise.resolve(`/unit-${pid}`)),
      kills: (cgroup) => (fail.kills ? Promise.reject(new Error("EIO")) : Promise.resolve(counts.get(cgroup) ?? null)),
      exiting: (pid) => Promise.resolve(exiting.has(pid)),
    };
    const ledger = LaunchLedger.memory(() => clock.now);
    const tasks = new EndedTasks(
      ledger,
      () => clock.now,
      { ...idle, list: () => Promise.resolve(panes), close: (p) => Promise.resolve(closed.push(p.paneId)) },
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
    const { tasks, ledger, counts, setPanes } = rig();
    counts.set("/unit-1", 4);
    setPanes([alive(1)]);
    await launched(tasks, "task-1");
    await pollUntil(() => ledger.notes().some((note) => note.taskId === "task-1" && note.oom?.kills === 4), "sample");
  });

  test("a spawn's sample reads do not hold its launch: it settles while they are still pending, and the sample lands once they answer", async () => {
    const gate = Promise.withResolvers<string | null>();
    let asked = 0;
    const probe: OomProbe = {
      cgroupOf: () => {
        asked += 1;
        return gate.promise;
      },
      kills: () => Promise.resolve(4),
      exiting: () => Promise.resolve(false),
    };
    const ledger = LaunchLedger.memory(() => 1);
    // A timeout far past the test: were the launch to wait on the read, this would hang rather than pass.
    const tasks = new EndedTasks(
      ledger,
      () => 1,
      { ...idle, list: () => Promise.resolve([alive(2)]), close: () => Promise.resolve() },
      probe,
      60_000,
    );
    await launched(tasks, "task-2");
    await pollUntil(() => asked === 1, "the spawn's sample read");
    expect(ledger.notes().find((note) => note.taskId === "task-2")?.oom).toBeUndefined();

    gate.resolve("/unit-2");
    await pollUntil(() => ledger.notes().some((note) => note.taskId === "task-2" && note.oom?.kills === 4), "sample");
  });

  test("sampling is single-flight: stalled reads of an earlier pass are not piled on, and sampling resumes once they settle", async () => {
    const gate = Promise.withResolvers<string | null>();
    let asked = 0;
    const probe: OomProbe = {
      cgroupOf: () => {
        asked += 1;
        return gate.promise;
      },
      kills: () => Promise.resolve(4),
      exiting: () => Promise.resolve(false),
    };
    const sampled: string[] = [];
    const deps = {
      ...idle,
      list: () => Promise.resolve([alive(1)]),
      note: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      oom: {
        probe,
        sampled: () => undefined,
        noteSamples: () => Promise.resolve(sampled.push("written")),
        timeoutMs: 10,
      },
    };
    await harvestExits(deps);
    await harvestExits(deps);
    await harvestExits(deps);
    expect(asked).toBe(1);

    gate.resolve("/unit-1");
    await pollUntil(async () => {
      await harvestExits(deps);
      return sampled.length > 0;
    }, "sampling to resume");
    expect(asked).toBe(2);
  });

  test("a live sample is stamped no later than its count is read, never with a cached one's later time", async () => {
    const clock = { now: 100 };
    const stamps: number[] = [];
    const probe: OomProbe = {
      cgroupOf: () => Promise.resolve("/shared"),
      kills: () => {
        clock.now += 50;
        return Promise.resolve(4);
      },
      exiting: () => Promise.resolve(false),
    };
    await harvestExits({
      ...idle,
      list: () => Promise.resolve([alive(1), alive(2)]),
      note: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      oom: {
        probe,
        sampled: () => undefined,
        noteSamples: (entries) => Promise.resolve(stamps.push(...entries.map((entry) => entry.sample.at))),
        now: () => clock.now,
      },
    });
    expect(stamps).toEqual([100, 100]);
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
      ...idle,
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

describe("harvestable", () => {
  test("only a dead, titled pane of one of our tasks: reap leaves those to harvest", () => {
    expect(harvestable(pane("%1"))).toBe(true);
    expect(harvestable(pane("%1", { deadStatus: 0 }))).toBe(true);
    expect(harvestable(pane("%1", { deadStatus: null }))).toBe(true);
    expect(harvestable(pane("%1", { dead: false }))).toBe(false);
    expect(harvestable(pane("%1", { titled: false }))).toBe(false);
    expect(harvestable(pane("%1", { taskId: null }))).toBe(false);
    expect(harvestable(pane("%1", { ours: false }))).toBe(false);
  });
});

describe("a window closed from outside", () => {
  /** A harvest pass over `panes` with one candidate per id (on server 100, which answers unless told otherwise), recording what it did. */
  function pass(
    panes: PaneInfo[],
    opts: {
      candidates?: string[];
      server?: number | null;
      candidateServer?: number;
      recorded?: { taskId: string; exit: number | null }[];
      listFails?: boolean;
      vanishedFails?: boolean;
    } = {},
  ): { events: string[]; run: () => Promise<void> } {
    const events: string[] = [];
    const candidateServer = opts.candidateServer ?? 100;
    return {
      events,
      run: () =>
        harvestExits({
          list: () => (opts.listFails === true ? Promise.reject(new Error("tmux down")) : Promise.resolve(panes)),
          close: (p) => Promise.resolve(void events.push(`close ${p.paneId}`)),
          note: (taskId, exit) => {
            events.push(`note ${taskId} ${exit}`);
            return Promise.resolve(true);
          },
          closing: (taskId) => Promise.resolve(void events.push(`closing ${taskId}`)),
          unaccounted: () =>
            (opts.candidates ?? ["task-9"]).map((taskId) => ({ taskId, recordedAt: 7, server: candidateServer })),
          vanished: (launch) => {
            events.push(`vanished ${launch.taskId}`);
            return opts.vanishedFails === true ? Promise.reject(new Error("disk")) : Promise.resolve();
          },
          server: () => Promise.resolve(opts.server === undefined ? 100 : opts.server),
          recordedExits: () => Promise.resolve(opts.recorded ?? []),
          clearExit: (taskId) => Promise.resolve(void events.push(`clear ${taskId}`)),
        }),
    };
  }

  test("a candidate no listing carries is noted vanished, once", async () => {
    const { events, run } = pass([pane("%1", { dead: false, deadStatus: null })]);
    await run();
    expect(events).toEqual(["vanished task-9"]);
  });

  test("a candidate whose pane is listed alive, dead (harvested), or not ours is not vanished", async () => {
    for (const listed of [
      pane("%9", { taskId: "task-9", dead: false, deadStatus: null }),
      pane("%9", { taskId: "task-9", deadStatus: 3 }),
      pane("%9", { taskId: "task-9", ours: false, dead: false }),
      pane("%9", { taskId: "task-9", titled: false }),
    ]) {
      const { events, run } = pass([listed]);
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      await run();
      expect(events.filter((e) => e.startsWith("vanished"))).toEqual([]);
    }
  });

  test("a task inside whileRegistering whose pane is listed is not vanished", async () => {
    const { events, run } = pass([pane("%9", { taskId: "task-9", windowId: "@reg" })]);
    await whileRegistering("@reg", run);
    expect(events).toEqual([]);
  });

  test("a dead pane with status 0 is noted before it is closed; one with no status is announced as closing first", async () => {
    const clean = pass([pane("%1", { deadStatus: 0 })], { candidates: [] });
    await clean.run();
    expect(clean.events).toEqual(["note task-1 0", "close %1"]);
    const bare = pass([pane("%1", { deadStatus: null })], { candidates: [] });
    await bare.run();
    expect(bare.events).toEqual(["closing task-1", "close %1"]);
  });

  test("a failed listing notes and judges nothing, and a rejecting vanished does not throw", async () => {
    const failed = pass([], { listFails: true });
    await failed.run();
    expect(failed.events).toEqual([]);
    const rejecting = pass([], { vanishedFails: true, candidates: ["task-8", "task-9"] });
    await rejecting.run();
    // The failure of one note does not stop the next.
    expect(rejecting.events).toEqual(["vanished task-8", "vanished task-9"]);
  });

  test("an exit the hook recorded is noted, cleared, and keeps its task from being judged; a pane noted this pass is only cleared", async () => {
    const { events, run } = pass([pane("%1", { deadStatus: 2 })], {
      recorded: [
        { taskId: "task-9", exit: 0 },
        { taskId: "task-1", exit: 2 },
        { taskId: "task-x", exit: null },
      ],
    });
    await run();
    expect(events).toEqual([
      "note task-1 2",
      "close %1",
      "note task-9 0",
      "clear task-9",
      "clear task-1",
      // No parseable status: announced as closing first, so the user closing its dead pane never reads vanished.
      "closing task-x",
      "clear task-x",
    ]);
  });

  test("the server pid is read only when some candidate is neither carried nor recorded", async () => {
    let reads = 0;
    const run = (panes: PaneInfo[], recorded: { taskId: string; exit: number | null }[]): Promise<void> =>
      harvestExits({
        ...idle,
        list: () => Promise.resolve(panes),
        close: () => Promise.resolve(),
        note: () => Promise.resolve(true),
        unaccounted: () => [{ taskId: "task-9", recordedAt: 7, server: 100 }],
        server: () => {
          reads += 1;
          return Promise.resolve(100);
        },
        recordedExits: () => Promise.resolve(recorded),
      });
    await run([pane("%9", { taskId: "task-9", dead: false, deadStatus: null })], []);
    await run([], [{ taskId: "task-9", exit: 0 }]);
    expect(reads).toBe(0);
    await run([], []);
    expect(reads).toBe(1);
  });

  test("an exit recorded while the task's launch is in flight is left for a later pass, so startNote cannot overwrite it", async () => {
    const events: string[] = [];
    const ledger = LaunchLedger.memory();
    const tasks = new EndedTasks(ledger, Date.now, {
      list: () => Promise.resolve([]),
      close: () => Promise.resolve(),
      server: () => Promise.resolve(100),
      recordedExits: () => Promise.resolve([{ taskId: "task-1", exit: 0 }]),
      clearExit: (taskId) => Promise.resolve(void events.push(`clear ${taskId}`)),
    });
    const settle = await tasks.launch("task-1");
    await tasks.harvestExits();
    // Neither noted nor cleared: the hook already fired, the launch has not settled.
    expect(events).toEqual([]);
    expect(tasks.progress()).toEqual([]);
    await settle(true, { server: 100 });
    await tasks.harvestExits();
    expect(events).toEqual(["clear task-1"]);
    expect(tasks.progress()).toEqual([expect.objectContaining({ taskId: "task-1", exit: 0 })]);
    expect(tasks.progress()[0]?.vanished).toBeUndefined();
  });

  test("a candidate on another live server is not judged; on a dead one, or the answering one, it is", async () => {
    // The test process's own pid: alive, and not the server that answers.
    const other = pass([], { server: 100, candidateServer: process.pid });
    await other.run();
    expect(other.events).toEqual([]);
    // No server answers but the recorded one is alive: a missing socket, not a stopped server.
    const unreachable = pass([], { server: null, candidateServer: process.pid });
    await unreachable.run();
    expect(unreachable.events).toEqual([]);
    const child = Bun.spawn(["true"]);
    await child.exited;
    const gone = pass([], { server: null, candidateServer: child.pid });
    await gone.run();
    expect(gone.events).toEqual(["vanished task-9"]);
    const same = pass([], { server: process.pid, candidateServer: process.pid });
    await same.run();
    expect(same.events).toEqual(["vanished task-9"]);
  });

  test("parseRecordedExits reads the hook's value like a pane's status, and drops a foreign id", () => {
    const output = [
      "@seance-exit-a 0:",
      "@seance-exit-b 3:",
      "@seance-exit-c :kill",
      "@seance-exit-d :",
      '@seance-exit-e "7:"',
      "@seance-exit-bad|id 1:",
      "@other 1:",
    ].join("\n");
    expect(parseRecordedExits(output)).toEqual([
      { taskId: "a", exit: 0 },
      { taskId: "b", exit: 3 },
      { taskId: "c", exit: 137 },
      { taskId: "d", exit: null },
      { taskId: "e", exit: 7 },
    ]);
  });
});
