import { describe, expect, test } from "bun:test";
import type { Machine, PushAlert, SettingsRecord } from "@seance/shared";
import { createDiskWatch } from "../src/disk-alerts.ts";
import { pollUntil } from "./fixtures.ts";
import { createTermSettings, type TermSettings } from "../src/settings.ts";
import type { SettingsStore, SettingsWrite } from "../src/settings-store.ts";
import { generateVapidKeys } from "../src/web-push.ts";

const NOW = 1_800_000_000_000;

const machine = (deviceId: string, disk: number): Machine => ({
  deviceId,
  name: deviceId,
  platform: "linux",
  repos: [],
  scannedAt: NOW,
  lastSeen: NOW,
  connected: true,
  status: { at: NOW / 1000 - 10, scan: NOW, disk },
});

/** The settings holder over a store with the relay's version rule; `refuse` fails that many puts first. */
async function setup(refuse = 0) {
  let held: SettingsRecord = { version: 1, vapid: await generateVapidKeys(), subscriptions: [] };
  let refusing = refuse;
  const puts: (readonly string[])[] = [];
  const store: SettingsStore = {
    get: async () => ({ version: held.version, record: held }),
    put: async (at, record): Promise<SettingsWrite> => {
      if (refusing > 0) {
        refusing -= 1;
        return { ok: false, code: "refused" };
      }
      if (held.version !== at) return { ok: false, code: "version_conflict" };
      puts.push((record.diskAlerts ?? []).map((e) => e.deviceId));
      held = { ...record, version: at + 1 };
      return { ok: true, version: at + 1 };
    },
  };
  const settings = createTermSettings({ store, term: 1, log: { warn: () => {} } });
  await settings.load();
  return { settings, puts, record: () => held };
}

function watchOver(settings: TermSettings, machines: { current: readonly Machine[] }, ready = () => true) {
  const raised: PushAlert[] = [];
  const clock = { now: NOW };
  const watch = createDiskWatch({
    settings: () => settings,
    ready,
    machines: () => machines.current,
    onAlert: (alert) => raised.push(alert),
    onError: (err) => {
      throw err;
    },
    now: () => clock.now,
    minGapMs: 30_000,
  });
  return { watch, raised, clock };
}

describe("createDiskWatch", () => {
  test("a crossing writes the list first and raises the alert once it landed; a steady reading writes nothing more", async () => {
    const { settings, puts, record } = await setup();
    const fleet = { current: [machine("a", 95)] };
    const { watch, raised } = watchOver(settings, fleet);
    watch.check(false);
    await pollUntil(() => raised.length === 1, "the alert");
    expect(puts).toEqual([["a"]]);
    expect(record().diskAlerts).toEqual([{ deviceId: "a", at: NOW }]);
    // The vapid pair and subscriptions ride the same write untouched.
    expect(record().vapid).toBeDefined();

    // A non-event cannot be polled: the second check has had its turn once the loop yields.
    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  test("a refused write raises nothing, and the next check recomputes and alerts", async () => {
    const { settings, puts } = await setup(1);
    const fleet = { current: [machine("a", 95)] };
    const { watch, raised } = watchOver(settings, fleet);
    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toEqual([]);
    expect(puts).toEqual([]);

    watch.check(false);
    await pollUntil(() => raised.length === 1, "the retried alert");
    expect(puts).toEqual([["a"]]);
  });

  test("a debounced check within the gap is skipped; one past it runs; a forced one always does", async () => {
    const { settings, puts } = await setup();
    const fleet = { current: [machine("a", 10)] };
    const { watch, raised, clock } = watchOver(settings, fleet);
    watch.check(true);
    fleet.current = [machine("a", 95)];
    clock.now += 10_000;
    watch.check(true);
    await Bun.sleep(20);
    expect(raised).toEqual([]);

    clock.now += 20_000;
    watch.check(true);
    await pollUntil(() => raised.length === 1, "the check past the gap");
    expect(puts).toHaveLength(1);

    fleet.current = [machine("a", 95), machine("b", 96)];
    clock.now += 1;
    watch.check(false);
    await pollUntil(() => raised.length === 2, "the forced check");
  });

  test("nothing runs before the term's settings are ready", async () => {
    const { settings, puts } = await setup();
    const { watch, raised } = watchOver(settings, { current: [machine("a", 95)] }, () => false);
    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toEqual([]);
    expect(puts).toEqual([]);
  });
});
