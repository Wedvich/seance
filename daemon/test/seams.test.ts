import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importPsk,
  open,
  parseMachineInfo,
  parseMachineStatus,
  QUOTA_KEY,
  toBase64,
  type MachineInfo,
  type MachineStatus,
  type StoreRequestFrame,
} from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { startDaemon } from "../src/run.ts";
import { readRuntime } from "../src/state.ts";
import type { HostProbe } from "../src/telemetry.ts";
import { makeGitFixture, pollUntil, usePrivateTmux, type GitFixture, type PrivateTmux } from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";

/**
 * The seams `startDaemon` takes for what lies outside the process — the host
 * and the clock — reach the wiring that reads them, so a test above the unit
 * tier can drive what the daemon reports.
 */

const PSK = toBase64(new Uint8Array(32).fill(9));
const TOKEN = "test-bearer";
/** Far from the wall clock, so a stamp that read `Date.now()` instead could not match by chance. */
const NOW_MS = 1_600_000_000_000;

const probe: HostProbe = {
  cpu: () => null,
  memory: () => Promise.resolve({ total: 100, available: 25 }),
  disks: () => Promise.resolve([{ total: 100, free: 40 }]),
  diskIo: () => Promise.resolve(null),
};

let base: string;
let privateTmux: PrivateTmux | undefined;
let fixture: GitFixture;
let appKey: CryptoKey;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-seams-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  process.env["CLAUDE_CONFIG_DIR"] = join(base, "claude-config");
  privateTmux = usePrivateTmux(base, "seams");
  fixture = await makeGitFixture(base);
  appKey = await importPsk(PSK);
});

afterAll(async () => {
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  await rm(base, { recursive: true, force: true });
});

test("the injected probe and clock drive the register's scan stamp and the status the daemon sends", async () => {
  const relay = startTestRelay(TOKEN);
  const config: Config = {
    name: "SeamMac",
    relayUrl: relay.url,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
  const home = join(base, "home");
  let daemon: { stop(): void } | undefined;
  try {
    daemon = await startDaemon({
      config,
      backend: createBackend(config, { home }),
      home,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 1_000,
      baseBackoffMs: 20,
      now: () => NOW_MS,
      probe,
    });
    // The boot register predates the first scan (stamp 0); the boot rescan's carries the clock's.
    let info: MachineInfo | null = null;
    for (let i = 0; i < 5 && info?.scannedAt !== NOW_MS; i++) {
      // oxlint-disable-next-line no-await-in-loop -- registers arrive in order
      info = parseMachineInfo((await open(appKey, (await relay.registers.next()).info)).payload);
    }
    expect(info?.scannedAt).toBe(NOW_MS);

    // A tick begun before that register names the boot blob; the one after it names this one.
    let status: MachineStatus | null = null;
    for (let i = 0; i < 5 && status?.scan !== NOW_MS; i++) {
      // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
      status = parseMachineStatus((await open(appKey, await relay.statuses.next())).payload);
    }
    expect(status).toMatchObject({ scan: NOW_MS, at: NOW_MS / 1000, mem: 75, disk: 60 });
    expect(status?.cpu).toBeUndefined();

    // runtime.json is written off the connect path, so it may land after the first frames.
    await pollUntil(async () => (await readRuntime())?.startedAt === NOW_MS, "runtime.json to carry the clock");
  } finally {
    daemon?.stop();
    relay.stop();
  }
});

test("the first fleet quota write follows the register's own sample, not the next interval", async () => {
  const relay = startTestRelay(TOKEN);
  const config: Config = {
    name: "QuotaMac",
    relayUrl: relay.url,
    bearerToken: TOKEN,
    psk: PSK,
    repoRoots: [fixture.root],
    tmuxSession: "main",
  };
  const home = join(base, "quota-home");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { organizationUuid: "org", accountUuid: "acct" },
      cachedUsageUtilization: { fetchedAtMs: NOW_MS - 60_000, utilization: { five_hour: { utilization: 10 } } },
    }),
  );
  // Its own state dir: a fresh one boots at scan 0, so the register's scan differs from the boot
  // snapshot's — a dir another test already rescanned would hide a missing `onSample` wiring.
  const sharedStateDir = process.env["SEANCE_STATE_DIR"];
  process.env["SEANCE_STATE_DIR"] = join(base, "quota-state");
  let daemon: { stop(): void } | undefined;
  try {
    daemon = await startDaemon({
      config,
      backend: createBackend(config, { home }),
      home,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 1_000,
      baseBackoffMs: 20,
      now: () => NOW_MS,
      probe,
      // Far past the test: only the sample after the register can write inside it.
      fleetQuota: { intervalMs: 600_000 },
    });
    let put: StoreRequestFrame | undefined;
    for (let i = 0; i < 10 && put === undefined; i++) {
      // oxlint-disable-next-line no-await-in-loop -- frames arrive in order
      const frame = await relay.storeFrames.next(5_000);
      if (frame.t === "store-put" && frame.key === QUOTA_KEY) put = frame;
    }
    expect(put).toMatchObject({ key: QUOTA_KEY, expect: 0 });
  } finally {
    daemon?.stop();
    relay.stop();
    if (sharedStateDir === undefined) delete process.env["SEANCE_STATE_DIR"];
    else process.env["SEANCE_STATE_DIR"] = sharedStateDir;
  }
});
