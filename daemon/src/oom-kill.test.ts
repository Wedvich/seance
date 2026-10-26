import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCgroupPath,
  isOomSamples,
  judgeOomKill,
  perPass,
  procOomProbe,
  sampleOom,
  type OomProbe,
} from "./oom-kill.ts";

const UNIT = "/system.slice/seanced.service";
const SCOPE = "/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope";

let dir: string;
let proc: string;
let cgroupRoot: string;

async function cgroupOfPid(pid: number, text: string): Promise<void> {
  await mkdir(join(proc, String(pid)), { recursive: true });
  await writeFile(join(proc, String(pid), "cgroup"), text);
}

async function oomKills(cgroup: string, kills: number): Promise<void> {
  await mkdir(join(cgroupRoot, cgroup), { recursive: true });
  const events = `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${kills}\noom_group_kill 0\n`;
  await writeFile(join(cgroupRoot, cgroup, "memory.events"), events);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-oom-"));
  proc = join(dir, "proc");
  cgroupRoot = join(dir, "cgroup");
  // A --system install as measured: the unit and its slice.
  await cgroupOfPid(100, `0::${UNIT}\n`);
  await oomKills(UNIT, 42);
  await oomKills("/system.slice", 50);
  // A hybrid host: v1 lines and an empty unified one.
  await cgroupOfPid(200, "12:memory:/user.slice\n1:name=systemd:/user.slice\n0::/\n");
  // A per-pane scope under the user manager.
  await cgroupOfPid(300, `0::${SCOPE}\n`);
  await oomKills(SCOPE, 0);
  await oomKills("/user.slice/user-1000.slice/user@1000.service/app.slice", 3);
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

describe("sampleOom", () => {
  test("samples the pane's own cgroup, then its parent, as /proc names them", async () => {
    expect(await sampleOom(100, probe())).toEqual([
      { cgroup: UNIT, kills: 42 },
      { cgroup: "/system.slice", kills: 50 },
    ]);
  });

  test("no probe at all off Linux: macOS has no equivalent", () => {
    expect(procOomProbe({ proc, cgroupRoot, platform: "darwin" })).toBeUndefined();
  });

  test("nothing where nothing reads: v1, a gone pid, a path that climbs", async () => {
    expect(await sampleOom(200, probe())).toEqual([]);
    expect(await sampleOom(999, probe())).toEqual([]);
    expect(await sampleOom(400, probe())).toEqual([]);
    expect(await sampleOom(-1, probe())).toEqual([]);
  });

  test("a probe that throws is no sample", async () => {
    const broken: OomProbe = { cgroupOf: () => Promise.reject(new Error("EIO")), kills: () => Promise.resolve(1) };
    expect(await sampleOom(100, broken)).toEqual([]);
  });
});

describe("judgeOomKill", () => {
  const counting = (counts: Record<string, number>): OomProbe => ({
    cgroupOf: () => Promise.resolve(null),
    kills: (cgroup) => Promise.resolve(counts[cgroup] ?? null),
  });
  const unit = [
    { cgroup: UNIT, kills: 42 },
    { cgroup: "/system.slice", kills: 50 },
  ];

  test("its own cgroup decides both ways: a rise is a kill counted there, no change is none, a drop is unknown", async () => {
    expect(await judgeOomKill(unit, counting({ [UNIT]: 43, "/system.slice": 51 }))).toBe(true);
    expect(await judgeOomKill(unit, counting({ [UNIT]: 42, "/system.slice": 51 }))).toBe(false);
    expect(await judgeOomKill(unit, counting({ [UNIT]: 0, "/system.slice": 51 }))).toBeUndefined();
  });

  test("once its own cgroup is gone the parent can only confirm", async () => {
    expect(await judgeOomKill(unit, counting({ "/system.slice": 51 }))).toBe(true);
    expect(await judgeOomKill(unit, counting({ "/system.slice": 50 }))).toBeUndefined();
    expect(await judgeOomKill(unit, counting({}))).toBeUndefined();
  });

  test("no sample, or a probe that throws, is unknown", async () => {
    expect(await judgeOomKill([], counting({ [UNIT]: 43 }))).toBeUndefined();
    const broken: OomProbe = { cgroupOf: () => Promise.resolve(null), kills: () => Promise.reject(new Error("EIO")) };
    expect(await judgeOomKill(unit, broken)).toBeUndefined();
  });

  test("against the real files: a per-pane scope removed after the kill is confirmed through its slice", async () => {
    const samples = await sampleOom(300, probe());
    expect(samples).toHaveLength(2);
    await rm(join(cgroupRoot, SCOPE), { recursive: true });
    await oomKills("/user.slice/user-1000.slice/user@1000.service/app.slice", 4);
    expect(await judgeOomKill(samples, probe())).toBe(true);
  });
});

describe("perPass", () => {
  test("reads each cgroup's count once per pass", async () => {
    let reads = 0;
    const pass = perPass({ cgroupOf: () => Promise.resolve(UNIT), kills: () => Promise.resolve(++reads) });
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

  test("ledger samples: one or two, each a path and a count", () => {
    expect(isOomSamples([{ cgroup: UNIT, kills: 0 }])).toBe(true);
    for (const bad of [
      [],
      [{ cgroup: UNIT, kills: -1 }],
      [{ cgroup: UNIT, kills: 1.5 }],
      [{ cgroup: "../x", kills: 1 }],
      [{ cgroup: UNIT }],
      Array.from({ length: 3 }, () => ({ cgroup: UNIT, kills: 1 })),
      "x",
    ]) {
      expect(isOomSamples(bad)).toBe(false);
    }
  });
});
