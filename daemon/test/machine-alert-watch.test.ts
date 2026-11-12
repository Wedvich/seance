import { describe, expect, test } from "bun:test";
import { CAPABILITIES, type AuthAlerted, type Machine, type PushAlert, type SettingsRecord } from "@seance/shared";
import { createMachineAlertWatch } from "../src/machine-alerts.ts";
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

/**
 * The settings holder over a store with the relay's version rule; `refuse` fails that many puts first.
 * `lose` loses the answer of that many puts after them (`indeterminate`), committed when `landed`.
 */
async function setup(refuse = 0, lose = 0, landed = true) {
  let held: SettingsRecord = { version: 1, vapid: await generateVapidKeys(), subscriptions: [] };
  let refusing = refuse;
  let losing = lose;
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
      if (losing > 0) {
        losing -= 1;
        if (landed) held = { ...record, version: at + 1 };
        return { ok: false, code: "indeterminate" };
      }
      held = { ...record, version: at + 1 };
      return { ok: true, version: at + 1 };
    },
  };
  const settings = createTermSettings({ store, term: 1, log: { warn: () => {} } });
  await settings.load();
  return { settings, puts, record: () => held };
}

/** `setup`'s store with the loss armed later: the next put loses its answer, committed when `landed`. */
async function restoreSetup() {
  let held: SettingsRecord = { version: 1, vapid: await generateVapidKeys(), subscriptions: [] };
  let losing: boolean | null = null;
  const store: SettingsStore = {
    get: async () => ({ version: held.version, record: held }),
    put: async (at, record): Promise<SettingsWrite> => {
      if (held.version !== at) return { ok: false, code: "version_conflict" };
      if (losing !== null) {
        if (losing) held = { ...record, version: at + 1 };
        losing = null;
        return { ok: false, code: "indeterminate" };
      }
      held = { ...record, version: at + 1 };
      return { ok: true, version: at + 1 };
    },
  };
  const settings = createTermSettings({ store, term: 1, log: { warn: () => {} } });
  await settings.load();
  return {
    settings,
    record: () => held,
    lose: (landed: boolean): void => {
      losing = landed;
    },
  };
}

/** A machine with exclaves `default` and `work`, signed in, whose status carries `auth` beside a clean disk. */
const authMachine = (deviceId: string, auth: { ax?: number[]; au?: number[] }): Machine => ({
  ...machine(deviceId, 10),
  capabilities: [CAPABILITIES.authHealth],
  exclaves: ["default", "work"].map((id) => ({
    id,
    accountId: `org:${id}`,
    extraUsageEnabled: null,
    authOk: true,
    skills: [],
  })),
  status: { at: NOW / 1000 - 10, scan: NOW, disk: 10, ...auth },
});

function watchOver(settings: TermSettings, machines: { current: readonly Machine[] }, ready = () => true) {
  const raised: PushAlert[] = [];
  const restored: AuthAlerted[] = [];
  const clock = { now: NOW };
  const watch = createMachineAlertWatch({
    settings: () => settings,
    ready,
    machines: () => machines.current,
    onAlert: (alert) => raised.push(alert),
    onRestored: (entry) => restored.push(entry),
    onError: (err) => {
      throw err;
    },
    now: () => clock.now,
    minGapMs: 30_000,
  });
  return { watch, raised, restored, clock };
}

describe("createMachineAlertWatch", () => {
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

  test("a write whose answer was lost, but landed, is still pushed once, by the next check", async () => {
    const { settings, puts, record } = await setup(0, 1, true);
    const fleet = { current: [machine("a", 95)] };
    const { watch, raised, clock } = watchOver(settings, fleet);
    watch.check(false);
    await pollUntil(() => puts.length === 1, "the write whose answer was lost");
    await Bun.sleep(20);
    expect(raised).toEqual([]);

    clock.now += 1000;
    watch.check(false);
    await pollUntil(() => raised.length === 1, "the alert, once the record shows it landed");
    expect(raised).toMatchObject([{ kind: "disk", deviceId: "a", at: NOW }]);
    expect(record().diskAlerts).toEqual([{ deviceId: "a", at: NOW }]);

    clock.now += 1000;
    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toHaveLength(1);
  });

  test("a write whose answer was lost and did not land alerts once, when the next check writes it", async () => {
    const { settings, record } = await setup(0, 1, false);
    const fleet = { current: [machine("a", 95)] };
    const { watch, raised, clock } = watchOver(settings, fleet);
    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toEqual([]);
    expect(record().diskAlerts).toBeUndefined();

    clock.now += 1000;
    watch.check(false);
    await pollUntil(() => raised.length === 1, "the alert of the write that did land");
    expect(raised).toMatchObject([{ deviceId: "a", at: NOW + 1000 }]);
    expect(record().diskAlerts).toEqual([{ deviceId: "a", at: NOW + 1000 }]);

    clock.now += 1000;
    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toHaveLength(1);
  });

  test("a lost answer is settled even when the disk has recovered by the next check: told once, then re-armed", async () => {
    const { settings, record } = await setup(0, 1, true);
    const fleet = { current: [machine("a", 95)] };
    const { watch, raised, clock } = watchOver(settings, fleet);
    watch.check(false);
    await pollUntil(() => record().diskAlerts !== undefined, "the write that landed");
    fleet.current = [machine("a", 50)];
    clock.now += 1000;
    watch.check(false);
    await pollUntil(() => raised.length === 1, "the crossing's alert");
    expect(raised).toMatchObject([{ deviceId: "a", at: NOW }]);
    expect(record().diskAlerts ?? []).toEqual([]);
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

  test("a login alert is raised only after its write landed, and the list carries it", async () => {
    const { settings, puts, record } = await setup();
    const fleet = { current: [authMachine("a", { ax: [1] })] };
    const { watch, raised } = watchOver(settings, fleet);
    watch.check(false);
    await pollUntil(() => raised.length === 1, "the login alert");
    expect(raised).toEqual([{ v: 1, kind: "auth", at: NOW, deviceId: "a", exclave: "work", state: "expired" }]);
    expect(record().authAlerts).toEqual([{ deviceId: "a", exclave: "work", state: "expired", at: NOW }]);
    expect(puts).toHaveLength(1);
    // The disk list stays absent when empty.
    expect(record().diskAlerts).toBeUndefined();

    watch.check(false);
    await Bun.sleep(20);
    expect(raised).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  test("a lost login-alert write that landed is raised once by the next check; one that did not is re-raised afresh", async () => {
    const landed = await setup(0, 1, true);
    const fleet = { current: [authMachine("a", { ax: [0] })] };
    const first = watchOver(landed.settings, fleet);
    first.watch.check(false);
    await pollUntil(() => landed.puts.length === 1, "the write whose answer was lost");
    await Bun.sleep(20);
    expect(first.raised).toEqual([]);
    first.clock.now += 1000;
    first.watch.check(false);
    await pollUntil(() => first.raised.length === 1, "the alert, once the record shows it landed");
    expect(first.raised).toMatchObject([{ kind: "auth", exclave: "default", at: NOW }]);

    const lost = await setup(0, 1, false);
    const second = watchOver(lost.settings, fleet);
    second.watch.check(false);
    await Bun.sleep(20);
    expect(second.raised).toEqual([]);
    second.clock.now += 1000;
    second.watch.check(false);
    await pollUntil(() => second.raised.length === 1, "the alert of the write that did land");
    expect(second.raised).toMatchObject([{ kind: "auth", exclave: "default", at: NOW + 1000 }]);
  });

  test("disk and login changes in one check make one write", async () => {
    const { settings, puts, record } = await setup();
    const full = { ...authMachine("a", { ax: [0] }), status: { at: NOW / 1000 - 10, scan: NOW, disk: 95, ax: [0] } };
    const { watch, raised } = watchOver(settings, { current: [full] });
    watch.check(false);
    await pollUntil(() => raised.length === 2, "both alerts");
    expect(puts).toHaveLength(1);
    expect(raised.map((a) => a.kind).toSorted()).toEqual(["auth", "disk"]);
    expect(record().diskAlerts).toEqual([{ deviceId: "a", at: NOW }]);
    expect(record().authAlerts).toHaveLength(1);
  });

  test("a recovery clears the entry and reports it restored once the write landed; an unread status clears nothing", async () => {
    const { settings, record } = await setup();
    const fleet = { current: [authMachine("a", { ax: [0] })] };
    const { watch, raised, restored, clock } = watchOver(settings, fleet);
    watch.check(false);
    await pollUntil(() => raised.length === 1, "the alert");

    fleet.current = [authMachine("a", { au: [0, 1] })];
    clock.now += 1000;
    watch.check(false);
    await Bun.sleep(20);
    expect(restored).toEqual([]);
    expect(record().authAlerts).toHaveLength(1);

    fleet.current = [authMachine("a", {})];
    clock.now += 1000;
    watch.check(false);
    await pollUntil(() => restored.length === 1, "the restored entry");
    expect(restored).toEqual([{ deviceId: "a", exclave: "default", state: "expired", at: NOW }]);
    expect(record().authAlerts).toBeUndefined();
    expect(raised).toHaveLength(1);
  });

  test("a clearing write whose answer was lost is still reported restored, once, whether or not it landed", async () => {
    for (const landed of [true, false]) {
      const { settings, record, lose } = await restoreSetup();
      const fleet = { current: [authMachine("a", { ax: [0] })] };
      const { watch, raised, restored, clock } = watchOver(settings, fleet);
      watch.check(false);
      // oxlint-disable-next-line no-await-in-loop -- one scenario after the other
      await pollUntil(() => raised.length === 1, "the alert");

      lose(landed);
      fleet.current = [authMachine("a", {})];
      clock.now += 1000;
      watch.check(false);
      // Negative: the answer was lost, so nothing is reported yet.
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(20);
      expect(restored).toEqual([]);

      clock.now += 1000;
      watch.check(false);
      // oxlint-disable-next-line no-await-in-loop
      await pollUntil(() => restored.length === 1, `the restored entry (landed: ${landed})`);
      expect(restored).toEqual([{ deviceId: "a", exclave: "default", state: "expired", at: NOW }]);
      expect(record().authAlerts).toBeUndefined();

      // Settled: a further check reports nothing more.
      clock.now += 1000;
      watch.check(false);
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(20);
      expect(restored).toHaveLength(1);
    }
  });
});
