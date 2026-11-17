import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ctimeUtcSeconds, procStartMatches, readAgentSession } from "./agent-session-file.ts";
import { processStart } from "./peer.ts";

const SESSION = "0b3f5e0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

/** `procStart` as Claude Code writes it on this platform for a process that started at `start` (`processStart`). */
function procStartFor(start: string): string {
  if (process.platform === "linux") return start;
  const seconds = Number(start.split(".")[0]);
  return ctimeUtc(seconds);
}

/** A zone-less `ctime` string in UTC, day space-padded as libc does. */
function ctimeUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number): string => String(n).padStart(2, "0");
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${time} ${d.getUTCFullYear()}`;
}

describe("procStartMatches", () => {
  test("macOS: a UTC ctime matches the seconds of `sec.usec`, whatever TZ the daemon runs under", () => {
    const before = process.env["TZ"];
    process.env["TZ"] = "Europe/Oslo";
    try {
      expect(procStartMatches("Tue Nov 17 09:03:05 2026", "1794906185.123456", "darwin")).toBe(true);
      expect(procStartMatches("Sat Nov  7 09:03:05 2026", "1794042185.9", "darwin")).toBe(true);
      // A second off, either way, is another process.
      expect(procStartMatches("Tue Nov 17 09:03:06 2026", "1794906185.123456", "darwin")).toBe(false);
      expect(procStartMatches("Tue Nov 17 09:03:04 2026", "1794906185.123456", "darwin")).toBe(false);
      // Read as local time it would be an hour off: the zone is never applied.
      expect(procStartMatches("Tue Nov 17 10:03:05 2026", "1794906185.123456", "darwin")).toBe(false);
    } finally {
      if (before === undefined) delete process.env["TZ"];
      else process.env["TZ"] = before;
    }
  });

  test("macOS: a tick string, a day the month lacks or a non-string is no match", () => {
    expect(procStartMatches("1794906185", "1794906185.1", "darwin")).toBe(false);
    expect(ctimeUtcSeconds("Tue Feb 31 09:03:05 2026")).toBeNull();
    expect(procStartMatches(1794906185, "1794906185.1", "darwin")).toBe(false);
  });

  test("Linux: equal tick strings match, a tick off or macOS's ctime form does not", () => {
    expect(procStartMatches("123456789", "123456789", "linux")).toBe(true);
    expect(procStartMatches("123456790", "123456789", "linux")).toBe(false);
    expect(procStartMatches("Tue Nov 17 09:03:05 2026", "123456789", "linux")).toBe(false);
  });

  test("any other platform matches nothing", () => {
    expect(procStartMatches("123", "123", "win32")).toBe(false);
  });
});

describe("readAgentSession", () => {
  let base: string;
  let dirA: string;
  let dirB: string;
  let start: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "seance-asf-")));
    dirA = join(base, "a");
    dirB = join(base, "b");
    await mkdir(join(dirA, "sessions"), { recursive: true });
    await mkdir(join(dirB, "sessions"), { recursive: true });
    const own = processStart(process.pid);
    if (own === null) throw new Error("no start time for this process");
    start = own;
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const fileOf = (dir: string, pid = process.pid): string => join(dir, "sessions", `${pid}.json`);
  const record = (fields: object = {}): string =>
    JSON.stringify({ pid: process.pid, sessionId: SESSION, procStart: procStartFor(start), ...fields });
  const clear = async (): Promise<void> => {
    await rm(fileOf(dirA), { force: true });
    await rm(fileOf(dirB), { force: true });
  };

  test("the process's own file names its conversation, and its bridge", async () => {
    await clear();
    await writeFile(fileOf(dirA), record({ bridgeSessionId: "session_01Bridge" }));
    expect(await readAgentSession(process.pid, start, [dirA, dirB])).toEqual({
      kind: "found",
      sessionId: SESSION,
      bridge: "session_01Bridge",
    });
  });

  test("a file naming another pid, an older start or a malformed id is no match", async () => {
    await clear();
    await writeFile(fileOf(dirA), record({ pid: process.pid + 1 }));
    expect(await readAgentSession(process.pid, start, [dirA])).toEqual({ kind: "none" });
    // A file a SIGKILLed process left for a pid the kernel reused.
    const older =
      process.platform === "linux" ? String(Number(start) - 100) : ctimeUtc(Number(start.split(".")[0]) - 100);
    await writeFile(fileOf(dirA), record({ procStart: older }));
    expect(await readAgentSession(process.pid, start, [dirA])).toEqual({ kind: "none" });
    await writeFile(fileOf(dirA), record({ sessionId: SESSION.toUpperCase() }));
    expect(await readAgentSession(process.pid, start, [dirA])).toEqual({ kind: "none" });
  });

  test("a symlink or a FIFO in the file's place is never followed or waited on", async () => {
    await clear();
    const real = join(base, "elsewhere.json");
    await writeFile(real, record());
    await symlink(real, fileOf(dirA));
    expect(await readAgentSession(process.pid, start, [dirA])).toEqual({ kind: "none" });
    await rm(fileOf(dirA));
    const made = Bun.spawnSync(["mkfifo", fileOf(dirA)]);
    expect(made.exitCode).toBe(0);
    expect(await readAgentSession(process.pid, start, [dirA])).toEqual({ kind: "none" });
    await rm(fileOf(dirA));
  });

  test("two config dirs both matching is no verification", async () => {
    await clear();
    await writeFile(fileOf(dirA), record());
    await writeFile(fileOf(dirB), record());
    expect(await readAgentSession(process.pid, start, [dirA, dirB])).toEqual({ kind: "ambiguous" });
    // The same dir named twice is one dir.
    expect(await readAgentSession(process.pid, start, [dirA, dirA])).toEqual({ kind: "found", sessionId: SESSION });
  });
});
