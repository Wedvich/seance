import { describe, expect, test } from "bun:test";
import { GITHUB_ALERTS_MAX, STATUS_STALE_MS, type GithubRate, type Machine } from "@seance/shared";
import { githubAlertStep } from "../src/github-alerts.ts";

const NOW = 1_800_000_000_000;
const RESET = NOW / 1000 + 1_200;

function machine(deviceId: string, gh: GithubRate | null, fields: Partial<Machine> = {}): Machine {
  return {
    deviceId,
    name: deviceId,
    platform: "linux",
    repos: [],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    status: { at: NOW / 1000 - 10, scan: NOW, ...(gh === null ? {} : { gh }) },
    ...fields,
  };
}

const plenty = [5000, 4000, RESET] as const;
const low = [5000, 999, RESET] as const;

describe("githubAlertStep", () => {
  test("one alert per user and budget however many machines read it, and none again in the window", () => {
    const fleet = [machine("a", { u: 7, c: low, g: plenty }), machine("b", { u: 7, c: [5000, 600, RESET], g: plenty })];
    const first = githubAlertStep(fleet, [], NOW);
    expect(first.alerts).toEqual([{ v: 1, kind: "github", at: NOW, resource: "core", reset: RESET }]);
    expect(first.next).toEqual([{ u: 7, r: "core", reset: RESET, at: NOW }]);

    const steady = githubAlertStep(fleet, first.next ?? [], NOW + 60_000);
    expect(steady).toEqual({ alerts: [], next: null });
  });

  test("the line is a fifth of the limit, and each budget alerts on its own", () => {
    expect(githubAlertStep([machine("a", { u: 7, c: [5000, 1000, RESET] })], [], NOW).alerts).toEqual([]);
    const both = githubAlertStep([machine("a", { u: 7, c: low, g: [5000, 10, RESET] })], [], NOW);
    expect(both.alerts.map((a) => (a.kind === "github" ? a.resource : null))).toEqual(["core", "graphql"]);
  });

  test("two GitHub users are two budgets", () => {
    const step = githubAlertStep([machine("a", { u: 7, c: low }), machine("b", { u: 8, c: low })], [], NOW);
    expect(step.next).toEqual([
      { u: 7, r: "core", reset: RESET, at: NOW },
      { u: 8, r: "core", reset: RESET, at: NOW },
    ]);
    expect(step.alerts).toHaveLength(2);
  });

  test("a reading without a user, a stale or disconnected one, or one past its reset says nothing", () => {
    expect(githubAlertStep([machine("a", { c: low })], [], NOW)).toEqual({ alerts: [], next: null });
    const staleStatus: Machine = {
      ...machine("a", null),
      status: { at: (NOW - STATUS_STALE_MS - 1000) / 1000, scan: NOW, gh: { u: 7, c: low } },
    };
    expect(githubAlertStep([staleStatus], [], NOW).alerts).toEqual([]);
    expect(githubAlertStep([machine("a", { u: 7, c: low }, { connected: false })], [], NOW).alerts).toEqual([]);
    expect(githubAlertStep([machine("a", { u: 7, c: [5000, 0, NOW / 1000] })], [], NOW).alerts).toEqual([]);
  });

  test("an entry goes once its reset passed, and the next window alerts again", () => {
    const held = [{ u: 7, r: "core" as const, reset: RESET, at: NOW }];
    const later = (RESET + 1) * 1000;
    const next = [5000, 500, RESET + 3_600] as const;
    const reading: Machine = {
      ...machine("a", null),
      status: { at: later / 1000 - 10, scan: NOW, gh: { u: 7, c: next } },
    };
    const step = githubAlertStep([reading], held, later);
    expect(step.alerts).toEqual([{ v: 1, kind: "github", at: later, resource: "core", reset: RESET + 3_600 }]);
    expect(step.next).toEqual([{ u: 7, r: "core", reset: RESET + 3_600, at: later }]);
    // No reading at all still clears a lapsed entry.
    expect(githubAlertStep([], held, later)).toEqual({ alerts: [], next: [] });
  });

  test("a full list is never evicted to make room: the newcomer waits for a slot", () => {
    const held = Array.from({ length: GITHUB_ALERTS_MAX }, (_, i) => ({
      u: 100 + i,
      r: "core" as const,
      reset: RESET,
      at: NOW - 1,
    }));
    expect(githubAlertStep([machine("a", { u: 7, c: low })], held, NOW)).toEqual({ alerts: [], next: null });
  });
});
