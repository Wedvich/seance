import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64 } from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config, ReapConfig } from "../src/config.ts";
import { exec } from "../src/exec.ts";
import { startDaemon, type DaemonHandle } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { makeGitFixture, pollUntil, usePrivateTmux, type GitFixture, type PrivateTmux } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

/**
 * The schedule inside the daemon: off unless configured, reports to the log,
 * audits as origin=schedule, and remembers its last run across restarts. A
 * merged branch nothing checks out is the cheapest thing a run deletes — no age
 * gate, no worktree — so it is what each test watches.
 */

const PSK = toBase64(new Uint8Array(32).fill(7));
const TOKEN = "test-bearer";

let base: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let relay: TestRelay;
let lines: string[] = [];
let realLog: typeof console.log;
let realError: typeof console.error;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-reapsched-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  privateTmux = usePrivateTmux(base, "reapsched");
  fixture = await makeGitFixture(base);
  // A fresh FETCH_HEAD, so no run here reaches for the network.
  await git("fetch", "-q", "origin");
  relay = startTestRelay(TOKEN);
  const capture = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  realLog = console.log;
  realError = console.error;
  console.log = capture;
  console.error = capture;
});

afterAll(async () => {
  console.log = realLog;
  console.error = realError;
  relay.stop();
  await privateTmux?.dispose();
  for (const key of ["SEANCE_STATE_DIR", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    delete process.env[key];
  }
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  lines = [];
});

async function git(...args: readonly string[]): Promise<void> {
  const result = await exec(["git", ...args], { cwd: fixture.repoPath });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

async function branchExists(name: string): Promise<boolean> {
  return (
    (await exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: fixture.repoPath }))
      .exitCode === 0
  );
}

async function daemonWith(reap: ReapConfig | undefined): Promise<DaemonHandle> {
  const config: Config = {
    name: "TestMac",
    relayUrl: relay.url,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
    ...(reap === undefined ? {} : { reap }),
  };
  const daemon = await startDaemon({
    config,
    backend: createBackend(config),
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    reapCheckIntervalMs: 50,
  });
  // The schedule reaps the scan set, which the daemon's first rescan fills in.
  await pollUntil(async () => ((await readState())?.repos.length ?? 0) > 0, "first scan");
  return daemon;
}

const logged = (): string => lines.join("\n");

describe("the reap schedule", () => {
  test("off by default: no block, no run", async () => {
    await git("branch", "untouched");
    const daemon = await daemonWith(undefined);
    try {
      await Bun.sleep(400); // a non-event: nothing to poll for
      expect(await branchExists("untouched")).toBe(true);
      expect(logged()).not.toContain("audit reap");
    } finally {
      daemon.stop();
      await git("branch", "-D", "untouched");
    }
  });

  test("a due run audits as origin=schedule, reports to the log, and records when it ran", async () => {
    await git("branch", "merged-already");
    const daemon = await daemonWith({ intervalHours: 24, minAgeDays: 7 });
    try {
      await pollUntil(() => logged().includes("audit reap origin=schedule done"), "a scheduled run");
      expect(await branchExists("merged-already")).toBe(false);
      expect(logged()).toContain('audit reap origin=schedule deleted-branch repo="myrepo" branch="merged-already"');
      expect(logged()).toContain("reap: removed 0 worktrees · deleted 1 branch");
      await pollUntil(async () => (await readState())?.lastReapAt !== undefined, "lastReapAt saved");
    } finally {
      daemon.stop();
    }
  });

  test("a restart inside the interval doesn't run again — lastReapAt outlives the process", async () => {
    await git("branch", "merged-later");
    const daemon = await daemonWith({ intervalHours: 24, minAgeDays: 7 });
    try {
      await Bun.sleep(400); // a non-event, as above
      expect(await branchExists("merged-later")).toBe(true);
      expect(logged()).not.toContain("audit reap");
    } finally {
      daemon.stop();
      await git("branch", "-D", "merged-later");
    }
  });
});
