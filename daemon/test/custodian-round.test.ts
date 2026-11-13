import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, importPsk, open as openSealed, parseMachineInfo, toBase64 } from "@seance/shared";
import { custodianAudit } from "../src/audit.ts";
import { createBackend } from "../src/backend-default.ts";
import { DespawnFailure } from "../src/backend.ts";
import { CUSTODIAN_DEFAULTS, type Config } from "../src/config.ts";
import { loadAgent } from "../src/custodian-agent.ts";
import { ensureRoundDir, launchRound, listRoundPanes, removeRoundTmp, ROUND_TMP } from "../src/custodian-launch.ts";
import { ROUND_SEED } from "../src/custodian-agent.ts";
import {
  createCustodianSeat,
  custodianPlatform,
  type CloseOutcome,
  type CustodianSeat,
  type SeatRecord,
} from "../src/custodian-seat.ts";
import { despawnRound, despawnSession } from "../src/despawn.ts";
import type { Exclave } from "../src/exclaves.ts";
import type { TrackedActivity } from "../src/pane-activity.ts";
import { startDaemon } from "../src/run.ts";
import { listPanePids } from "../src/session-events.ts";
import { listClaudeSessions, listPanes, paneInfo } from "../src/sessions.ts";
import { resolveTargetSession, tmuxOk } from "../src/tmux.ts";
import { makeClaudeStub, pollUntil, usePrivateTmux, type ClaudeStub, type PrivateTmux } from "./fixtures.ts";
import { startTestRelay } from "./harness.ts";

const platform = custodianPlatform(process.platform) ?? "linux";
const MIN = 60_000;
const EVERY = CUSTODIAN_DEFAULTS.everyMinutes * MIN;
const TIMEOUT = CUSTODIAN_DEFAULTS.roundTimeoutMinutes * MIN;

let base = "";
let privateTmux: PrivateTmux | undefined;
let stub: ClaudeStub;
let session = "";
let roundDir = "";
let agents = "";
let savedClaudeBin: string | undefined;

const exclave = (): Exclave => ({
  id: "default",
  root: base,
  configDir: join(base, ".claude"),
  configFile: join(base, ".claude.json"),
});

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-cust-"));
  process.env["SEANCE_STATE_DIR"] = join(base, "state");
  privateTmux = usePrivateTmux(base, "cust");
  stub = await makeClaudeStub(base);
  session = await resolveTargetSession("main");
  roundDir = await ensureRoundDir(join(base, "round"));
  agents = await loadAgent();
  savedClaudeBin = process.env["SEANCE_CLAUDE_BIN"];
});

afterAll(async () => {
  for (const { pane } of await listRoundPanes()) await tmuxOk(["kill-pane", "-t", pane]).catch(() => "");
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  if (savedClaudeBin === undefined) delete process.env["SEANCE_CLAUDE_BIN"];
  else process.env["SEANCE_CLAUDE_BIN"] = savedClaudeBin;
  await rm(base, { recursive: true, force: true });
});

interface Rig {
  readonly seat: CustodianSeat;
  readonly clock: { now: number };
  readonly audit: string[];
  readonly saved: { record: SeatRecord };
}

/**
 * A seat over the real launch and the real close, with a clock the test moves and a tick it calls: the deadline is
 * crossed by moving the clock, never by waiting for one.
 */
function seatOver(record: SeatRecord = {}, given?: { now: number }): Rig {
  const clock = given ?? { now: Date.now() };
  const audit: string[] = [];
  const saved = { record };
  const tracked = (): readonly TrackedActivity[] => [
    {
      pane: "%1",
      state: "idle",
      stateSince: clock.now - EVERY,
      turnEnded: true,
      screenSince: clock.now - EVERY,
      sampledAt: clock.now,
    },
  ];
  const sink = custodianAudit((line) => {
    audit.push(line.replace(/ pane=%\d+/u, " pane=%N").replace(/ exclave="?default"?/u, " exclave=default"));
    return Promise.resolve();
  });
  const seat = createCustodianSeat({
    settings: CUSTODIAN_DEFAULTS,
    now: () => clock.now,
    checkIntervalMs: 3_600_000,
    activity: tracked,
    untouchable: () => false,
    draining: () => false,
    stopped: () => false,
    record: () => saved.record,
    save: (next) => {
      saved.record = next;
      return Promise.resolve();
    },
    pick: () => Promise.resolve({ exclave: exclave() }),
    launch: (picked, onTmp) =>
      launchRound({
        exclave: picked,
        roundDir,
        settings: CUSTODIAN_DEFAULTS,
        agents,
        notes: null,
        tmuxSession: "main",
        weakerNested: false,
        platform,
        onTmp,
      }),
    listRounds: listRoundPanes,
    paneAlive: async (pane) => {
      const found = (await listRoundPanes()).find((entry) => entry.pane === pane);
      if (found === undefined) return "gone";
      return found.dead ? "dead" : "live";
    },
    close: async (pane): Promise<CloseOutcome> => {
      try {
        return (await despawnRound(pane, { graceMs: 1_000 })).outcome;
      } catch (err) {
        if (err instanceof DespawnFailure && err.code === "session_not_found") return "gone";
        throw err;
      }
    },
    removeTmp: removeRoundTmp,
    audit: sink,
    warn: () => {},
  });
  return { seat, clock, audit, saved };
}

async function tmpExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function onlyRound(): Promise<string> {
  let found = "";
  await pollUntil(async () => {
    const rounds = await listRoundPanes();
    found = rounds[0]?.pane ?? "";
    return rounds.length === 1;
  }, "one round pane");
  return found;
}

async function noRounds(): Promise<void> {
  await pollUntil(async () => (await listRoundPanes()).length === 0, "no round pane");
}

describe("a round, with the stubs for claude", () => {
  test("ok: launched as the plan says, invisible to every pane reader, closed at its deadline", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    await rm(stub.argvFile, { force: true });
    await rm(stub.stdinFile, { force: true });
    const r = seatOver();
    await r.seat.start();
    await r.seat.tick();
    const pane = await onlyRound();
    const tmpDir = r.saved.record.round?.tmpDir ?? "";
    expect(r.saved.record.round).toMatchObject({ pane, exclave: "default" });
    expect(tmpDir).toMatch(ROUND_TMP);

    const argv = await stub.argv();
    const at = (flag: string): number => argv.indexOf(flag);
    expect(argv.slice(at("-n"), at("-n") + 3)).toEqual(["-n", "custodian", "--remote-control"]);
    expect(JSON.parse(argv[at("--agents") + 1] ?? "")).toHaveProperty("custodian");
    expect(argv.slice(at("--agent"), at("--agent") + 2)).toEqual(["--agent", "custodian"]);
    const fencePath = argv[at("--settings") + 1] ?? "";
    expect(fencePath.startsWith("/tmp/seance-cu-")).toBe(true);
    const fence: { sandbox: { filesystem: { denyWrite: string[] } } } = JSON.parse(await readFile(fencePath, "utf8"));
    expect(fence.sandbox.filesystem.denyWrite).toEqual([roundDir]);
    for (const pair of [
      ["--setting-sources", "project"],
      ["--permission-mode", "dontAsk"],
      ["--model", "haiku"],
      ["--effort", "low"],
    ]) {
      expect(argv.slice(at(pair[0] ?? ""), at(pair[0] ?? "") + 2)).toEqual(pair);
    }
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.at(-1)).toBe("--");
    expect((await stub.stdin()).startsWith(ROUND_SEED)).toBe(true);

    expect((await tmuxOk(["display-message", "-p", "-t", pane, "#{window_name}"])).trim()).toBe("custodian");
    expect((await tmuxOk(["show-options", "-p", "-t", pane, "-v", "@seance-custodian"])).trim()).toBe("1");

    // An untitled pane is absent from every reader anyway, so wait for the title before the C10 assertions mean anything.
    await pollUntil(async () => (await paneInfo(pane))?.titled === true, "the round's pane to be titled");
    expect(await paneInfo(pane)).toMatchObject({ custodian: true });
    expect((await listPanes()).map((p) => p.paneId)).not.toContain(pane);
    expect((await listPanePids()).map((p) => p.id)).not.toContain(pane);
    expect((await listClaudeSessions([])).map((s) => s.id)).not.toContain(pane);
    const refusal = await despawnSession(pane, { force: true }).catch((err: unknown) => err);
    if (!(refusal instanceof DespawnFailure)) throw new Error(`despawnSession did not refuse: ${String(refusal)}`);
    expect(refusal.code).toBe("session_not_found");

    // The control: the same titled stub in a window without the option is listed, and despawnable.
    const control = (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `${session}:`,
        "-c",
        base,
        `exec ${stub.ok} --remote-control`,
      ])
    ).trim();
    await tmuxOk(["set-option", "-p", "-t", control, "@seance-task", "ctl-1"]).catch(() => "");
    await pollUntil(async () => (await paneInfo(control))?.titled === true, "the control pane to be titled");
    expect((await listPanes()).map((p) => p.paneId)).toContain(control);
    expect((await listPanePids()).map((p) => p.id)).toContain(control);
    await despawnSession(control, { force: true });
    await pollUntil(async () => (await paneInfo(control)) === null, "the control pane to close");

    // The deadline: the graceful close, the tmp dir gone, and one start, one kill, one end.
    r.clock.now += TIMEOUT;
    await r.seat.tick();
    await noRounds();
    expect(await tmpExists(tmpDir)).toBe(false);
    expect(r.audit).toEqual([
      "audit custodian origin=custodian op=start exclave=default pane=%N outcome=started",
      "audit custodian origin=custodian op=kill pane=%N reason=deadline outcome=exited",
      "audit custodian origin=custodian op=end pane=%N outcome=failed reason=deadline",
    ]);
    expect(r.saved.record).toEqual({ lastEndedAt: r.clock.now });
    r.seat.stop();
  });

  test("stuck: a claude that never reaches its TUI is killed at the deadline", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.stuck;
    const r = seatOver();
    await r.seat.start();
    await r.seat.tick();
    const pane = await onlyRound();
    expect((await paneInfo(pane))?.titled).toBe(false);
    r.clock.now += TIMEOUT;
    await r.seat.tick();
    await noRounds();
    expect(r.audit[1]).toBe("audit custodian origin=custodian op=kill pane=%N reason=deadline outcome=killed");
    expect(r.audit[2]).toContain("op=end");
    expect(await tmpExists(r.saved.record.round?.tmpDir ?? "/nonexistent")).toBe(false);
    r.seat.stop();
  });

  test("failing: a claude that exits on its own ends as exited, with no kill line, and its tmp is removed", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.failing;
    const r = seatOver();
    await r.seat.start();
    await r.seat.tick();
    const tmpDir = r.saved.record.round?.tmpDir ?? "";
    expect(tmpDir).toMatch(ROUND_TMP);
    await noRounds();
    r.clock.now += MIN;
    await r.seat.tick();
    expect(r.audit).toEqual([
      "audit custodian origin=custodian op=start exclave=default pane=%N outcome=started",
      "audit custodian origin=custodian op=end pane=%N outcome=failed reason=exited",
    ]);
    expect(await tmpExists(tmpDir)).toBe(false);
    expect(r.saved.record).toEqual({ lastEndedAt: r.clock.now });
    r.seat.stop();
  });

  test("adoption: a second seat adopts the running round, kills a stray, and closes the round at its original deadline", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    const clock = { now: Date.now() };
    const a = seatOver({}, clock);
    await a.seat.start();
    await a.seat.tick();
    const round = await onlyRound();
    a.seat.stop();

    const stray = (
      await tmuxOk(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-c", base, "exec sleep 600"])
    ).trim();
    await tmuxOk(["set-option", "-p", "-t", stray, "@seance-custodian", "1"]);

    const b = seatOver(a.saved.record, clock);
    await b.seat.start();
    await pollUntil(async () => (await paneInfo(stray)) === null, "the stray round pane to close");
    expect((await listRoundPanes()).map((p) => p.pane)).toEqual([round]);
    // B launched nothing: only the stray's kill is audited, and the recorded round is kept.
    expect(b.audit).toEqual(["audit custodian origin=custodian op=kill pane=%N reason=stray outcome=killed"]);
    await b.seat.tick();
    expect((await listRoundPanes()).map((p) => p.pane)).toEqual([round]);

    clock.now += TIMEOUT;
    await b.seat.tick();
    await noRounds();
    expect(b.audit.at(-1)).toContain("op=end");
    expect(b.audit.some((line) => line.includes("reason=deadline"))).toBe(true);
    expect(await tmpExists(a.saved.record.round?.tmpDir ?? "/nonexistent")).toBe(false);
    b.seat.stop();
  });
});

describe("the capability bit", () => {
  const PSK = toBase64(new Uint8Array(32).fill(9));
  const TOKEN = "test-bearer";

  async function advertised(
    custodian: Config["custodian"],
    opts: { readonly live: boolean },
  ): Promise<readonly string[]> {
    const home = await mkdtemp(join(base, "cap-home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { organizationUuid: "o", accountUuid: "a" } }),
    );
    const relay = startTestRelay(TOKEN);
    const config: Config = {
      name: "CustMac",
      relayUrl: relay.url,
      bearerToken: TOKEN,
      psk: PSK,
      repoRoots: [],
      tmuxSession: "main",
      ...(custodian === undefined ? {} : { custodian }),
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
        telemetryIntervalMs: 100_000,
        // A seat that starts must find nothing to do and nothing to launch: the sandbox check fails it first.
        custodian: {
          live: opts.live,
          checkIntervalMs: 3_600_000,
          sandboxProblem: () => Promise.resolve("test: no sandbox"),
        },
      });
      const frame = await relay.registers.next(5_000);
      const info = parseMachineInfo((await openSealed(await importPsk(PSK), frame.info)).payload);
      return info?.capabilities ?? [];
    } finally {
      daemon?.stop();
      relay.stop();
    }
  }

  test("a daemon with the key and a live seat advertises custodian", async () => {
    expect(await advertised(CUSTODIAN_DEFAULTS, { live: true })).toContain(CAPABILITIES.custodian);
  });

  test("without the key it does not", async () => {
    expect(await advertised(undefined, { live: true })).not.toContain(CAPABILITIES.custodian);
  });

  test("rounds are held in production: the key alone advertises nothing", async () => {
    expect(await advertised(CUSTODIAN_DEFAULTS, { live: false })).not.toContain(CAPABILITIES.custodian);
  });
});
