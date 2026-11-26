import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importPsk,
  open as openSealed,
  parseMachineInfo,
  parseMachineStatus,
  type MachineInfo,
  type MachineStatus,
} from "@seance/shared";
import { createBackend } from "../src/backend-default.ts";
import { codexRunnable, createCodexAccount, type CodexAccount } from "../src/codex/account.ts";
import { codexEnv, prepareCodexHome, renderCodexConfig } from "../src/codex/home.ts";
import { readRemote, removeRemote, writeRemote } from "../src/codex/remote.ts";
import { probeCodex } from "../src/codex/probe.ts";
import { configSkeleton, type Config } from "../src/config.ts";
import { startDaemon } from "../src/run.ts";
import { makeCodexStub, makeGitFixture, pollUntil, usePrivateTmux, type CodexStub } from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";

/**
 * The Codex login (docs/codex.md, "The account"; DESIGN.md, Daemon, "Codex login") against a stub `codex` that speaks
 * the app-server's line protocol: the probe, the home, the account's cadence, the daemon's blob and status, and the
 * owner's verbs. No test runs a real `codex`, and no home here is anyone's.
 */

const RATE_LIMITS = {
  ordinaryUsageAllowed: true,
  accountId: "acct-1",
  rateLimits: {
    limitId: "codex",
    normalModelSlug: null,
    primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_760_010_000 },
    secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_760_500_000 },
    credits: { hasCredits: true, unlimited: false, balance: "5" },
    individualLimit: null,
    spendControlReached: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
};
const ACCOUNT = {
  account: { type: "chatgpt", email: "a@example.com", planType: "team", workspaceName: "Acme" },
  userId: "user-1",
};
const SIGNED_IN = { account: { result: ACCOUNT }, rateLimits: { result: RATE_LIMITS } };
const SIGNED_OUT = {
  account: { result: { account: null, userId: null, requiresOpenaiAuth: true } },
  rateLimits: { error: { code: -32_600, message: "codex account authentication required to read rate limits" } },
};
const EXPIRED = {
  account: { result: { account: null, userId: null } },
  rateLimits: { error: { code: -32_603, message: 'failed: 401 Unauthorized {"detail":"quoted body"}' } },
};

let base: string;
let stub: CodexStub;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-codex-")));
  stub = await makeCodexStub(join(base, "stub"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await stub.reset();
});

const freshHome = async (): Promise<string> => {
  const dir = await mkdtemp(join(base, "state-"));
  return (await prepareCodexHome(dir, null)).home;
};

const probe = async (home: string, timeoutMs?: number) =>
  probeCodex({
    bin: stub.path,
    env: codexEnv(home, base),
    home,
    now: () => 1_759_999_000_000,
    ...(timeoutMs === undefined ? {} : { timeoutMs, killAfterMs: 200 }),
  });

describe("the home", () => {
  test("0700 directories and a 0600 config.toml, regenerated whole at each write", async () => {
    const dir = await mkdtemp(join(base, "state-"));
    const launch = { command: "/opt/bin/bun", args: ['/srv/se"ance/daemon/src/main.ts', "mcp"] };
    const { home, mcp } = await prepareCodexHome(dir, launch);
    expect(mcp).toBe(true);
    expect((await stat(join(dir, "codex"))).mode & 0o777).toBe(0o700);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    const file = join(home, "config.toml");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, "utf8");
    expect(text).toBe(renderCodexConfig(launch));
    expect(text).toContain('cli_auth_credentials_store = "file"');
    expect(text).toContain("check_for_update_on_startup = false");
    expect(text).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');
    expect(text).toContain("project_doc_max_bytes = 262144");
    expect(text).toContain(
      '[mcp_servers.seance]\ncommand = "/opt/bin/bun"\nargs = ["/srv/se\\"ance/daemon/src/main.ts", "mcp"]',
    );
    expect(text).not.toContain("hooks");
    await writeFile(file, "model = 'hand edited'\n");
    await prepareCodexHome(dir, null);
    const again = await readFile(file, "utf8");
    expect(again).not.toContain("hand edited");
    expect(again).not.toContain("mcp_servers");
  });
});

describe("the probe", () => {
  test("a signed-in home: identity, display, quota and credits, run bare in the home with CODEX_HOME set", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_IN);
    process.env["CREDENTIALS_DIRECTORY"] = "/run/credentials/seanced.service";
    try {
      expect(await probe(home)).toEqual({
        health: "ok",
        version: "0.170.0",
        accountId: "codex:acct-1:user-1",
        display: { email: "a@example.com", plan: "team", workspace: "Acme" },
        quota: { s: "cache", at: 1_759_999_000, h: 3, hr: 1_760_010_000, d: 41, dr: 1_760_500_000, c: 0 },
        credits: true,
        blocked: false,
      });
    } finally {
      delete process.env["CREDENTIALS_DIRECTORY"];
    }
    const calls = await stub.calls();
    expect(calls.map((call) => call.argv)).toEqual([["--version"], ["app-server"]]);
    for (const call of calls) {
      expect(call.codexHome).toBe(home);
      expect(call.cwd).toBe(home);
      expect(call.credentials).toBe(false);
    }
  });

  test("an empty home reads signed out; a refused login reads expired", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_OUT);
    expect(await probe(home)).toEqual({ health: "signed_out", version: "0.170.0" });
    await stub.scenario(EXPIRED);
    expect(await probe(home)).toEqual({ health: "expired", version: "0.170.0" });
  });

  test("below the floor, missing or unreadable, no app-server runs", async () => {
    const home = await freshHome();
    await stub.scenario({ ...SIGNED_IN, version: "0.166.0" });
    expect(await probe(home)).toEqual({ health: "unknown", version: "0.166.0", failure: "outdated" });
    await stub.scenario({ ...SIGNED_IN, versionExit: 3 });
    expect(await probe(home)).toEqual({ health: "unknown", version: null, failure: "unreadable_version" });
    expect((await stub.calls()).map((call) => call.argv)).toEqual([["--version"], ["--version"]]);
    const missing = await probeCodex({
      bin: join(base, "no-codex"),
      env: codexEnv(home, base),
      home,
      now: Date.now,
    });
    expect(missing).toEqual({ health: "unknown", version: null, failure: "missing" });
  });

  test("a server that never answers is ended at the timeout; one that floods is cut at the cap", async () => {
    const home = await freshHome();
    await stub.scenario({ ...SIGNED_IN, hang: true });
    expect(await probe(home, 1_500)).toEqual({ health: "unknown", version: "0.170.0", failure: "timeout" });
    await stub.scenario({ ...SIGNED_IN, flood: 80_000 });
    expect(await probe(home)).toEqual({ health: "unknown", version: "0.170.0", failure: "oversized" });
  });
});

describe("the account", () => {
  let account: CodexAccount | null = null;

  const start = async (home: string, staleAfterMs = 3_600_000, userHome = base) => {
    const counts = { info: 0, status: 0, paired: 0 };
    account = createCodexAccount({
      home,
      userHome,
      bin: stub.path,
      staleAfterMs,
      checkIntervalMs: 50,
      onInfoChange: () => counts.info++,
      onStatusChange: () => counts.status++,
      onPairedChange: () => counts.paired++,
      remotePath: join(home, "..", "remote.json"),
    });
    account.start();
    await pollUntil(
      async () => (await stub.calls()).length >= 2 && account?.view().health !== "unknown",
      "a first probe",
    );
    await account.idle();
    return counts;
  };

  test("a sign-in shows in the blob's login and the status's view, and re-registers once", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_IN);
    const counts = await start(home);
    expect(account?.login()).toEqual({
      agent: "codex",
      accountId: "codex:acct-1:user-1",
      email: "a@example.com",
      plan: "team",
      workspace: "Acme",
      authOk: true,
      credits: true,
      version: "0.170.0",
    });
    expect(account?.view().health).toBe("ok");
    expect(counts).toEqual({ info: 1, status: 1, paired: 0 });
    // Fresh: the minute timer probes nothing until the reading is stale.
    await Bun.sleep(300);
    expect((await stub.calls()).length).toBe(2);
    account?.stop();
  });

  test("remote.json, read on the tick, sets the login's paired and offers the slot; a probe is not run for it", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_IN);
    const counts = await start(home);
    expect(account?.paired()).toBe(false);
    const note = join(home, "..", "remote.json");
    await writeRemote({ v: 1, environmentId: "env_1", clients: ["cli_1"], at: 1 }, note);
    await pollUntil(() => account?.paired() === true, "the pairing read");
    expect(account?.login().paired).toBe(true);
    expect(counts).toEqual({ info: 2, status: 1, paired: 1 });
    await removeRemote(note);
    await pollUntil(() => account?.paired() === false, "the unpairing read");
    expect(account?.login()).not.toHaveProperty("paired");
    expect(counts.paired).toBe(2);
    expect((await stub.calls()).length).toBe(2);
    account?.stop();
  });

  test("signed out is probed again only when the credential file's entry changes, never on the clock", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_OUT);
    await start(home, 60_000);
    expect(account?.login()).toEqual({ agent: "codex", accountId: null, authOk: false, version: "0.170.0" });
    await Bun.sleep(300);
    expect((await stub.calls()).length).toBe(2);
    // The stub stands in for Codex writing its file at sign-in; nothing in the daemon reads it.
    await stub.scenario(SIGNED_IN);
    await writeFile(join(home, "auth.json"), "{}");
    await pollUntil(() => account?.login().authOk === true, "the sign-in read");
    expect(account?.login().accountId).toBe("codex:acct-1:user-1");
    account?.stop();
  });

  test("signed out beside the owner's own ~/.codex sign-in says so, re-registering on its change with no probe", async () => {
    const home = await freshHome();
    const userHome = await mkdtemp(join(base, "user-"));
    const ownerAuth = join(userHome, ".codex", "auth.json");
    await mkdir(join(userHome, ".codex"));
    // Unreadable: existence is all the daemon may learn of it.
    await writeFile(ownerAuth, "{}", { mode: 0o000 });
    await stub.scenario(SIGNED_OUT);
    const counts = await start(home, 60_000, userHome);
    expect(account?.login()).toEqual({
      agent: "codex",
      accountId: null,
      authOk: false,
      ownerHome: true,
      version: "0.170.0",
    });
    await rm(ownerAuth);
    await pollUntil(() => account?.login().ownerHome === undefined, "the owner's sign-out read");
    expect(counts.info).toBe(2);
    await writeFile(ownerAuth, "{}", { mode: 0o000 });
    await pollUntil(() => account?.login().ownerHome === true, "the owner's sign-in read");
    expect(counts.info).toBe(3);
    expect((await stub.calls()).length).toBe(2);
    // Séance's own sign-in drops it, and nothing looks at the owner's home again while signed in.
    await stub.scenario(SIGNED_IN);
    await writeFile(join(home, "auth.json"), "{}");
    await pollUntil(() => account?.login().authOk === true, "the sign-in read");
    expect(account?.login()).not.toHaveProperty("ownerHome");
    account?.stop();
  });

  test("expired keeps the identity and drops the reading; a failed probe keeps everything", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_IN);
    await start(home, 60_000);
    const quota = account?.view().quota;
    expect(quota).not.toBeNull();
    await stub.scenario({ ...SIGNED_IN, version: "0.166.0" });
    await writeFile(join(home, "auth.json"), "{}");
    await pollUntil(() => account?.view().health === "unknown", "the outdated read");
    expect(account?.view()).toEqual({ health: "unknown", quota: quota ?? null, blocked: false });
    expect(account?.login().version).toBe("0.166.0");
    expect(account?.login().accountId).toBe("codex:acct-1:user-1");
    await stub.scenario(EXPIRED);
    await writeFile(join(home, "auth.json"), "{ }");
    await pollUntil(() => account?.view().health === "expired", "the expired read");
    expect(account?.view()).toEqual({ health: "expired", quota: null, blocked: false });
    expect(account?.login()).toMatchObject({ accountId: "codex:acct-1:user-1", authOk: true });
    account?.stop();
  });

  test("a running session's own reading refreshes the quota for the same account only, never a health", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_IN);
    const counts = await start(home);
    const moved = {
      ...RATE_LIMITS,
      ordinaryUsageAllowed: false,
      rateLimits: { ...RATE_LIMITS.rateLimits, primary: { ...RATE_LIMITS.rateLimits.primary, usedPercent: 57 } },
    };
    // Another account's reading, or garbage, is dropped whole.
    account?.observe({ ...moved, accountId: "acct-2" });
    account?.observe({ ...moved, rateLimits: "nope" });
    account?.observe(null);
    expect(account?.view().quota?.h).toBe(3);
    account?.observe(moved);
    expect(account?.view()).toMatchObject({ health: "ok", blocked: true, quota: { h: 57, d: 41 } });
    expect(counts.status).toBe(2);
    // Fresh again: the reading counts as the probe's, so none runs.
    await Bun.sleep(200);
    expect((await stub.calls()).length).toBe(2);
    account?.stop();
  });

  test("a signed-out login takes no session's reading", async () => {
    const home = await freshHome();
    await stub.scenario(SIGNED_OUT);
    await start(home);
    account?.observe(RATE_LIMITS);
    expect(account?.view()).toEqual({ health: "signed_out", quota: null, blocked: false });
    account?.stop();
  });
});

describe("codexRunnable: when this machine advertises CAPABILITIES.codex", () => {
  const login = { agent: "codex", accountId: "codex:a:u", authOk: true, version: "0.170.0" } as const;
  test("signed in, identified and at the floor", () => {
    expect(codexRunnable(login)).toBe(true);
    expect(codexRunnable({ ...login, version: "0.171.2" })).toBe(true);
  });
  test("signed out, unidentified, below the floor or of no known version", () => {
    expect(codexRunnable({ ...login, authOk: false })).toBe(false);
    expect(codexRunnable({ ...login, accountId: null })).toBe(false);
    expect(codexRunnable({ ...login, version: "0.166.0" })).toBe(false);
    expect(codexRunnable({ agent: "codex", accountId: "codex:a:u", authOk: true })).toBe(false);
  });
});

describe("the daemon", () => {
  const PSK = Buffer.alloc(32, 9).toString("base64");
  const TOKEN = "codex-login-token";
  let fixture: Awaited<ReturnType<typeof makeGitFixture>>;
  let privateTmux: ReturnType<typeof usePrivateTmux>;
  let state: string;

  beforeAll(async () => {
    state = join(base, "daemon-state");
    process.env["SEANCE_STATE_DIR"] = state;
    privateTmux = usePrivateTmux(base, "codex-login");
    fixture = await makeGitFixture(base);
  });

  afterAll(async () => {
    await privateTmux.dispose();
    delete process.env["SEANCE_STATE_DIR"];
  });

  async function withDaemon(
    opts: { readonly block: boolean; readonly codex: boolean },
    body: (next: { info: () => Promise<MachineInfo>; status: () => Promise<MachineStatus> }) => Promise<void>,
  ): Promise<void> {
    const appKey = await importPsk(PSK);
    const home = await mkdtemp(join(base, "daemon-home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude.json"), "{}");
    const relay = startTestRelay(TOKEN);
    const config: Config = {
      name: "CodexBox",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [fixture.root],
      tmuxSession: "main",
      ...(opts.block
        ? { codex: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" } }
        : {}),
    };
    let daemon: { stop(): Promise<void> | void } | undefined;
    try {
      daemon = await startDaemon({
        config,
        backend: createBackend(config, { home }),
        home,
        pingIntervalMs: 60_000,
        pongTimeoutMs: 1_000,
        baseBackoffMs: 20,
        telemetryIntervalMs: 100,
        ...(opts.codex ? { codex: { bin: stub.path, checkIntervalMs: 50 } } : {}),
      });
      await body({
        info: async () => {
          const frame = await relay.registers.next(5_000);
          const info = parseMachineInfo((await openSealed(appKey, frame.info)).payload);
          if (info === null) throw new Error("unparseable register blob");
          return info;
        },
        status: async () => {
          const status = parseMachineStatus((await openSealed(appKey, await relay.statuses.next(5_000))).payload);
          if (status === null) throw new Error("unparseable status");
          return status;
        },
      });
    } finally {
      await daemon?.stop();
      relay.stop();
    }
  }

  test("with a codex block its blob carries the login, re-registered once read, and its status the quota", async () => {
    await stub.scenario(SIGNED_IN);
    await withDaemon({ block: true, codex: true }, async (next) => {
      let info = await next.info();
      while (info.logins?.[0]?.accountId !== "codex:acct-1:user-1") {
        // oxlint-disable-next-line no-await-in-loop -- registers arrive in order
        info = await next.info();
      }
      expect(info.logins).toEqual([
        {
          agent: "codex",
          accountId: "codex:acct-1:user-1",
          email: "a@example.com",
          plan: "team",
          workspace: "Acme",
          authOk: true,
          credits: true,
          version: "0.170.0",
        },
      ]);
      // Signed in, identified and at the floor: the scheduler may route it a Codex task.
      expect(info.capabilities).toContain("codex");
      let status = await next.status();
      const deadline = Date.now() + 10_000;
      while (status.lq === undefined || status.scan !== info.scannedAt) {
        if (Date.now() > deadline) throw new Error(`no lq in the status; last ${JSON.stringify(status)}`);
        // oxlint-disable-next-line no-await-in-loop -- statuses arrive in order
        status = await next.status();
      }
      expect(status.lq).toEqual([
        { x: 0, s: "cache", at: expect.any(Number), h: 3, hr: 1_760_010_000, d: 41, dr: 1_760_500_000, c: 0 },
      ]);
      expect(status).not.toHaveProperty("lu");
      const toml = await readFile(join(state, "codex", "home", "config.toml"), "utf8");
      expect(toml).toContain('cli_auth_credentials_store = "file"');
    });
  });

  test("without the block, or without the option, logins is empty and no codex runs", async () => {
    for (const opts of [
      { block: false, codex: true },
      { block: true, codex: false },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one daemon at a time
      await withDaemon(opts, async (next) => {
        const info = await next.info();
        expect(info.logins).toEqual([]);
        expect(info.capabilities).not.toContain("codex");
        const status = await next.status();
        for (const key of ["lq", "lx", "lu", "lb"]) expect(status).not.toHaveProperty(key);
      });
    }
    expect(await stub.calls()).toEqual([]);
  });
});

describe("seance codex", () => {
  const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  let root: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(base, "cli-"));
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "config.json"), configSkeleton("box"), { mode: 0o600 });
    env = {
      ...process.env,
      SEANCE_STATE_DIR: join(root, "state"),
      SEANCE_CONFIG_DIR: join(root, "config"),
      SEANCE_CODEX_BIN: stub.path,
      // The verbs' `homedir()`: never the developer's own `~/.codex`.
      HOME: root,
    };
  });

  const run = async (...args: string[]): Promise<{ out: string; err: string; code: number }> => {
    const proc = Bun.spawn([process.execPath, mainPath, "codex", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { out, err, code };
  };
  const auditLines = async (): Promise<readonly string[]> =>
    (await readFile(join(root, "state", "seanced.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.includes("audit codex"))
      .map((line) => line.slice(line.indexOf("audit codex")));
  const pairRunDirs = async (): Promise<readonly string[]> =>
    (await readdir("/tmp")).filter((name) => name.startsWith("seance-cxp-"));
  const withBlock = async (): Promise<void> => {
    const file = join(root, "config", "config.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), codex: {} }));
  };

  test("every verb refuses without a codex block, audited, and runs no codex", async () => {
    for (const verb of ["login", "logout", "status", "pair", "unpair"]) {
      // oxlint-disable-next-line no-await-in-loop -- one CLI at a time
      const { err, code } = await run(verb);
      expect(code).toBe(1);
      expect(err).toContain("no `codex` block");
    }
    expect(await auditLines()).toEqual([
      "audit codex origin=cli op=login outcome=no_config",
      "audit codex origin=cli op=logout outcome=no_config",
      "audit codex origin=cli op=status outcome=no_config",
      "audit codex origin=cli op=pair outcome=no_config",
      "audit codex origin=cli op=unpair outcome=no_config",
    ]);
    expect(await stub.calls()).toEqual([]);
  });

  test("login hands the terminal to codex's device-auth in séance's home, after writing its config", async () => {
    await withBlock();
    await stub.scenario({ loginExit: 0 });
    const { out, code } = await run("login");
    expect(code).toBe(0);
    expect(out).toContain("stub login");
    const home = join(root, "state", "codex", "home");
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
    const calls = await stub.calls();
    expect(calls.map((call) => call.argv)).toEqual([["--version"], ["login", "--device-auth"]]);
    expect(calls.every((call) => call.codexHome === home)).toBe(true);
    await stub.scenario({ loginExit: 1 });
    expect((await run("logout")).code).toBe(1);
    expect(await auditLines()).toEqual([
      "audit codex origin=cli op=login outcome=ok",
      "audit codex origin=cli op=logout outcome=failed",
    ]);
  });

  test("status probes the home and prints its health; the audit line carries the health alone", async () => {
    await withBlock();
    expect((await run("status")).code).toBe(1);
    await prepareCodexHome(join(root, "state"), null);
    await stub.scenario(SIGNED_IN);
    const { out, code } = await run("status");
    expect(code).toBe(0);
    expect(out).toContain("signed in");
    expect(out).toContain("codex:acct-1:user-1");
    expect(out).toContain("5h 3% · 7d 41%");
    await stub.scenario(SIGNED_OUT);
    expect((await run("status")).out).toContain("login     signed out (`seance codex login`)");
    // A plain `codex login` in the owner's own home, never Séance's: named, so the verb's need is plain.
    await mkdir(join(root, ".codex"));
    await writeFile(join(root, ".codex", "auth.json"), "{}", { mode: 0o000 });
    expect((await run("status")).out).toContain(
      "login     signed out: signed in to codex, not to Séance's home (`seance codex login`)",
    );
    const lines = await auditLines();
    expect(lines).toEqual([
      "audit codex origin=cli op=status outcome=no_home",
      "audit codex origin=cli op=status outcome=ok",
      "audit codex origin=cli op=status outcome=signed_out",
      "audit codex origin=cli op=status outcome=signed_out",
    ]);
    for (const line of lines) expect(line).not.toContain("example.com");
  });

  test("pair prints only the code, notes every client on a --listen server of its own, and unpair revokes them all", async () => {
    await withBlock();
    await prepareCodexHome(join(root, "state"), null);
    await stub.scenario({ remote: { clients: ["cli_old"] } });
    const before = new Set(await pairRunDirs());
    const paired = await run("pair");
    expect(paired.code).toBe(0);
    expect(paired.out).toContain("pairing code  STUB-CODE");
    expect(paired.out).toContain("paired");
    for (const id of ["env_stub", "cli_old", "cli_new", "1234567890"])
      expect(paired.out + paired.err).not.toContain(id);
    const note = join(root, "state", "codex", "remote.json");
    expect(await readRemote(note)).toMatchObject({ environmentId: "env_stub", clients: ["cli_old", "cli_new"] });
    expect((await stat(note)).mode & 0o777).toBe(0o600);
    const calls = await stub.calls();
    expect(calls.at(-1)?.argv.slice(0, 2)).toEqual(["app-server", "--listen"]);
    expect(calls.at(-1)?.codexHome).toBe(join(root, "state", "codex", "home"));
    const rpc = await stub.rpc();
    expect(rpc.map((call) => call.method)).toEqual([
      "initialize",
      "remoteControl/enable",
      "remoteControl/pairing/start",
      "remoteControl/pairing/status",
      "remoteControl/client/list",
      "remoteControl/disable",
    ]);
    expect(rpc[1]?.params).toEqual({ ephemeral: true });
    // The verb's server and run dir went with it.
    expect((await pairRunDirs()).filter((dir) => !before.has(dir))).toEqual([]);

    const unpaired = await run("unpair");
    expect(unpaired.code).toBe(0);
    expect(unpaired.out).toContain("2 phones revoked");
    expect(await readRemote(note)).toBeNull();
    const revoked = (await stub.rpc()).filter((call) => call.method === "remoteControl/client/revoke");
    expect(revoked.map((call) => call.params)).toEqual([
      { environmentId: "env_stub", clientId: "cli_old" },
      { environmentId: "env_stub", clientId: "cli_new" },
    ]);
    expect((await run("unpair")).out).toContain("no phone was paired");
    expect(await auditLines()).toEqual([
      "audit codex origin=cli op=pair outcome=ok",
      "audit codex origin=cli op=unpair outcome=ok",
      "audit codex origin=cli op=unpair outcome=not_paired",
    ]);
  });

  test("a server that will not enable remote control fails pair, audited, and leaves no note", async () => {
    await withBlock();
    await prepareCodexHome(join(root, "state"), null);
    await stub.scenario({ remote: { refuse: true } });
    const { err, code } = await run("pair");
    expect(code).toBe(1);
    expect(err).toContain("remote control did not come up");
    expect(await readRemote(join(root, "state", "codex", "remote.json"))).toBeNull();
    expect(await auditLines()).toEqual(["audit codex origin=cli op=pair outcome=failed"]);
  });
});
