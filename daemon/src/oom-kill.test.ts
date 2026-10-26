import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCgroupPath,
  isExiting,
  isExitingStat,
  isOomSample,
  judgeOomKill,
  OOM_WINDOW_MS,
  perPass,
  procOomProbe,
  sampleOom,
  type OomDeath,
  type OomProbe,
  type OomSample,
} from "./oom-kill.ts";

const UNIT = "/system.slice/seanced.service";
const SCOPE = "/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope";

let dir: string;
let proc: string;
let cgroupRoot: string;

async function cgroupOfPid(pid: number | "self", text: string): Promise<void> {
  await mkdir(join(proc, String(pid)), { recursive: true });
  await writeFile(join(proc, String(pid), "cgroup"), text);
}

function statLine(pid: number, state: string, flags: number, comm = "claude"): string {
  return `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 1 0 5 100 10\n`;
}

async function statusOfPid(pid: number, state: string, pending = "0000000000000000", flags = 0x400000): Promise<void> {
  await mkdir(join(proc, String(pid)), { recursive: true });
  await writeFile(
    join(proc, String(pid), "status"),
    `Name:\tclaude\nState:\t${state}\nSigPnd:\t0\nShdPnd:\t${pending}\n`,
  );
  await writeFile(join(proc, String(pid), "stat"), statLine(pid, state[0] ?? "S", flags));
}

async function oomKills(root: string, cgroup: string, kills: number): Promise<void> {
  await mkdir(join(root, cgroup), { recursive: true });
  const events = `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${kills}\noom_group_kill 0\n`;
  await writeFile(join(root, cgroup, "memory.events"), events);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-oom-"));
  proc = join(dir, "proc");
  cgroupRoot = join(dir, "cgroup");
  // A --system install as measured: the daemon and its panes share the unit.
  await cgroupOfPid("self", `0::${UNIT}\n`);
  await cgroupOfPid(100, `0::${UNIT}\n`);
  await statusOfPid(100, "S (sleeping)");
  await oomKills(cgroupRoot, UNIT, 42);
  // A hybrid host: v1 lines and an empty unified one.
  await cgroupOfPid(200, "12:memory:/user.slice\n1:name=systemd:/user.slice\n0::/\n");
  await cgroupOfPid(400, "0::/../etc\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function probe(): OomProbe {
  const linux = procOomProbe({ proc, cgroupRoot, platform: "linux" });
  if (linux === undefined) throw new Error("no probe on linux");
  return linux;
}

const pane = (pid: number): { pid: number; paneId: string; windowId: string } => ({
  pid,
  paneId: "%1",
  windowId: "@1",
});

describe("procOomProbe", () => {
  test("no probe at all off Linux: macOS has no equivalent", () => {
    expect(procOomProbe({ proc, cgroupRoot, platform: "darwin" })).toBeUndefined();
  });

  test("no probe where the mount is not this namespace's: the daemon's own cgroup must read under it", async () => {
    // A cgroup namespace's /proc paths are relative to its root, which the host's mount does not share.
    const elsewhere = await mkdtemp(join(tmpdir(), "seance-oom-ns-"));
    try {
      expect(procOomProbe({ proc, cgroupRoot: elsewhere, platform: "linux" })).toBeUndefined();
      expect(procOomProbe({ proc: join(dir, "no-proc"), cgroupRoot, platform: "linux" })).toBeUndefined();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("sampleOom", () => {
  test("samples the pane's own cgroup, as /proc names it, tagged with the pane", async () => {
    expect(await sampleOom(pane(100), probe(), () => 7)).toEqual({
      cgroup: UNIT,
      kills: 42,
      at: 7,
      paneId: "%1",
      windowId: "@1",
    });
  });

  test("nothing where nothing reads: v1, a gone pid, a path that climbs", async () => {
    expect(await sampleOom(pane(200), probe())).toBeNull();
    expect(await sampleOom(pane(999), probe())).toBeNull();
    expect(await sampleOom(pane(400), probe())).toBeNull();
    expect(await sampleOom(pane(-1), probe())).toBeNull();
  });

  test("a probe that throws, or never answers, is no sample", async () => {
    const broken: OomProbe = {
      cgroupOf: () => Promise.reject(new Error("EIO")),
      kills: () => Promise.resolve(1),
      exiting: () => Promise.resolve(false),
    };
    expect(await sampleOom(pane(100), broken)).toBeNull();
    const stalled: OomProbe = { ...broken, cgroupOf: () => Promise.withResolvers<never>().promise };
    expect(await sampleOom(pane(100), stalled, Date.now, 20)).toBeNull();
  });

  test("a pid on its way out gives no sample: the count may already hold its kill", async () => {
    const exiting = (value: boolean): OomProbe => ({
      cgroupOf: () => Promise.resolve(UNIT),
      kills: () => Promise.resolve(5),
      exiting: () => Promise.resolve(value),
    });
    expect(await sampleOom(pane(1), exiting(false))).not.toBeNull();
    expect(await sampleOom(pane(1), exiting(true))).toBeNull();
  });
});

describe("exiting, against the real files", () => {
  test("a live pid is not; a zombie, one with SIGKILL pending, and a pid gone are", async () => {
    await statusOfPid(501, "Z (zombie)");
    await statusOfPid(502, "S (sleeping)", "0000000000000100");
    await statusOfPid(503, "S (sleeping)", "0000000000004000");
    const live = probe();
    expect(await live.exiting(100)).toBe(false);
    expect(await live.exiting(501)).toBe(true);
    expect(await live.exiting(502)).toBe(true);
    expect(await live.exiting(503)).toBe(false);
    // PF_EXITING alone, with nothing pending in the status.
    await statusOfPid(504, "S (sleeping)", "0000000000000000", 0x400004);
    expect(await live.exiting(504)).toBe(true);
    expect(await live.exiting(999)).toBe(true);
    expect(await live.exiting(0)).toBe(true);
  });

  test("PF_EXITING is read from the stat flags, past a comm holding spaces and parens", () => {
    expect(isExitingStat(statLine(7, "S", 0x400000))).toBe(false);
    expect(isExitingStat(statLine(7, "S", 0x400004))).toBe(true);
    expect(isExitingStat(statLine(7, "S", 0x400000, "a) S 1 2 3 4 5 4 (b"))).toBe(false);
    expect(isExitingStat(statLine(7, "S", 0x400004, "a) S 1 2 3 4 5 0 (b"))).toBe(true);
    expect(isExitingStat("")).toBe(true);
    expect(isExitingStat("7 (x) S 1 2")).toBe(true);
    expect(isExitingStat("7 (x) S 1 2 3 4 5 nope 0")).toBe(true);
  });

  test("unparseable status counts as exiting", () => {
    expect(isExiting("")).toBe(true);
    expect(isExiting("State:\tS (sleeping)\nSigPnd:\tnothex\n")).toBe(true);
    expect(isExiting("State:\tS (sleeping)\nSigPnd:\t0\nShdPnd:\t0\n")).toBe(false);
  });
});

describe("judgeOomKill", () => {
  const counting = (counts: Record<string, number>): OomProbe => ({
    cgroupOf: () => Promise.resolve(null),
    kills: (cgroup) => Promise.resolve(counts[cgroup] ?? null),
    exiting: () => Promise.resolve(false),
  });
  const sample: OomSample = { cgroup: UNIT, kills: 42, at: 1_000_000, paneId: "%1", windowId: "@1" };
  const death: OomDeath = { paneId: "%1", windowId: "@1", deadAt: 1_060_000 };
  const soon = (): number => 1_120_000;

  test("a rise is a kill counted there, no change is none, a drop is unknown", async () => {
    expect(await judgeOomKill(sample, death, counting({ [UNIT]: 43 }), soon)).toBe(true);
    expect(await judgeOomKill(sample, death, counting({ [UNIT]: 42 }), soon)).toBe(false);
    expect(await judgeOomKill(sample, death, counting({ [UNIT]: 0 }), soon)).toBeUndefined();
  });

  test("a cgroup that no longer reads says nothing: a per-pane scope is removed once empty", async () => {
    expect(await judgeOomKill(sample, death, counting({}), soon)).toBeUndefined();
    // Nor does a parent's rise stand in for it.
    expect(await judgeOomKill(sample, death, counting({ "/system.slice": 99 }), soon)).toBeUndefined();
  });

  test("a rise confirms only close to the death on both sides, and with a known death time", async () => {
    const rose = counting({ [UNIT]: 43 });
    const stale = { ...sample, at: death.deadAt === null ? 0 : death.deadAt - OOM_WINDOW_MS - 1 };
    expect(await judgeOomKill(stale, death, rose, soon)).toBeUndefined();
    expect(await judgeOomKill(sample, death, rose, () => 1_060_000 + OOM_WINDOW_MS + 1)).toBeUndefined();
    expect(await judgeOomKill(sample, { ...death, deadAt: null }, rose, soon)).toBeUndefined();
    // No change is a negative whatever the window.
    expect(await judgeOomKill(stale, death, counting({ [UNIT]: 42 }), soon)).toBe(false);
    expect(await judgeOomKill(sample, death, counting({ [UNIT]: 42 }), () => 9e12)).toBe(false);
    expect(await judgeOomKill(sample, { ...death, deadAt: null }, counting({ [UNIT]: 42 }), soon)).toBe(false);
  });

  test("a sample taken after the death proves nothing", async () => {
    const after = { ...sample, at: 1_100_000 };
    expect(await judgeOomKill(after, death, counting({ [UNIT]: 42 }), soon)).toBeUndefined();
  });

  test("only the same pane's sample counts: a relaunch or another launch's pane is unknown", async () => {
    const same = counting({ [UNIT]: 42 });
    expect(await judgeOomKill(sample, { ...death, paneId: "%2" }, same, soon)).toBeUndefined();
    expect(await judgeOomKill(sample, { ...death, windowId: "@2" }, same, soon)).toBeUndefined();
    expect(await judgeOomKill(undefined, death, same, soon)).toBeUndefined();
  });

  test("a probe that throws or never answers is unknown", async () => {
    const broken: OomProbe = {
      cgroupOf: () => Promise.resolve(null),
      kills: () => Promise.reject(new Error("EIO")),
      exiting: () => Promise.resolve(false),
    };
    expect(await judgeOomKill(sample, death, broken, soon)).toBeUndefined();
    const stalled: OomProbe = { ...broken, kills: () => Promise.withResolvers<never>().promise };
    expect(await judgeOomKill(sample, death, stalled, soon, 20)).toBeUndefined();
  });

  test("against the real files: a rise in the unit's count, read back from its own memory.events", async () => {
    const root = await mkdtemp(join(tmpdir(), "seance-oom-real-"));
    try {
      await oomKills(root, SCOPE, 0);
      await cgroupOfPid("self", `0::${SCOPE}\n`);
      await cgroupOfPid(300, `0::${SCOPE}\n`);
      await statusOfPid(300, "S (sleeping)");
      const real = procOomProbe({ proc, cgroupRoot: root, platform: "linux" });
      if (real === undefined) throw new Error("no probe");
      const taken = await sampleOom(pane(300), real, () => 1_000_000);
      if (taken === null) throw new Error("no sample");
      await oomKills(root, SCOPE, 1);
      expect(await judgeOomKill(taken, death, real, soon)).toBe(true);
      // The scope removed once empty: the verdict is unknown, not a parent's guess.
      await rm(join(root, SCOPE), { recursive: true });
      expect(await judgeOomKill(taken, death, real, soon)).toBeUndefined();
    } finally {
      await cgroupOfPid("self", `0::${UNIT}\n`);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("perPass", () => {
  test("reads each cgroup's count once per pass", async () => {
    let reads = 0;
    const pass = perPass({
      cgroupOf: () => Promise.resolve(UNIT),
      kills: () => Promise.resolve(++reads),
      exiting: () => Promise.resolve(false),
    });
    expect(await pass.kills(UNIT)).toBe(1);
    expect(await pass.kills(UNIT)).toBe(1);
    expect(await pass.kills("/system.slice")).toBe(2);
  });
});

describe("validation", () => {
  test("a cgroup path is absolute and never climbs", () => {
    expect(isCgroupPath(UNIT)).toBe(true);
    expect(isCgroupPath("/")).toBe(true);
    for (const bad of ["system.slice", "/a/../b", "/a/./b", "/a\nb", "/a\0b", `/${"a".repeat(4096)}`, 1]) {
      expect(isCgroupPath(bad)).toBe(false);
    }
  });

  test("a ledger sample: a path, a count, a time and the pane it came from", () => {
    const good = { cgroup: UNIT, kills: 0, at: 1, paneId: "%3", windowId: "@4" };
    expect(isOomSample(good)).toBe(true);
    for (const bad of [
      { ...good, kills: -1 },
      { ...good, kills: 1.5 },
      { ...good, cgroup: "../x" },
      { ...good, at: -1 },
      { ...good, paneId: "3" },
      { ...good, windowId: "@x" },
      // Each prefix belongs to its own field.
      { ...good, paneId: "@3" },
      { ...good, windowId: "%4" },
      { cgroup: UNIT, kills: 1 },
      // The list a first draft of this field wrote.
      [good],
      "x",
      null,
    ]) {
      expect(isOomSample(bad)).toBe(false);
    }
  });
});
