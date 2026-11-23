import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_ID, CAPABILITIES, importPsk, open as openSealed, parseMachineInfo, seal, toBase64 } from "@seance/shared";
import { custodianAudit } from "../src/audit.ts";
import { createBackend } from "../src/backend-default.ts";
import { DespawnFailure } from "../src/backend.ts";
import { CUSTODIAN_DEFAULTS, type Config } from "../src/config.ts";
import { loadAgent } from "../src/custodian-agent.ts";
import {
  ensureRoundDir,
  launchRound,
  listRoundPanePids,
  listRoundPanes,
  removeRoundTmp,
} from "../src/custodian-launch.ts";
import type { PrView } from "../src/custodian-frame.ts";
import { vsockFilter } from "../src/custodian-seccomp.ts";
import { CUSTODIAN_SOCKET_NAME, startCustodianSocket } from "../src/custodian-socket.ts";
import { createCustodianFlags } from "../src/custodian-flags.ts";
import { createCustodianVerbs } from "../src/custodian-verbs.ts";
import { createWorktreeRule } from "../src/custodian-worktree.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { exchange } from "../src/local-client.ts";
import { custodianNotesPath, socketPath, stateDir } from "../src/paths.ts";
import { shq } from "../src/shq.ts";
import { scanRepos } from "../src/scan.ts";
import { ROUND_SEED } from "../src/custodian-agent.ts";
import type { RoundEntry } from "../src/custodian-rounds.ts";
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
import { CUSTODIAN_SOCKET_DIR_PREFIX, ROUND_TMP } from "../src/seat-record.ts";
import { custodianSeatOf, loadOrInitState, readState, saveState } from "../src/state.ts";
import { EndedTasks, listPanePids } from "../src/session-events.ts";
import { listClaudeSessions, listPanes, paneInfo } from "../src/sessions.ts";
import { capturePane, resolveTargetSession, tmux, tmuxOk } from "../src/tmux.ts";
import {
  captureLog,
  makeClaudeStub,
  makeGitFixture,
  pollUntil,
  scriptStub,
  usePrivateTmux,
  type ClaudeStub,
  type GitFixture,
  type PrivateTmux,
} from "./fixtures.ts";
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
/** The round socket the seats built here without a daemon serve: a daemon chooses and records its own. */
let testSocket = "";

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
  testSocket = join(await mkdtemp(CUSTODIAN_SOCKET_DIR_PREFIX), CUSTODIAN_SOCKET_NAME);
});

afterAll(async () => {
  for (const { pane } of await listRoundPanes()) await tmuxOk(["kill-pane", "-t", pane]).catch(() => "");
  await privateTmux?.dispose();
  delete process.env["SEANCE_STATE_DIR"];
  if (savedClaudeBin === undefined) delete process.env["SEANCE_CLAUDE_BIN"];
  else process.env["SEANCE_CLAUDE_BIN"] = savedClaudeBin;
  await rm(base, { recursive: true, force: true });
  await rm(dirname(testSocket), { recursive: true, force: true });
});

/**
 * What the seats built here said, warnings and audit lines unredacted: the rig would otherwise drop why a round never
 * launched, and a round-pane wait that times out prints it (`roundPanesNow`). Cleared after each test.
 */
const seatLines: string[] = [];

/** Round sockets a test started: closed after it, so a failed assertion cannot leave the path held for the next one. */
const sockets: { readonly stop: () => void }[] = [];
afterEach(() => {
  seatLines.length = 0;
  for (const each of sockets.splice(0)) each.stop();
});

async function roundSocket(
  handle: Parameters<typeof startCustodianSocket>[0]["handle"],
): Promise<{ readonly stop: () => void }> {
  const started = await startCustodianSocket({ path: testSocket, handle, warn: () => {} });
  if ("problem" in started) throw new Error(`round socket did not start: ${started.problem}`);
  sockets.push(started);
  return started;
}

interface Rig {
  readonly seat: CustodianSeat;
  readonly clock: { now: number };
  readonly audit: string[];
  readonly rounds: RoundEntry[];
  readonly saved: { record: SeatRecord };
}

/**
 * A seat over the real launch and the real close, with a clock the test moves and a tick it calls: the deadline is
 * crossed by moving the clock, never by waiting for one.
 */
function seatOver(record: SeatRecord = {}, given?: { now: number }, weakerNested = false): Rig {
  const clock = given ?? { now: Date.now() };
  const audit: string[] = [];
  const rounds: RoundEntry[] = [];
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
    seatLines.push(line);
    audit.push(line.replace(/ pane=%\d+/u, " pane=%N").replace(/ exclave="?default"?/u, " exclave=default"));
    return Promise.resolve();
  });
  const seat = createCustodianSeat({
    settings: CUSTODIAN_DEFAULTS,
    now: () => clock.now,
    checkIntervalMs: 3_600_000,
    activity: tracked,
    untouchable: () => false,
    // The round log's own rule (`upsertRound`): by start, never over a healthy line.
    appendRound: (entry) => {
      const at = rounds.findIndex((round) => round.start === entry.start);
      if (at < 0) rounds.push(entry);
      else if (rounds[at]?.outcome !== "healthy") rounds[at] = entry;
      return Promise.resolve();
    },
    readRounds: () => Promise.resolve([...rounds]),
    readControl: () => Promise.resolve({ pause: null, unreadable: false }),
    peekRoundRequest: () => Promise.resolve("none"),
    dropRoundRequest: () => Promise.resolve(),
    remoteId: () => Promise.resolve(null),
    publishView: () => Promise.resolve(),
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
        weakerNested,
        platform,
        custodianSocket: testSocket,
        rootMasks: [],
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
    warn: (line) => void seatLines.push(line),
  });
  return { seat, clock, audit, saved, rounds };
}

async function tmpExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The round panes tmux holds now, and what the seats said: a round-pane wait's explanation when it times out. */
async function roundPanesNow(): Promise<string> {
  return [`round panes: ${JSON.stringify(await listRoundPanes())}`, ...seatLines].join("\n");
}

async function onlyRound(): Promise<string> {
  let found = "";
  await pollUntil(
    async () => {
      const rounds = await listRoundPanes();
      found = rounds[0]?.pane ?? "";
      return rounds.length === 1;
    },
    "one round pane",
    undefined,
    roundPanesNow,
  );
  return found;
}

async function noRounds(): Promise<void> {
  await pollUntil(async () => (await listRoundPanes()).length === 0, "no round pane", undefined, roundPanesNow);
}

describe("a round, with the stubs for claude", () => {
  test("ok: launched as the plan says, invisible to every pane reader, closed at its deadline", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    await rm(stub.argvFile, { force: true });
    await rm(stub.stdinFile, { force: true });
    await mkdir(stateDir(), { recursive: true });
    await roundSocket(() => Promise.resolve({ ok: false, code: "not_custodian" }));
    const r = seatOver();
    await r.seat.start();
    await r.seat.tick();
    const pane = await onlyRound();
    const tmpDir = r.saved.record.round?.tmpDir ?? "";
    expect(r.saved.record.round).toMatchObject({ pane, exclave: "default" });
    expect(tmpDir).toMatch(ROUND_TMP);

    const argv = await stub.argv();
    const at = (flag: string): number => argv.indexOf(flag);
    expect(argv.slice(at("-n"), at("-n") + 3)).toEqual(["-n", "custodian", "--agents"]);
    expect(argv).not.toContain("--remote-control");
    expect(JSON.parse(argv[at("--agents") + 1] ?? "")).toHaveProperty("custodian");
    expect(argv.slice(at("--agent"), at("--agent") + 2)).toEqual(["--agent", "custodian"]);
    const fencePath = argv[at("--settings") + 1] ?? "";
    expect(fencePath.startsWith("/tmp/seance-cu-")).toBe(true);
    const fence: {
      permissions: { allow: string[]; deny: string[] };
      sandbox: {
        filesystem: { denyWrite: string[]; denyRead: string[]; allowRead: string[] };
        network: { allowedDomains: string[]; allowUnixSockets?: string[]; allowAllUnixSockets?: boolean };
      };
    } = JSON.parse(await readFile(fencePath, "utf8"));
    expect(fence.sandbox.filesystem.denyWrite).toEqual([roundDir]);
    const socketDir = await realpath(dirname(testSocket));
    expect(fence.sandbox.filesystem.allowRead).toEqual(
      expect.arrayContaining([roundDir, await realpath(tmpDir), socketDir]),
    );
    // The state dir is masked, whether by its own entry or by a root that holds it (`/tmp`, `/Users`).
    const state = await realpath(stateDir());
    expect(fence.sandbox.filesystem.denyRead.some((path) => state === path || state.startsWith(`${path}/`))).toBe(true);
    if (platform === "darwin") {
      // The fence as written, not the paths computed for it: each mask and each re-allow is also there under the Data
      // volume's mount point, which `realpath` would have folded back into its short form.
      for (const mask of ["/Users", "/private/var/folders"]) {
        expect(fence.sandbox.filesystem.denyRead).toEqual(
          expect.arrayContaining([mask, `/System/Volumes/Data${mask}`]),
        );
      }
      expect(fence.sandbox.filesystem.allowRead).toContain(`/System/Volumes/Data${roundDir}`);
    }
    // The window runs a script in the round's own tmp dir, not a command string for the owner's `default-shell` to parse.
    expect((await stat(join(tmpDir, "run.sh"))).mode & 0o777).toBe(0o700);
    if (platform === "linux") {
      expect(await readFile(join(tmpDir, "run.sh"), "utf8")).toContain("\nexec bwrap --dev-bind / / --seccomp 3 -- ");
    }
    expect(fence.sandbox.network.allowedDomains).toEqual([]);
    if (platform === "darwin") expect(fence.sandbox.network.allowUnixSockets).toEqual([socketDir]);
    else expect(fence.sandbox.network.allowAllUnixSockets).toBe(true);
    expect(fence.permissions.allow).toEqual(["Bash(seance custodian *)"]);
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
    const listedBefore = (await listClaudeSessions([])).length;
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
    expect((await listClaudeSessions([])).map((s) => s.id)).toContain(control);
    expect((await listClaudeSessions([])).length).toBe(listedBefore + 1);
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

  test.skipIf(platform !== "linux")(
    "Linux's weaker nested mode runs the round under the same vsock filter as strict mode",
    async () => {
      process.env["SEANCE_CLAUDE_BIN"] = stub.stuck;
      const r = seatOver({}, undefined, true);
      await r.seat.start();
      await r.seat.tick();
      await onlyRound();
      const tmpDir = r.saved.record.round?.tmpDir ?? "";
      expect(tmpDir).toMatch(ROUND_TMP);
      const bpf = join(tmpDir, "seccomp.bpf");
      expect(await readFile(join(tmpDir, "run.sh"), "utf8")).toContain(
        `\nexec bwrap --dev-bind / / --seccomp 3 -- /usr/bin/env -i `,
      );
      expect((await stat(bpf)).mode & 0o777).toBe(0o600);
      const filter = vsockFilter(process.arch);
      expect(filter).not.toBeNull();
      expect((await readFile(bpf)).toString("base64")).toBe(Buffer.from(filter ?? []).toString("base64"));
      r.clock.now += TIMEOUT;
      await r.seat.tick();
      await noRounds();
      r.seat.stop();
    },
  );

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

  test("failing: a claude that exits on its own leaves a dead pane the seat closes, audited, and its tmp is removed", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.failing;
    // The developer's ~/.tmux.conf may set either way, and a pane that closes the moment its command exits would also
    // beat launchRound's own `set-option -p`: pin it, and put it back.
    await tmuxOk(["set-option", "-gw", "remain-on-exit", "on"]);
    try {
      const r = seatOver();
      await r.seat.start();
      await r.seat.tick();
      const tmpDir = r.saved.record.round?.tmpDir ?? "";
      expect(tmpDir).toMatch(ROUND_TMP);
      await pollUntil(async () => (await listRoundPanes()).some((entry) => entry.dead), "the failing round to exit");
      r.clock.now += MIN;
      await r.seat.tick();
      expect(r.audit).toEqual([
        "audit custodian origin=custodian op=start exclave=default pane=%N outcome=started",
        "audit custodian origin=custodian op=kill pane=%N reason=exited outcome=killed",
        // Gone inside the start window with no verb called: the shape of a sandbox that failed to start.
        "audit custodian origin=custodian op=end pane=%N outcome=failed reason=start_failed",
      ]);
      await noRounds();
      expect(await tmpExists(tmpDir)).toBe(false);
      expect(r.saved.record).toEqual({ lastEndedAt: r.clock.now });
      r.seat.stop();
    } finally {
      await tmuxOk(["set-option", "-gw", "remain-on-exit", "off"]);
    }
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

  async function advertised(custodian: Config["custodian"]): Promise<readonly string[]> {
    const booted = await boot(custodian, {
      // A seat that starts must find nothing to do and nothing to launch: the sandbox check fails it first.
      sandboxProblem: () => Promise.resolve("test: no sandbox"),
    });
    try {
      const frame = await booted.relay.registers.next(5_000);
      const info = parseMachineInfo((await openSealed(await importPsk(PSK), frame.info)).payload);
      return info?.capabilities ?? [];
    } finally {
      await booted.stop();
    }
  }

  async function boot(
    custodian: Config["custodian"],
    opts: { readonly sandboxProblem: () => Promise<string | null>; readonly drilled?: boolean },
  ): Promise<{ readonly relay: ReturnType<typeof startTestRelay>; readonly stop: () => Promise<void> }> {
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
    try {
      const daemon = await startDaemon({
        config,
        backend: createBackend(config, { home }),
        home,
        pingIntervalMs: 60_000,
        pongTimeoutMs: 1_000,
        baseBackoffMs: 20,
        telemetryIntervalMs: 100_000,
        statusFloorMs: 20,
        custodian: {
          checkIntervalMs: 3_600_000,
          sandboxProblem: opts.sandboxProblem,
          weakerNested: () => Promise.resolve(false),
          // A CI runner's strict-mode Linux was never drilled, so the seat would refuse it: say it was, except where
          // the test is about that refusal.
          sandboxDrilled: () => opts.drilled ?? true,
        },
      });
      return {
        relay,
        stop: async (): Promise<void> => {
          await daemon.stop();
          relay.stop();
        },
      };
    } catch (err) {
      relay.stop();
      throw err;
    }
  }

  /** A round pane a seat that is not running must find and close: tagged, in the private tmux, never a real claude. */
  async function strayRound(): Promise<string> {
    const pane = (
      await tmuxOk(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-c", base, "exec sleep 600"])
    ).trim();
    await tmuxOk(["set-option", "-p", "-t", pane, "@seance-custodian", "1"]);
    return pane;
  }

  for (const [label, custodian, problem, drilled] of [
    ["is off", undefined, null, true],
    ["is declined by the host's checks", CUSTODIAN_DEFAULTS, "test: no sandbox", true],
    ["is refused for a sandbox mode nobody drilled", CUSTODIAN_DEFAULTS, null, false],
  ] as const) {
    test(`a seat that ${label} closes a round the last process left, audited reason=off`, async () => {
      const stray = await strayRound();
      let booted: Awaited<ReturnType<typeof boot>> | undefined;
      const lines = await captureLog(async () => {
        booted = await boot(custodian, { sandboxProblem: () => Promise.resolve(problem), drilled });
        await pollUntil(async () => (await paneInfo(stray)) === null, "the stray round pane to close");
        await Bun.sleep(50);
      });
      await booted?.stop();
      const audit = lines.filter((line) => line.includes("audit custodian"));
      expect(audit.some((line) => line.includes("op=kill") && line.includes("reason=off"))).toBe(true);
      expect(audit.some((line) => line.includes("op=end") && line.includes("reason=lost"))).toBe(true);
      expect(audit.some((line) => line.includes("op=refused reason=sandbox_undrilled"))).toBe(!drilled);
    });
  }

  const sessions = { v: 1, kind: "custodian", verb: "sessions" };
  const askVerb = (path: string): Promise<unknown> =>
    exchange(sessions, {
      path,
      timeoutMs: 5_000,
      timeoutText: "the daemon did not answer the custodian frame",
      restartGraceMs: 0,
    }).catch(() => null);

  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );
  const seatRecordNow = async (): Promise<SeatRecord> => {
    const state = await readState();
    return state === null ? {} : custodianSeatOf(state);
  };
  const socketIn = (dir: string): string => join(dir, CUSTODIAN_SOCKET_NAME);

  test("a host whose seat cannot start records no round socket dir, and the main socket answers the verbs unsupported", async () => {
    const booted = await boot(CUSTODIAN_DEFAULTS, { sandboxProblem: () => Promise.resolve("test: no sandbox") });
    try {
      await pollUntil(async () => (await askVerb(socketPath())) !== null, "the daemon's local socket to answer");
      expect(await askVerb(socketPath())).toEqual({ ok: false, code: "unsupported" });
      // The seat's checks ran before a socket dir would have been chosen: give a wrongly recorded one time to appear.
      await Bun.sleep(100);
      expect((await seatRecordNow()).socketDir).toBeUndefined();
    } finally {
      await booted.stop();
    }
  });

  test("a started seat records its socket dir and listens there, refusing a caller that is no round; a restart serves the same dir, and a seat turned off removes it", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    let socketDir = "";
    try {
      const first = await boot(CUSTODIAN_DEFAULTS, { sandboxProblem: () => Promise.resolve(null) });
      try {
        await pollUntil(async () => {
          socketDir = (await seatRecordNow()).socketDir ?? "";
          return socketDir !== "" && (await askVerb(socketIn(socketDir))) !== null;
        }, "the round's socket to be recorded and answer");
        // Only a process under the running round's pane is the custodian; this test process is not.
        expect(await askVerb(socketIn(socketDir))).toEqual({ ok: false, code: "not_custodian" });
        expect(await askVerb(socketPath())).toEqual({ ok: false, code: "unsupported" });
      } finally {
        await first.stop();
      }
      // The socket goes with the seat; its dir stays, so an adopted round's environment still names a live path.
      expect(await exists(socketIn(socketDir))).toBe(false);
      expect(await exists(socketDir)).toBe(true);

      const second = await boot(CUSTODIAN_DEFAULTS, { sandboxProblem: () => Promise.resolve(null) });
      try {
        await pollUntil(
          async () => (await askVerb(socketIn(socketDir))) !== null,
          "the restarted seat to serve the recorded dir",
        );
        expect((await seatRecordNow()).socketDir).toBe(socketDir);
      } finally {
        await second.stop();
      }
    } finally {
      const off = await boot(undefined, { sandboxProblem: () => Promise.resolve(null) });
      try {
        await pollUntil(async () => !(await exists(socketDir)), "the seat turned off to remove its socket dir");
        await pollUntil(async () => (await seatRecordNow()).socketDir === undefined, "the record to drop the dir");
      } finally {
        await off.stop();
      }
    }
  });

  /**
   * Boots a seat over a record holding a round whose socket dir is `socketDir` (or none), and checks the round is
   * closed unreachable and lost, and the seat serves a fresh dir of its own.
   */
  async function expectRoundUnreachable(socketDir: string | undefined): Promise<void> {
    process.env["SEANCE_CLAUDE_BIN"] = stub.ok;
    const stray = await strayRound();
    const state = await loadOrInitState();
    const round = { pane: stray, startedAt: Date.now(), tmpDir: "/tmp/seance-cu-abc123", exclave: "default" };
    await saveState({ ...state, custodian: { round, ...(socketDir === undefined ? {} : { socketDir }) } });
    let booted: Awaited<ReturnType<typeof boot>> | undefined;
    try {
      const lines = await captureLog(async () => {
        booted = await boot(CUSTODIAN_DEFAULTS, { sandboxProblem: () => Promise.resolve(null) });
        await pollUntil(async () => (await paneInfo(stray)) === null, "the unreachable round pane to close");
        await pollUntil(async () => (await seatRecordNow()).round === undefined, "the round to end");
      });
      // Against every captured line, so a failure prints what the seat did instead (a refusal, another kill reason).
      expect(lines).toContainEqual(
        expect.stringMatching(new RegExp(`audit custodian .*op=kill pane=${stray} reason=unreachable `, "u")),
      );
      expect(lines).toContainEqual(
        expect.stringMatching(new RegExp(`audit custodian .*op=end pane=${stray} outcome=failed reason=lost$`, "u")),
      );
      const served = (await seatRecordNow()).socketDir;
      expect(served).toMatch(/^\/tmp\/seance-cu-s-/u);
      expect(served).not.toBe(socketDir);
    } finally {
      await booted?.stop();
      // A seat turned off removes the dir, so no test leaves one in /tmp.
      const off = await boot(undefined, { sandboxProblem: () => Promise.resolve(null) });
      try {
        await pollUntil(async () => (await seatRecordNow()).socketDir === undefined, "the record to drop the dir");
      } finally {
        await off.stop();
      }
    }
  }

  test("a round an older daemon left, its record naming no socket dir, is closed and lost, never adopted", async () => {
    await expectRoundUnreachable(undefined);
  });

  test("a round whose recorded socket dir is a planted link is closed and lost, and the link's target left alone", async () => {
    const target = await mkdtemp(join(base, "planted-"));
    const planted = `${CUSTODIAN_SOCKET_DIR_PREFIX}Plant1`;
    await rm(planted, { force: true });
    await symlink(target, planted);
    try {
      await expectRoundUnreachable(planted);
      expect((await lstat(planted)).isSymbolicLink()).toBe(true);
      expect(await exists(target)).toBe(true);
    } finally {
      await rm(planted, { force: true });
    }
  });

  test("a daemon with the key and a live seat advertises custodian", async () => {
    expect(await advertised(CUSTODIAN_DEFAULTS)).toContain(CAPABILITIES.custodian);
  });

  test("without the key it does not", async () => {
    expect(await advertised(undefined)).not.toContain(CAPABILITIES.custodian);
  });

  /** One app-sealed `custodian` request to a booted daemon, and what it answered. */
  async function ask(booted: Awaited<ReturnType<typeof boot>>, deviceId: string, payload: unknown): Promise<unknown> {
    const key = await importPsk(PSK);
    booted.relay.sendToDaemon(
      await seal(
        key,
        { to: deviceId, from: APP_ID },
        { id: crypto.randomUUID(), ts: Date.now(), op: "custodian", payload },
      ),
    );
    return (await openSealed(key, await booted.relay.messages.next(5_000))).payload;
  }

  test("the op is answered only where a seat runs, and a round meets the daemon's own view of it", async () => {
    // No custodian key: no seat, so no control: unsupported, and nothing written for a seat to read.
    const off = await boot(undefined, { sandboxProblem: () => Promise.resolve(null) });
    try {
      const frame = await off.relay.registers.next(5_000);
      expect(await ask(off, frame.deviceId, { act: "resume" })).toMatchObject({ ok: false, code: "unsupported" });
    } finally {
      await off.stop();
    }
    // A seat whose checks failed: host_failed from the daemon's memory, however long ago it failed (no seat.json read).
    const failed = await boot(CUSTODIAN_DEFAULTS, {
      sandboxProblem: () => Promise.resolve("test: no sandbox"),
    });
    try {
      const frame = await failed.relay.registers.next(5_000);
      expect(await ask(failed, frame.deviceId, { act: "pause" })).toMatchObject({ ok: true });
      let reply: unknown = null;
      await pollUntil(async () => {
        reply = await ask(failed, frame.deviceId, { act: "round" });
        return (reply as { code?: string }).code === "host_failed";
      }, "the failed seat to refuse a round as host_failed");
      expect(reply).toMatchObject({ ok: false, code: "host_failed" });
      // The pause shows behind `failing` (`p`), so the card can offer Resume: the status says so once the pause is read.
      const key = await importPsk(PSK);
      await pollUntil(async () => {
        const status = (await openSealed(key, await failed.relay.statuses.next(5_000))).payload as {
          cu?: { s?: string; p?: boolean };
        };
        return status.cu?.s === "failing" && status.cu.p === true;
      }, "a failing status carrying the pause");
      // The pause survives behind `failing`, so the card can offer Resume.
      expect(await ask(failed, frame.deviceId, { act: "resume" })).toEqual({ ok: true, pause: null });
    } finally {
      await failed.stop();
    }
  });
});

const ROUND_IDLE_SCRIPT = "exec sleep 600";

/**
 * The round's pane runs under `env -i`, so the script knows nothing of the test's env: every path is absolute, and the
 * panes it acts on arrive in `go`, one per line (A, B, then the round's own).
 */
const roundVerbsScript = (out: string): string => `
out=${shq(out)}
mkdir -p "$out"
command -v seance > "$out/which"
env > "$out/env.txt"
until [ -f "$out/go" ]; do sleep 0.1; done
{ read -r a; read -r b; read -r self; } < "$out/go"
run() { name=$1; shift; "$@" > "$out/$name.json" 2> "$out/$name.err"; echo $? > "$out/$name.rc"; }
run sessions seance custodian sessions
run captureA seance custodian capture "$a"
run captureSelf seance custodian capture "$self"
run prA seance custodian pr "$a"
run prB seance custodian pr "$b"
run closeA seance custodian close "$a"
run closeB seance custodian close "$b"
run closeSelf seance custodian close "$self"
run flagSelf seance custodian flag "$self" look
run interruptSelf seance custodian interrupt "$self"
printf 'carry on' | run nudgeSelf seance custodian nudge "$self"
printf '## standing\\nkeep checking\\n## nonsense\\nnope\\n## other\\nnope\\n' | run notes seance custodian notes
printf 'closed one, kept one' | run done seance custodian done
echo finished > "$out/finished"
exec sleep 600
`;

const PR_URL = "https://github.com/o/r/pull/9";
const PR_VIEW: PrView = {
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  autoMerge: false,
  checks: { state: "SUCCESS", contexts: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] },
  readAt: 1,
};

describe("the verbs, over the round's own socket, from the round's own pane", () => {
  let fx: GitFixture;

  beforeAll(async () => {
    await mkdir(join(base, "verbs-fx"), { recursive: true });
    fx = await makeGitFixture(join(base, "verbs-fx"));
  });

  async function sessionPane(name: string, taskId: string): Promise<string> {
    const pane = (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `${session}:`,
        "-n",
        name,
        "-c",
        base,
        `exec ${stub.repl} --remote-control`,
      ])
    ).trim();
    await tmuxOk(["set-option", "-p", "-t", pane, "@seance-task", taskId]);
    await pollUntil(async () => (await paneInfo(pane))?.titled === true, `${name} to be titled`);
    return pane;
  }

  /** The verbs over the real ledger, panes and git, with only the GitHub side (`readPr`, the origin's repo) faked. */
  async function verbsOver(r: Rig, ended: EndedTasks, panes: readonly string[], audit: string[]) {
    const turnEnded = Date.now();
    const closeAfter = CUSTODIAN_DEFAULTS.closeAfterMinutes * MIN;
    const repos = await scanRepos([fx.root]);
    return createCustodianVerbs({
      roundPane: () => r.seat.roundPane(),
      roundPanePids: listRoundPanePids,
      activity: (pane) =>
        panes.includes(pane)
          ? { state: "idle", stateSince: turnEnded, turnEnded: true, screenSince: turnEnded, sampledAt: turnEnded }
          : null,
      retainedSince: () => turnEnded - closeAfter,
      untouchable: () => false,
      tasks: ended,
      readPr: () => Promise.resolve(PR_VIEW),
      originOf: () => Promise.resolve({ owner: "o", name: "r" }),
      worktree: createWorktreeRule({ tasks: ended, repos: () => repos, listPanes }),
      despawn: (id, request) => despawnSession(id, request),
      killPane: async (pane) => (await tmux(["kill-pane", "-t", pane])).exitCode === 0,
      deliver: () => Promise.resolve({ ok: false, code: "unsupported" }),
      keys: () => Promise.resolve(false),
      settings: CUSTODIAN_DEFAULTS,
      seat: {
        count: (verb, ok) => r.seat.count(verb, ok),
        countWorktree: (kind) => r.seat.countWorktree(kind),
        countFlagged: () => r.seat.countFlagged(),
        done: (summary) => r.seat.done(summary),
        isDone: () => r.seat.isDone(),
      },
      now: () => turnEnded + 2 * closeAfter,
      audit: custodianAudit((line) => {
        audit.push(line.replaceAll(/ pane=%\d+/gu, " pane=%N"));
        return Promise.resolve();
      }),
      flags: createCustodianFlags({
        path: join(process.env["SEANCE_STATE_DIR"] ?? "", "custodian-flags.json"),
        now: () => turnEnded + 2 * closeAfter,
        warn: () => {},
      }),
      sendEvent: () => Promise.resolve(true),
      warn: () => {},
    });
  }

  test("a frame from the test process, a session pane or a second round pane is refused, and nothing is closed", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = await scriptStub(base, "round-idle", ROUND_IDLE_SCRIPT);
    const ledger = LaunchLedger.memory();
    await ledger.record("t-r");
    await ledger.note("t-r", { repo: fx.repoPath, path: await fx.pushBranch("feat-refused") });
    const ended = new EndedTasks(ledger);
    const target = await sessionPane("sess-r", "t-r");
    const audit: string[] = [];
    const r = seatOver();
    const verbs = await verbsOver(r, ended, [target], audit);
    await mkdir(stateDir(), { recursive: true });
    await roundSocket(verbs.handle);
    const out = join(stateDir(), "refused");
    try {
      await r.seat.start();
      await r.seat.tick();
      const roundPane = await onlyRound();
      const shim = join(r.saved.record.round?.tmpDir ?? "", "bin", "seance");
      await mkdir(out, { recursive: true });

      // From this process, which is no pane at all.
      const frame = { v: 1, kind: "custodian", verb: "close", pane: target };
      const fromHere = await exchange(frame, {
        path: testSocket,
        timeoutMs: 5_000,
        timeoutText: "no answer",
        restartGraceMs: 0,
      });
      expect(fromHere).toEqual({ ok: false, code: "not_custodian" });

      // From a window that looks like a session (`--remote-control`) and from a second pane tagged as a round that the
      // seat record does not name: each runs the round's own shim, aimed at the round's socket as a round's env is.
      const asks = async (name: string, tagged: boolean): Promise<string> => {
        const pane = (
          await tmuxOk([
            "new-window",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            `${session}:`,
            "-n",
            name,
            "-c",
            base,
            `: --remote-control; SEANCE_CUSTODIAN_SOCKET=${shq(testSocket)} ${shim} custodian close ${target} > ${out}/${name}.out 2> ${out}/${name}.err; echo $? > ${out}/${name}.rc; exec sleep 600`,
          ])
        ).trim();
        if (tagged) await tmuxOk(["set-option", "-p", "-t", pane, "@seance-custodian", "1"]);
        await pollUntil(() => tmpExists(join(out, `${name}.rc`)), `${name}'s close to be answered`);
        return pane;
      };
      const impostor = await asks("impostor-session", false);
      const second = await asks("impostor-round", true);
      for (const name of ["impostor-session", "impostor-round"]) {
        expect((await readFile(join(out, `${name}.rc`), "utf8")).trim()).toBe("1");
        expect(await readFile(join(out, `${name}.err`), "utf8")).toContain("refused not_custodian");
      }

      expect(await paneInfo(target)).not.toBeNull();
      expect(audit.filter((line) => line.includes("op=close"))).toEqual(
        Array.from(
          { length: 3 },
          () => "audit custodian origin=custodian op=close pane=%N task=- outcome=not_custodian",
        ),
      );
      expect(roundPane).not.toBe(second);
      await tmux(["kill-pane", "-t", impostor]);
      await tmux(["kill-pane", "-t", second]);
      await tmux(["kill-pane", "-t", target]);
      // The round's own end, so the next test finds one round pane.
      expect(await r.seat.done("refusals checked")).toBe("ok");
      await r.seat.tick();
      await noRounds();
    } finally {
      r.seat.stop();
    }
  }, 60_000);

  test("a round's own seance runs sessions, capture, pr, close, notes and done; the seat then ends it healthy", async () => {
    await mkdir(stateDir(), { recursive: true });
    const out = join(stateDir(), "verbs");
    process.env["SEANCE_CLAUDE_BIN"] = await scriptStub(base, "round-verbs", roundVerbsScript(out));
    // What a tmux server's global environment can hold, and a round must never inherit.
    await tmuxOk(["set-environment", "-g", "SSH_AUTH_SOCK", "/tmp/leak.sock"]);
    await tmuxOk(["set-environment", "-g", "GH_TOKEN", "ghp_leak"]);
    const clean = await fx.pushBranch("feat-a");
    const dirty = await fx.pushBranch("feat-b");
    await writeFile(join(dirty, "unsaved.txt"), "only here\n");
    const ledger = LaunchLedger.memory();
    for (const [taskId, path] of [
      ["t-a", clean],
      ["t-b", dirty],
    ] as const) {
      await ledger.record(taskId);
      await ledger.note(taskId, { repo: fx.repoPath, path });
    }
    const ended = new EndedTasks(ledger);
    await ended.notePr("t-a", PR_URL);
    const paneA = await sessionPane("sess-a", "t-a");
    const paneB = await sessionPane("sess-b", "t-b");

    // After every fixture write: the touched guard compares the worktree's newest signal with the turn's end.
    const audit: string[] = [];
    const r = seatOver();
    const verbs = await verbsOver(r, ended, [paneA, paneB], audit);
    await roundSocket(verbs.handle);
    try {
      await r.seat.start();
      await r.seat.tick();
      const roundPane = await onlyRound();
      const tmpDir = r.saved.record.round?.tmpDir ?? "";
      await pollUntil(() => tmpExists(join(out, "which")), "the round's script to start");
      // Before the round closes pane A: what `capture` must hand back is this screen, not an empty or another pane's.
      const screenA = await capturePane(paneA, { history: false });
      await writeFile(join(out, "go.tmp"), `${paneA}\n${paneB}\n${roundPane}\n`);
      await rename(join(out, "go.tmp"), join(out, "go"));
      await pollUntil(() => tmpExists(join(out, "finished")), "the round's verbs to finish", 60_000);

      // F1: the round's own seance is the one on PATH, whatever the tmux server's PATH holds.
      expect((await readFile(join(out, "which"), "utf8")).trim()).toBe(join(tmpDir, "bin", "seance"));

      // The environment is built, not inherited.
      const env = await readFile(join(out, "env.txt"), "utf8");
      expect(env).toContain(`SEANCE_CUSTODIAN_SOCKET=${testSocket}\n`);
      expect(env).toContain(`TMPDIR=${tmpDir}\n`);
      expect(env).toContain(`CLAUDE_CODE_TMPDIR=${tmpDir}\n`);
      for (const leaked of ["SSH_AUTH_SOCK", "GH_TOKEN", "SEANCE_STATE_DIR", "TMUX="]) {
        expect(env).not.toContain(leaked);
      }

      const read = (name: string): Promise<string> => readFile(join(out, name), "utf8");
      const codes = await Promise.all(
        ["sessions", "captureA", "captureSelf", "prA", "prB", "closeA", "closeB", "closeSelf", "notes", "done"].map(
          async (v) => (await read(`${v}.rc`)).trim(),
        ),
      );
      expect(codes).toEqual(["0", "0", "1", "0", "1", "0", "0", "1", "0", "0"]);

      const listed: { panes: { pane: string }[] } = JSON.parse(await read("sessions.json"));
      const seen = new Map(listed.panes.map((p) => [p.pane, p]));
      // The round never sees its own pane; the private server's first window is listed as a foreign shell.
      expect(seen.has(roundPane)).toBe(false);
      for (const pane of [paneA, paneB]) {
        expect(seen.get(pane)).toMatchObject({ owner: "ours", classification: "live", close: "ok" });
      }

      const captured: { text: string } = JSON.parse(await read("captureA.json"));
      expect(captured).toMatchObject({ ok: true, verb: "capture", pane: paneA });
      expect(captured.text.trim()).not.toBe("");
      expect(screenA).not.toBeNull();
      expect(captured.text.trim()).toBe(screenA?.trim() ?? "");
      expect(await read("captureSelf.err")).toContain("refused marked");
      expect(JSON.parse(await read("prA.json"))).toMatchObject({
        ok: true,
        verb: "pr",
        pane: paneA,
        taskId: "t-a",
        url: PR_URL,
        state: "OPEN",
      });
      expect(await read("prB.err")).toContain("refused prless");

      expect(JSON.parse(await read("closeA.json"))).toMatchObject({
        ok: true,
        verb: "close",
        taskId: "t-a",
        outcome: "exited",
        worktree: { removed: true, how: "origin" },
      });
      expect(await tmpExists(clean)).toBe(false);
      expect(JSON.parse(await read("closeB.json"))).toMatchObject({
        ok: true,
        taskId: "t-b",
        worktree: { kept: "dirty" },
      });
      expect(await tmpExists(dirty)).toBe(true);
      expect(await paneInfo(paneA)).toBeNull();
      expect(await paneInfo(paneB)).toBeNull();
      expect(await read("closeSelf.err")).toContain("refused marked");
      // The acting verbs reach the round's own socket and its binding too: refused for the round's own pane by the
      // verb's own check, never `not_custodian` or `unsupported`.
      for (const verb of ["flagSelf", "interruptSelf", "nudgeSelf"]) {
        // oxlint-disable-next-line no-await-in-loop -- three small reads
        const [rc, err] = await Promise.all([read(`${verb}.rc`), read(`${verb}.err`)]);
        expect(rc.trim()).toBe("1");
        expect(err).toMatch(/refused (?!not_custodian|unsupported)/u);
      }
      expect(JSON.parse(await read("notes.json"))).toMatchObject({ ok: true, kept: ["standing"], dropped: 2 });
      const notes = await readFile(custodianNotesPath(), "utf8");
      expect(notes).toContain("keep checking");
      expect(notes).not.toContain("nope");
      expect(JSON.parse(await read("done.json"))).toEqual({ ok: true, verb: "done" });

      expect(audit.filter((line) => line.includes("op=close"))).toEqual([
        "audit custodian origin=custodian op=close pane=%N task=t-a outcome=exited",
        "audit custodian origin=custodian op=close pane=%N task=t-b outcome=exited",
        "audit custodian origin=custodian op=close pane=%N task=- outcome=marked",
      ]);
      expect(audit.filter((line) => line.includes("op=worktree"))).toEqual([
        "audit custodian origin=custodian op=worktree pane=%N task=t-a outcome=removed how=origin",
        "audit custodian origin=custodian op=worktree pane=%N task=t-b outcome=kept why=dirty",
      ]);
      // `capture` and `pr` read and act on nothing: no audit line, however they ended.
      expect(audit.some((line) => line.includes("op=capture") || line.includes("op=pr"))).toBe(false);

      // `done` marked the round: the next tick closes it ahead of its deadline, healthy, with the tally.
      await r.seat.tick();
      await noRounds();
      expect(r.rounds.at(-1)).toMatchObject({
        outcome: "healthy",
        reason: "done",
        summary: "closed one, kept one",
        counts: {
          close: { ok: 2, refused: 1 },
          capture: { ok: 1, refused: 1 },
          pr: { ok: 1, refused: 1 },
          worktrees: { removed: 1, kept: 1 },
        },
      });
      expect(await tmpExists(tmpDir)).toBe(false);
    } finally {
      r.seat.stop();
      await tmuxOk(["set-environment", "-g", "-u", "SSH_AUTH_SOCK"]).catch(() => "");
      await tmuxOk(["set-environment", "-g", "-u", "GH_TOKEN"]).catch(() => "");
    }
  }, 90_000);
});
