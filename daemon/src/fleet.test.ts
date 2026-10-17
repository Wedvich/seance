import { describe, expect, test } from "bun:test";
import { importPsk, toBase64, type Machine } from "@seance/shared";
import { machine } from "../test/fake-app-relay.ts";
import { BrokerError } from "./broker-client.ts";
import { FleetUnreachable, selectFleet, type Fleet, type FleetLease } from "./fleet.ts";

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
