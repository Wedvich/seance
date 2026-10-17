import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBranchState, parseTaskProgressList, type BranchState, type RepoEntry } from "@seance/shared";
import { BRANCH_ENDED_GRACE_MS, createBranchStates, type BranchStates } from "../src/branch-state.ts";
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
    await emitter.check();
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
    await emitter.check();
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
    await emitter.check();
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
    expect(lines.join("\n")).not.toContain("nowhere");
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
        return Promise.resolve({ kind: "failed", detail: "exit 128: no route", brief: "exit 128" });
      },
    });
    await emitter.check();
    await emitter.check();
    await emitter.check();
    // A pass that has not yet seen the work fetches nothing; the first that has fetches once, then the repo backs off.
    expect(fetches).toBe(1);
    stopAll(w);
  });

  test("the fetch warning names the repo and the exit code, never git's stderr", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    await commitAndPush(path, "a.txt", "worktree-x");
    const emitter = start(w, {
      fetch: () =>
        Promise.resolve({
          kind: "failed",
          detail: "exit 128: fatal: https://user:hunter2@example.test/org/myrepo.git unreachable",
          brief: "exit 128",
        }),
    });
    const lines = await captureLog(async () => {
      await emitter.check();
      await emitter.check();
    });
    const warned = lines.filter((line) => line.includes("fetch failed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("myrepo");
    expect(warned[0]).toContain("exit 128");
    expect(warned[0]).not.toContain("hunter2");
    stopAll(w);
  });

  test("a restart re-sends nothing that did not change, and keeps the progress", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const first = start(w);
    await first.check();
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
    await first.check();
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

  /** What `freeWorktreeName` allows: the worktree and its local branch are gone, origin's ref stays, the name is reused. */
  async function reuseName(w: World, oldPath: string, name: string, taskId: string): Promise<string> {
    await git(w.fixture.repoPath, "worktree", "remove", "--force", oldPath);
    await git(w.fixture.repoPath, "branch", "-D", `worktree-${name}`);
    return launch(w, taskId, name);
  }

  test("a reused branch name: the newer task reads live, the older is judged by its recorded tip alone", async () => {
    const w = await world();
    const path = await launch(w, "old", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await w.ledger.note("old", { prUrl: "https://github.com/org/myrepo/pull/1" });
    await emitter.check();
    const oldTip = w.ledger.notes().find((n) => n.taskId === "old")?.tip;
    expect(oldTip).toBe(await git(path, "rev-parse", "HEAD"));
    const sent = w.states.length;

    // B is spawned at origin/main under the same name, while A's PR is open on origin.
    await reuseName(w, path, "x", "new");
    await emitter.check();
    await emitter.check();
    expect(w.states.slice(sent).map((s) => [s.taskId, s.branch, s.merged])).toEqual([["new", "worktree-x", false]]);
    const old = w.ledger.notes().find((n) => n.taskId === "old");
    expect(old).toMatchObject({ tip: oldTip, pushed: true });
    expect(old?.merged).toBeUndefined();

    // A's real merge still settles it, by its own tip, and never B.
    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.slice(sent + 1).map((s) => [s.taskId, s.merged])).toEqual([["old", true]]);
    expect(w.ledger.notes().find((n) => n.taskId === "new")?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a merged newer launch still owns its path, so the older one never reads its branch", async () => {
    const w = await world();
    const path = await launch(w, "old", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    await reuseName(w, path, "x", "new");
    await w.ledger.note("new", { branch: "worktree-x", ahead: true, pushed: true, merged: true });
    const sent = w.states.length;
    await emitter.check();
    await emitter.check();
    expect(w.states).toHaveLength(sent);
    expect(w.ledger.notes().find((n) => n.taskId === "old")?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a branch reset to origin/main after a push is not merged", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    const sent = w.states.length;
    expect(w.states.at(-1)).toMatchObject({ pushed: true, merged: false });
    await git(path, "reset", "-q", "--hard", "origin/main");
    await emitter.check();
    await emitter.check();
    expect(w.states).toHaveLength(sent);
    expect(w.ledger.notes()[0]?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a relaunch of the task id to the same path starts fresh: nothing merged on its first pass", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await w.ledger.note("t1", { prUrl: "https://github.com/org/myrepo/pull/1" });
    await emitter.check();
    const sent = w.states.length;
    await git(path, "reset", "-q", "--hard", "origin/main");
    await w.ledger.startNote("t1", { repo: w.repo.path, path });
    await emitter.check();
    await emitter.check();
    // Its one state is the fresh branch's own, unpushed and unmerged.
    expect(w.states.slice(sent)).toEqual([expect.objectContaining({ taskId: "t1", pushed: false, merged: false })]);
    expect(w.ledger.notes()[0]).not.toHaveProperty("ahead");
    expect(w.ledger.notes()[0]).not.toHaveProperty("merged");
    stopAll(w);
  });

  test("a `here` relaunch clears the worktree note, and the emitter then watches nothing", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    const sent = w.states.length;
    await w.ledger.startNote("t1");
    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.ledger.notes()).toEqual([]);
    expect(w.states).toHaveLength(sent);
    stopAll(w);
  });

  test("with no origin/HEAD, pushed needs the remote ref at the tip exactly, and nothing is merged", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w, { repos: () => [{ ...w.repo, defaultBranch: null }] });
    await emitter.check();
    expect(w.states).toHaveLength(1);

    seq += 1;
    const server = join(base, `server-${seq}`);
    await git(base, "clone", "-q", w.fixture.barePath, server);
    await git(server, "switch", "-q", "-c", "worktree-x");
    await writeFile(join(server, "old.txt"), "old\n");
    await git(server, "add", "old.txt");
    await git(server, "commit", "-q", "-m", "an earlier attempt");
    await git(server, "push", "-q", "origin", "worktree-x");
    await git(w.fixture.repoPath, "fetch", "-q", "origin");
    await emitter.check();
    // The stale ref is ahead of the fresh tip, which would pass an ancestor test.
    expect(w.states).toHaveLength(1);
    expect(w.states[0]).toMatchObject({ pushed: false, merged: false });

    await writeFile(join(path, "a.txt"), "a\n");
    await git(path, "add", "a.txt");
    await git(path, "commit", "-q", "-m", "add a.txt");
    await git(path, "push", "-q", "--force", "origin", "worktree-x");
    await emitter.check();
    expect(w.states).toHaveLength(2);
    expect(w.states[1]).toMatchObject({ pushed: true, merged: false });

    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.every((s) => !s.merged)).toBe(true);
    expect(w.ledger.notes()[0]?.merged).toBeUndefined();
    stopAll(w);
  });

  test("an empty commit pushed under a draft PR is no work: neither pushed nor merged", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await git(path, "commit", "-q", "--allow-empty", "-m", "draft");
    await git(path, "push", "-q", "origin", "worktree-x");
    await w.ledger.note("t1", { prUrl: "https://github.com/org/myrepo/pull/1" });
    await emitter.check();
    await emitter.check();
    expect(w.states.every((s) => !s.pushed && !s.merged)).toBe(true);
    expect(w.ledger.notes()[0]).not.toHaveProperty("tip");
    expect(w.ledger.notes()[0]).not.toHaveProperty("ahead");
    expect(w.ledger.notes()[0]).not.toHaveProperty("merged");
    stopAll(w);
  });

  test("a revert of the only change is no work: the pre-revert commit stays the one judged, and is not merged", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    const worked = await git(path, "rev-parse", "HEAD");
    expect(w.ledger.notes()[0]).toMatchObject({ tip: worked, ahead: true, pushed: true });
    await git(path, "revert", "--no-edit", "HEAD");
    await git(path, "push", "-q", "origin", "worktree-x");
    await emitter.check();
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ pushed: true, merged: false });
    expect(w.ledger.notes()[0]).toMatchObject({ tip: worked });
    expect(w.ledger.notes()[0]?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a branch someone else made under a removed task branch's name is not read as the task's", async () => {
    const w = await world();
    const path = await launch(w, "old", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await w.ledger.note("old", { prUrl: "https://github.com/org/myrepo/pull/1" });
    await emitter.check();
    const oldTip = w.ledger.notes()[0]?.tip;
    expect(oldTip).toBe(await git(path, "rev-parse", "HEAD"));

    // The task's worktree and branch are freed; a spawn with no task id takes the name and path and merges its own work.
    await git(w.fixture.repoPath, "worktree", "remove", "--force", path);
    await git(w.fixture.repoPath, "branch", "-D", "worktree-x");
    await git(w.fixture.repoPath, "worktree", "add", "-q", "--no-track", "-b", "worktree-x", path, "origin/main");
    await commitAndPush(path, "b.txt", "+worktree-x");
    await squashMergeOnOrigin(w, "worktree-x");
    const sent = w.states.length;
    await emitter.check();
    await emitter.check();
    expect(w.states.slice(sent).every((s) => !s.merged)).toBe(true);
    const old = w.ledger.notes().find((n) => n.taskId === "old");
    expect(old?.tip).toBe(oldTip);
    expect(old?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a failed re-dispatch of an old id does not take its path from the launch that holds it", async () => {
    const w = await world();
    let tick = 0;
    w.ledger = await LaunchLedger.open(w.ledgerPath, () => ++tick);
    const path = await launch(w, "old", "x");
    const emitter = start(w);
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    await reuseName(w, path, "x", "new");
    // The scheduler re-dispatches "old"; its spawn is refused, so nothing but `record` ran: it is now last in the ledger.
    await w.ledger.record("old");
    expect(w.ledger.notes().map((n) => n.taskId)).toEqual(["new", "old"]);
    await commitAndPush(path, "b.txt", "+worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ taskId: "new", branch: "worktree-x", pushed: true, merged: false });
    stopAll(w);
  });

  test("an undelivered state is not re-sent once its task was relaunched", async () => {
    const w = await world();
    let tick = 0;
    w.ledger = await LaunchLedger.open(w.ledgerPath, () => ++tick);
    const path = await launch(w, "t1", "x");
    const delivered: BranchState[] = [];
    let deliver = false;
    const emitter = start(w, {
      emit: (state) => {
        if (deliver) delivered.push(state);
        return Promise.resolve(deliver);
      },
    });
    await emitter.check();
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    // The first launch's pushed state is still undelivered when the id is relaunched to the same path.
    await git(path, "reset", "-q", "--hard", "origin/main");
    await w.ledger.startNote("t1", { repo: w.repo.path, path });
    deliver = true;
    await emitter.check();
    await emitter.check();
    expect(delivered.map((s) => s.pushed)).toEqual([false]);
    stopAll(w);
  });

  test("with no origin/HEAD a pushed fresh branch stays unmerged once the default branch appears", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    let defaultBranch: string | null = null;
    const emitter = start(w, { repos: () => [{ ...w.repo, defaultBranch }] });
    // Pushed with no commit of its own: pushed on an exact match, though nothing was judged ahead.
    await git(path, "push", "-q", "origin", "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ pushed: true, merged: false });
    defaultBranch = "main";
    await emitter.check();
    await emitter.check();
    expect(w.states.every((s) => !s.merged)).toBe(true);
    expect(w.ledger.notes()[0]?.merged).toBeUndefined();
    stopAll(w);
  });

  test("a tag named like the branch does not break branch detection", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    await git(w.fixture.repoPath, "tag", "worktree-x");
    const emitter = start(w);
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x"]);
    stopAll(w);
  });

  test("a stop leaves the backlog to the emitter that replaces it on the same ledger", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    const first = start(w, { emit: () => Promise.resolve(false) });
    await first.check();
    first.stop();
    const delivered: BranchState[] = [];
    const second = start(w, {
      emit: (state) => {
        delivered.push(state);
        return Promise.resolve(true);
      },
    });
    await second.check();
    await second.check();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ taskId: "t1", branch: "worktree-x" });
    stopAll(w);
  });

  test("a stop while the note is being written keeps the state for the next emitter", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    const real = w.ledger.note.bind(w.ledger);
    let first: BranchStates | undefined;
    w.ledger.note = async (taskId, patch, under) => {
      const applied = await real(taskId, patch, under);
      first?.stop();
      return applied;
    };
    first = start(w, { emit: () => Promise.resolve(true) });
    // The constructor's pass is the one that notes and is stopped under it.
    await first.check();
    w.ledger.note = real;
    expect(w.states).toEqual([]);
    expect(w.ledger.notes()[0]?.branch).toBe("worktree-x");

    const second = start(w);
    await second.check();
    await second.check();
    expect(w.states).toHaveLength(1);
    expect(w.states[0]).toMatchObject({ taskId: "t1", branch: "worktree-x" });
    stopAll(w);
  });

  test("a retried state keeps its observation time, and one whose task left the ledger is dropped", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    await launch(w, "t2", "y");
    const clock = { now: 1_000 };
    const delivered: BranchState[] = [];
    let deliver = false;
    const emitter = start(w, {
      now: () => clock.now,
      emit: (state) => {
        if (deliver) delivered.push(state);
        return Promise.resolve(deliver);
      },
    });
    await emitter.check();
    clock.now = 2_000;
    await w.ledger.retract("t2");
    deliver = true;
    await emitter.check();
    expect(delivered.map((s) => [s.taskId, s.at])).toEqual([["t1", 1_000]]);
    await emitter.check();
    expect(delivered).toHaveLength(1);
    stopAll(w);
  });
});

/** A forward-only clock from real time: the cut-off's grace and the fetch window both run on it. */
function forwardClock(): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance: (ms) => {
      offset += ms;
    },
  };
}

/** Git processes a pass started, by git's own trace: every one logs its built-in command. */
async function gitRunsDuring(pass: () => Promise<void>): Promise<number> {
  seq += 1;
  const trace = join(base, `trace-${seq}`);
  process.env["GIT_TRACE"] = trace;
  try {
    await pass();
  } finally {
    delete process.env["GIT_TRACE"];
  }
  const text = await readFile(trace, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.includes("trace: built-in: git")).length;
}

describe("branch-state emitter: the cut-off for ended, quiet tasks", () => {
  const PAST_GRACE = BRANCH_ENDED_GRACE_MS + 1;
  test("a never-ahead task whose session ended past the grace runs no git, and a later rename goes unreported", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(new Set()) });
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x"]);
    // Ended, but within the grace: still read.
    time.advance(BRANCH_ENDED_GRACE_MS - 60_000);
    expect(await gitRunsDuring(emitter.check)).toBeGreaterThan(0);
    time.advance(60_000);
    expect(await gitRunsDuring(emitter.check)).toBe(0);
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states).toHaveLength(1);
    stopAll(w);
  });

  test("a live session keeps its task read past the grace, and the clock starts when it ends", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    let live = new Set(["t1"]);
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(live) });
    await emitter.check();
    time.advance(2 * PAST_GRACE);
    await git(path, "branch", "-m", "worktree-a");
    await emitter.check();
    live = new Set();
    await git(path, "branch", "-m", "worktree-b");
    await emitter.check();
    time.advance(PAST_GRACE);
    await git(path, "branch", "-m", "worktree-c");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-a", "worktree-b"]);
    stopAll(w);
  });

  test("a session seen live again before the cut-off starts a fresh grace", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    let live = new Set<string>();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(live) });
    await emitter.check();
    time.advance(BRANCH_ENDED_GRACE_MS - 60_000);
    live = new Set(["t1"]);
    await emitter.check();
    live = new Set();
    // Past the first end's grace, within the second's.
    time.advance(120_000);
    await emitter.check();
    time.advance(BRANCH_ENDED_GRACE_MS - 60_000);
    await git(path, "branch", "-m", "worktree-c");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-c"]);
    time.advance(120_000);
    await emitter.check();
    await git(path, "branch", "-m", "worktree-d");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-c"]);
    stopAll(w);
  });

  test("a cut-off task whose session registers late is read again, and gets a fresh grace", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    let live = new Set<string>();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(live) });
    await emitter.check();
    time.advance(PAST_GRACE);
    await emitter.check();
    expect(await gitRunsDuring(emitter.check)).toBe(0);
    live = new Set(["t1"]);
    await git(path, "branch", "-m", "worktree-late");
    expect(await gitRunsDuring(emitter.check)).toBeGreaterThan(0);
    expect(w.states.at(-1)).toMatchObject({ branch: "worktree-late" });
    live = new Set();
    await emitter.check();
    expect(await gitRunsDuring(emitter.check)).toBeGreaterThan(0);
    time.advance(PAST_GRACE);
    await emitter.check();
    expect(await gitRunsDuring(emitter.check)).toBe(0);
    stopAll(w);
  });

  test("an unknown live read leaves a cut-off task skipped", async () => {
    const w = await world();
    await launch(w, "t1", "x");
    const time = forwardClock();
    let fail = false;
    const emitter = start(w, {
      now: time.now,
      liveTasks: () => (fail ? Promise.reject(new Error("no tmux")) : Promise.resolve(new Set<string>())),
    });
    await emitter.check();
    time.advance(PAST_GRACE);
    await emitter.check();
    fail = true;
    expect(await gitRunsDuring(emitter.check)).toBe(0);
    stopAll(w);
  });

  test("a relaunch past the cut-off reads the task again", async () => {
    const w = await world();
    const time = forwardClock();
    // The ledger stamps `siteAt` from the same clock, so the relaunch's can never tie with the first.
    w.ledger = await LaunchLedger.open(w.ledgerPath, time.now);
    const path = await launch(w, "t1", "x");
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(new Set()) });
    await emitter.check();
    time.advance(PAST_GRACE);
    await emitter.check();
    expect(await gitRunsDuring(emitter.check)).toBe(0);
    time.advance(1_000);
    await w.ledger.startNote("t1", { repo: w.repo.path, path });
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ branch: "worktree-renamed" });
    stopAll(w);
  });

  test("a live-session read that hangs cuts nothing off and does not hold the pass up", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    const emitter = start(w, {
      now: time.now,
      liveTimeoutMs: 20,
      liveTasks: () => new Promise<ReadonlySet<string>>(() => {}),
    });
    await emitter.check();
    time.advance(2 * PAST_GRACE);
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-renamed"]);
    stopAll(w);
  });

  test("a task in a repo with no origin/HEAD is never judged, so never cut off", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    const emitter = start(w, {
      now: time.now,
      repos: () => [{ ...w.repo, defaultBranch: null }],
      liveTasks: () => Promise.resolve(new Set()),
    });
    await emitter.check();
    time.advance(PAST_GRACE);
    await emitter.check();
    time.advance(PAST_GRACE);
    expect(await gitRunsDuring(emitter.check)).toBeGreaterThan(0);
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-renamed"]);
    stopAll(w);
  });

  test("the grace is an unbroken run of judged checks: an unjudged pass restarts it", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    let listed = true;
    const emitter = start(w, {
      now: time.now,
      repos: () => (listed ? [w.repo] : []),
      liveTasks: () => Promise.resolve(new Set()),
    });
    await emitter.check();
    // Unjudged across more than the grace.
    listed = false;
    time.advance(60_000);
    await emitter.check();
    time.advance(2 * PAST_GRACE);
    await emitter.check();
    listed = true;
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-renamed"]);
    // Judging resumed just now: read until a full grace after it.
    time.advance(BRANCH_ENDED_GRACE_MS - 60_000);
    expect(await gitRunsDuring(emitter.check)).toBeGreaterThan(0);
    time.advance(60_000);
    expect(await gitRunsDuring(emitter.check)).toBe(0);
    stopAll(w);
  });

  test("a failed own-work read is no judgement: the task is not cut off", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    await writeFile(join(path, "a.txt"), "a\n");
    await git(path, "add", "a.txt");
    await git(path, "commit", "-q", "-m", "add a.txt");
    const tip = await git(path, "rev-parse", "HEAD");
    // The branch ref survives, its commit does not: every own-work read of the tip fails.
    await rm(join(w.fixture.repoPath, ".git", "objects", tip.slice(0, 2), tip.slice(2)), { force: true });
    const time = forwardClock();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(new Set()) });
    await emitter.check();
    time.advance(2 * PAST_GRACE);
    await emitter.check();
    time.advance(PAST_GRACE);
    expect(await gitRunsDuring(emitter.check)).toBeGreaterThan(0);
    expect(w.ledger.notes()[0]?.ahead).toBeUndefined();
    stopAll(w);
  });

  test("a live-session read that fails cuts nothing off", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    const time = forwardClock();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.reject(new Error("no tmux")) });
    await emitter.check();
    time.advance(2 * PAST_GRACE);
    await emitter.check();
    await git(path, "branch", "-m", "worktree-renamed");
    await emitter.check();
    expect(w.states.map((s) => s.branch)).toEqual(["worktree-x", "worktree-renamed"]);
    stopAll(w);
  });

  test("a task with a PR URL is read past the grace, so a late push and its squash merge are reported", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    await w.ledger.note("t1", { prUrl: "https://example.test/org/myrepo/pull/1" });
    const time = forwardClock();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(new Set()) });
    await emitter.check();
    time.advance(PAST_GRACE);
    await emitter.check();
    time.advance(PAST_GRACE);
    await commitAndPush(path, "a.txt", "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ pushed: true, merged: false });
    await squashMergeOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ branch: "worktree-x", merged: true });
    stopAll(w);
  });

  test("a task once seen ahead is read past the grace, so a later push and merge are reported", async () => {
    const w = await world();
    const path = await launch(w, "t1", "x");
    await writeFile(join(path, "a.txt"), "a\n");
    await git(path, "add", "a.txt");
    await git(path, "commit", "-q", "-m", "add a.txt");
    const time = forwardClock();
    const emitter = start(w, { now: time.now, liveTasks: () => Promise.resolve(new Set()) });
    await emitter.check();
    expect(w.ledger.notes()[0]?.ahead).toBe(true);
    time.advance(2 * PAST_GRACE);
    await git(path, "push", "-q", "origin", "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ pushed: true, merged: false });
    await fastForwardOnOrigin(w, "worktree-x");
    await emitter.check();
    expect(w.states.at(-1)).toMatchObject({ merged: true });
    stopAll(w);
  });
});
