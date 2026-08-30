import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plain, RepoEntry, SessionsResponse, SpawnResponse } from "@seance/shared";
import type { AuditSink } from "../src/audit.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { createHandler, type HandlerContext } from "../src/handlers.ts";
import { localRequest, LocalUnavailable, localSocketReachable } from "../src/local-client.ts";
import { startLocalSocket, type LocalSocketHandle } from "../src/local-socket.ts";
import { scanRepos } from "../src/scan.ts";
import { tmux } from "../src/tmux.ts";
import { makeClaudeStub, makeGitFixture, type ClaudeStub, type GitFixture } from "./fixtures.ts";

/**
 * The local op path with everything under it real: socket, handler, backend,
 * git and tmux. Only the relay is absent, which is the point — this is the
 * route an MCP spawn aimed at this machine takes instead.
 */

let base: string;
let sockPath: string;
let fixture: GitFixture;
let stub: ClaudeStub;
let repos: readonly RepoEntry[];
let socket: LocalSocketHandle;
const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);
const logged = (): string => lines.join("\n");

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-sock-"));
  sockPath = join(base, "seanced.sock");
  process.env["SEANCE_TMUX_SOCKET"] = `seance-sock-test-${process.pid}`;
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  fixture = await makeGitFixture(base);
  stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  repos = await scanRepos([fixture.root]);

  const config: Config = {
    name: "TestMac",
    relayUrl: "ws://localhost/daemon",
    bearerToken: "test-bearer",
    psk: "",
    repoRoots: [fixture.root],
    tmuxSession: "main",
    machineTag: "testbox",
  };
  const ctx: HandlerContext = {
    backend: createBackend(config, { waitMs: 700 }),
    getRepos: () => repos,
    rescan: () => Promise.resolve(repos),
    auditSink: collect,
  };
  socket = await startLocalSocket({ handle: createHandler(ctx, "local"), path: sockPath });
});

afterAll(async () => {
  socket.stop();
  await tmux(["kill-server"]);
  delete process.env["SEANCE_TMUX_SOCKET"];
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

/** The socket server frames NDJSON; these send raw bytes to exercise what the client never would. */
async function raw(payload: string, waitMs = 300): Promise<string> {
  let received = "";
  const sock = await Bun.connect<undefined>({
    unix: sockPath,
    socket: {
      data: (_s, chunk: Buffer): void => void (received += chunk.toString()),
      error: (): void => {},
    },
  });
  // `write` is short under backpressure and Bun does not queue the rest, so a
  // one-shot write of anything large silently sends a fraction of it — which is
  // exactly how the frame-cap assertion below would pass without testing
  // anything. Loop until the bytes are actually gone or the peer hangs up.
  let buf = Buffer.from(payload, "utf8");
  for (let i = 0; i < 2_000 && buf.length > 0; i++) {
    let written = 0;
    try {
      written = sock.write(buf);
    } catch {
      break; // dropped by the server, which is the point of some of these
    }
    if (written <= 0) {
      // oxlint-disable-next-line no-await-in-loop -- backpressure: nothing to parallelize
      await Bun.sleep(1);
      continue;
    }
    buf = buf.subarray(written);
  }
  await Bun.sleep(waitMs);
  sock.end();
  return received;
}

describe("the local op socket", () => {
  test("it bound, and the directory mode is what gates it", async () => {
    expect(socket.path).toBe(sockPath);
    expect(await localSocketReachable(sockPath)).toBe(true);
    // The directory is the access control; the socket's own mode is belt-and-braces.
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    expect((await stat(sockPath)).mode & 0o777).toBe(0o600);
  });

  test("sessions answers over the socket with no relay in the picture", async () => {
    const reply = await localRequest<SessionsResponse>("sessions", {}, { path: sockPath });
    expect(Array.isArray(reply.sessions)).toBe(true);
    expect(logged()).toContain('audit request origin=local op="sessions"');
  });

  test("a spawn runs the real backend and audits as origin=local", async () => {
    lines.length = 0;
    const reply = await localRequest<SpawnResponse>(
      "spawn",
      { repo: "myrepo", mode: "here", title: "Local Op", prompt: "do the thing", client: "mcp" },
      { path: sockPath },
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error(reply.message);
    expect(reply.window).toBe("Local Op");

    // The window really exists, and the machineTag suffix proves it went through
    // the same backend a relayed spawn would — not a second spawn path.
    const windows = await tmux(["list-windows", "-t", "main", "-F", "#{window_name}"]);
    expect(windows.stdout).toContain("Local Op");
    const argv = await stub.argv();
    expect(argv).toContain("local-op (testbox)");

    expect(logged()).toContain('audit spawn origin=local client="mcp" repo="myrepo"');
    expect(logged()).toContain("audit spawn origin=local ok window=");
    // The prompt is never in the log, on this path either.
    expect(logged()).not.toContain("do the thing");
    expect(logged()).toContain("promptLen=12");

    await tmux(["kill-window", "-t", "main:Local Op"]);
  });

  test("a structured spawn failure comes back as a payload, not a dropped connection", async () => {
    const reply = await localRequest<SpawnResponse>("spawn", { repo: "nope", mode: "here" }, { path: sockPath });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected a failure");
    expect(reply.code).toBe("repo_not_found");
  });

  test("a request too big for one write still arrives whole", async () => {
    // The client's write is short under backpressure exactly as the server's is.
    // Unqueued, the daemon sees a fragment with no newline, dispatches nothing,
    // and the caller learns that only when the op times out — so the tell for a
    // regression here is the timeout, not a wrong answer. `nope` keeps the
    // backend out of it: resolving the repo is enough to prove the frame landed.
    const prompt = "x".repeat(400_000);
    const reply = await localRequest<SpawnResponse>(
      "spawn",
      { repo: "nope", mode: "here", prompt, client: "mcp" },
      { path: sockPath, timeoutMs: 5_000 },
    );
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected a failure");
    expect(reply.code).toBe("repo_not_found");
  });

  test("an explicit path does not drag its directory to 0700", async () => {
    // The mode is enforced for `runDir()`, which this module owns. A caller's
    // own directory is not ours to tighten.
    const loose = join(base, "loose");
    await mkdir(loose, { recursive: true });
    await chmod(loose, 0o755);
    const handle = await startLocalSocket({ handle: () => Promise.resolve(null), path: join(loose, "s.sock") });
    expect(handle.path).not.toBeNull();
    expect((await stat(loose)).mode & 0o777).toBe(0o755);
    handle.stop();
  });

  test("ops outside the allowlist are refused before they reach the handler", async () => {
    lines.length = 0;
    for (const op of ["rescan", "update-available"]) {
      const line = await raw(`${JSON.stringify({ id: `x-${op}`, ts: Date.now(), op, payload: {} })}\n`);
      const reply = JSON.parse(line.trim()) as Plain;
      expect(reply.payload).toMatchObject({ ok: false });
      expect(JSON.stringify(reply.payload)).toContain("not available on the local socket");
    }
    // The handler audits every op it sees; neither of these reached it.
    expect(logged()).not.toContain("audit request origin=local");
  });

  test("a frame past the cap drops the peer instead of growing the daemon's heap", async () => {
    lines.length = 0;
    // No newline anywhere, so the server can only be buffering it.
    const reply = await raw("x".repeat(1_200_000), 500);
    expect(reply).toBe("");
    // The peer is gone: a further write on that connection cannot be delivered.
    expect(await localSocketReachable(sockPath)).toBe(true);
    // And nothing was handed to the handler.
    expect(logged()).not.toContain("audit request origin=local");
  });

  test("a frame that is not JSON is dropped rather than answered", async () => {
    expect(await raw("not json at all\n")).toBe("");
    expect(await localSocketReachable(sockPath)).toBe(true);
  });

  test("a stale socket file left by a killed daemon is taken over, not refused", async () => {
    const orphan = join(base, "orphan.sock");
    await writeFile(orphan, "not a socket");
    const taken = await startLocalSocket({ handle: () => Promise.resolve(null), path: orphan });
    expect(taken.path).toBe(orphan);
    expect(await localSocketReachable(orphan)).toBe(true);
    taken.stop();
  });

  test("a live socket is not stolen from the daemon that owns it", async () => {
    const second = await startLocalSocket({ handle: () => Promise.resolve(null), path: sockPath });
    expect(second.path).toBeNull();
    // The original is untouched.
    expect(await localSocketReachable(sockPath)).toBe(true);
  });

  test("with nothing listening, the client says so rather than hanging", async () => {
    const missing = join(base, "absent.sock");
    await expect(localRequest("sessions", {}, { path: missing })).rejects.toBeInstanceOf(LocalUnavailable);
  });
});
