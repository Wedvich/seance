import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateReport } from "@seance/shared";
import { exec } from "./exec.ts";
import { createUpdater, type UpdateEffects, type Updater } from "./update.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

const GIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec(["git", "-C", cwd, ...GIT_ID, ...args]);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Upstream work repo plus a clone — the clone plays the daemon's checkout. */
async function makePair(): Promise<{ upstream: string; checkout: string }> {
  const base = await mkdtemp(join(tmpdir(), "seance-update-"));
  cleanups.push(base);
  const upstream = join(base, "upstream");
  await exec(["git", "init", "-q", "-b", "main", upstream]);
  await Bun.write(join(upstream, "f.txt"), "one\n");
  await runGit(upstream, ["add", "f.txt"]);
  await runGit(upstream, ["commit", "-q", "-m", "one"]);
  const checkout = join(base, "checkout");
  await exec(["git", "clone", "-q", upstream, checkout]);
  return { upstream, checkout };
}

async function publish(upstream: string): Promise<string> {
  await runGit(upstream, ["commit", "-q", "--allow-empty", "-m", "next"]);
  return runGit(upstream, ["rev-parse", "HEAD"]);
}

interface Harness {
  readonly reports: UpdateReport[];
  readonly lines: string[];
  readonly calls: { install: number; restart: number; reportsAtRestart: number };
  readonly make: (root: string, debounceMs?: number) => Updater;
}

function harness(effectOverrides: Partial<UpdateEffects> = {}): Harness {
  const reports: UpdateReport[] = [];
  const lines: string[] = [];
  const calls = { install: 0, restart: 0, reportsAtRestart: -1 };
  const effects: UpdateEffects = {
    install: async () => {
      calls.install += 1;
      return { ok: true };
    },
    restart: async () => {
      calls.restart += 1;
      calls.reportsAtRestart = reports.length;
    },
    ...effectOverrides,
  };
  return {
    reports,
    lines,
    calls,
    make: (root, debounceMs = 0) =>
      createUpdater({
        root,
        debounceMs,
        effects,
        sink: (line) => {
          lines.push(line);
        },
        report: async (report) => {
          reports.push(report);
        },
      }),
  };
}

describe("self-update pipeline", () => {
  test("fast-forwards a clean checkout that is behind, installs, reports, then restarts", async () => {
    const { upstream, checkout } = await makePair();
    const target = await publish(upstream);
    const h = harness();

    const updater = h.make(checkout);
    updater.check("announce");
    await updater.settled();

    expect(await runGit(checkout, ["rev-parse", "HEAD"])).toBe(target);
    expect(h.calls.install).toBe(1);
    expect(h.calls.restart).toBe(1);
    expect(h.reports.map((r) => r.outcome)).toEqual(["ok"]);
    // The restart kills the process, so the ok must already be persisted.
    expect(h.calls.reportsAtRestart).toBe(1);
    expect(h.lines.some((l) => l.startsWith("audit update origin=announce outcome=ok"))).toBe(true);
  });

  test("a converged checkout audits `current` and is never reported", async () => {
    const { checkout } = await makePair();
    const h = harness();

    const updater = h.make(checkout);
    updater.check("register");
    await updater.settled();

    expect(h.reports).toEqual([]);
    expect(h.calls.install).toBe(0);
    expect(h.lines.some((l) => l.includes("outcome=current"))).toBe(true);
  });

  test("a dirty tree is a refusal, before anything touches the network's result", async () => {
    const { upstream, checkout } = await makePair();
    await publish(upstream);
    await appendFile(join(checkout, "f.txt"), "local edit\n");
    const h = harness();

    const updater = h.make(checkout);
    updater.check("register");
    await updater.settled();

    expect(h.reports.map((r) => r.outcome)).toEqual(["skipped_dirty"]);
    expect(h.calls.install).toBe(0);
    expect(h.calls.restart).toBe(0);
  });

  test("a checkout off its default branch is a refusal", async () => {
    const { upstream, checkout } = await makePair();
    await publish(upstream);
    await runGit(checkout, ["checkout", "-q", "-b", "feature"]);
    const h = harness();

    const updater = h.make(checkout);
    updater.check("register");
    await updater.settled();

    expect(h.reports.map((r) => r.outcome)).toEqual(["skipped_branch"]);
    expect(h.reports[0]?.detail).toContain("feature");
  });

  test("local commits origin lacks are a refusal, never a force", async () => {
    const { checkout } = await makePair();
    await runGit(checkout, ["commit", "-q", "--allow-empty", "-m", "local work"]);
    const h = harness();

    const updater = h.make(checkout);
    updater.check("register");
    await updater.settled();

    expect(h.reports.map((r) => r.outcome)).toEqual(["skipped_diverged"]);
  });

  test("an unreachable origin reports fetch_failed", async () => {
    const { upstream, checkout } = await makePair();
    await publish(upstream);
    await runGit(checkout, ["remote", "set-url", "origin", join(checkout, "nowhere")]);
    const h = harness();

    const updater = h.make(checkout);
    updater.check("register");
    await updater.settled();

    expect(h.reports.map((r) => r.outcome)).toEqual(["fetch_failed"]);
  });

  test("a failed install reports install_failed, keeps running, and leaves the ff in place", async () => {
    const { upstream, checkout } = await makePair();
    const target = await publish(upstream);
    const h = harness({ install: async () => ({ ok: false, detail: "lockfile drift" }) });

    const updater = h.make(checkout);
    updater.check("announce");
    await updater.settled();

    expect(h.reports.map((r) => r.outcome)).toEqual(["install_failed"]);
    expect(h.reports[0]?.detail).toBe("lockfile drift");
    expect(h.calls.restart).toBe(0);
    // Documented no-rollback: disk moved forward, the process still runs the old code.
    expect(await runGit(checkout, ["rev-parse", "HEAD"])).toBe(target);
  });

  test("checks are single-flight with one coalesced trailing run, then debounced", async () => {
    const { checkout } = await makePair();
    const h = harness();

    const updater = h.make(checkout, 60_000);
    updater.check("register");
    updater.check("announce"); // in flight — queued, coalesced into one trailing run
    updater.check("announce");
    await updater.settled();
    updater.check("register"); // idle and inside the debounce window — suppressed
    await updater.settled();

    expect(h.lines.filter((l) => l.includes("checking")).length).toBe(2);
  });
});
