import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBranchState, parseTaskProgressList, type BranchState, type RepoEntry } from "@seance/shared";
import { createBranchStates, type BranchStates } from "../src/branch-state.ts";
import { exec } from "../src/exec.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { captureLog, makeGitFixture, type GitFixture } from "./fixtures.ts";

const GIT_ID = ["-c", "user.email=test@seance.local", "-c", "user.name=Seance Test"];

let base: string;
let seq = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-branch-state-"));
  // No machine config may reach these repos, as in reap.test.ts.
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});

afterAll(async () => {
  delete process.env["GIT_CONFIG_GLOBAL"];
  delete process.env["GIT_CONFIG_NOSYSTEM"];
  await rm(base, { recursive: true, force: true });
});

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...GIT_ID, ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

interface World {
  readonly fixture: GitFixture;
  readonly repo: RepoEntry;
  readonly ledgerPath: string;
  readonly states: BranchState[];
  ledger: LaunchLedger;
  /** Emitters made through `start`, stopped with the world. */
  readonly started: BranchStates[];
}

async function world(): Promise<World> {
  seq += 1;
  const dir = join(base, `w${seq}`);
  const fixture = await makeGitFixture(dir);
  const repo: RepoEntry = {
    name: "myrepo",
    path: fixture.repoPath,
    defaultBranch: "main",
    origin: "example.test/org/myrepo",
  };
  const ledgerPath = join(dir, "launched.json");
  return { fixture, repo, ledgerPath, states: [], ledger: await LaunchLedger.open(ledgerPath), started: [] };
}

function start(w: World, overrides: Partial<Parameters<typeof createBranchStates>[0]> = {}): BranchStates {
  const states = createBranchStates({
    ledger: w.ledger,
    repos: () => [w.repo],
    emit: (state) => {
      w.states.push(state);
      return Promise.resolve(true);
    },
    intervalMs: 3_600_000,
    fetchStaleMs: 0,
    ...overrides,
  });
  w.started.push(states);
  return states;
}

function stopAll(w: World): void {
  for (const s of w.started) s.stop();
}

/** A worktree on a new `--no-track` branch from origin/main, as `claude --worktree` makes one; launched and sited in the ledger. */
async function launch(w: World, taskId: string, name: string): Promise<string> {
  const path = join(w.fixture.repoPath, ".claude", "worktrees", name);
  await git(w.fixture.repoPath, "worktree", "add", "-q", "--no-track", "-b", `worktree-${name}`, path, "origin/main");
  await w.ledger.record(taskId);
  await w.ledger.note(taskId, { repo: w.repo.path, path });
  return path;
}

async function commitAndPush(worktree: string, file: string, branch: string): Promise<void> {
  await writeFile(join(worktree, file), `${file}\n`);
  await git(worktree, "add", file);
  await git(worktree, "commit", "-q", "-m", `add ${file}`);
  await git(worktree, "push", "-q", "origin", branch);
}

/** What GitHub's squash merge leaves: one commit on origin's main, the branch deleted there. */
async function squashMergeOnOrigin(w: World, branch: string): Promise<void> {
  seq += 1;
  const server = join(base, `server-${seq}`);
  await git(base, "clone", "-q", w.fixture.barePath, server);
  await git(server, "merge", "--squash", `origin/${branch}`);
  await git(server, "commit", "-q", "-m", `${branch} (#1)`);
  await git(server, "push", "-q", "origin", "main", `:${branch}`);
}

async function fastForwardOnOrigin(w: World, branch: string): Promise<void> {
  seq += 1;
  const server = join(base, `server-${seq}`);
  await git(base, "clone", "-q", w.fixture.barePath, server);
  await git(server, "merge", "--ff-only", `origin/${branch}`);
  await git(server, "push", "-q", "origin", "main");
}

describe("branch-state emitter", () => {
  test("a fresh branch at origin/main sends one unpushed, unmerged state, and a second pass sends nothing", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    expect(w.states).toHaveLength(1);
    expect(w.states[0]).toMatchObject({
      taskId: "t1",
      repo: "example.test/org/myrepo",
      branch: "worktree-x",
      pushed: false,
      merged: false,
    });
    expect(parseBranchState(w.states[0])).not.toBeNull();
    await emitter.check();
    expect(w.states).toHaveLength(1);
    expect(w.ledger.notes()[0]?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a push with no upstream reads as pushed", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    const tracking = await exec(["git", "config", "--get", "branch.worktree-x.remote"], { cwd: path });
    expect(tracking.exitCode).not.toBe(0);
    await emitter.check();
    expect(w.states.map((s) => s.pushed)).toEqual([false, true]);
    await emitter.check();
    expect(w.states).toHaveLength(2);
    stopAll(w);
  });

  test("a branch renamed in the worktree sends the new name on the next pass", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-renamed"]);
    stopAll(w);
  });

  test("a stale remote ref under a fresh branch's name is not pushed, and never merged", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    seq += 1;
    const server = join(base, `server-${seq}`);
    await git(base, "clone", "-q", w.fixture.barePath, server);
    await git(server, "switch", "-q", "-c", "worktree-x");
    await writeFile(join(server, "old.txt"), "old\n");
    await git(server, "add", "old.txt");
    await git(server, "commit", "-q", "-m", "an earlier attempt");
    await git(server, "push", "-q", "origin", "worktree-x");
    await git(w.fixture.repoPath, "fetch", "-q", "origin");
    const emitter = start(w);
    await emitter.check();
    await emitter.check();
    expect(w.states).toHaveLength(1);
    expect(w.states[0]).toMatchObject({ pushed: false, merged: false });
    stopAll(w);
  });

  test("a squash merge with the branch deleted on origin sends merged, then nothing more", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ branch: "worktree-x", merged: true });
    const sent = w.states.length;
    expect(w.ledger.progress()).toEqual([
      expect.objectContaining({ taskId: "t1", branch: "worktree-x", pushed: true, merged: true }),
    ]);
    expect(parseTaskProgressList(w.ledger.progress())).not.toBeNull();
    await emitter.check();
    await emitter.check();
    expect(w.states).toHaveLength(sent);
    stopAll(w);
  });

  test("a fast-forward merge after a push sends merged", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ pushed: true, merged: false });
    await fastForwardOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ merged: true });
    stopAll(w);
  });

  test("a removed worktree is still watched through its last-seen branch", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    await git(w.fixture.repoPath, "worktree", "remove", "--force", path);
    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ branch: "worktree-x", merged: true });
    stopAll(w);
  });

  test("a deleted local branch is still judged by its last-seen tip", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    await git(w.fixture.repoPath, "worktree", "remove", "--force", path);
    await git(w.fixture.repoPath, "branch", "-D", "worktree-x");
    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ merged: true });
    stopAll(w);
  });

  test("an unreachable origin resolves quietly, merges nothing and warns once across passes", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    const sent = w.states.length;
    await git(w.fixture.repoPath, "remote", "set-url", "origin", join(base, "nowhere.git"));
    const lines = await captureLog(async () => {
      await emitter.check();
      await emitter.check();
    });
    expect(lines.filter((line) => line.includes("fetch failed"))).toHaveLength(1);
    expect(w.states).toHaveLength(sent);
    expect(w.ledger.notes()[0]?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a failed fetch is not retried on every pass: the repo backs off", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    await commitAndPush(path, "a.txt", "worktree-x");
    let fetches = 0;
    const emitter = start(w, {
      fetch: () => {
        fetches += 1;
        return Promise.resolve({ kind: "failed", detail: "exit 128: no route" });
      },
    });
    await emitter.check();
    await emitter.check();
    await emitter.check();
    // A pass that has not yet seen the work fetches nothing; the first that has fetches once, then the repo backs off.
    expect(fetches).toBe(1);
    stopAll(w);
  });

  test("a restart re-sends nothing that did not change, and keeps the progress", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const first = start(w);
    await commitAndPush(path, "a.txt", "worktree-x");
    await first.check();
    first.stop();
    const sent = w.states.length;

    w.ledger = await LaunchLedger.open(w.ledgerPath);
    const second = start(w);
    await second.check();
    await second.check();
    expect(w.states).toHaveLength(sent);
    expect(w.ledger.progress()).toEqual([expect.objectContaining({ taskId: "t1", pushed: true })]);
    stopAll(w);
  });

  test("a restart after a merge the daemon missed still settles it", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const first = start(w);
    await commitAndPush(path, "a.txt", "worktree-x");
    await first.check();
    first.stop();
    await squashMergeOnOrigin(w, "worktree-x");

    w.ledger = await LaunchLedger.open(w.ledgerPath);
    const second = start(w);
    await second.check();
    expect(w.states.at(-1)).toMatchObject({ merged: true });
    stopAll(w);
  });

  test("a repo missing from the repo list is skipped", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    const emitter = start(w, { repos: () => [] });
    await emitter.check();
    expect(w.states).toEqual([]);
    stopAll(w);
  });

  test("an undelivered state is retried on the next pass, and delivered exactly once", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    const delivered: BranchState[] = [];
    let deliver = false;
    const emitter = start(w, {
      emit: (state) => {
        if (deliver) delivered.push(state);
        return Promise.resolve(deliver);
      },
    });
    // The constructor's own pass and this one both find it undelivered.
    await emitter.check();
    await emitter.check();
    expect(delivered).toEqual([]);
    deliver = true;
    await emitter.check();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ taskId: "t1", branch: "worktree-x" });
    await emitter.check();
    expect(delivered).toHaveLength(1);
    stopAll(w);
  });

  test("a rejecting emit is retried like an undelivered one", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    let calls = 0;
    const emitter = start(w, {
      emit: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("socket")) : Promise.resolve(true);
      },
    });
    await emitter.check();
    await emitter.check();
    await emitter.check();
    expect(calls).toBe(2);
    stopAll(w);
  });

  test("two tasks on one path: the newer reads live, the older is judged by its recorded branch", async () => {
    const w = await world();
    const path = await launch(w, "old", "x");
    await commitAndPush(path, "a.txt", "worktree-x");
    const oldTip = await git(path, "rev-parse", "HEAD");
    await w.ledger.note("old", { branch: "worktree-x", tip: oldTip, ahead: true, pushed: true });
    // The worktree name is reused: the same directory now holds a newer task's branch.
    await git(path, "switch", "-q", "--no-track", "-c", "worktree-new", "origin/main");
    await w.ledger.record("new");
    await w.ledger.note("new", { repo: w.repo.path, path });

    const emitter = start(w);
    await emitter.check();
    expect(w.states.map((s) => [s.taskId, s.branch])).toEqual([["new", "worktree-new"]]);

    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.slice(1).map((s) => [s.taskId, s.branch, s.merged])).toEqual([["old", "worktree-x", true]]);
    stopAll(w);
  });
});
