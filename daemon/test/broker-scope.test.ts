import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64, type SessionsResponse } from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import { BrokerError, brokerMachines } from "../src/broker-client.ts";
import type { Config, PskSource } from "../src/config.ts";
import { localRequest } from "../src/local-client.ts";
import { startDaemon, type DaemonHandle } from "../src/run.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";
import { startTestRelay, type TestRelay } from "./harness.ts";

/**
 * Where the fleet broker runs at all: only on a daemon whose key is
 * service-delivered. A real daemon, its real local socket and the real broker
 * client; the source reaches `startDaemon` through `resolvedPsk`, the plumbing
 * the supervisor uses. The relay double counts every upgrade — it accepts the
 * daemon leg and rejects an app-role dial (no bearer header) — so "never dialled"
 * is one connection and no rejections.
 */

const PSK = toBase64(new Uint8Array(32).fill(3));
const TOKEN = "scope-bearer";

let base: string;
let privateTmux: PrivateTmux | undefined;
let repoRoot: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-brkscope-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "brkscope");
  repoRoot = join(base, "repos");
  await mkdir(repoRoot, { recursive: true });
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  await rm(base, { recursive: true, force: true });
});

async function withDaemon(
  source: PskSource,
  body: (relay: TestRelay, daemon: DaemonHandle, path: string) => Promise<void>,
): Promise<void> {
  const relay = startTestRelay(TOKEN);
  const config: Config = {
    name: "ScopeBox",
    relayUrl: `${relay.url}/daemon`,
    bearerToken: TOKEN,
    psk: "",
    repoRoots: [repoRoot],
    tmuxSession: "scope",
  };
  const daemon = await startDaemon({
    config,
    resolvedPsk: { psk: PSK, source },
    backend: createBackend(config, { waitMs: 700 }),
    pingIntervalMs: 60_000,
    pongTimeoutMs: 1_000,
    baseBackoffMs: 20,
  });
  try {
    await relay.registers.next();
    const path = daemon.localSocket;
    if (path === null) throw new Error("the local op socket did not bind");
    await body(relay, daemon, path);
  } finally {
    daemon.stop();
    relay.stop();
  }
}

describe("the broker runs only where the key is service-delivered", () => {
  for (const source of ["config", "keychain", "dpapi", "tpm"] as const) {
    test(`a ${source}-sourced daemon refuses broker frames and never dials app-role`, async () => {
      await withDaemon(source, async (relay, _daemon, path) => {
        const err = await brokerMachines({ path }).catch((caught: unknown) => caught);
        expect(err).toBeInstanceOf(BrokerError);
        expect(err).toMatchObject({ code: "broker_disabled" });
        // The local op path is untouched by the refusal.
        const reply = await localRequest<SessionsResponse>("sessions", {}, { path });
        expect(Array.isArray(reply.sessions)).toBe(true);
        expect(relay.connectionCount()).toBe(1);
        expect(relay.rejectedCount()).toBe(0);
      });
    });
  }

  test("a credential-sourced daemon serves broker frames over its own app-role dial", async () => {
    await withDaemon("credential", async (relay, _daemon, path) => {
      // The double cannot authenticate an app, so the dial is what is observable:
      // the request reaches the broker and the broker reaches for the relay.
      const reply = brokerMachines({ path, timeoutMs: 3_000 }).catch((caught: unknown) => caught);
      await pollUntil(() => relay.rejectedCount() > 0, "the broker's app-role dial");
      expect(await reply).not.toMatchObject({ code: "broker_disabled" });
    });
  });
});
