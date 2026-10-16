import { beforeEach, describe, expect, test } from "bun:test";
import {
  METRIC_NAMES,
  parseMetricsReply,
  type DespawnResponse,
  type MetricsReply,
  type OpName,
  type Plain,
  type RepoEntry,
  type SessionEntry,
  type SpawnResponse,
} from "@seance/shared";
import type { AuditSink } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import type { SessionBackend } from "./backend.ts";
import type { Config } from "./config.ts";
import { createHandler, type HandlerContext } from "./handlers.ts";
import { MetricsStore, type Sample } from "./metrics-store.ts";

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
  backend: createBackend(CONFIG),
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
