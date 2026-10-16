import { describe, expect, test } from "bun:test";
import { METRIC_NAMES, type ExclaveInfo, type Machine, type MetricsSeries } from "@seance/shared";
import { accountSeries, chartLines } from "../src/chart.ts";
import { deriveMachines } from "../src/machines-view.ts";

const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const ACCOUNT = "org-1:acct-aaaaaaaa-1111";

function exclave(id: string, accountId: string | null): ExclaveInfo {
  return { id, accountId, extraUsageEnabled: null, authOk: accountId !== null, skills: [] };
}

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-1",
    name: "mac",
    platform: "darwin",
    repos: [],
    scannedAt: 1,
    lastSeen: NOW,
    connected: true,
    capabilities: ["metrics"],
    exclaves: [exclave("default", ACCOUNT)],
    ...overrides,
  };
}

describe("deriveMachines", () => {
  test("a daemon that predates exclaves still renders, marked as such", () => {
    const { exclaves: _, ...old } = machine();
    const [card] = deriveMachines([old], NOW).cards;
    expect(card?.name).toBe("mac");
    expect(card?.note).toContain("predates exclaves");
    expect(card?.exclaves).toEqual([]);
  });

  // Disk is in the status for the scheduler's free-space floor, never on the card.
  test("pressure renders from the status alone, indexed sessions land on their exclave", () => {
    const status = { at: S - 10, scan: 1, cpu: 95, mem: 80, disk: 99, free: 10, sess: [2] };
    const [card] = deriveMachines([machine({ status })], NOW).cards;
    expect(card?.gauges.map((gauge) => [gauge.label, gauge.level])).toEqual([
      ["CPU", "err"],
      ["Memory", "warn"],
    ]);
    expect(card?.exclaves[0]?.sessions).toBe(2);
    expect(card?.charts).toBe(true);
  });

  // The relay still lists a slept Mac's socket while a timed-out request has marked it asleep:
  // its 17-minute-old beat read as CPU 85% beside "last seen 17m ago".
  test("an asleep card draws no pressure or sessions from its last status; its quota still counts", () => {
    const status = {
      at: S - 17 * 60,
      scan: 1,
      cpu: 85,
      mem: 39,
      sess: [2],
      quota: [{ x: 0, h: 7, s: "cache" as const, at: S - 18 * 60 }],
    };
    const { cards, accounts } = deriveMachines(
      [machine({ connected: false, lastSeen: NOW - 17 * 60_000, status })],
      NOW,
    );
    expect(cards[0]?.meta).toStartWith("asleep · last seen");
    expect(cards[0]?.gauges).toEqual([]);
    expect(cards[0]?.exclaves[0]?.sessions).toBeNull();
    expect(accounts[0]?.bars.map((bar) => bar.pct)).toEqual([7]);
  });

  test("an account across machines takes the newest observation; unsigned exclaves group nowhere", () => {
    const older = machine({
      deviceId: "a",
      name: "a",
      exclaves: [exclave("default", ACCOUNT), exclave("scratch", null)],
      status: { at: S, scan: 1, quota: [{ x: 0, h: 10, s: "cache", at: S - 600 }] },
    });
    const newer = machine({
      deviceId: "b",
      name: "b",
      exclaves: [exclave("work", ACCOUNT)],
      status: { at: S, scan: 1, quota: [{ x: 0, h: 50, s: "cache", at: S - 60 }] },
    });
    const { accounts } = deriveMachines([older, newer], NOW);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.title).toBe("default · work");
    expect(accounts[0]?.bars.map((bar) => bar.pct)).toEqual([50]);
    expect(accounts[0]?.observed).toContain("on b");
    expect(accounts[0]?.historyFrom).toBe("b");
  });

  test("a window past its reset reads empty, however full the reading was", () => {
    const quota = [
      {
        x: 0,
        s: "cache" as const,
        at: S - 5 * 3600,
        h: 92,
        hr: S - 60,
        d: 43,
        dr: S + 5 * 86_400,
        w: [{ m: "Fable", p: 27, r: S - 1 }],
      },
    ];
    const [account] = deriveMachines([machine({ status: { at: S, scan: 1, quota } })], NOW).accounts;
    expect(account?.bars.map((bar) => [bar.label, bar.pct, bar.level, bar.resets])).toEqual([
      ["5h", 0, "ok", "reset"],
      ["7d", 43, "ok", "resets in 5d"],
      ["7d Fable", 0, "ok", "reset"],
    ]);
  });

  // The newest observer is asleep, or predates `metrics`: any online host still
  // has some history, and with none the card offers no chart at all.
  test("an account's history comes from another online host when the newest can't serve it", () => {
    const quota = (
      at: number,
    ): { at: number; scan: number; quota: { x: number; h: number; s: "cache"; at: number }[] } => ({
      at: S,
      scan: 1,
      quota: [{ x: 0, h: 10, s: "cache", at }],
    });
    const serving = machine({ deviceId: "a", status: quota(S - 600) });
    const old = machine({ deviceId: "b", capabilities: [], status: quota(S - 60) });
    expect(deriveMachines([serving, old], NOW).accounts[0]?.historyFrom).toBe("a");

    const asleep = machine({ deviceId: "a", connected: false });
    expect(deriveMachines([asleep, old], NOW).accounts[0]?.historyFrom).toBeNull();
  });
});

function series(metric: string, points: [number, number][], labels: Record<string, string> = {}): MetricsSeries {
  return { metric, labels, points };
}

describe("chartLines", () => {
  const window = { from: 0, to: 300, step: 30 };
  const size = { width: 300, height: 100 };

  test("a gauge breaks at one missed tick and drops points outside the window", () => {
    const [line] = chartLines(
      [
        series(METRIC_NAMES.cpu, [
          [-30, 1],
          [0, 0],
          [30, 50],
          [90, 100],
          [330, 1],
        ]),
      ],
      window,
      size,
    );
    // 90 is a run of one, so it is drawn as a dot; the gap before it is bridged apart, dotted.
    expect([line?.d, line?.gaps]).toEqual(["M0 100L30 50M90 0h0", "M30 50L90 0"]);
  });

  // What a Mac in clamshell sleep leaves: one tick per dark wake, each alone.
  test("lone points between gaps are dots, each gap bridged once", () => {
    const [line] = chartLines(
      [
        series(METRIC_NAMES.cpu, [
          [0, 50],
          [120, 50],
          [240, 0],
          [270, 0],
        ]),
      ],
      window,
      size,
    );
    expect(line?.d).toBe("M0 50h0M120 50h0M240 100L270 100");
    expect(line?.gaps).toBe("M0 50L120 50M120 50L240 100");
  });

  test("a quota series holds its level between observations, across any gap", () => {
    const [line] = chartLines(
      [
        series(METRIC_NAMES.h, [
          [0, 0],
          [240, 50],
        ]),
      ],
      window,
      size,
    );
    expect([line?.d, line?.gaps]).toEqual(["M0 100H240V50", ""]);
  });
});

describe("accountSeries", () => {
  // A machine with two exclaves signed in as one account reports the same
  // windows twice; the chart draws each window once, labelled by window alone.
  test("keeps one account's quota windows, folded across exclaves", () => {
    const other = "org-1:acct-bbbbbbbb-2222";
    const folded = accountSeries(
      [
        series(METRIC_NAMES.cpu, [[0, 50]], { account: ACCOUNT }),
        series(
          METRIC_NAMES.h,
          [
            [0, 10],
            [60, 20],
          ],
          { exclave: "default", account: ACCOUNT },
        ),
        series(
          METRIC_NAMES.h,
          [
            [30, 15],
            [60, 25],
          ],
          { exclave: "work", account: ACCOUNT },
        ),
        series(METRIC_NAMES.w, [[0, 70]], { exclave: "default", account: ACCOUNT, model: "Fable" }),
        series(METRIC_NAMES.h, [[0, 99]], { exclave: "home", account: other }),
      ],
      ACCOUNT,
    );
    expect(folded).toEqual([
      {
        metric: METRIC_NAMES.h,
        labels: {},
        points: [
          [0, 10],
          [30, 15],
          [60, 25],
        ],
      },
      { metric: METRIC_NAMES.w, labels: { model: "Fable" }, points: [[0, 70]] },
    ]);
    expect(
      chartLines(folded, { from: 0, to: 60, step: 30 }, { width: 60, height: 100 }).map((line) => line.label),
    ).toEqual(["5h", "7d Fable"]);
  });
});
