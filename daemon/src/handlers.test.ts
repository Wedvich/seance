import { beforeEach, describe, expect, test } from "bun:test";
import {
  APP_ID,
  BRANCH_MAX_LENGTH,
  METRIC_NAMES,
  parseMetricsReply,
  REPLY_JSON_BUDGET,
  SCHEDULER_CLIENT,
  SCHEDULER_ID,
  type DespawnResponse,
  type MetricsReply,
  type OpName,
  type Plain,
  type RepoEntry,
  type SessionEntry,
  type SessionsResponse,
  type SpawnRequest,
  type SpawnResponse,
  type TaskProgress,
  parseTaskProgressList,
} from "@seance/shared";
import type { AuditSink } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import { SpawnFailure, type SessionBackend } from "./backend.ts";
import type { Config } from "./config.ts";
import { createHandler, createLocalOps, fitProgress, type HandlerContext, type TaskLaunches } from "./handlers.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { MetricsStore, type Sample } from "./metrics-store.ts";
import { EndedTasks } from "./session-events.ts";

// The audit trail is what's under test, so collect it at the seam the daemon
// injects rather than off stdout, which is only where daemonSink happens to
// put it.
const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);

beforeEach(() => {
  lines.length = 0;
});

const REPOS: readonly RepoEntry[] = [{ name: "myrepo", path: "/repos/myrepo", defaultBranch: "main" }];

// The real backend, as everywhere in the daemon suite — every scenario below
// names a repo the scan set doesn't hold, so the failure lands before tmux.
const CONFIG: Config = {
  name: "TestMac",
  relayUrl: "ws://localhost/daemon",
  bearerToken: "test-bearer",
  psk: "",
  repoRoots: ["/repos"],
  tmuxSession: "main",
};

const ctx: HandlerContext = {
  // Nothing here reaches a real spawn; a home that isn't one keeps it that way.
  backend: createBackend(CONFIG, { home: "/nonexistent/seance-home" }),
  getRepos: () => REPOS,
  rescan: () => Promise.resolve(REPOS),
  auditSink: collect,
};

const request = (op: OpName, payload: unknown): Plain => ({ id: "req-1", ts: Date.now(), op, payload });

const logged = (): string => lines.join("\n");

// "nope" fails the repo lookup before any git or tmux work, so the audit path
// is exercised without a machine underneath it.
const spawnNope = (extra: Record<string, unknown> = {}): Plain =>
  request("spawn", { repo: "nope", mode: "worktree", ...extra });

describe("relay ops are audited", () => {
  test("every op is recorded, not just spawn — enumeration at 3am is the same signal", async () => {
    await createHandler(ctx)(request("rescan", {}));
    expect(logged()).toContain('audit request origin=relay op="rescan" id="req-1"');
  });

  test("the origin rides every request line, so a local op is not mistaken for a relayed one", async () => {
    await createHandler(ctx, "local")(request("sessions", {}));
    expect(logged()).toContain('audit request origin=local op="sessions" id="req-1"');
  });

  test("a relay spawn is tagged as such, so it is distinguishable from one typed at the machine", async () => {
    await createHandler(ctx)(spawnNope());
    expect(logged()).toContain('audit spawn origin=relay repo="nope" mode=worktree');
  });

  test("the outcome carries the structured failure code", async () => {
    await createHandler(ctx)(spawnNope());
    expect(logged()).toContain("audit spawn origin=relay failed code=repo_not_found");
  });

  test("a malformed payload is recorded as rejected rather than passing silently", async () => {
    await createHandler(ctx)(request("spawn", { repo: "", mode: "nonsense" }));
    expect(logged()).toContain("audit spawn origin=relay rejected");
  });

  // The string-key loop in isSpawnRequest cannot see a boolean field, so this is
  // the only thing standing between a truthy "false" and a plan-mode spawn.
  test("a non-boolean plan is rejected rather than coerced", async () => {
    await createHandler(ctx)(spawnNope({ plan: "yes" }));
    expect(logged()).toContain("audit spawn origin=relay rejected");
  });

  test("a taskId outside its bounds is rejected before the backend sees it", async () => {
    for (const taskId of ["", "a b", "x".repeat(65), "t;rm", 7]) {
      lines.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- each case reads the lines the previous one cleared
      await createHandler(ctx)(spawnNope({ taskId }));
      expect(logged()).toContain("audit spawn origin=relay rejected");
    }
  });

  test("a baseBranch that is not a valid branch name is rejected before the backend sees it", async () => {
    for (const baseBranch of ["", "-x", "a..b", "a b", "HEAD", "a.lock", "x".repeat(BRANCH_MAX_LENGTH + 1), 7]) {
      lines.length = 0;
      // oxlint-disable-next-line no-await-in-loop -- each case reads the lines the previous one cleared
      await createHandler(ctx)(spawnNope({ baseBranch }));
      expect(logged()).toContain("audit spawn origin=relay rejected");
    }
    lines.length = 0;
    await createHandler(ctx)(spawnNope({ baseBranch: "martin/pen-1-stack" }));
    expect(logged()).not.toContain("rejected");
  });

  test("a newline in a wire value cannot forge an audit line", async () => {
    await createHandler(ctx)(request("spawn", { repo: 'x\ninfo audit spawn ok window="gotcha"', mode: "here" }));
    expect(logged()).not.toContain('window="gotcha"');
    expect(logged()).toContain("\\n");
  });
});

const SPAWNED: SessionEntry = { window: "late-riser", repo: "myrepo", path: "/repos/myrepo" };

/**
 * A backend whose spawn succeeds and reports whether the window registered in
 * time; its session list holds the window exactly when it did. Implementing
 * the seam rather than mocking past it: an alternative backend is what
 * `SessionBackend` is for.
 */
function fakeBackend(registered: boolean): { readonly backend: SessionBackend; readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    backend: {
      spawn: () => Promise.resolve({ window: SPAWNED.window, path: SPAWNED.path, registered, handle: "@7" }),
      sessions: () => {
        calls += 1;
        return Promise.resolve(registered ? [SPAWNED] : []);
      },
      doctor: () => Promise.resolve([]),
    },
  };
}

async function spawnReply(backend: SessionBackend): Promise<SpawnResponse> {
  const reply = await createHandler({ ...ctx, backend })(request("spawn", { repo: "myrepo", mode: "here" }));
  if (reply === null) throw new Error("spawn produced no reply");
  return reply.payload as SpawnResponse;
}

describe("the spawn ack carries the window it announced", () => {
  test("the session list is read once, after the backend saw the window register", async () => {
    const up = fakeBackend(true);
    const payload = await spawnReply(up.backend);
    if (!payload.ok) throw new Error(`expected ok, got ${payload.message}`);
    // The app writes this list straight into its cache: short by one here and
    // the machine reads as idle until something else refreshes it.
    expect(payload.sessions).toEqual([SPAWNED]);
    expect(up.calls()).toBe(1);
  });

  test("a session that never registers still answers, with the list as it stands", async () => {
    const never = fakeBackend(false);
    const payload = await spawnReply(never.backend);
    if (!payload.ok) throw new Error(`expected ok, got ${payload.message}`);
    expect(payload.sessions).toEqual([]);
    // …and says so, rather than letting the empty list read as an idle machine.
    expect(payload.note).toContain("never registered");
    // The flag, not the prose, is what stops the clients claiming it is running.
    expect(payload.pending).toBe(true);
  });

  test("the note carries the screen, so the phone reads the dialog it is stuck on", async () => {
    const never = fakeBackend(false);
    const asked: string[] = [];
    const payload = await spawnReply({
      ...never.backend,
      capture: (handle) => {
        asked.push(handle);
        return Promise.resolve("Do you trust the files in this folder?");
      },
    });
    if (!payload.ok) throw new Error(`expected ok, got ${payload.message}`);
    expect(asked).toEqual(["@7"]);
    expect(payload.note).toContain("Do you trust the files in this folder?");
    // The handle is backend-scoped; a wire payload carrying a tmux window id is a leak.
    expect(payload).not.toHaveProperty("handle");
  });

  test("a registered session says nothing extra and never reads the screen", async () => {
    const prompt = fakeBackend(true);
    let captured = false;
    const payload = await spawnReply({
      ...prompt.backend,
      capture: () => {
        captured = true;
        return Promise.resolve("should not be asked");
      },
    });
    if (!payload.ok) throw new Error(`expected ok, got ${payload.message}`);
    expect(payload.note).toBeUndefined();
    expect(payload.pending).toBeUndefined();
    expect(captured).toBe(false);
  });
});

describe("a spawn for a task already running", () => {
  const running: SessionBackend = {
    spawn: () => Promise.reject(new SpawnFailure("task_running", "task t-1 is already running in fix", "%12")),
    sessions: () => Promise.resolve([]),
    doctor: () => Promise.resolve([]),
  };

  test("is refused with the code and the running session's id, and the trail names both the task and that session", async () => {
    const reply = await createHandler({ ...ctx, backend: running })(
      request("spawn", { repo: "myrepo", mode: "here", taskId: "t-1" }),
    );
    expect(reply?.payload).toEqual({
      ok: false,
      code: "task_running",
      message: "task t-1 is already running in fix",
      id: "%12",
    });
    expect(logged()).toContain('mode=here title="" model=');
    expect(logged()).toContain('task="t-1" prompt=none');
    expect(logged()).toContain('audit spawn origin=relay failed code=task_running target="%12"');
  });

  test("an untracked spawn's lines carry no task, and its failures no target", async () => {
    await createHandler(ctx)(spawnNope());
    expect(logged()).not.toContain("task=");
    expect(logged()).not.toContain("target=");
  });
});

/** A backend whose sessions are whatever `live` holds, and whose spawn runs `onSpawn` first. */
function taskBackend(onSpawn: (spawn: SpawnRequest) => Promise<void>) {
  const live: SessionEntry[] = [];
  const backend: SessionBackend = {
    spawn: async (spawn) => {
      await onSpawn(spawn);
      live.push({ id: `%${live.length + 1}`, window: "w", repo: "myrepo", path: "/p", taskId: spawn.taskId });
      return { window: "w", path: "/p", registered: true, handle: "@1" };
    },
    sessions: () => Promise.resolve([...live]),
    doctor: () => Promise.resolve([]),
  };
  return { backend, live };
}

/** A backend whose every spawn fails with `failure`. */
function failing(failure: Error): SessionBackend {
  return {
    spawn: () => Promise.reject(failure),
    sessions: () => Promise.resolve([]),
    doctor: () => Promise.resolve([]),
  };
}

const spawnTask = (taskId: string): Plain => request("spawn", { repo: "myrepo", mode: "here", taskId });

/** As the scheduler asks, unless `from` says otherwise (null: no sealer): it alone gets `ended` and `ledgerSince`. */
async function sessionsOf(
  handle: (plain: Plain, from?: string) => Promise<Plain | null>,
  from: string | null = SCHEDULER_ID,
): Promise<SessionsResponse> {
  const reply = await handle(request("sessions", {}), from ?? undefined);
  return reply?.payload as SessionsResponse;
}

describe("a task's launch is recorded before it runs", () => {
  test("on the ledger as the spawn runs; listed in `ended` once no session carries it, beside the ledger's since", async () => {
    const ledger = LaunchLedger.memory(() => 1_000);
    const tasks = new EndedTasks(ledger);
    let seen: readonly string[] = [];
    const { backend, live } = taskBackend(() => {
      seen = ledger.ids();
      return Promise.resolve();
    });
    const handle = createHandler({ ...ctx, backend, tasks });
    await handle(spawnTask("t-1"));
    expect(seen).toEqual(["t-1"]);

    let reply = await sessionsOf(handle);
    expect(reply.ended).toBeUndefined();
    expect(reply.ledgerSince).toBe(1_000);
    live.length = 0;
    reply = await sessionsOf(handle);
    expect(reply.ended).toEqual(["t-1"]);
  });

  test("a refusal leaves the ledger; task_running and a crash keep it, and the note of the launch they left", async () => {
    const ledger = LaunchLedger.memory();
    const tasks = new EndedTasks(ledger);
    // The earlier launch's progress, PR URL included: the mod sends it once, so wiping it loses it for good.
    for (const id of ["dup", "crashed"]) {
      await ledger.record(id);
      await ledger.note(id, {
        repo: "/r",
        path: `/r/.claude/worktrees/${id}`,
        branch: `worktree-${id}`,
        ahead: true,
        pushed: true,
        prUrl: "https://example.test/org/r/pull/1",
      });
    }
    const before = ledger.notes();
    expect(before).toHaveLength(2);
    await createHandler({ ...ctx, backend: failing(new SpawnFailure("repo_not_found", "gone")), tasks })(
      spawnTask("refused"),
    );
    await createHandler({ ...ctx, backend: failing(new SpawnFailure("task_running", "already", "%3")), tasks })(
      spawnTask("dup"),
    );
    await createHandler({ ...ctx, backend: failing(new Error("boom")), tasks })(spawnTask("crashed"));
    expect((await sessionsOf(createHandler({ ...ctx, tasks }))).ended).toEqual(["dup", "crashed"]);
    expect(ledger.notes()).toEqual(before);
  });

  test("the scheduler's sessions reply waits for a spawn in flight, so the task is never in neither list", async () => {
    const gate = Promise.withResolvers<void>();
    const { backend } = taskBackend(() => gate.promise);
    const taskCtx = { ...ctx, backend, tasks: new EndedTasks(LaunchLedger.memory()) };
    const handle = createHandler(taskCtx);
    const spawning = handle(spawnTask("t-1"));
    await Bun.sleep(0);
    const answered: unknown[] = [];
    const overRelay = sessionsOf(handle).then((reply) => answered.push(reply));
    // The leader reaching its own machine, in process: the same wait.
    const inProcess = createLocalOps(taskCtx, "leader")
      .sessions()
      .then((reply) => answered.push(reply));
    await Bun.sleep(10);
    expect(answered).toEqual([]);
    gate.resolve();
    await Promise.all([spawning, overRelay, inProcess]);
    expect(answered).toMatchObject([{ sessions: [{ taskId: "t-1" }] }, { sessions: [{ taskId: "t-1" }] }]);
  });

  test("any other caller is answered while a spawn is in flight, with neither field", async () => {
    const gate = Promise.withResolvers<void>();
    const { backend } = taskBackend(() => gate.promise);
    const tasks = new EndedTasks(LaunchLedger.memory());
    const relay = createHandler({ ...ctx, backend, tasks });
    const spawning = relay(spawnTask("t-1"));
    await Bun.sleep(0);
    try {
      // An app over the relay, and the local socket (MCP, the CLI), which passes no sealer.
      const replies = [
        await sessionsOf(relay, APP_ID),
        await sessionsOf(createHandler({ ...ctx, backend, tasks }, "local"), null),
      ];
      for (const reply of replies) {
        expect(reply.sessions).toEqual(expect.any(Array));
        expect(reply.ended).toBeUndefined();
        expect(reply.ledgerSince).toBeUndefined();
      }
    } finally {
      gate.resolve();
      await spawning;
    }
  });

  test("a launch the ledger cannot record is refused before the backend runs", async () => {
    let spawned = false;
    const { backend } = taskBackend(() => {
      spawned = true;
      return Promise.resolve();
    });
    const tasks: TaskLaunches = {
      launch: () => Promise.reject(new Error("disk full")),
      launched: () => false,
      settled: () => Promise.resolve(),
      report: () => ({ ended: [], ledgerSince: 0 }),
      progress: () => [],
    };
    const reply = await createHandler({ ...ctx, backend, tasks })(spawnTask("t-1"));
    expect(reply?.payload).toMatchObject({ ok: false, code: "launch_error" });
    expect(spawned).toBe(false);
    expect(logged()).toContain("audit spawn origin=relay failed code=launch_error");
  });

  describe("a scheduler spawn for a task the ledger holds as launched", () => {
    const dispatch = (taskId: string, client: string = SCHEDULER_CLIENT): Plain =>
      request("spawn", { repo: "myrepo", mode: "here", taskId, client });

    test("is refused task_launched and audited once its session has ended — a rolled-back record runs nothing", async () => {
      const ledger = LaunchLedger.memory();
      const tasks = new EndedTasks(ledger);
      let spawns = 0;
      const { backend, live } = taskBackend(() => {
        spawns += 1;
        return Promise.resolve();
      });
      const handle = createHandler({ ...ctx, backend, tasks });
      expect((await handle(dispatch("t-1")))?.payload).toMatchObject({ ok: true });
      live.length = 0;
      const again = await handle(dispatch("t-1"));
      expect(again?.payload).toMatchObject({ ok: false, code: "task_launched" });
      expect(spawns).toBe(1);
      expect(ledger.ids()).toEqual(["t-1"]);
      expect(logged()).toContain("audit spawn origin=relay failed code=task_launched");
      // The leader's own machine refuses the same, under its own origin.
      const local = await createLocalOps({ ...ctx, backend, tasks }, "leader").spawn({
        repo: "myrepo",
        mode: "here",
        taskId: "t-1",
        client: SCHEDULER_CLIENT,
      });
      expect(local).toMatchObject({ ok: false, code: "task_launched" });
      expect(logged()).toContain("audit spawn origin=leader failed code=task_launched");
      expect(spawns).toBe(1);
    });

    test("is task_running while its session still runs, naming the pane, so the leader records where it runs", async () => {
      const tasks = new EndedTasks(LaunchLedger.memory());
      let spawns = 0;
      const { backend } = taskBackend(() => {
        spawns += 1;
        return Promise.resolve();
      });
      const handle = createHandler({ ...ctx, backend, tasks });
      await handle(dispatch("t-1"));
      expect((await handle(dispatch("t-1")))?.payload).toMatchObject({ ok: false, code: "task_running", id: "%1" });
      expect(spawns).toBe(1);
    });

    test("runs when its launch was retracted, and is not the refusal's business from any other client", async () => {
      const tasks = new EndedTasks(LaunchLedger.memory());
      const refusing = createHandler({ ...ctx, backend: failing(new SpawnFailure("repo_not_found", "gone")), tasks });
      await refusing(dispatch("t-1"));
      const { backend, live } = taskBackend(() => Promise.resolve());
      const handle = createHandler({ ...ctx, backend, tasks });
      expect((await handle(dispatch("t-1")))?.payload).toMatchObject({ ok: true });
      live.length = 0;
      expect((await handle(dispatch("t-1", "mcp")))?.payload).toMatchObject({ ok: true });
    });
  });

  test("a daemon keeping no launches sends neither field", async () => {
    const reply = await sessionsOf(createHandler(ctx));
    expect(reply.ended).toBeUndefined();
    expect(reply.ledgerSince).toBeUndefined();
  });
});

const bytesOf = (reply: SessionsResponse): number => Buffer.byteLength(JSON.stringify(reply), "utf8");

const noted = (taskId: string, at: number, merged = false): TaskProgress => ({
  taskId,
  at,
  branch: "worktree-x",
  ...(merged ? { merged: true as const } : {}),
});

describe("a worktree launch's site and the scheduler's progress", () => {
  const spawnIn = (mode: "worktree" | "here", taskId: string): Plain =>
    request("spawn", { repo: "myrepo", mode, taskId });

  test("a worktree spawn that lands records its repo and worktree; a here spawn and a refusal record neither", async () => {
    const ledger = LaunchLedger.memory();
    const tasks = new EndedTasks(ledger);
    const { backend } = taskBackend(() => Promise.resolve());
    await createHandler({ ...ctx, backend, tasks })(spawnIn("worktree", "wt"));
    await createHandler({ ...ctx, backend, tasks })(spawnIn("here", "here"));
    await createHandler({ ...ctx, backend: failing(new SpawnFailure("repo_not_found", "gone")), tasks })(
      spawnIn("worktree", "refused"),
    );
    expect(ledger.notes()).toEqual([expect.objectContaining({ taskId: "wt", repo: "/repos/myrepo", path: "/p" })]);
  });

  test("only the scheduler's sessions carries progress", async () => {
    const ledger = LaunchLedger.memory();
    const tasks = new EndedTasks(ledger);
    const { backend } = taskBackend(() => Promise.resolve());
    const handle = createHandler({ ...ctx, backend, tasks });
    await handle(spawnIn("worktree", "t-1"));
    await ledger.note("t-1", { branch: "worktree-x", pushed: true });
    const scheduler = await sessionsOf(handle);
    expect(scheduler.progress).toEqual([{ taskId: "t-1", at: expect.any(Number), branch: "worktree-x", pushed: true }]);
    expect(scheduler.progressTrimmed).toBeUndefined();
    expect(parseTaskProgressList(scheduler.progress)).not.toBeNull();
    const inProcess = await createLocalOps({ ...ctx, backend, tasks }, "leader").sessions();
    expect(inProcess).toMatchObject({ progress: [{ taskId: "t-1" }] });
    for (const from of [APP_ID, null]) {
      // oxlint-disable-next-line no-await-in-loop -- two callers, one handler
      const reply = await sessionsOf(handle, from);
      expect(reply.progress).toBeUndefined();
      expect(reply.progressTrimmed).toBeUndefined();
    }
  });

  test("a full ledger of large notes is trimmed to fit one envelope, oldest first, still parseable", async () => {
    const clock = { now: 1_000 };
    const ledger = LaunchLedger.memory(() => clock.now);
    const tasks = new EndedTasks(ledger);
    const ids = Array.from({ length: 128 }, (_, i) => `t-${i}`);
    for (const [i, id] of ids.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- the ledger's clock moves between notes
      await ledger.record(id);
      clock.now += 1;
      // oxlint-disable-next-line no-await-in-loop
      await ledger.note(id, {
        branch: `b${i}-`.padEnd(255, "x"),
        prUrl: `https://example.test/pr/${i}/`.padEnd(2_000, "a"),
        pushed: true,
      });
    }
    const handle = createHandler({ ...ctx, tasks });
    const reply = await sessionsOf(handle);
    const progress = reply.progress ?? [];
    expect(reply.progressTrimmed).toBeGreaterThan(0);
    expect(progress.length + (reply.progressTrimmed ?? 0)).toBe(128);
    expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThanOrEqual(REPLY_JSON_BUDGET);
    expect(parseTaskProgressList(progress)).not.toBeNull();
    // The newest survive, in their original order.
    expect(progress.map((entry) => entry.taskId)).toEqual(ids.slice(-progress.length));
  });

  describe("fitProgress", () => {
    const base: SessionsResponse = { sessions: [], at: 1 };

    test("nothing to fit leaves the reply as it was", () => {
      expect(fitProgress(base, [])).toBe(base);
      expect(fitProgress(base, [noted("a", 1)])).toEqual({ ...base, progress: [noted("a", 1)] });
    });

    test("merged entries go before older open ones, and an empty survivor list omits progress", () => {
      const all = [noted("open-old", 1), noted("done-new", 9, true), noted("open-new", 5)];
      const one = Buffer.byteLength(JSON.stringify(fitProgress(base, [noted("open-new", 5)], 1_000)), "utf8");
      const fitted = fitProgress(base, all, one + 30);
      expect(fitted.progressTrimmed).toBe(2);
      expect(fitted.progress?.map((e) => e.taskId)).toEqual(["open-new"]);
      const none = fitProgress(base, all, 10);
      expect(none.progress).toBeUndefined();
      expect(none.progressTrimmed).toBe(3);
    });

    test("a reply exactly at the budget keeps everything; one byte under drops the oldest", () => {
      const all = [noted("a", 1), noted("b", 2), noted("c", 3)];
      const whole = fitProgress(base, all, 1_000_000);
      expect(whole.progressTrimmed).toBeUndefined();
      const exact = bytesOf(whole);
      expect(fitProgress(base, all, exact)).toEqual(whole);
      const under = fitProgress(base, all, exact - 1);
      expect(under.progressTrimmed).toBe(1);
      expect(under.progress?.map((e) => e.taskId)).toEqual(["b", "c"]);
      expect(bytesOf(under)).toBeLessThanOrEqual(exact - 1);
    });

    test("the trimmed count's own digits are budgeted, across 9 to 10 entries dropped", () => {
      const all = Array.from({ length: 14 }, (_, i) => noted(`t${String(i).padStart(2, "0")}`, i));
      const seen = new Set<number>();
      // Below the floor — base plus the count of everything dropped — no trimming can fit.
      const floor = bytesOf(fitProgress(base, all, 0));
      for (let budget = bytesOf(fitProgress(base, all, 1_000_000)); budget >= floor; budget -= 1) {
        const fitted = fitProgress(base, all, budget);
        seen.add(fitted.progressTrimmed ?? 0);
        // Whatever the count's width, the reply never outgrows the budget.
        expect(bytesOf(fitted)).toBeLessThanOrEqual(budget);
      }
      expect(seen.has(9) && seen.has(10)).toBe(true);
    });

    test("a base already over budget drops every entry and still reports the count: the budget cannot be met", () => {
      const all = [noted("a", 1), noted("b", 2)];
      const fitted = fitProgress(base, all, 5);
      expect(fitted.progress).toBeUndefined();
      expect(fitted.progressTrimmed).toBe(2);
      expect(bytesOf(fitted)).toBeGreaterThan(5);
    });
  });
});

describe("despawn is audited and answers with the list it left", () => {
  // The real backend refuses this shape before tmux, so the audit path runs
  // without a machine underneath it.
  const despawnBad = (extra: Record<string, unknown> = {}): Plain => request("despawn", { id: "main:1", ...extra });

  async function despawnReply(backend: SessionBackend, id: string): Promise<DespawnResponse> {
    const reply = await createHandler({ ...ctx, backend })(request("despawn", { id }));
    if (reply === null) throw new Error("despawn produced no reply");
    return reply.payload as DespawnResponse;
  }

  test("each surface tags its own despawns, with the target quoted as the wire text it is", async () => {
    await createHandler(ctx, "local")(despawnBad({ client: "mcp", force: true }));
    expect(logged()).toContain('audit despawn origin=local client="mcp" target="main:1" force=true');
    expect(logged()).toContain("audit despawn origin=local failed code=invalid_target");
  });

  test("a malformed payload is recorded as rejected rather than passing silently", async () => {
    await createHandler(ctx)(request("despawn", { id: "%1", force: "yes" }));
    expect(logged()).toContain("audit despawn origin=relay rejected");
  });

  test("an outcome is recorded with the window, and the reply's list is read after it", async () => {
    let gone = false;
    const payload = await despawnReply(
      {
        spawn: () => Promise.reject(new Error("not under test")),
        despawn: () => {
          gone = true;
          return Promise.resolve({ window: "late-riser", outcome: "exited" });
        },
        sessions: () => Promise.resolve(gone ? [] : [{ ...SPAWNED, id: "%7" }]),
        doctor: () => Promise.resolve([]),
      },
      "%7",
    );
    expect(payload).toEqual({ ok: true, window: "late-riser", outcome: "exited", sessions: [] });
    expect(logged()).toContain('audit despawn origin=relay ok window="late-riser" outcome=exited');
  });

  test("a backend that can't despawn answers with a code instead of dropping the request", async () => {
    const startOnly: SessionBackend = {
      spawn: () => Promise.reject(new Error("not under test")),
      sessions: () => Promise.resolve([]),
      doctor: () => Promise.resolve([]),
    };
    expect(await despawnReply(startOnly, "%7")).toMatchObject({ ok: false, code: "internal_error" });
    expect(logged()).toContain("audit despawn origin=relay failed code=internal_error");
  });
});

describe("metrics answers from the store, within one envelope", () => {
  const NOW = 1_700_000_000 - (1_700_000_000 % 3600);

  /** The real store, in memory: it is this package's, so nothing here is mocked past it. */
  function storeWith(samples: readonly Sample[]): MetricsStore {
    const store = MetricsStore.memory();
    store.write(samples, NOW);
    return store;
  }

  async function metricsReply(store: MetricsStore | null, payload: unknown): Promise<MetricsReply> {
    const handler = createHandler(store === null ? ctx : { ...ctx, metrics: (r) => store.query(r) });
    const plain = await handler(request("metrics", payload));
    if (plain === null) throw new Error("metrics produced no reply");
    const reply = parseMetricsReply(plain.payload);
    if (reply === null) throw new Error("metrics reply did not parse");
    return reply;
  }

  test("returns the named series over the range, values to one decimal", async () => {
    const store = storeWith([
      { metric: METRIC_NAMES.cpu, labels: { machine: "mac" }, ts: NOW - 30, value: 100 / 3 },
      { metric: METRIC_NAMES.cpu, labels: { machine: "mac" }, ts: NOW, value: 12 },
      { metric: METRIC_NAMES.mem, labels: { machine: "mac" }, ts: NOW, value: 50 },
    ]);
    const reply = await metricsReply(store, { from: NOW - 60, to: NOW, step: 30, names: [METRIC_NAMES.cpu] });
    expect(reply).toEqual({
      series: [
        {
          metric: METRIC_NAMES.cpu,
          labels: { machine: "mac" },
          points: [
            [NOW - 30, 33.3],
            [NOW, 12],
          ],
        },
      ],
    });
    expect(logged()).toContain('audit request origin=relay op="metrics" id="req-1"');
    store.close();
  });

  test("labels narrow the reply to one account's series, so other exclaves' quota stays off the wire", async () => {
    const quota = (exclave: string, account: string): Sample => ({
      metric: METRIC_NAMES.h,
      labels: { machine: "mac", exclave, account },
      ts: NOW,
      value: 40,
    });
    const store = storeWith([quota("default", "acct-a"), quota("work", "acct-b"), quota("side", "acct-a")]);
    const reply = await metricsReply(store, {
      from: NOW,
      to: NOW,
      step: 30,
      names: [METRIC_NAMES.h, METRIC_NAMES.d, METRIC_NAMES.w],
      labels: { account: "acct-a" },
    });
    if (!("series" in reply)) throw new Error("expected series");
    expect(reply.series.map((s) => s.labels)).toEqual([
      { account: "acct-a", exclave: "default", machine: "mac" },
      { account: "acct-a", exclave: "side", machine: "mac" },
    ]);
    store.close();
  });

  test("a malformed or over-long range is refused with a code, before the store is read", async () => {
    let reads = 0;
    const handler = createHandler({
      ...ctx,
      metrics: () => {
        reads += 1;
        return [];
      },
    });
    for (const payload of [
      { from: NOW, to: NOW - 1, step: 30 },
      { from: 0, to: NOW, step: 30 },
      { step: 30 },
      { from: NOW, to: NOW, step: 30, labels: { account: 1 } },
    ]) {
      const plain = await handler(request("metrics", payload));
      expect(parseMetricsReply(plain?.payload)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(reads).toBe(0);
  });

  test("a daemon without a store answers with a code instead of leaving the chart to time out", async () => {
    const reply = await metricsReply(null, { from: NOW, to: NOW, step: 30 });
    expect(reply).toMatchObject({ ok: false, code: "internal_error" });
  });
});
