import { describe, expect, test } from "bun:test";
import { reasonText, type Machine, type Reason, type Task, type TaskState } from "@seance/shared";
import { describeVerdict, type VerdictContent } from "../src/verdict-view.ts";

const NOW = 1_800_000_000_000;

const task = (state: TaskState, extra: Partial<Task> = {}): Task => ({
  id: "t",
  spec: { repo: "github.com/acme/app", mode: "worktree" },
  state,
  createdAt: NOW,
  ...extra,
});

const at = { deviceId: "mac", exclave: "default", clone: "app" };

function verdictOf(t: Task): VerdictContent {
  return describeVerdict({ kind: "queued", task: t }, [], {}, NOW, null);
}

const machine = (deviceId: string, name: string, connected = true): Machine => ({
  deviceId,
  name,
  platform: "darwin",
  repos: [],
  scannedAt: 1,
  lastSeen: NOW,
  connected,
});

describe("a queued verdict's stage track", () => {
  test("waiting is the first bead, reserved the second, placed the third", () => {
    expect(verdictOf(task("queued")).stage).toEqual({ reached: 0 });
    expect(verdictOf(task("blocked")).stage).toEqual({ reached: 0 });
    expect(verdictOf(task("ready")).stage).toEqual({ reached: 0 });
    expect(verdictOf(task("reserved", { reservation: { ...at, expiresAt: NOW + 60_000 } })).stage).toEqual({
      reached: 1,
    });
    expect(verdictOf(task("running", { assignment: at })).stage).toEqual({ reached: 2 });
    expect(verdictOf(task("needs-input", { assignment: at })).stage).toEqual({ reached: 2 });
  });

  test("an outcome is a glyph, not a stage: ended and finished tasks, and a lost one, show none", () => {
    for (const state of ["awaiting-merge", "done", "failed", "cancelled", "lost"] as const) {
      expect(verdictOf(task(state, { assignment: at })).stage).toBeNull();
    }
  });

  test("an unqueued verdict has no track, and offers a retry only when it carries one", () => {
    const lost = describeVerdict({ kind: "unqueued", message: "no answer.", mayHaveLanded: true }, [], {}, NOW, null);
    expect(lost.stage).toBeNull();
    expect(lost.primary.onClick).toBe("back");
    const retry = describeVerdict(
      { kind: "unqueued", message: "no answer.", mayHaveLanded: true, retry: task("queued") },
      [],
      {},
      NOW,
      null,
    );
    expect(retry.primary.onClick).toBe("retry");
  });
});

describe("a queued verdict's body", () => {
  const over: Reason = { code: "quota_over_line", window: "5h", projectedPct: 100 };
  const pinned = (extra: Partial<Task> = {}): Task =>
    task("ready", {
      spec: { repo: "github.com/acme/app", mode: "worktree", pin: { deviceId: "full" } },
      decision: {
        at: NOW,
        chosen: null,
        candidates: [
          { deviceId: "full", machine: "FullBox", exclave: "default", rejected: [over] },
          {
            deviceId: "mac",
            machine: "Mac",
            exclave: "default",
            rejected: [{ code: "pin_mismatch", field: "deviceId" }],
          },
        ],
      },
      ...extra,
    });
  const machines = [machine("full", "FullBox"), machine("mac", "Mac")];

  test("says who the task is pinned to and why it waits, without the pin's own rejections", () => {
    const { body } = describeVerdict({ kind: "queued", task: pinned() }, machines, {}, NOW, null);
    expect(body).toContain("Pinned to FullBox.");
    expect(body).toContain(`Waiting: FullBox · default: ${reasonText(over)}.`);
    expect(body).not.toContain("pinned machine");
  });

  test("a pin on an offline machine says the task waits for it", () => {
    const offline = [machine("full", "FullBox", false)];
    const { body } = describeVerdict(
      { kind: "queued", task: task("queued", { spec: pinned().spec }) },
      offline,
      {},
      NOW,
      null,
    );
    expect(body).toContain("FullBox is offline — the task waits for it.");
  });
});

describe("a Start now refusal on the queued verdict", () => {
  const refusal = { taskId: "t", message: "Something besides the concurrency caps keeps it from every machine." };
  const body = (t: Task, r: typeof refusal | null): string =>
    describeVerdict({ kind: "queued", task: t }, [], {}, NOW, null, r).body;

  test("is said on its own task's verdict while the task still waits", () => {
    expect(body(task("ready"), refusal)).toEndWith(`Couldn't start it at once: ${refusal.message}`);
  });

  test("is not said for another task, nor once a pass placed it after all", () => {
    expect(body(task("ready"), { ...refusal, taskId: "other" })).not.toContain("Couldn't start it");
    const reserved = task("reserved", { reservation: { ...at, expiresAt: NOW + 60_000 } });
    expect(body(reserved, refusal)).not.toContain("Couldn't start it");
    expect(body(task("ready"), null)).not.toContain("Couldn't start it");
  });
});
