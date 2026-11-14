import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configSkeleton } from "../src/config.ts";
import { parseDuration, printable, requestOwnerRound } from "../src/custodian-owner-cli.ts";
import { emptyCounts } from "../src/custodian-rounds.ts";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * `seanced custodian status | log | round | pause | resume` through the real CLI as a subprocess, on a throwaway state
 * dir: what the owner types is the product, and the dispatch in `main.ts` is part of it.
 */
describe("seanced custodian, the owner's verbs", () => {
  let root: string;
  let custodian: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-owner-cli-"));
    custodian = join(root, "state", "custodian");
    env = { ...process.env, SEANCE_STATE_DIR: join(root, "state"), SEANCE_CONFIG_DIR: join(root, "config") };
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const run = async (...args: string[]): Promise<{ out: string; err: string; code: number }> => {
    const proc = Bun.spawn([process.execPath, mainPath, "custodian", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { out, err, code };
  };
  const audit = async (): Promise<string> => readFile(join(root, "state", "seanced.log"), "utf8").catch(() => "");

  test("pause --for shows in status until resume clears it, both audited under origin=cli", async () => {
    expect((await run("pause", "--for", "1h")).code).toBe(0);
    expect((await run("status")).out).toMatch(/paused:\s+until /u);
    expect((await run("resume")).out).toContain("resumed");
    expect((await run("status")).out).toMatch(/paused:\s+no\n/u);
    expect((await run("pause")).out).toContain("until resume");
    expect((await run("status")).out).toMatch(/paused:\s+until resume/u);
    const lines = (await audit()).split("\n").filter((line) => line.includes("audit custodian"));
    expect(lines.map((line) => /op=(\w+)/u.exec(line)?.[1])).toEqual(["pause", "resume", "pause"]);
    for (const line of lines) expect(line).toContain("origin=cli");
    expect((await stat(join(custodian, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(custodian)).mode & 0o777).toBe(0o700);
  });

  test("a pause outside 1m..30d, or malformed, is a usage error and writes nothing", async () => {
    for (const bad of ["0m", "40d", "31d", "1w", "h", "-1h", "1.5h"]) {
      const result = await run("pause", "--for", bad);
      expect(result.code).toBe(2);
    }
    expect((await run("pause", "--for")).code).toBe(2);
    expect((await run("pause", "now")).code).toBe(2);
    expect(await Bun.file(join(custodian, "state.json")).exists()).toBe(false);
    expect((await run("pause", "--for", "30d")).code).toBe(0);
    expect((await run("pause", "--for=1m")).code).toBe(0);
  });

  test("a state file it cannot read reads as paused in status, and resume repairs it", async () => {
    await mkdir(custodian, { recursive: true });
    await writeFile(join(custodian, "state.json"), "{nope");
    expect((await run("status")).out).toContain("custodian/state.json is unreadable");
    expect((await run("resume")).code).toBe(0);
    expect((await run("status")).out).toMatch(/paused:\s+no\n/u);
  });

  test("round is refused while rounds are held: exit 1, the reason, no request file, one audit line", async () => {
    const result = await run("round");
    expect(result.code).toBe(1);
    expect(result.err).toContain("build item 4b");
    expect(await Bun.file(join(custodian, "round-request")).exists()).toBe(false);
    const lines = (await audit()).split("\n").filter((line) => line.includes("op=round"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("origin=cli");
    expect(lines[0]).toContain("outcome=held");
  });

  test("status says rounds are held, and that the daemon has not reported", async () => {
    const { out, code } = await run("status");
    expect(code).toBe(0);
    expect(out).toContain("rounds:      held (docs/custodian.md, build item 4b)");
    expect(out).toContain("has not reported");
    expect(out).toContain("seat:        not configured");
    expect(out).toContain("last round:  none");
  });

  test("status reads the seat's published view, and says failing from it", async () => {
    await mkdir(custodian, { recursive: true });
    await writeFile(
      join(custodian, "seat.json"),
      JSON.stringify({ s: "failing", at: Date.now(), failed: true, version: "abc123" }),
    );
    const { out } = await run("status");
    expect(out).toContain("failing, host checks failed");
    expect(out).toMatch(/failing:\s+yes/u);
  });

  test("log prints newest first, with a summary's control and bidi characters replaced", async () => {
    expect((await run("log")).out).toContain("no rounds logged");
    await mkdir(custodian, { recursive: true });
    const entry = (start: number, over: object) => ({
      start,
      end: start + 1_000,
      exclave: "default",
      outcome: "healthy",
      reason: "done",
      counts: emptyCounts(),
      ...over,
    });
    await writeFile(
      join(custodian, "rounds.jsonl"),
      [
        entry(1_700_000_000_000, { summary: "older round" }),
        entry(1_700_000_100_000, { summary: "\u001B[2Jclear‮evil\nsecond line", exclave: "x\u001B[31m" }),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const { out, code } = await run("log");
    expect(code).toBe(0);
    expect(out).not.toContain("\u001B");
    expect(out).not.toContain("‮");
    expect(out).toContain("�[2J");
    expect(out).toContain("clear�evil");
    expect(out).toContain("second line");
    expect(out.indexOf("clear")).toBeLessThan(out.indexOf("older round"));
  });
});

describe("printable and parseDuration", () => {
  test("printable replaces control, format and separator characters and truncates", () => {
    expect(printable("a\u001Bb\u009Bc‮d e​f\ng")).toBe("a�b�c�d�e�f�g");
    expect(printable("a\nb", 10, true)).toBe("a\nb");
    expect(printable("x".repeat(500), 10)).toBe(`${"x".repeat(10)}…`);
  });

  test("parseDuration takes n then m, h or d, from 1m to 30d", () => {
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    for (const bad of ["0m", "31d", "43201m", "1", "m", "1x", "1 h", ""]) expect(parseDuration(bad)).toBeNull();
  });
});

describe("round, with rounds live (the test seam), reads the seat's published view", () => {
  let root: string;
  const saved = { state: process.env["SEANCE_STATE_DIR"], config: process.env["SEANCE_CONFIG_DIR"] };
  const seatPath = (): string => join(root, "state", "custodian", "seat.json");
  const requestPath = (): string => join(root, "state", "custodian", "round-request");
  const writeConfig = (extra: object): Promise<void> =>
    writeFile(join(root, "config", "config.json"), JSON.stringify({ ...JSON.parse(configSkeleton("m")), ...extra }));
  const view = (over: object): string =>
    JSON.stringify({ s: "idle", at: Date.now(), failed: false, version: "v", ...over });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-owner-round-"));
    process.env["SEANCE_STATE_DIR"] = join(root, "state");
    process.env["SEANCE_CONFIG_DIR"] = join(root, "config");
    await mkdir(join(root, "state", "custodian"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeConfig({ custodian: {} });
  });
  afterEach(async () => {
    for (const [key, value] of [
      ["SEANCE_STATE_DIR", saved.state],
      ["SEANCE_CONFIG_DIR", saved.config],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("a fresh view writes the request and exits 0", async () => {
    await writeFile(seatPath(), view({}));
    await requestOwnerRound(true);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(await readFile(requestPath(), "utf8")).at).toBeNumber();
  });

  test("a failed view writes nothing and exits 1, but a stale failed view is no report", async () => {
    await writeFile(seatPath(), view({ failed: true }));
    await requestOwnerRound(true);
    expect(process.exitCode).toBe(1);
    expect(await Bun.file(requestPath()).exists()).toBe(false);
    process.exitCode = 0;
    await writeFile(seatPath(), view({ failed: true, at: Date.now() - 3_600_000 }));
    await requestOwnerRound(true);
    expect(process.exitCode ?? 0).toBe(0);
    expect(await Bun.file(requestPath()).exists()).toBe(true);
  });

  test("a running round, or one that started or ended within the min-gap, is refused with the reason", async () => {
    await writeFile(seatPath(), view({ s: "running" }));
    await requestOwnerRound(true);
    expect(process.exitCode).toBe(1);
    expect(await Bun.file(requestPath()).exists()).toBe(false);
    process.exitCode = 0;
    await writeFile(seatPath(), view({}));
    const entry = {
      start: Date.now() - 60_000,
      end: Date.now() - 30_000,
      exclave: "default",
      outcome: "healthy",
      reason: "done",
      counts: emptyCounts(),
    };
    await writeFile(join(root, "state", "custodian", "rounds.jsonl"), `${JSON.stringify(entry)}\n`);
    await requestOwnerRound(true);
    expect(process.exitCode).toBe(1);
    expect(await Bun.file(requestPath()).exists()).toBe(false);
  });

  test("a missing or stale view warns but still writes the request", async () => {
    await requestOwnerRound(true);
    expect(await Bun.file(requestPath()).exists()).toBe(true);
    await rm(requestPath());
    await writeFile(seatPath(), view({ at: Date.now() - 3_600_000 }));
    await requestOwnerRound(true);
    expect(await Bun.file(requestPath()).exists()).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("with no custodian key it writes nothing and exits 1", async () => {
    await writeConfig({});
    await requestOwnerRound(true);
    expect(process.exitCode).toBe(1);
    expect(await Bun.file(requestPath()).exists()).toBe(false);
  });
});
