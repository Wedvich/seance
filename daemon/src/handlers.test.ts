import { beforeEach, describe, expect, test } from "bun:test";
import type { OpName, Plain, RepoEntry, SessionEntry, SpawnResponse } from "@seance/shared";
import type { AuditSink } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import type { SessionBackend } from "./backend.ts";
import type { Config } from "./config.ts";
import { createHandler, type HandlerContext } from "./handlers.ts";

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
    expect(logged()).toContain('audit request op="rescan" id="req-1"');
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

  test("a newline in a wire value cannot forge an audit line", async () => {
    await createHandler(ctx)(request("spawn", { repo: 'x\ninfo audit spawn ok window="gotcha"', mode: "here" }));
    expect(logged()).not.toContain('window="gotcha"');
    expect(logged()).toContain("\\n");
  });
});

const SPAWNED: SessionEntry = { window: "late-riser", repo: "myrepo", path: "/repos/myrepo" };

/**
 * A backend whose spawn succeeds but whose session list only admits the new
 * window after `blindCalls` looks — the real shape of detection keying off a
 * process title claude sets on its own schedule. Implementing the seam rather
 * than mocking past it: an alternative backend is what `SessionBackend` is for.
 */
function lateTitlingBackend(blindCalls: number): { readonly backend: SessionBackend; readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    backend: {
      spawn: () => Promise.resolve({ window: SPAWNED.window, path: SPAWNED.path }),
      sessions: () => {
        calls += 1;
        return Promise.resolve(calls > blindCalls ? [SPAWNED] : []);
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
  test("the session list is polled until the new window appears, not sampled once", async () => {
    const late = lateTitlingBackend(2);
    const payload = await spawnReply(late.backend);
    if (!payload.ok) throw new Error(`expected ok, got ${payload.message}`);
    // The app writes this list straight into its cache: short by one here and
    // the machine reads as idle until something else refreshes it.
    expect(payload.sessions).toEqual([SPAWNED]);
    expect(late.calls()).toBe(3);
  });

  test("a session that never titles still answers, with the list as it stands", async () => {
    const never = lateTitlingBackend(Number.POSITIVE_INFINITY);
    const payload = await spawnReply(never.backend);
    if (!payload.ok) throw new Error(`expected ok, got ${payload.message}`);
    expect(payload.sessions).toEqual([]);
    // Bounded: a late ack is worse than an incomplete one.
    expect(never.calls()).toBeGreaterThan(1);
  }, 10_000);
});
