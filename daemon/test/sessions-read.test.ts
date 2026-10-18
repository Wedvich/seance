import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEDULER_ID, type Plain, type RepoEntry } from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { createHandler, type HandlerContext } from "../src/handlers.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { EndedTasks } from "../src/session-events.ts";
import { exec } from "../src/exec.ts";
import { listPanes } from "../src/sessions.ts";

// Q1 of the M3 review: a `tmux list-panes` that fails for any reason but "no
// server" is no answer. Read as an empty list, every task the machine launched
// reads `ended`, and the leader settles running sessions done.

let base: string;
let shimDir: string;
const savedPath = process.env["PATH"];
const savedSocket = process.env["SEANCE_TMUX_SOCKET"];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-sessions-read-"));
  shimDir = join(base, "bin");
  await exec(["mkdir", "-p", shimDir]);
  const shim = join(shimDir, "tmux");
  // A server from another tmux version answers every client this way.
  await writeFile(shim, '#!/bin/sh\necho "protocol version mismatch (client 8, server 7)" >&2\nexit 1\n');
  await chmod(shim, 0o755);
  // First exec here, outside any timed window (CLAUDE.md, Testing).
  await exec([shim]);
});

afterAll(async () => {
  process.env["PATH"] = savedPath;
  if (savedSocket === undefined) delete process.env["SEANCE_TMUX_SOCKET"];
  else process.env["SEANCE_TMUX_SOCKET"] = savedSocket;
  await rm(base, { recursive: true, force: true });
});

const CONFIG: Config = {
  name: "TestBox",
  relayUrl: "ws://127.0.0.1:1",
  bearerToken: "t",
  psk: "p",
  repoRoots: [],
  tmuxSession: "main",
};
const REPOS: readonly RepoEntry[] = [];

async function schedulerSessions(): Promise<unknown> {
  const ledger = LaunchLedger.memory();
  await ledger.record("t-1");
  const ctx: HandlerContext = {
    backend: createBackend(CONFIG, { home: "/nonexistent/seance-home" }),
    getRepos: () => REPOS,
    rescan: () => Promise.resolve(REPOS),
    auditSink: () => Promise.resolve(),
    tasks: new EndedTasks(ledger),
  };
  const request: Plain = { id: "req-1", ts: Date.now(), op: "sessions", payload: {} };
  return (await createHandler(ctx)(request, SCHEDULER_ID))?.payload;
}

describe("a failed tmux read", () => {
  test("is internal_error from sessions, not an empty list that names every launched task ended", async () => {
    process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;
    try {
      expect(await schedulerSessions()).toMatchObject({ ok: false, code: "internal_error" });
      // Reap and a spawn's duplicate check read panes the same way, and refuse the same way.
      await expect(listPanes()).rejects.toThrow("protocol version mismatch");
    } finally {
      process.env["PATH"] = savedPath;
    }
  });

  test("but a server that is not running is nothing running: every launched task has ended", async () => {
    process.env["SEANCE_TMUX_SOCKET"] = join(base, "no-such.sock");
    expect(await schedulerSessions()).toMatchObject({ sessions: [], ended: ["t-1"] });
    expect(await listPanes()).toEqual([]);
    // A socket left behind by a server that has gone: tmux's own "no server running".
    // A real socket inode with no listener, not a plain file: connecting to a file is
    // ENOTSOCK on macOS, which tmux reports as a connect error, not as no server.
    const live = join(base, "live.sock");
    const stale = join(base, "stale.sock");
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(live, resolve);
    });
    await link(live, stale);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.env["SEANCE_TMUX_SOCKET"] = stale;
    expect(await listPanes()).toEqual([]);
  });
});
