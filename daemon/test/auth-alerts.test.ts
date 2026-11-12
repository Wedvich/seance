import { describe, expect, test } from "bun:test";
import {
  AUTH_ALERTS_MAX,
  AUTH_EXPIRING_MS,
  CAPABILITIES,
  STATUS_STALE_MS,
  type AuthAlerted,
  type Machine,
  type MachineStatus,
} from "@seance/shared";
import { authAlertStep } from "../src/auth-alerts.ts";

const NOW = 1_800_000_000_000;

function machine(
  deviceId: string,
  auth: Pick<MachineStatus, "ax" | "ae" | "au"> | null,
  ids: readonly string[] = ["default", "work"],
  fields: Partial<Machine> = {},
): Machine {
  return {
    deviceId,
    name: deviceId,
    platform: "linux",
    repos: [],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    capabilities: [CAPABILITIES.authHealth],
    exclaves: ids.map((id) => ({ id, accountId: `org:${id}`, extraUsageEnabled: null, authOk: true, skills: [] })),
    ...(auth === null ? {} : { status: { at: NOW / 1000 - 10, scan: NOW, ...auth } }),
    ...fields,
  };
}

const expiring = (index: number, inMs = AUTH_EXPIRING_MS / 2): Pick<MachineStatus, "ae"> => ({
  ae: [[index, Math.round((NOW + inMs) / 1000)]],
});

const held = (deviceId: string, exclave: string, state: AuthAlerted["state"], at = NOW - 1): AuthAlerted => ({
  deviceId,
  exclave,
  state,
  at,
});

describe("authAlertStep", () => {
  test("a lapse alerts once and is recorded; the same reading afterwards changes nothing", () => {
    const first = authAlertStep([machine("a", { ax: [1] })], [], NOW);
    expect(first.alerts).toEqual([{ v: 1, kind: "auth", at: NOW, deviceId: "a", exclave: "work", state: "expired" }]);
    expect(first.next).toEqual([held("a", "work", "expired", NOW)]);
    expect(first.restored).toEqual([]);

    const steady = authAlertStep([machine("a", { ax: [1] })], first.next ?? [], NOW + 60_000);
    expect(steady).toEqual({ alerts: [], next: null, restored: [] });
  });

  test("escalation only: expiring alerts, then expired alerts again, never the reverse", () => {
    const soon = authAlertStep([machine("a", expiring(0))], [], NOW);
    expect(soon.alerts).toMatchObject([{ kind: "auth", exclave: "default", state: "expiring" }]);

    const lapsed = authAlertStep([machine("a", { ax: [0] })], soon.next ?? [], NOW + 1000);
    expect(lapsed.alerts).toMatchObject([{ exclave: "default", state: "expired", at: NOW + 1000 }]);
    expect(lapsed.next).toEqual([held("a", "default", "expired", NOW + 1000)]);

    // An `expiring` reading over a held `expired` entry is no new alert and no downgrade.
    const back = authAlertStep([machine("a", expiring(0))], lapsed.next ?? [], NOW + 2000);
    expect(back).toEqual({ alerts: [], next: null, restored: [] });
  });

  test("an `ae` time already past reads expired and alerts as expired", () => {
    const step = authAlertStep([machine("a", { ae: [[0, Math.round(NOW / 1000) - 5]] })], [], NOW);
    expect(step.alerts).toMatchObject([{ exclave: "default", state: "expired" }]);
  });

  test("ok clears the entry and reports it restored with its own time", () => {
    const entry = held("a", "work", "expired", NOW - 90 * 60_000);
    const step = authAlertStep([machine("a", {})], [entry], NOW);
    expect(step.alerts).toEqual([]);
    expect(step.next).toEqual([]);
    expect(step.restored).toEqual([entry]);
  });

  test("stale and disconnected machines change nothing: no alert, no recovery", () => {
    const entry = held("a", "work", "expired");
    const stale = machine("a", { ax: [] }, undefined, {
      status: { at: (NOW - STATUS_STALE_MS - 1000) / 1000, scan: NOW },
    });
    expect(authAlertStep([stale], [entry], NOW)).toEqual({ alerts: [], next: null, restored: [] });
    const gone = machine("a", {}, undefined, { connected: false });
    expect(authAlertStep([gone], [entry], NOW)).toEqual({ alerts: [], next: null, restored: [] });
    expect(authAlertStep([machine("b", { ax: [0] }, undefined, { connected: false })], [], NOW).alerts).toEqual([]);
  });

  test("unknown neither alerts nor clears: an older daemon, and a fresh daemon that has not read yet", () => {
    const entry = held("a", "work", "expired");
    // No capability: "not listed" means nothing.
    const older = machine("a", {}, undefined, { capabilities: [] });
    expect(authAlertStep([older], [entry], NOW)).toEqual({ alerts: [], next: null, restored: [] });
    // Everything unread (plan review F1): a restart must not read as recovered.
    expect(authAlertStep([machine("a", { au: [0, 1] })], [entry], NOW)).toEqual({
      alerts: [],
      next: null,
      restored: [],
    });
    expect(authAlertStep([machine("a", { au: [0, 1] })], [], NOW).alerts).toEqual([]);
  });

  test("entries for a machine or an exclave gone from the registry drop", () => {
    const entries = [held("a", "work", "expired"), held("b", "default", "expiring"), held("a", "old", "expired")];
    const step = authAlertStep([machine("a", { ax: [1] })], entries, NOW);
    expect(step.alerts).toEqual([]);
    expect(step.next).toEqual([held("a", "work", "expired")]);
  });

  test("a signed-out exclave raises nothing and clears its entry silently", () => {
    const out = machine("a", { ax: [0] }, undefined, {
      exclaves: ["default", "work"].map((id) => ({
        id,
        accountId: null,
        extraUsageEnabled: null,
        authOk: false,
        skills: [],
      })),
    });
    const step = authAlertStep([out], [held("a", "work", "expired")], NOW);
    expect(step.alerts).toEqual([]);
    expect(step.next).toEqual([]);
    expect(step.restored).toEqual([]);
  });

  test("an id the record's parser would refuse is skipped, never stored or pushed", () => {
    const step = authAlertStep([machine("a", { ax: [0] }, ["has space", "work"])], [], NOW);
    expect(step.alerts).toEqual([]);
    expect(step.next).toBeNull();
    expect(authAlertStep([machine("bad id", { ax: [0] })], [], NOW).alerts).toEqual([]);
  });

  test("the cap never evicts a held entry: past it a new lapse is neither alerted nor added, and nothing repeats", () => {
    const ids = Array.from({ length: AUTH_ALERTS_MAX + 1 }, (_, i) => `x${i}`);
    const everyone = ids.slice(0, 9);
    const rest = ids.slice(9);
    const fleet = (): Machine[] => [
      machine("a", { ax: everyone.map((_, i) => i) }, everyone),
      machine("b", { ax: rest.map((_, i) => i) }, rest),
    ];
    const first = authAlertStep(fleet(), [], NOW);
    expect(first.alerts).toHaveLength(AUTH_ALERTS_MAX);
    expect(first.next).toHaveLength(AUTH_ALERTS_MAX);

    // Across a second step (a new term, a later tick) the one that did not fit stays unalerted, the rest silent.
    const second = authAlertStep(fleet(), first.next ?? [], NOW + 1000);
    expect(second).toEqual({ alerts: [], next: null, restored: [] });

    // A held entry still escalates at the cap.
    const entries = first.next ?? [];
    const soon = entries.map((e, i) => (i === 0 ? { ...e, state: "expiring" as const } : e));
    const heldMachines = fleet();
    const escalate = authAlertStep(heldMachines, soon, NOW + 2000);
    expect(escalate.alerts).toHaveLength(1);
    expect(escalate.next).toHaveLength(AUTH_ALERTS_MAX);

    // Once a slot frees, the unalerted one is taken.
    const freed = authAlertStep(fleet(), entries.slice(1), NOW + 3000);
    expect(freed.alerts).toHaveLength(1);
  });

  test("exclaves are told apart by index, not by id order alone: a lapse in one leaves its neighbour held as it was", () => {
    const step = authAlertStep(
      [machine("a", { ax: [0], ...expiring(1) })],
      [held("a", "work", "expiring", NOW - 5)],
      NOW,
    );
    expect(step.alerts).toMatchObject([{ exclave: "default", state: "expired" }]);
    expect(step.next).toEqual([held("a", "work", "expiring", NOW - 5), held("a", "default", "expired", NOW)]);
  });
});
