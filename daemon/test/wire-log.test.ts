import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID, importPsk, open, seal, toBase64, type Envelope, type Plain } from "@seance/shared";
import type { Config } from "../src/config.ts";
import { startDaemon, type DaemonHandle } from "../src/run.ts";
import { tmux } from "../src/tmux.ts";
import { makeClaudeStub, makeGitFixture, type GitFixture } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

/**
 * The daemon is the only tier that sees both the envelope `iv` and the plaintext
 * `id`, so its log lines are the hinge the cross-tier join hangs on — a relay
 * line can name nothing but the `iv`. These pin both halves of that contract:
 * the pairing is emitted, and the payload never rides along with it.
 */

const PSK = toBase64(new Uint8Array(32).fill(7));
const TOKEN = "test-bearer";
const SECRET_PROMPT = "correct horse battery staple";

let base: string;
let fixture: GitFixture;
let appKey: CryptoKey;
let lines: string[] = [];
let realLog: typeof console.log;
let realError: typeof console.error;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-wirelog-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  process.env["SEANCE_TMUX_SOCKET"] = `seance-wirelog-test-${process.pid}`;
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  fixture = await makeGitFixture(base);
  const stub = await makeClaudeStub(base);
  process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
  appKey = await importPsk(PSK);
  // Both streams: log.ts sends `error` to console.error, and the realistic leak is a
  // handler crash stringifying an error that quotes the request — capturing only
  // console.log would let the prompt assertion below pass over a prompt in the output.
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
  await tmux(["kill-server"]);
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["SEANCE_TMUX_SOCKET"];
  delete process.env["SEANCE_CLAUDE_BIN"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  lines = [];
});

const logged = (): string => lines.join("\n");

function makeConfig(relayUrl: string): Config {
  return {
    name: "TestMac",
    relayUrl,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
}

async function startTestDaemon(relayUrl: string): Promise<DaemonHandle> {
  return startDaemon({
    config: makeConfig(relayUrl),
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
    spawnWaitMs: 700,
  });
}

/** Waits for a register whose decrypted repo list includes `repoName`. */
async function registerWithRepo(relay: TestRelay, repoName: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const frame = await relay.registers.next();
    const plain = await open(appKey, frame.info);
    const info = plain.payload as { repos: { name: string }[] };
    if (info.repos.some((repo) => repo.name === repoName)) return frame.deviceId;
  }
  throw new Error(`no register with repo ${repoName}`);
}

async function appRequest(
  relay: TestRelay,
  deviceId: string,
  op: Plain["op"],
  payload: unknown,
): Promise<{ id: string; env: Envelope }> {
  const id = crypto.randomUUID();
  const env = await seal(appKey, { to: deviceId, from: APP_ID }, { id, ts: Date.now(), op, payload });
  relay.sendToDaemon(env);
  return { id, env };
}

describe("wire correlation logging", () => {
  test("pairs the request iv with the plaintext id, and the reply iv with its re", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const deviceId = await registerWithRepo(relay, "myrepo");
      const { id, env } = await appRequest(relay, deviceId, "sessions", {});
      const reply = await relay.messages.next(3_000);

      // The relay only ever sees these two ivs; the daemon is what ties each to an id.
      expect(logged()).toContain(`wire recv iv=${JSON.stringify(env.iv)} id=${JSON.stringify(id)} op="sessions"`);
      expect(logged()).toContain(`wire send iv=${JSON.stringify(reply.iv)} re=${JSON.stringify(id)}`);
      // Request and reply carry different ivs — the join crosses through `id`, not the iv.
      expect(reply.iv).not.toBe(env.iv);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("names the iv on a dropped envelope, so a silent failure is still joinable", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const deviceId = await registerWithRepo(relay, "myrepo");
      const { env } = await appRequest(relay, deviceId, "sessions", {});
      await relay.messages.next(3_000);
      relay.sendToDaemon(env); // byte-identical replay
      await Bun.sleep(200);

      // Same `wire ` prefix as the success paths, so one grep covers both.
      expect(logged()).toContain(`wire dropped iv=${JSON.stringify(env.iv)}`);
      expect(logged()).toContain("reason=replay");
    } finally {
      daemon.stop();
      relay.stop();
    }
  });

  test("never logs the prompt alongside the correlation ids", async () => {
    const relay = startTestRelay(TOKEN);
    const daemon = await startTestDaemon(relay.url);
    try {
      const deviceId = await registerWithRepo(relay, "myrepo");
      // Rejected for the unknown repo, which is enough: `wire recv` is emitted
      // before the handler runs, so the line is on the record either way.
      const { id } = await appRequest(relay, deviceId, "spawn", {
        repo: "no-such-repo",
        mode: "here",
        prompt: SECRET_PROMPT,
      });
      await relay.messages.next(3_000);

      expect(logged()).toContain(`id=${JSON.stringify(id)} op="spawn"`);
      expect(logged()).not.toContain(SECRET_PROMPT);
    } finally {
      daemon.stop();
      relay.stop();
    }
  });
});
