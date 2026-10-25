import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failureReasonText,
  importPsk,
  isRecord,
  RequestFailure,
  toBase64,
  type Machine,
  type Task,
} from "@seance/shared";
import { startBrokerDouble } from "../test/broker-double.ts";
import { machine } from "../test/fake-app-relay.ts";
import { BrokerError } from "./broker-client.ts";
import { brokerFail, brokerOk, type BrokerReply } from "./broker-protocol.ts";
import { enqueueAuto } from "./auto.ts";
import { brokerFleet, DaemonFault, FleetUnreachable, selectFleet, type Fleet, type FleetLease } from "./fleet.ts";

interface CountingFleet extends Fleet {
  opened: number;
  sent: { deviceId: string; op: string }[];
}

function countingFleet(machines: readonly Machine[], fail?: unknown): CountingFleet {
  const fleet: CountingFleet = {
    opened: 0,
    sent: [],
    open: (): Promise<FleetLease> => {
      fleet.opened += 1;
      if (fail !== undefined) return Promise.reject(fail);
      return Promise.resolve({
        machines,
        request: <T>(deviceId: string, op: string): Promise<T> => {
          fleet.sent.push({ deviceId, op });
          return Promise.reject(new Error("not under test"));
        },
        scheduler: null,
        release: (): void => {},
      });
    },
    stop: (): void => {},
  };
  return fleet;
}

const KEY = await importPsk(toBase64(new Uint8Array(32).fill(9)));

describe("selectFleet", () => {
  test("a key this process can read means the direct path; the broker is never asked", async () => {
    let lookups = 0;
    const direct = countingFleet([machine()]);
    const broker = countingFleet([machine()]);
    const handed: CryptoKey[] = [];
    const fleet = selectFleet({
      key: () => {
        lookups += 1;
        return Promise.resolve(KEY);
      },
      direct: (key) => {
        handed.push(key);
        return direct;
      },
      broker,
    });
    await fleet.open();
    await fleet.open();
    expect(direct.opened).toBe(2);
    expect(broker.opened).toBe(0);
    // Memoized: the keychain or DPAPI store is read once per process, not per call.
    expect(lookups).toBe(1);
    expect(handed[0]).toBe(KEY);
  });

  test("no key here means the daemon's broker, and the stores are not re-read inside the retry window", async () => {
    let lookups = 0;
    const broker = countingFleet([machine({ deviceId: "remote" })]);
    let clock = 0;
    const fleet = selectFleet({
      key: () => {
        lookups += 1;
        return Promise.resolve(null);
      },
      direct: () => {
        throw new Error("no key was found, so nothing may build the direct path");
      },
      broker,
      keyRetryMs: 1_000,
      now: () => clock,
    });
    const lease = await fleet.open();
    expect(lease.machines.map((entry) => entry.deviceId)).toEqual(["remote"]);
    await fleet.open();
    expect(lookups).toBe(1);
    clock = 1_000;
    await fleet.open();
    expect(lookups).toBe(2);
    expect(broker.opened).toBe(3);
  });

  test("a key that turns up later — a keychain unlocked mid-session — switches to direct", async () => {
    let key: CryptoKey | null = null;
    const direct = countingFleet([machine()]);
    const broker = countingFleet([machine()]);
    const fleet = selectFleet({ key: () => Promise.resolve(key), direct: () => direct, broker, keyRetryMs: 0 });
    await fleet.open();
    key = KEY;
    await fleet.open();
    expect(broker.opened).toBe(1);
    expect(direct.opened).toBe(1);
  });

  test("a direct-path failure is the answer — never retried through the daemon", async () => {
    const direct = countingFleet(
      [],
      new Error("the relay rejected the bearer token — check bearerToken in config.json"),
    );
    const broker = countingFleet([machine()]);
    const fleet = selectFleet({ key: () => Promise.resolve(KEY), direct: () => direct, broker });
    await expect(fleet.open()).rejects.toThrow("bearer token");
    expect(broker.opened).toBe(0);
  });

  test("an unusable key is an error, not a reason to fall back", async () => {
    const broker = countingFleet([machine()]);
    const fleet = selectFleet({
      key: () => Promise.reject(new Error("psk is not valid base64")),
      direct: () => countingFleet([]),
      broker,
    });
    await expect(fleet.open()).rejects.toThrow("not valid base64");
    expect(broker.opened).toBe(0);
  });

  test("no key and no daemon names both, with what to do about each", async () => {
    const broker = countingFleet(
      [],
      new BrokerError("daemon_unreachable", "no daemon listening at /run/seanced.sock (ENOENT)"),
    );
    const fleet = selectFleet({ key: () => Promise.resolve(null), direct: () => countingFleet([]), broker });
    const err = await fleet.open().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(FleetUnreachable);
    const message = String(err);
    expect(message).toContain("no PSK");
    expect(message).toContain("no daemon listening");
    expect(message).toContain("is seanced running?");
    expect(message).toContain("seanced psk-import");
    // Local ops ride the same socket, so the advice must not promise them.
    expect(message).not.toContain("needs neither");
  });

  test("each broker failure gets advice for its own cause, not the missing-daemon advice", async () => {
    const cases: [BrokerError["code"], string][] = [
      ["relay_unavailable", "could not reach the relay"],
      ["busy", "busy"],
      ["bad_reply", "not readable"],
    ];
    for (const [code, expected] of cases) {
      const fleet = selectFleet({
        key: () => Promise.resolve(null),
        direct: () => countingFleet([]),
        broker: countingFleet([], new BrokerError(code, "detail")),
      });
      // oxlint-disable-next-line no-await-in-loop -- one cause at a time, each asserted alone
      const message = String(await fleet.open().catch((caught: unknown) => caught));
      expect(message).toContain(expected);
      expect(message).toContain("detail");
      expect(message).not.toContain("psk-import");
      expect(message).not.toContain("is seanced running?");
      // The daemon answered, so its op socket — and with it local ops — is up.
      expect(message).toContain("needs neither");
    }
  });

  test("a daemon that took the connection and went quiet is not vouched for as serving local ops", async () => {
    const cases: [BrokerError["code"], string][] = [
      ["daemon_timeout", "itself is stuck"],
      ["daemon_closed", "dropped the connection"],
    ];
    for (const [code, expected] of cases) {
      const fleet = selectFleet({
        key: () => Promise.resolve(null),
        direct: () => countingFleet([]),
        broker: countingFleet([], new BrokerError(code, "detail")),
      });
      // oxlint-disable-next-line no-await-in-loop -- one cause at a time, each asserted alone
      const err = await fleet.open().catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(FleetUnreachable);
      const message = String(err);
      expect(message).toContain(expected);
      expect(message).toContain("seanced status");
      // Local ops ride the same daemon, which just failed to answer on that socket.
      expect(message).not.toContain("needs neither");
    }
  });

  test("a daemon that does not broker says why and what to do here, never to update seanced", async () => {
    const fleet = selectFleet({
      key: () => Promise.resolve(null),
      direct: () => countingFleet([]),
      broker: countingFleet([], new BrokerError("broker_disabled", "detail")),
    });
    const message = String(await fleet.open().catch((caught: unknown) => caught));
    expect(message).toContain("not service-delivered");
    expect(message).toContain("seanced doctor");
    expect(message).not.toContain("update");
    expect(message).not.toContain("is seanced running?");
  });

  test("concurrent first calls share one key lookup", async () => {
    let lookups = 0;
    const fleet = selectFleet({
      key: async () => {
        lookups += 1;
        await Bun.sleep(5);
        return KEY;
      },
      direct: () => countingFleet([]),
      broker: countingFleet([]),
    });
    await Promise.all([fleet.open(), fleet.open(), fleet.open()]);
    expect(lookups).toBe(1);
  });
});

const TASK: Task = {
  id: "11111111-2222-4333-8444-555555555555",
  state: "queued",
  createdAt: 1,
  spec: { repo: "github.com/m/seance", mode: "worktree", prompt: "p", client: "mcp" },
};
const LEADER = { kind: "ready", deviceId: "device-1", term: 2 } as const;

function actionOf(raw: unknown): unknown {
  return isRecord(raw) ? raw["action"] : undefined;
}

/** A daemon that brokers the scheduler: `fleet` answers, and `reply` answers every scheduler frame. */
async function schedulerDaemon(
  reply: (id: string, raw: Record<string, unknown>) => BrokerReply | Promise<BrokerReply>,
) {
  return startBrokerDouble((raw, id) => {
    if (actionOf(raw) === "fleet") return brokerOk(id, { machines: [machine()], scheduler: LEADER });
    return isRecord(raw) ? reply(id, raw) : brokerFail(id, "invalid_request", "not a frame");
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("brokerFleet", () => {
  test("a lease opens on one fleet round trip: the registry and the scheduler the daemon sees", async () => {
    const double = await schedulerDaemon((id) => brokerOk(id, { ok: true, landedEarlier: false }));
    try {
      const lease = await brokerFleet({ path: double.path }).open();
      expect(lease.machines.map((entry) => entry.deviceId)).toEqual(["device-1"]);
      expect(lease.scheduler?.availability()).toEqual(LEADER);
      expect(double.frames.map(actionOf)).toEqual(["fleet"]);
    } finally {
      await double.stop();
    }
  });

  test("an enqueue frame carries the id and the spec — not a sealed task, not createdAt", async () => {
    const double = await schedulerDaemon((id) => brokerOk(id, { ok: true, landedEarlier: true }));
    try {
      const lease = await brokerFleet({ path: double.path }).open();
      expect(await lease.scheduler?.enqueue(TASK)).toEqual({ ok: true, landedEarlier: true });
      const sent = double.frames.at(-1);
      expect(sent).toMatchObject({ action: "scheduler", schedulerOp: "enqueue", taskId: TASK.id, spec: TASK.spec });
      expect(JSON.stringify(sent)).not.toContain("createdAt");
    } finally {
      await double.stop();
    }
  });

  test("a daemon that predates the fleet action answers unsupported, and the lease falls back to machines with no scheduler", async () => {
    const double = await startBrokerDouble((raw, id) =>
      actionOf(raw) === "machines" ? brokerOk(id, [machine({ name: "Old" })]) : brokerFail(id, "unsupported", "no"),
    );
    try {
      const lease = await brokerFleet({ path: double.path }).open();
      expect(lease.machines.map((entry) => entry.name)).toEqual(["Old"]);
      expect(lease.scheduler).toBeNull();
      expect(double.frames.map(actionOf)).toEqual(["fleet", "machines"]);
    } finally {
      await double.stop();
    }
  });

  test("a daemon that drops the unknown frame is probed with machines, whose hint names it as older than the broker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-fleet-"));
    const old = Bun.listen<undefined>({
      unix: join(dir, "old.sock"),
      socket: { data: (sock): void => void sock.end() },
    });
    try {
      const err = await rejection(brokerFleet({ path: join(dir, "old.sock") }).open());
      expect(err).toMatchObject({ code: "daemon_closed" });
      expect(String(err)).toContain("older than the fleet broker");
    } finally {
      old.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fleet answer that is not readable is bad_reply, not a guess", async () => {
    const double = await startBrokerDouble((_raw, id) => brokerOk(id, { machines: "none" }));
    try {
      expect(await rejection(brokerFleet({ path: double.path }).open())).toMatchObject({ code: "bad_reply" });
    } finally {
      await double.stop();
    }
  });

  test("an availability kind this build does not know reads as no leader", async () => {
    const double = await startBrokerDouble((_raw, id) =>
      brokerOk(id, { machines: [machine()], scheduler: { kind: "elected", deviceId: "d", term: 1 } }),
    );
    try {
      const lease = await brokerFleet({ path: double.path }).open();
      expect(lease.scheduler?.availability()).toEqual({ kind: "none" });
    } finally {
      await double.stop();
    }
  });
});

describe("the brokered scheduler leg's failures", () => {
  /** What an enqueue and a cancel each throw when the daemon answers with this. */
  async function thrown(reply: (id: string) => BrokerReply): Promise<RequestFailure[]> {
    const double = await schedulerDaemon((id) => reply(id));
    try {
      const lease = await brokerFleet({ path: double.path }).open();
      const scheduler = lease.scheduler;
      if (scheduler === null) throw new Error("expected a scheduler leg");
      return [await rejection(scheduler.enqueue(TASK)), await rejection(scheduler.cancel(TASK.id))].map((err) => {
        if (!(err instanceof RequestFailure)) throw new Error(`a bare ${String(err)} escaped the leg`);
        return err;
      });
    } finally {
      await double.stop();
    }
  }

  test("a refusal before anything was sent is refused, so it never reads as may-have-landed", async () => {
    for (const code of ["busy", "shutting_down", "broker_disabled", "invalid_request", "relay_unavailable"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one double each
      const failures = await thrown((id) => brokerFail(id, code, `${code} detail`));
      expect(failures.map((failure) => failure.reason)).toEqual(["refused", "refused"]);
    }
  });

  test("a code that can follow a send is dropped: enqueue retries it under the same id, cancel words it as may-have-landed", async () => {
    for (const code of ["stopped_in_flight", "internal_error", "reply_too_large"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one double each
      const failures = await thrown((id) => brokerFail(id, code, `${code} detail`));
      expect(failures.map((failure) => failure.reason)).toEqual(["dropped", "dropped"]);
    }
  });

  test("a daemon that never answers is dropped at the peer's deadline, in the daemon's words and not the relay's", async () => {
    const double = await schedulerDaemon(() => new Promise<BrokerReply>(() => {}));
    try {
      // The fleet probe is answered at once; the scheduler frames are not. One bound covers both, so it is
      // generous enough that the probe is never what times out on a loaded machine.
      const lease = await brokerFleet({ path: double.path, timeoutMs: 1_000 }).open();
      const failure = await rejection(lease.scheduler?.queue() ?? Promise.reject(new Error("no leg")));
      expect(failure).toMatchObject({ reason: "dropped", target: "daemon" });
      if (!(failure instanceof RequestFailure)) throw new Error("expected a RequestFailure");
      expect(failureReasonText(failure)).toContain("the daemon did not answer within 1000ms");
      expect(failureReasonText(failure)).toContain("may have landed anyway");
      expect(failureReasonText(failure)).not.toContain("relay connection");
    } finally {
      await double.stop();
    }
  });

  test("the daemon's own relay failure passes through with its reason, as the direct path throws it", async () => {
    const failures = await thrown((id) => brokerFail(id, "request_failed", "no scheduler is leading", "no_leader"));
    expect(failures.map((failure) => failure.reason)).toEqual(["no_leader", "no_leader"]);
    expect(failures[0]?.message).toBe("no scheduler is leading");
  });

  test("the relay's target survives the wire, so a relay timeout is not worded as a machine's", async () => {
    const failures = await thrown((id) => brokerFail(id, "request_failed", "store-put timed out", "timeout", "relay"));
    for (const failure of failures) {
      expect(failure).toMatchObject({ reason: "timeout", target: "relay" });
      expect(failureReasonText(failure)).toContain("the relay did not answer");
    }
    // An older daemon sends none, and the default is what the direct path's machine ops carry.
    const [bare] = await thrown((id) => brokerFail(id, "request_failed", "no answer", "timeout"));
    expect(bare?.target).toBe("machine");
  });

  test("a request_failed reason this build does not know is dropped, the uncertain class, never refused", async () => {
    // A newer daemon's reason: the parser drops it, which is the shape of a reasonless failure.
    const failures = await thrown((id) => brokerFail(id, "request_failed", "a reason from the future"));
    expect(failures.map((failure) => failure.reason)).toEqual(["dropped", "dropped"]);
    expect(failures[0]?.message).toBe("a reason from the future");
  });

  test("a daemon-side fault keeps the daemon's message instead of the fixed relay line", async () => {
    for (const code of ["internal_error", "stopped_in_flight"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one double each
      const failures = await thrown((id) => brokerFail(id, code, `${code} from the daemon`));
      for (const failure of failures) {
        const text = failureReasonText(failure);
        expect(text).toContain(`${code} from the daemon`);
        expect(text).toContain("may have landed anyway");
        expect(text).not.toContain("relay connection");
      }
    }
    // The direct path's own `dropped` is a lost relay socket, and its line is unchanged.
    expect(failureReasonText(new RequestFailure("dropped", "closed", "relay"))).toBe(
      "lost the relay connection after the request went out — it may have landed anyway",
    );
  });

  test("an enqueue answer that is not a TaskCreated is dropped, not trusted", async () => {
    const failures = await thrown((id) => brokerOk(id, { ok: "maybe" }));
    expect(failures[0]).toMatchObject({ reason: "dropped" });
  });

  test("queue and cancel read a lost answer as null and a malformed one as dropped", async () => {
    const lost = await schedulerDaemon((id) => brokerOk(id, null));
    try {
      const lease = await brokerFleet({ path: lost.path }).open();
      expect(await lease.scheduler?.queue()).toBeNull();
      expect(await lease.scheduler?.cancel(TASK.id)).toBeNull();
    } finally {
      await lost.stop();
    }
    const garbled = await schedulerDaemon((id) => brokerOk(id, { at: "later" }));
    try {
      const lease = await brokerFleet({ path: garbled.path }).open();
      expect(await rejection(lease.scheduler?.queue() ?? Promise.reject(new Error("no leg")))).toMatchObject({
        reason: "dropped",
      });
    } finally {
      await garbled.stop();
    }
  });

  test("accounts read null on any failure and on one unreadable record, never an enqueue failure", async () => {
    const good = [{ accountId: "org-a:me", alias: "personal", version: 1 }];
    const answers: [unknown, typeof good | null][] = [
      [good, good],
      [[...good, { accountId: 3 }], null],
      ["nope", null],
      [null, null],
    ];
    for (const [data, expected] of answers) {
      // oxlint-disable-next-line no-await-in-loop -- one double each
      const double = await schedulerDaemon((id) => brokerOk(id, data));
      try {
        // oxlint-disable-next-line no-await-in-loop -- one double each
        const lease = await brokerFleet({ path: double.path }).open();
        // oxlint-disable-next-line no-await-in-loop -- one double each
        expect(await lease.scheduler?.accounts()).toEqual(expected);
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- one double each
        await double.stop();
      }
    }
    const refusing = await schedulerDaemon((id) => brokerFail(id, "busy", "busy"));
    try {
      const lease = await brokerFleet({ path: refusing.path }).open();
      expect(await lease.scheduler?.accounts()).toBeNull();
    } finally {
      await refusing.stop();
    }
  });
});

describe("enqueueAuto through the brokered leg", () => {
  const REQUEST = { repo: "github.com/m/seance", mode: "worktree", prompt: "fix it" } as const;
  const enqueues = (frames: readonly unknown[]): Record<string, unknown>[] =>
    frames.filter((frame): frame is Record<string, unknown> => isRecord(frame) && frame["schedulerOp"] === "enqueue");

  test("a first enqueue the daemon drops is retried, and the retry carries the same task id", async () => {
    let tries = 0;
    const double = await schedulerDaemon((id) => {
      tries += 1;
      return tries === 1
        ? brokerFail(id, "stopped_in_flight", "the daemon stopped while the request was out")
        : brokerOk(id, { ok: true, landedEarlier: true });
    });
    try {
      const lease = await brokerFleet({ path: double.path }).open();
      if (lease.scheduler === null) throw new Error("expected a scheduler leg");
      const outcome = await enqueueAuto(lease.scheduler, REQUEST, () => {}, "mcp");
      expect(outcome.ok).toBe(true);
      expect(outcome.text).toContain("an earlier try had already stored it");
      const sent = enqueues(double.frames);
      expect(sent).toHaveLength(2);
      expect(typeof sent[0]?.["taskId"]).toBe("string");
      expect(sent[1]?.["taskId"]).toBe(sent[0]?.["taskId"]);
    } finally {
      await double.stop();
    }
  }, 10_000);

  test("a daemon fault is final: one send, no retry, and still worded as possibly queued", async () => {
    // `bad_reply` is minted peer-side, for an answer the daemon sent that is not an enqueue's.
    const cases = [
      { say: (id: string): BrokerReply => brokerFail(id, "internal_error", "boom"), words: "boom" },
      {
        say: (id: string): BrokerReply => brokerOk(id, { ok: "maybe" }),
        words: "the daemon's answer was not readable",
      },
    ];
    for (const { say, words } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one double each
      const double = await schedulerDaemon(say);
      const audited: string[] = [];
      try {
        // oxlint-disable-next-line no-await-in-loop -- one double each
        const lease = await brokerFleet({ path: double.path }).open();
        if (lease.scheduler === null) throw new Error("expected a scheduler leg");
        // oxlint-disable-next-line no-await-in-loop -- one double each
        const outcome = await enqueueAuto(lease.scheduler, REQUEST, (line) => void audited.push(line), "mcp");
        const [only] = enqueues(double.frames);
        expect(enqueues(double.frames)).toHaveLength(1);
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toBe(
          `auto failed: ${words} — task ${String(only?.["taskId"])} may have queued; check get_queue before retrying`,
        );
        expect(audited).toEqual([expect.stringMatching(/^audit enqueue origin=mcp client=mcp .* unanswered$/u)]);
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- one double each
        await double.stop();
      }
    }
  });

  test("a DaemonFault is a RequestFailure, so every direct-path catch still sees one", () => {
    const fault = new DaemonFault("boom");
    expect(fault).toBeInstanceOf(RequestFailure);
    expect(fault).toMatchObject({ reason: "dropped", target: "daemon", message: "boom" });
  });
});
