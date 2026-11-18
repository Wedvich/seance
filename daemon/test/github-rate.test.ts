import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPsk, open as openSealed, parseMachineStatus, toBase64, type MachineStatus } from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { graphqlResetOf, startGithubRate, type GithubRateReader } from "../src/github-rate.ts";
import { startDaemon } from "../src/run.ts";
import {
  makeGhStub,
  makeGitFixture,
  pollUntil,
  usePrivateTmux,
  type GhRun,
  type GhStub,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW / 1000 + 1_800;

let base: string;
let stub: GhStub;
let gh: GhRun;
let reader: GithubRateReader | null = null;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-github-rate-"));
  stub = await makeGhStub(base);
});

beforeEach(async () => {
  gh = await stub.fresh();
});

afterEach(() => {
  reader?.stop();
  reader = null;
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function rateLimit(core: Record<string, unknown> = {}, graphql: Record<string, unknown> = {}): string {
  const budget = (fields: Record<string, unknown>): Record<string, unknown> => ({
    limit: 5000,
    used: 1200,
    remaining: 3800,
    reset: RESET,
    ...fields,
  });
  // `rate` and the other resources are GitHub's too: read past, never kept.
  return JSON.stringify({
    resources: { core: budget(core), graphql: budget(graphql), search: budget({ limit: 30 }) },
    rate: budget(core),
  });
}

function start(opts: { readonly now?: () => number; readonly intervalMs?: number; readonly lowIntervalMs?: number }) {
  reader = startGithubRate({ gh: stub.path, now: opts.now ?? (() => NOW), intervalMs: 3_600_000, ...opts });
  return reader;
}

describe("startGithubRate", () => {
  test("reads /rate_limit and the user id by constant argv, and the view carries both budgets", async () => {
    await gh.setReply(rateLimit({ remaining: 3800 }, { limit: 5000, used: 10, remaining: 4990 }), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const r = start({});
    await r.readNow();
    expect(await gh.argvs()).toEqual([
      ["api", "--hostname", "github.com", "rate_limit"],
      ["api", "--hostname", "github.com", "user", "--jq", ".id"],
    ]);
    expect(r.view()).toEqual({ u: 583231, c: [5000, 3800, RESET], g: [5000, 4990, RESET] });
  });

  test("the user id is read once and kept; a later read is /rate_limit alone", async () => {
    await gh.setReply(rateLimit(), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const r = start({});
    await r.readNow();
    await r.readNow();
    expect(await gh.calls()).toBe(3);
    expect((await gh.argv()).at(-1)).toBe("rate_limit");
    expect(r.view()?.u).toBe(583231);
  });

  test("an answer off its shape is no reading", async () => {
    const r = start({});
    for (const reply of [
      "not json",
      JSON.stringify({ resources: { core: { limit: 5000, used: 0, remaining: 5000, reset: RESET } } }),
      rateLimit({ remaining: 5001 }),
      rateLimit({ limit: 0, remaining: 0 }),
      rateLimit({}, { reset: "soon" }),
      rateLimit({ remaining: -1 }),
      JSON.stringify({ message: "Bad credentials" }),
    ]) {
      await gh.setReply(reply, 0);
      // oxlint-disable-next-line no-await-in-loop -- one read per reply, in order
      await r.readNow();
      expect(r.view()).toBeNull();
    }
    // A well-formed answer behind a failing exit is not trusted either.
    await gh.setReply(rateLimit(), 1);
    await r.readNow();
    expect(r.view()).toBeNull();
  });

  test("no login forgets the user id, and the next good read asks for it again", async () => {
    await gh.setReply(rateLimit(), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const r = start({});
    await r.readNow();
    await gh.setReply("", 4);
    await r.readNow();
    expect(r.view()).toBeNull();
    await gh.setReply(rateLimit(), 0);
    await gh.setCallReply(5, "777\n", 0);
    await r.readNow();
    expect((await gh.argvs()).map((argv) => argv[3])).toEqual([
      "rate_limit",
      "user",
      "rate_limit",
      "rate_limit",
      "user",
    ]);
    expect(r.view()?.u).toBe(777);
  });

  test("an id that fails to read leaves the reading, without `u`", async () => {
    await gh.setReply(rateLimit(), 0);
    await gh.setCallReply(2, "not-an-id\n", 0);
    const r = start({});
    await r.readNow();
    expect(r.view()).toEqual({ c: [5000, 3800, RESET], g: [5000, 3800, RESET] });
  });

  test("no gh at all is no reading", async () => {
    reader = startGithubRate({ gh: join(base, "no-such-gh"), now: () => NOW, intervalMs: 3_600_000 });
    await reader.readNow();
    expect(reader.view()).toBeNull();
  });

  test("a budget past its reset drops out of the view", async () => {
    let now = NOW;
    await gh.setReply(rateLimit({}, { reset: RESET + 1_800 }), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const r = start({ now: () => now });
    await r.readNow();
    now = RESET * 1000;
    expect(r.view()).toEqual({ u: 583231, g: [5000, 3800, RESET + 1_800] });
    now = (RESET + 1_800) * 1000;
    expect(r.view()).toBeNull();
  });

  test("under half a budget left, reads come at the low pace; above it, at the slow one", async () => {
    await gh.setReply(rateLimit({ remaining: 2600 }), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const aboveHalf = start({ intervalMs: 50, lowIntervalMs: 3_600_000 });
    await aboveHalf.readNow();
    await pollUntil(async () => (await gh.calls()) >= 3, "a third gh call");
    aboveHalf.stop();
    const quiet = await gh.settledCalls();

    gh = await stub.fresh();
    await gh.setReply(rateLimit({}, { remaining: 2400 }), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const underHalf = start({ intervalMs: 50, lowIntervalMs: 3_600_000 });
    await underHalf.readNow();
    // A non-event: the slow pace would have read again many times by now.
    await Bun.sleep(300);
    expect(await gh.calls()).toBe(2);
    underHalf.stop();
    expect(quiet).toBeGreaterThanOrEqual(3);

    gh = await stub.fresh();
    await gh.setReply(rateLimit({}, { remaining: 2400 }), 0);
    await gh.setCallReply(2, "583231\n", 0);
    const underHalfFast = start({ intervalMs: 3_600_000, lowIntervalMs: 50 });
    await underHalfFast.readNow();
    await pollUntil(async () => (await gh.calls()) >= 3, "a third gh call");
  });
});

describe("the daemon", () => {
  const PSK = toBase64(new Uint8Array(32).fill(9));
  const TOKEN = "test-bearer";
  let privateTmux: PrivateTmux | undefined;
  let fixture: GitFixture;
  let appKey: CryptoKey;

  beforeAll(async () => {
    process.env["SEANCE_STATE_DIR"] = join(base, "state");
    privateTmux = usePrivateTmux(base, "github-rate");
    fixture = await makeGitFixture(base);
    appKey = await importPsk(PSK);
  });

  afterAll(async () => {
    await privateTmux?.dispose();
    delete process.env["SEANCE_STATE_DIR"];
  });

  async function withDaemon(
    githubRate: { readonly gh: string } | undefined,
    body: (next: () => Promise<MachineStatus>) => Promise<void>,
  ): Promise<void> {
    const home = await mkdtemp(join(base, "daemon-home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "{}");
    const relay = startTestRelay(TOKEN);
    const config: Config = {
      name: "GhMac",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [fixture.root],
      tmuxSession: "main",
    };
    let daemon: { stop(): void } | undefined;
    try {
      daemon = await startDaemon({
        config,
        backend: createBackend(config, { home }),
        home,
        pingIntervalMs: 60_000,
        pongTimeoutMs: 1_000,
        baseBackoffMs: 20,
        telemetryIntervalMs: 100,
        ...(githubRate === undefined ? {} : { githubRate }),
      });
      await body(async () => {
        const plain = await openSealed(appKey, await relay.statuses.next(5_000));
        const status = parseMachineStatus(plain.payload);
        if (status === null) throw new Error("unparseable status");
        return status;
      });
    } finally {
      daemon?.stop();
      relay.stop();
    }
  }

  test("its status carries its own gh's budget as `gh`, user id included", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1_800;
    await gh.setReply(rateLimit({ reset, remaining: 900 }, { reset }), 0);
    await gh.setCallReply(2, "583231\n", 0);
    await withDaemon({ gh: stub.path }, async (next) => {
      let status = await next();
      const deadline = Date.now() + 10_000;
      while (status.gh?.u === undefined) {
        if (Date.now() > deadline) throw new Error(`no gh in the status; last ${JSON.stringify(status)}`);
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        status = await next();
      }
      expect(status.gh).toEqual({ u: 583231, c: [5000, 900, reset], g: [5000, 3800, reset] });
    });
  });

  test("a daemon started without it runs no gh and reports no `gh`", async () => {
    await withDaemon(undefined, async (next) => {
      for (let i = 0; i < 3; i++) {
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        expect(await next()).not.toHaveProperty("gh");
      }
    });
    expect(await gh.calls()).toBe(0);
  });
});

describe("graphqlResetOf", () => {
  test("the GraphQL budget's reset in unix ms, or null with no GraphQL reading", () => {
    expect(graphqlResetOf({ u: 7, c: [5000, 10, 100], g: [5000, 0, 1_800_000_000] })).toBe(1_800_000_000_000);
    expect(graphqlResetOf({ c: [5000, 10, 100] })).toBeNull();
    expect(graphqlResetOf(null)).toBeNull();
  });
});
