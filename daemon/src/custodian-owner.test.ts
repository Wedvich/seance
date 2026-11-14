import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ID, SCHEDULER_ID, type CustodianRequest, type OpName, type Plain } from "@seance/shared";
import type { AuditSink } from "./audit.ts";
import { createBackend } from "./backend-default.ts";
import type { Config } from "./config.ts";
import { ROUND_REQUEST_MIN_GAP_MS, requestRound, type SeatView } from "./custodian-control.ts";
import { ownerAct, type OwnerRoundInputs } from "./custodian-owner.ts";
import { emptyCounts, type RoundEntry } from "./custodian-rounds.ts";
import { createHandler, createLocalOps, type CustodianControl, type HandlerContext } from "./handlers.ts";
import type { SeatRecord } from "./seat-record.ts";

/**
 * The `custodian` app op (docs/custodian.md C45, C47): the handler's gate, then `ownerAct` over real control files in
 * a throwaway dir, the same functions the shell's verbs run (`custodian-owner-cli.test.ts` drives those).
 */

const NOW = 1_800_000_000_000;
const lines: string[] = [];
const collect: AuditSink = (line) => void lines.push(line);
const trail = (): string[] => lines.filter((line) => line.startsWith("audit custodian"));

const CONFIG: Config = {
  name: "TestMac",
  relayUrl: "ws://localhost/daemon",
  bearerToken: "test-bearer",
  psk: "",
  repoRoots: ["/repos"],
  tmuxSession: "main",
};

const base: HandlerContext = {
  backend: createBackend(CONFIG, { home: "/nonexistent/seance-home" }),
  getRepos: () => [],
  rescan: () => Promise.resolve([]),
  auditSink: collect,
};

const ask = (payload: unknown, op: OpName = "custodian"): Plain => ({ id: "req-1", ts: NOW, op, payload });

let dir: string;
let statePath: string;
let requestPath: string;
/** What the seat and its files say; each test sets what it needs. */
let seat: { live: boolean; configured: boolean; view: SeatView | null; record: SeatRecord; rounds: RoundEntry[] };

beforeEach(async () => {
  lines.length = 0;
  dir = await mkdtemp(join(tmpdir(), "seance-custodian-op-"));
  statePath = join(dir, "custodian", "state.json");
  requestPath = join(dir, "custodian", "round-request");
  seat = { live: true, configured: true, view: null, record: {}, rounds: [] };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const inputs = (): Omit<OwnerRoundInputs, "now"> & { now: () => number; path: string } => ({
  now: () => NOW,
  live: seat.live,
  configured: () => Promise.resolve(seat.configured),
  seatView: () => Promise.resolve(seat.view),
  seatRecord: () => Promise.resolve(seat.record),
  rounds: () => Promise.resolve(seat.rounds),
  request: (now) => requestRound(now, requestPath),
  path: statePath,
});

const control: CustodianControl = { act: (request, audit) => ownerAct(request, inputs(), audit) };
const handle = (over: Partial<HandlerContext> = {}): ReturnType<typeof createHandler> =>
  createHandler({ ...base, custodian: control, ...over });
const act = async (request: CustodianRequest): Promise<unknown> => (await handle()(ask(request), APP_ID))?.payload;
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("the custodian op's gate", () => {
  test("anyone but an app is refused, before anything is read or written: the scheduler, unsealed, the local socket", async () => {
    const pause = ask({ act: "pause" });
    expect((await handle()(pause, SCHEDULER_ID))?.payload).toMatchObject({ ok: false, code: "refused" });
    expect((await handle()(pause))?.payload).toMatchObject({ ok: false, code: "refused" });
    expect((await handle()(pause, "some-device"))?.payload).toMatchObject({ ok: false, code: "refused" });
    const local = createHandler({ ...base, custodian: control }, "local");
    expect((await local(pause, APP_ID))?.payload).toMatchObject({ ok: false, code: "refused" });
    expect(await exists(statePath)).toBe(false);
    expect(trail()).toEqual([
      "audit custodian origin=relay op=- outcome=refused",
      "audit custodian origin=relay op=- outcome=refused",
      "audit custodian origin=relay op=- outcome=refused",
      "audit custodian origin=local op=- outcome=refused",
    ]);
    expect(lines.some((line) => line.startsWith('audit request origin=relay op="custodian"'))).toBe(true);
  });

  test("a malformed request is invalid_request, a daemon with no control is unsupported, a failed write internal_error", async () => {
    for (const bad of [undefined, { act: "stop" }, { act: "round", minutes: 60 }, { act: "pause", minutes: 0 }]) {
      expect((await handle()(ask(bad), APP_ID))?.payload).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect((await createHandler(base)(ask({ act: "resume" }), APP_ID))?.payload).toMatchObject({
      ok: false,
      code: "unsupported",
    });
    const broken: CustodianControl = { act: () => Promise.reject(new Error("disk full")) };
    expect((await handle({ custodian: broken })(ask({ act: "pause" }), APP_ID))?.payload).toMatchObject({
      ok: false,
      code: "internal_error",
    });
    expect(trail()).toEqual([
      ...Array.from({ length: 4 }, () => "audit custodian origin=relay op=- outcome=invalid_request"),
      "audit custodian origin=relay op=resume outcome=unsupported",
      "audit custodian origin=relay op=pause outcome=internal_error",
    ]);
  });

  test("no op but the relay handler's carries it: the leader's in-process ops have none", () => {
    expect(Object.keys(createLocalOps(base, "leader"))).not.toContain("custodian");
  });
});

describe("the custodian op's acts", () => {
  test("pause for an hour, pause until resumed, resume: the file the seat reads, audited with the end and no payload", async () => {
    expect(await act({ act: "pause", minutes: 60 })).toEqual({ ok: true, pause: { until: NOW + 3_600_000 } });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ pause: { at: NOW, until: NOW + 3_600_000 } });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(await act({ act: "pause" })).toEqual({ ok: true, pause: { until: null } });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ pause: { at: NOW, until: null } });
    expect(await act({ act: "resume" })).toEqual({ ok: true, pause: null });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({});
    expect(trail()).toEqual([
      `audit custodian origin=relay op=pause until=${new Date(NOW + 3_600_000).toISOString()}`,
      "audit custodian origin=relay op=pause until=none",
      "audit custodian origin=relay op=resume",
    ]);
  });

  test("round while rounds are held: refused held, nothing requested, pause and resume still work", async () => {
    seat.live = false;
    expect(await act({ act: "round" })).toMatchObject({ ok: false, code: "held" });
    expect(await exists(requestPath)).toBe(false);
    expect(await act({ act: "pause" })).toEqual({ ok: true, pause: { until: null } });
    expect(trail()).toEqual([
      "audit custodian origin=relay op=round outcome=held",
      "audit custodian origin=relay op=pause until=none",
    ]);
  });

  test("round while the daemon's seat is still starting: unsupported, nothing requested; pause still writes", async () => {
    const starting = (): Omit<OwnerRoundInputs, "now"> & { now: () => number; path: string } => ({
      ...inputs(),
      seatReady: () => false,
    });
    const op: CustodianControl = { act: (request, audit) => ownerAct(request, starting(), audit) };
    expect((await handle({ custodian: op })(ask({ act: "round" }), APP_ID))?.payload).toMatchObject({
      ok: false,
      code: "unsupported",
    });
    expect(await exists(requestPath)).toBe(false);
    expect((await handle({ custodian: op })(ask({ act: "pause" }), APP_ID))?.payload).toEqual({
      ok: true,
      pause: { until: null },
    });
    expect(trail()).toEqual([
      "audit custodian origin=relay op=round outcome=starting",
      "audit custodian origin=relay op=pause until=none",
    ]);
  });

  test("round writes the request and answers the pause that holds, which a round request overrides for one round", async () => {
    await act({ act: "pause" });
    expect(await act({ act: "round" })).toEqual({ ok: true, pause: { until: null } });
    expect(JSON.parse(await readFile(requestPath, "utf8"))).toEqual({ at: NOW });
    expect(trail().at(-1)).toBe("audit custodian origin=relay op=round outcome=requested");
  });

  test("round is refused with the shell's reasons, each its own code, and nothing requested", async () => {
    const fresh = (over: Partial<SeatView>): SeatView => ({ s: "idle", at: NOW, failed: false, version: "v", ...over });
    const cases: [() => void, string][] = [
      [() => (seat.configured = false), "unconfigured"],
      [() => (seat.view = fresh({ failed: true })), "host_failed"],
      [() => (seat.view = fresh({ s: "running" })), "running"],
      [() => (seat.record = { round: { pane: "%3", startedAt: NOW - 1, tmpDir: "/tmp/x", exclave: "e" } }), "running"],
    ];
    for (const [arrange, code] of cases) {
      seat = { live: true, configured: true, view: null, record: {}, rounds: [] };
      arrange();
      // oxlint-disable-next-line no-await-in-loop -- one case at a time over one dir
      expect(await act({ act: "round" })).toMatchObject({ ok: false, code });
    }
    seat = {
      live: true,
      configured: true,
      view: null,
      record: {},
      rounds: [
        {
          start: NOW - 60_000,
          end: NOW - 30_000,
          exclave: "e",
          outcome: "healthy",
          reason: "done",
          counts: emptyCounts(),
        },
      ],
    };
    expect(await act({ act: "round" })).toEqual({
      ok: false,
      code: "too_soon",
      message: expect.any(String),
      after: NOW - 60_000 + ROUND_REQUEST_MIN_GAP_MS,
    });
    expect(await exists(requestPath)).toBe(false);
    expect(trail()).toEqual([
      "audit custodian origin=relay op=round outcome=unconfigured",
      "audit custodian origin=relay op=round outcome=failed",
      "audit custodian origin=relay op=round outcome=running",
      "audit custodian origin=relay op=round outcome=running",
      "audit custodian origin=relay op=round outcome=too_soon",
    ]);
  });

  test("a stale failed view is no report: the round is requested", async () => {
    seat.view = { s: "idle", at: NOW - 3_600_000, failed: true, version: "v" };
    expect(await act({ act: "round" })).toMatchObject({ ok: true });
    expect(await exists(requestPath)).toBe(true);
  });
});
