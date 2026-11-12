import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID, SCHEDULER_ID, type Plain, type RepoEntry } from "@seance/shared";
import { pushAudit, type AuditSink } from "../src/audit.ts";
import type { SessionBackend } from "../src/backend.ts";
import { exec } from "../src/exec.ts";
import { createHandler, createLocalOps, pushForTask, type HandlerContext, type TaskLaunches } from "../src/handlers.ts";
import { makeGitFixture, type GitFixture } from "./fixtures.ts";

/**
 * `push-branch` at the daemon holding the task: who may ask, which worktree it resolves to, and what
 * its audit lines name (DESIGN.md, "Passing to a successor"). The push itself is `push-branch.test.ts`'s.
 */

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];

let base: string;
let fixture: GitFixture;
let repos: readonly RepoEntry[];
let savedGlobal: string | undefined;
let savedNoSystem: string | undefined;
const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);

/** Where the launch ledger says each task ran; a task the map lacks has no launch here. */
const sites = new Map<string, { readonly repo: string; readonly path: string }>();

const tasks: TaskLaunches = {
  launch: () => Promise.reject(new Error("unused")),
  launched: () => false,
  worktree: (taskId) => sites.get(taskId) ?? { refused: "this machine holds no launch of it" },
  continuation: () => ({ refused: "unused" }),
  closing: () => Promise.resolve(),
  settled: () => Promise.resolve(),
  report: () => ({ ended: [], ledgerSince: 0 }),
  progress: () => [],
};

const backend: SessionBackend = {
  spawn: () => Promise.reject(new Error("unused")),
  sessions: () => Promise.resolve([]),
  doctor: () => Promise.resolve([]),
};

function ctx(): HandlerContext {
  return {
    backend,
    getRepos: () => repos,
    rescan: () => Promise.resolve(repos),
    auditSink: collect,
    tasks,
  };
}

const request = (payload: unknown): Plain => ({ id: "req-1", ts: Date.now(), op: "push-branch", payload });
const logged = (): string => lines.join("\n");

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...GIT_ID, ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function taskWorktree(taskId: string, branch: string): Promise<{ path: string; tip: string }> {
  const path = join(fixture.repoPath, ".claude", "worktrees", branch.replaceAll("/", "-"));
  await git(fixture.repoPath, "worktree", "add", "-q", "--no-track", "-b", branch, path, "origin/main");
  await writeFile(join(path, `${taskId}.txt`), "work\n");
  await git(path, "add", ".");
  await git(path, "commit", "-q", "-m", "work");
  sites.set(taskId, { repo: fixture.repoPath, path });
  return { path, tip: await git(path, "rev-parse", "HEAD") };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-push-handler-"));
  savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  savedNoSystem = process.env["GIT_CONFIG_NOSYSTEM"];
  const globalConfig = join(base, "gitconfig");
  await writeFile(globalConfig, "");
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  fixture = await makeGitFixture(base);
  repos = [{ name: "myrepo", path: fixture.repoPath, defaultBranch: "main" }];
});

afterAll(async () => {
  if (savedGlobal === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
  else process.env["GIT_CONFIG_GLOBAL"] = savedGlobal;
  if (savedNoSystem === undefined) delete process.env["GIT_CONFIG_NOSYSTEM"];
  else process.env["GIT_CONFIG_NOSYSTEM"] = savedNoSystem;
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  lines.length = 0;
  sites.clear();
});

describe("push-branch", () => {
  test("pushes the worktree the ledger names and audits a code and a short tip, never the branch", async () => {
    const { tip } = await taskWorktree("t-push", "task/audited-secret");
    const reply = await createHandler(ctx())(request({ taskId: "t-push" }), SCHEDULER_ID);
    expect(reply?.payload).toEqual({ ok: true, remoteBranch: "task/audited-secret", tip, pushed: true });
    expect(logged()).toContain(
      `audit push origin=relay task="t-push" repo="myrepo" outcome=pushed tip=${tip.slice(0, 7)}`,
    );
    const again = await createHandler(ctx())(request({ taskId: "t-push" }), SCHEDULER_ID);
    expect(again?.payload).toMatchObject({ ok: true, pushed: false });
    expect(logged()).toContain(`outcome=unchanged tip=${tip.slice(0, 7)}`);
    expect(logged()).not.toContain("audited-secret");
  });

  test("only the scheduler's seal may ask", async () => {
    await taskWorktree("t-app", "task/app-asks");
    for (const from of [APP_ID, undefined]) {
      // oxlint-disable-next-line no-await-in-loop -- two asks, one outcome each
      const reply = await createHandler(ctx())(request({ taskId: "t-app" }), from);
      expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(logged()).not.toContain("audit push");
  });

  test("a task this machine holds no launch of is not_launched, audited", async () => {
    const reply = await createHandler(ctx())(request({ taskId: "t-none" }), SCHEDULER_ID);
    expect(reply?.payload).toMatchObject({ ok: false, code: "not_launched" });
    expect(logged()).toContain('audit push origin=relay task="t-none" outcome=not_launched');
  });

  test("a worktree outside its clone's .claude/worktrees is not one to push from", async () => {
    sites.set("t-out", { repo: fixture.repoPath, path: fixture.repoPath });
    const reply = await createHandler(ctx())(request({ taskId: "t-out" }), SCHEDULER_ID);
    expect(reply?.payload).toMatchObject({ ok: false, code: "not_launched" });
  });

  test("a clone this daemon no longer scans is not_launched", async () => {
    const { path } = await taskWorktree("t-gone", "task/unscanned");
    sites.set("t-gone", { repo: join(base, "elsewhere"), path });
    const reply = await createHandler(ctx())(request({ taskId: "t-gone" }), SCHEDULER_ID);
    expect(reply?.payload).toMatchObject({ ok: false, code: "not_launched" });
  });

  test("a malformed request, or a head that is no branch name, is invalid_request", async () => {
    await taskWorktree("t-bad", "task/bad-request");
    for (const payload of [{}, { taskId: "t-bad", expect: "-x" }, { taskId: "t-bad", extra: 1, expect: 3 }]) {
      // oxlint-disable-next-line no-await-in-loop -- each case is its own reply
      const reply = await createHandler(ctx())(request(payload), SCHEDULER_ID);
      expect(reply?.payload).toMatchObject({ ok: false, code: "invalid_request" });
    }
  });

  test("the leader reaching its own machine runs the same op under its own origin", async () => {
    const { tip } = await taskWorktree("t-local", "task/local-leader");
    const reply = await createLocalOps(ctx(), "leader").pushBranch({ taskId: "t-local" });
    expect(reply).toMatchObject({ ok: true, tip });
    expect(logged()).toContain('audit request origin=leader op="push-branch"');
    expect(logged()).toContain('audit push origin=leader task="t-local"');
  });
});

describe("pushForTask", () => {
  test("a session's own pass pushes the same worktree under origin=successor, and the audit names no branch", async () => {
    const { tip } = await taskWorktree("t-self", "task/self-secret");
    const reply = await pushForTask(ctx(), pushAudit("successor", collect), "t-self", { hasPr: false });
    expect(reply).toEqual({ ok: true, remoteBranch: "task/self-secret", tip, pushed: true });
    expect(logged()).toContain(
      `audit push origin=successor task="t-self" repo="myrepo" outcome=pushed tip=${tip.slice(0, 7)}`,
    );
    expect(logged()).not.toContain("self-secret");
  });

  test("a task with no launch here is not_launched, audited under the same origin", async () => {
    const reply = await pushForTask(ctx(), pushAudit("successor", collect), "t-none", {});
    expect(reply).toMatchObject({ ok: false, code: "not_launched" });
    expect(logged()).toContain('audit push origin=successor task="t-none" outcome=not_launched');
  });
});
