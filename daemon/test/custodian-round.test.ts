import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, importPsk, open as openSealed, parseMachineInfo, toBase64 } from "@seance/shared";
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
import { createCustodianVerbs } from "../src/custodian-verbs.ts";
import { createWorktreeRule } from "../src/custodian-worktree.ts";
import { LaunchLedger } from "../src/launch-ledger.ts";
import { exchange } from "../src/local-client.ts";
import { startLocalSocket } from "../src/local-socket.ts";
import { custodianNotesPath, socketPath } from "../src/paths.ts";
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
import { ROUND_TMP } from "../src/seat-record.ts";
import { EndedTasks, listPanePids } from "../src/session-events.ts";
import { listClaudeSessions, listPanes, paneInfo } from "../src/sessions.ts";
import { resolveTargetSession, tmux, tmuxOk } from "../src/tmux.ts";
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
  readonly rounds: RoundEntry[];
  readonly saved: { record: SeatRecord };
}

/**
 * A seat over the real launch and the real close, with a clock the test moves and a tick it calls: the deadline is
 * crossed by moving the clock, never by waiting for one.
 */
function seatOver(record: SeatRecord = {}, given?: { now: number }): Rig {
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
    audit.push(line.replace(/ pane=%\d+/u, " pane=%N").replace(/ exclave="?default"?/u, " exclave=default"));
    return Promise.resolve();
  });
  const seat = createCustodianSeat({
    settings: CUSTODIAN_DEFAULTS,
    now: () => clock.now,
    checkIntervalMs: 3_600_000,
    activity: tracked,
    untouchable: () => false,
    appendRound: (entry) => {
      rounds.push(entry);
      return Promise.resolve();
    },
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
  return { seat, clock, audit, saved, rounds };
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
        "audit custodian origin=custodian op=end pane=%N outcome=failed reason=exited",
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
      booted.stop();
    }
  }

  async function boot(
    custodian: Config["custodian"],
    opts: { readonly sandboxProblem: () => Promise<string | null> },
  ): Promise<{ readonly relay: ReturnType<typeof startTestRelay>; readonly stop: () => void }> {
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
        custodian: {
          checkIntervalMs: 3_600_000,
          sandboxProblem: opts.sandboxProblem,
          weakerNested: () => Promise.resolve(false),
        },
      });
      return {
        relay,
        stop: (): void => {
          daemon.stop();
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

  for (const [label, custodian, problem] of [
    ["is off", undefined, null],
    ["is declined by the host's checks", CUSTODIAN_DEFAULTS, "test: no sandbox"],
  ] as const) {
    test(`a seat that ${label} closes a round the last process left, audited reason=off`, async () => {
      const stray = await strayRound();
      let booted: Awaited<ReturnType<typeof boot>> | undefined;
      const lines = await captureLog(async () => {
        booted = await boot(custodian, { sandboxProblem: () => Promise.resolve(problem) });
        await pollUntil(async () => (await paneInfo(stray)) === null, "the stray round pane to close");
        await Bun.sleep(50);
      });
      booted?.stop();
      const audit = lines.filter((line) => line.includes("audit custodian"));
      expect(audit.some((line) => line.includes("op=kill") && line.includes("reason=off"))).toBe(true);
      expect(audit.some((line) => line.includes("op=end") && line.includes("reason=lost"))).toBe(true);
    });
  }

  test("a host whose seat cannot start answers the verbs unsupported, not not_custodian", async () => {
    const booted = await boot(CUSTODIAN_DEFAULTS, { sandboxProblem: () => Promise.resolve("test: no sandbox") });
    try {
      const sessions = { v: 1, kind: "custodian", verb: "sessions" };
      const answer = async (): Promise<unknown> =>
        exchange(sessions, {
          path: socketPath(),
          timeoutMs: 5_000,
          timeoutText: "the daemon did not answer the custodian frame",
          restartGraceMs: 0,
        }).catch(() => null);
      await pollUntil(async () => (await answer()) !== null, "the daemon's local socket to answer");
      await pollUntil(
        async () => JSON.stringify(await answer()) === JSON.stringify({ ok: false, code: "unsupported" }),
        "the failed seat to answer unsupported",
      );
    } finally {
      booted.stop();
    }
  });

  test("a daemon with the key and a seat advertises custodian", async () => {
    expect(await advertised(CUSTODIAN_DEFAULTS)).toContain(CAPABILITIES.custodian);
  });

  test("without the key it does not", async () => {
    expect(await advertised(undefined)).not.toContain(CAPABILITIES.custodian);
  });
});

const ROUND_IDLE_SCRIPT = "exec sleep 600";

const ROUND_VERBS_SCRIPT = `
out="$SEANCE_STATE_DIR/verbs"
mkdir -p "$out"
command -v seanced > "$out/which"
until [ -f "$out/go" ]; do sleep 0.1; done
{ read -r a; read -r b; } < "$out/go"
run() { name=$1; shift; "$@" > "$out/$name.json" 2> "$out/$name.err"; echo $? > "$out/$name.rc"; }
run sessions seanced custodian sessions
run closeA seanced custodian close "$a"
run closeB seanced custodian close "$b"
run closeSelf seanced custodian close "$TMUX_PANE"
printf '## standing\\nkeep checking\\n## nonsense\\nnope\\n## other\\nnope\\n' | run notes seanced custodian notes
printf 'closed one, kept one' | run done seanced custodian done
echo finished > "$out/finished"
exec sleep 600
`;

describe("the verbs, over the socket, from the round's own pane", () => {
  let roundScript = "";
  let fx: GitFixture;

  beforeAll(async () => {
    roundScript = await scriptStub(base, "round-verbs", ROUND_VERBS_SCRIPT);
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

  test("a frame from the test process, a session pane or a second round pane is refused, and nothing is closed", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = await scriptStub(base, "round-idle", ROUND_IDLE_SCRIPT);
    const ledger = LaunchLedger.memory();
    await ledger.record("t-r");
    await ledger.note("t-r", { repo: fx.repoPath, path: await fx.pushBranch("feat-refused") });
    const ended = new EndedTasks(ledger);
    const target = await sessionPane("sess-r", "t-r");
    const turnEnded = Date.now();
    const closeAfter = CUSTODIAN_DEFAULTS.closeAfterMinutes * MIN;
    const audit: string[] = [];
    const r = seatOver();
    const repos = await scanRepos([fx.root]);
    const verbs = createCustodianVerbs({
      roundPane: () => r.seat.roundPane(),
      roundPanePids: listRoundPanePids,
      activity: (pane) =>
        pane === target
          ? { state: "idle", stateSince: turnEnded, turnEnded: true, screenSince: turnEnded, sampledAt: turnEnded }
          : null,
      retainedSince: () => turnEnded - closeAfter,
      untouchable: () => false,
      tasks: ended,
      worktree: createWorktreeRule({ tasks: ended, repos: () => repos, listPanes }),
      despawn: (id, request) => despawnSession(id, request),
      killPane: async (pane) => (await tmux(["kill-pane", "-t", pane])).exitCode === 0,
      settings: CUSTODIAN_DEFAULTS,
      seat: {
        count: (verb, ok) => r.seat.count(verb, ok),
        countWorktree: (kind) => r.seat.countWorktree(kind),
        done: (summary) => r.seat.done(summary),
        isDone: () => r.seat.isDone(),
      },
      now: () => turnEnded + 2 * closeAfter,
      audit: custodianAudit((line) => {
        audit.push(line.replaceAll(/ pane=%\d+/gu, " pane=%N"));
        return Promise.resolve();
      }),
      onKept: (): void => {},
      warn: () => {},
    });
    const socket = await startLocalSocket({ handle: () => Promise.resolve(null), custodian: verbs.handle });
    const out = join(process.env["SEANCE_STATE_DIR"] ?? "", "refused");
    try {
      await r.seat.start();
      await r.seat.tick();
      const roundPane = await onlyRound();
      const shim = join(r.saved.record.round?.tmpDir ?? "", "bin", "seanced");
      await mkdir(out, { recursive: true });

      // From this process, which is no pane at all.
      const frame = { v: 1, kind: "custodian", verb: "close", pane: target };
      const fromHere = await exchange(frame, {
        path: socketPath(),
        timeoutMs: 5_000,
        timeoutText: "no answer",
        restartGraceMs: 0,
      });
      expect(fromHere).toEqual({ ok: false, code: "not_custodian" });

      // From a window that looks like a session (`--remote-control`) and from a second pane tagged as a round that the
      // seat record does not name: each runs the round's own shim and writes what it was told.
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
            `: --remote-control; ${shim} custodian close ${target} > ${out}/${name}.out 2> ${out}/${name}.err; echo $? > ${out}/${name}.rc; exec sleep 600`,
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
      socket.stop();
      r.seat.stop();
    }
  }, 60_000);

  test("a round's own seanced runs sessions, close, notes and done; the seat then ends it healthy", async () => {
    process.env["SEANCE_CLAUDE_BIN"] = roundScript;
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
    const paneA = await sessionPane("sess-a", "t-a");
    const paneB = await sessionPane("sess-b", "t-b");

    // After every fixture write: the touched guard compares the worktree's newest signal with the turn's end.
    const turnEnded = Date.now();
    const closeAfter = CUSTODIAN_DEFAULTS.closeAfterMinutes * MIN;
    const audit: string[] = [];
    const r = seatOver();
    const repos = await scanRepos([fx.root]);
    const verbs = createCustodianVerbs({
      roundPane: () => r.seat.roundPane(),
      roundPanePids: listRoundPanePids,
      activity: (pane) =>
        pane === paneA || pane === paneB
          ? { state: "idle", stateSince: turnEnded, turnEnded: true, screenSince: turnEnded, sampledAt: turnEnded }
          : null,
      retainedSince: () => turnEnded - closeAfter,
      untouchable: () => false,
      tasks: ended,
      worktree: createWorktreeRule({ tasks: ended, repos: () => repos, listPanes }),
      despawn: (id, request) => despawnSession(id, request),
      killPane: async (pane) => (await tmux(["kill-pane", "-t", pane])).exitCode === 0,
      settings: CUSTODIAN_DEFAULTS,
      seat: {
        count: (verb, ok) => r.seat.count(verb, ok),
        countWorktree: (kind) => r.seat.countWorktree(kind),
        done: (summary) => r.seat.done(summary),
        isDone: () => r.seat.isDone(),
      },
      now: () => turnEnded + 2 * closeAfter,
      audit: custodianAudit((line) => {
        audit.push(line.replaceAll(/ pane=%\d+/gu, " pane=%N"));
        return Promise.resolve();
      }),
      onKept: (): void => {},
      warn: () => {},
    });
    const socket = await startLocalSocket({ handle: () => Promise.resolve(null), custodian: verbs.handle });
    const out = join(process.env["SEANCE_STATE_DIR"] ?? "", "verbs");
    try {
      await r.seat.start();
      await r.seat.tick();
      const roundPane = await onlyRound();
      const tmpDir = r.saved.record.round?.tmpDir ?? "";
      await pollUntil(() => tmpExists(join(out, "which")), "the round's script to start");
      await writeFile(join(out, "go.tmp"), `${paneA}\n${paneB}\n`);
      await rename(join(out, "go.tmp"), join(out, "go"));
      await pollUntil(() => tmpExists(join(out, "finished")), "the round's verbs to finish", 60_000);

      // F1: the round's own seanced is the one on PATH, whatever the tmux server's PATH holds.
      expect((await readFile(join(out, "which"), "utf8")).trim()).toBe(join(tmpDir, "bin", "seanced"));
      const read = (name: string): Promise<string> => readFile(join(out, name), "utf8");
      const codes = await Promise.all(
        ["sessions", "closeA", "closeB", "closeSelf", "notes", "done"].map(async (v) => (await read(`${v}.rc`)).trim()),
      );
      expect(codes).toEqual(["0", "0", "0", "1", "0", "0"]);

      const listed: { panes: { pane: string }[] } = JSON.parse(await read("sessions.json"));
      const seen = new Map(listed.panes.map((p) => [p.pane, p]));
      // The round never sees its own pane; the private server's first window is listed as a foreign shell.
      expect(seen.has(roundPane)).toBe(false);
      for (const pane of [paneA, paneB]) {
        expect(seen.get(pane)).toMatchObject({ owner: "ours", classification: "live", close: "ok" });
      }

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

      // `done` marked the round: the next tick closes it ahead of its deadline, healthy, with the tally.
      await r.seat.tick();
      await noRounds();
      expect(r.rounds.at(-1)).toMatchObject({
        outcome: "healthy",
        reason: "done",
        summary: "closed one, kept one",
        counts: { close: { ok: 2, refused: 1 }, worktrees: { removed: 1, kept: 1 } },
      });
      expect(await tmpExists(tmpDir)).toBe(false);
    } finally {
      socket.stop();
      r.seat.stop();
    }
  }, 90_000);
});
