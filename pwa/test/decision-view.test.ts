import { describe, expect, test } from "bun:test";
import { reasonText, type Candidate, type Decision, type Machine, type Reason, type Task } from "@seance/shared";
import { describeDecision, taskHeadline } from "../src/decision-view.ts";

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;

function machine(deviceId: string, name: string, connected = true): Machine {
  return { deviceId, name, platform: "darwin", repos: [], scannedAt: 1, lastSeen: NOW, connected };
}

const scored = (deviceId: string, name: string, total: number, observedAgoS = 180): Candidate => ({
  deviceId,
  machine: name,
  exclave: "default",
  clone: "app",
  rejected: [],
  score: {
    components: { accountPressure: 0.25, machinePressure: 0.4, dependencyDistance: 0, queuePressure: 1 },
    sticky: 0,
    total,
  },
  quota: { observedAt: NOW_S - observedAgoS, observer: deviceId, source: "session" },
});

const rejected = (deviceId: string, name: string, reasons: readonly Reason[]): Candidate => ({
  deviceId,
  machine: name,
  exclave: "work",
  rejected: reasons,
});

describe("describeDecision", () => {
  const decision: Decision = {
    at: NOW,
    chosen: { deviceId: "mac", exclave: "default", clone: "app" },
    candidates: [
      scored("mac", "Mac", 1.5),
      scored("wsl", "WSL", 2.75, 7200),
      rejected("lxc", "LXC", [{ code: "offline" }, { code: "quota_unknown", why: "unobserved" }]),
    ],
  };

  test("chose X because its score was lowest, with every component and the quota's age as the cards word it", () => {
    const summary = describeDecision(decision, [machine("mac", "Mac"), machine("wsl", "WSL")], NOW, "would");
    expect(summary.headline).toBe("Would start on Mac · default.");
    expect(summary.chosen).toEqual({
      id: "mac/default",
      where: "Mac · default",
      outcome: "chosen",
      why: "lowest score — score 1.50 (account 0.25 · load 40% · queue 1)",
      quota: "quota: session · 3m ago on Mac",
    });
  });

  test("a loser that scored says by how much; a rejected one gives every reason", () => {
    const summary = describeDecision(decision, [machine("mac", "Mac"), machine("wsl", "WSL", false)], NOW, "did");
    expect(summary.headline).toBe("Placed on Mac · default.");
    expect(summary.others).toEqual([
      {
        id: "wsl/default",
        where: "WSL · default",
        outcome: "scored",
        why: "scored higher, score 2.75 (account 0.25 · load 40% · queue 1) against 1.50",
        // An asleep observer is named as such, as on the account card.
        quota: "quota: session · 2h ago on WSL, asleep",
      },
      {
        id: "lxc/work",
        where: "LXC · work",
        outcome: "rejected",
        why: "offline, its account's quota has never been observed",
        quota: null,
      },
    ]);
  });

  test("an exact tie says so, and how it was broken, rather than claiming the loser scored higher", () => {
    const tied: Decision = { ...decision, candidates: [scored("mac", "Mac", 1.5), scored("wsl", "WSL", 1.5)] };
    expect(describeDecision(tied, [], NOW, "would").others[0]?.why).toBe(
      "tied, score 1.50 (account 0.25 · load 40% · queue 1) — a tie goes to the lower device id",
    );
    // Two exclaves of one machine share its device id, so the exclave is what broke it.
    const sameMachine: Decision = {
      ...decision,
      candidates: [scored("mac", "Mac", 1.5), { ...scored("mac", "Mac", 1.5), exclave: "work" }],
    };
    expect(describeDecision(sameMachine, [], NOW, "would").others[0]?.why).toBe(
      "tied, score 1.50 (account 0.25 · load 40% · queue 1) — a tie goes to the exclave sorted first",
    );
  });

  test("nothing placeable is said plainly, in both tenses, and an empty fleet apart from a full one", () => {
    const none: Decision = { at: NOW, chosen: null, candidates: [rejected("lxc", "LXC", [{ code: "repo_absent" }])] };
    expect(describeDecision(none, [], NOW, "would").headline).toBe("No machine can take it right now.");
    expect(describeDecision(none, [], NOW, "did").headline).toBe("Waiting — no machine can take it yet.");
    expect(describeDecision({ at: NOW, chosen: null, candidates: [] }, [], NOW, "would").headline).toBe(
      "No machine is registered to take it.",
    );
  });

  test("a record the leader cut says how many it left out, and cut to nothing is still a full fleet", () => {
    expect(describeDecision(decision, [], NOW, "did").omitted).toBeNull();
    const cut: Decision = { ...decision, candidates: decision.candidates.slice(0, 1), trimmed: 2 };
    const summary = describeDecision(cut, [], NOW, "did");
    expect(summary.headline).toBe("Placed on Mac · default.");
    expect(summary.others).toEqual([]);
    expect(summary.omitted).toEqual({ count: 2, text: "2 more not shown — left out to keep the record small" });
    const none = describeDecision({ at: NOW, chosen: null, candidates: [], trimmed: 5 }, [], NOW, "did");
    expect(none.headline).toBe("Waiting — no machine can take it yet.");
    expect(none.omitted?.count).toBe(5);
  });

  test("a candidate whose reasons this build could not read still reads as rejected", () => {
    const unknown: Decision = { at: NOW, chosen: null, candidates: [rejected("lxc", "LXC", [])] };
    expect(describeDecision(unknown, [], NOW, "would").others[0]?.why).toBe(
      "rejected for a reason this app can't read — update it",
    );
  });

  test("credits spill and a continuation's bonus are part of the why", () => {
    const base = scored("mac", "Mac", 0.5);
    const sticky: Candidate = {
      ...base,
      score: { components: { ...base.score!.components, dependencyDistance: 0.25 }, sticky: 2, total: 0.5 },
      spill: { window: "7d", projectedPct: 93.4 },
    };
    const summary = describeDecision(
      { at: NOW, chosen: { deviceId: "mac", exclave: "default", clone: "app" }, candidates: [sticky] },
      [],
      NOW,
      "would",
    );
    expect(summary.chosen?.why).toBe(
      "lowest score — score 0.50 (account 0.25 · load 40% · queue 1 · distance 0.25 · continuation −2.00) — would spend credits (7d at 93%)",
    );
  });
});

test("every reason has its own words", () => {
  const reasons: readonly Reason[] = [
    { code: "status_stale" },
    { code: "task_id_unsupported" },
    { code: "exclaves_unknown" },
    { code: "disk_low", freeMib: 512 },
    { code: "pressure_unknown" },
    { code: "pin_mismatch", field: "exclave" },
    { code: "auth_missing" },
    { code: "quota_unknown", why: "trimmed" },
    { code: "quota_over_line", window: "5h", projectedPct: 91.6 },
    { code: "cap_reached", inFlight: 8, max: 8 },
    { code: "cap_reached", inFlight: 2, max: 2, scope: "account" },
    { code: "cap_reached", inFlight: 1, max: 1, scope: "batch" },
    { code: "batch_order", index: 2 },
    { code: "paused", until: "resume", scope: "queue" },
    { code: "paused", until: "reset", scope: "account" },
  ];
  const texts = reasons.map(reasonText);
  expect(new Set(texts).size).toBe(reasons.length);
  expect(texts).toContain("disk nearly full (512 MiB free)");
  expect(texts).toContain("5h quota would reach 92%");
  expect(texts).toContain("8 of 8 auto tasks already in flight");
  expect(texts).toContain("its batch runs in order, and member 2 has not ended yet");
});

describe("taskHeadline", () => {
  const task = (fields: Partial<Task>): Task => ({
    id: "t1",
    spec: { repo: "github.com/acme/app", mode: "worktree" },
    state: "ready",
    createdAt: NOW,
    ...fields,
  });
  const machines = [machine("mac", "Mac")];
  const at = { deviceId: "mac", exclave: "default", clone: "app" };

  test("follows the task from queued to placed, by machine name", () => {
    expect(taskHeadline(task({}), machines, NOW)).toBe("Queued — waiting for a machine.");
    expect(taskHeadline(task({ state: "reserved", reservation: { ...at, expiresAt: NOW } }), machines, NOW)).toBe(
      "Starting on Mac · default…",
    );
    expect(taskHeadline(task({ state: "running", assignment: at }), machines, NOW)).toBe(
      "It's running on Mac · default.",
    );
  });

  test("a lost task says its machine went away, and when", () => {
    expect(taskHeadline(task({ state: "lost", assignment: at, absentSince: NOW - 20 * 60_000 }), machines, NOW)).toBe(
      "Lost on Mac · default — its machine went away 20m ago.",
    );
  });

  test("a cancel that could not reach its machine, and a spawn never confirmed, say what may still run", () => {
    expect(taskHeadline(task({ state: "cancelled", assignment: at, leftRunning: true }), machines, NOW)).toBe(
      "Cancelled — its session may still be running on Mac · default.",
    );
    expect(taskHeadline(task({ state: "cancelled", assignment: at }), machines, NOW)).toBe("Cancelled.");
    const unconfirmed = { code: "dispatch_unconfirmed", message: "never confirmed" };
    expect(taskHeadline(task({ state: "failed", assignment: at, failure: unconfirmed }), machines, NOW)).toBe(
      "Never confirmed on Mac · default — it may have started there.",
    );
  });
});
