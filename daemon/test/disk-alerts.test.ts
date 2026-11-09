import { describe, expect, test } from "bun:test";
import { DISK_ALERTS_MAX, MIN_FREE_MIB, STATUS_STALE_MS, type Machine, type MachineStatus } from "@seance/shared";
import { diskAlertStep } from "../src/disk-alerts.ts";

const NOW = 1_800_000_000_000;

function machine(deviceId: string, reading: Partial<MachineStatus> | null, fields: Partial<Machine> = {}): Machine {
  return {
    deviceId,
    name: deviceId,
    platform: "linux",
    repos: [],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    ...(reading === null ? {} : { status: { at: NOW / 1000 - 10, scan: NOW, ...reading } }),
    ...fields,
  };
}

describe("diskAlertStep", () => {
  test("a crossing alerts once and is recorded; the same reading afterwards changes nothing", () => {
    const full = [machine("a", { disk: 93, free: 4000 })];
    const first = diskAlertStep(full, [], NOW);
    expect(first.alerts).toEqual([{ v: 1, kind: "disk", at: NOW, deviceId: "a", diskPct: 93, freeMib: 4000 }]);
    expect(first.next).toEqual([{ deviceId: "a", at: NOW }]);

    const steady = diskAlertStep(full, first.next ?? [], NOW + 60_000);
    expect(steady.alerts).toEqual([]);
    expect(steady.next).toBeNull();
  });

  test("free space under the routing floor alone alerts", () => {
    const step = diskAlertStep([machine("a", { disk: 50, free: MIN_FREE_MIB - 1 })], [], NOW);
    expect(step.alerts).toMatchObject([{ kind: "disk", deviceId: "a", diskPct: 50, freeMib: MIN_FREE_MIB - 1 }]);
    expect(diskAlertStep([machine("a", { disk: 50, free: MIN_FREE_MIB })], [], NOW).alerts).toEqual([]);
  });

  test("a reading with neither figure alerts nothing and re-arms nothing, and a lone figure carries only itself", () => {
    expect(diskAlertStep([machine("a", {})], [], NOW)).toEqual({ alerts: [], next: null });
    // A held machine whose reading lost both figures stays held: no figure is not a recovery.
    expect(diskAlertStep([machine("a", {})], [{ deviceId: "a", at: NOW - 1 }], NOW)).toEqual({
      alerts: [],
      next: null,
    });
    const step = diskAlertStep([machine("a", { disk: 90 })], [], NOW);
    expect(step.alerts).toEqual([{ v: 1, kind: "disk", at: NOW, deviceId: "a", diskPct: 90 }]);
  });

  test("hysteresis: between the lines it stays held; past them it re-arms and alerts again on the next crossing", () => {
    const held = [{ deviceId: "a", at: NOW - 1 }];
    // Below the alert line but not past the re-arm one: held, silent.
    expect(diskAlertStep([machine("a", { disk: 87, free: 4000 })], held, NOW)).toEqual({ alerts: [], next: null });
    // Fill recovered, free space has not: held.
    expect(diskAlertStep([machine("a", { disk: 70, free: MIN_FREE_MIB * 2 - 1 })], held, NOW).next).toBeNull();
    const rearmed = diskAlertStep([machine("a", { disk: 84, free: MIN_FREE_MIB * 2 })], held, NOW);
    expect(rearmed).toEqual({ alerts: [], next: [] });
    const again = diskAlertStep([machine("a", { disk: 95 })], rearmed.next ?? [], NOW + 1000);
    expect(again.alerts).toHaveLength(1);
  });

  test("a stale, absent or disconnected status is ignored: no alert, no re-arm", () => {
    const stale = machine("a", { disk: 99, at: (NOW - STATUS_STALE_MS - 1000) / 1000 });
    const none = machine("b", null);
    const gone = machine("c", { disk: 99 }, { connected: false });
    expect(diskAlertStep([stale, none, gone], [], NOW)).toEqual({ alerts: [], next: null });
    const held = [
      { deviceId: "a", at: 1 },
      { deviceId: "c", at: 1 },
    ];
    const recovered = machine("a", { disk: 10, at: (NOW - STATUS_STALE_MS - 1000) / 1000 });
    expect(diskAlertStep([recovered, machine("c", { disk: 10 }, { connected: false })], held, NOW).next).toBeNull();
  });

  test("a machine gone from the registry is dropped from the list", () => {
    const held = [
      { deviceId: "a", at: 1 },
      { deviceId: "gone", at: 2 },
    ];
    const step = diskAlertStep([machine("a", { disk: 95 })], held, NOW);
    expect(step.alerts).toEqual([]);
    expect(step.next).toEqual([{ deviceId: "a", at: 1 }]);
  });

  test("the list never grows past the record's cap: the oldest alerts go, the newest stay", () => {
    const held = Array.from({ length: DISK_ALERTS_MAX }, (_, i) => ({ deviceId: `m${i}`, at: i + 1 }));
    const fleet = [...held.map((e) => machine(e.deviceId, { disk: 95 })), machine("new", { disk: 95 })];
    const step = diskAlertStep(fleet, held, NOW);
    expect(step.alerts.map((a) => (a.kind === "disk" ? a.deviceId : null))).toEqual(["new"]);
    expect(step.next).toHaveLength(DISK_ALERTS_MAX);
    expect(step.next?.map((e) => e.deviceId)).toEqual([...held.slice(1).map((e) => e.deviceId), "new"]);
  });

  test("several machines in one step alert independently", () => {
    const step = diskAlertStep(
      [machine("a", { disk: 95 }), machine("b", { disk: 10 }), machine("c", { free: 5 })],
      [],
      NOW,
    );
    expect(step.alerts.map((a) => (a.kind === "disk" ? a.deviceId : null))).toEqual(["a", "c"]);
    expect(step.next?.map((e) => e.deviceId)).toEqual(["a", "c"]);
  });
});
