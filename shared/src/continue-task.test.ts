import { describe, expect, test } from "bun:test";
import type { Machine } from "./app-client.ts";
import {
  continuationSpec,
  continuationUnderway,
  continueOffer,
  newestLanded,
  offeredSpec,
  waitingContinuation,
  type OfferContext,
} from "./continue-task.ts";
import { blockedBrief } from "./pr-blocked.ts";
import { parseTaskSpec } from "./parse.ts";
import {
  CAPABILITIES,
  LAUNCH_LEDGER_MAX_AGE_MS,
  type Assignment,
  type Target,
  type Task,
  type TaskSpec,
} from "./types.ts";

const assignment: Assignment = { deviceId: "dev-a", exclave: "default", clone: "app", window: "w", pane: "%1" };

function machine(capabilities: readonly string[] | undefined, deviceId = "dev-a"): Machine {
  return {
    deviceId,
    name: "Box",
    platform: "linux",
    repos: [],
    scannedAt: 0,
    lastSeen: 0,
    connected: true,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function failed(over: Partial<Task> = {}, spec: Partial<TaskSpec> = {}): Task {
  return {
    id: "t-old",
    spec: { repo: "github.com/acme/app", mode: "worktree", prompt: "do it", ...spec },
    state: "failed",
    createdAt: 1,
    assignment,
    failure: { code: "session_failed", message: "exited", exit: 137 },
    ...over,
  };
}

const able = [machine([CAPABILITIES.continueTask, CAPABILITIES.continueSession])];

describe("continueOffer", () => {
  test("a placed session_failed task on a machine that advertises it is offered, at its own target", () => {
    expect(continueOffer(failed(), able, [])).toEqual({
      ok: true,
      at: { deviceId: "dev-a", exclave: "default", clone: "app" },
    });
  });

  test("each way it is not offered says why", () => {
    const refusals: readonly (readonly [string, Task, readonly Machine[]])[] = [
      ["not failed", failed({ state: "running" }), able],
      ["another failure", failed({ failure: { code: "lost_expired", message: "lost" } }), able],
      ["no failure at all", failed({ failure: undefined }), able],
      ["here mode", failed({}, { mode: "here" }), able],
      ["never placed", failed({ assignment: undefined }), able],
      ["machine unlisted", failed(), [machine([CAPABILITIES.continueTask, CAPABILITIES.continueSession], "dev-other")]],
      ["machine lacks the capability", failed(), [machine([CAPABILITIES.taskId])]],
      // An older daemon would run `--continue`, which misses a worktree spawn's conversation.
      ["machine continues without session ids", failed(), [machine([CAPABILITIES.continueTask])]],
      ["machine predates capabilities", failed(), [machine(undefined)]],
    ];
    for (const [name, task, machines] of refusals) {
      const offer = continueOffer(task, machines, []);
      expect(offer.ok, name).toBe(false);
      expect(offer.ok ? "" : offer.reason.length, name).toBeGreaterThan(0);
    }
  });
});

describe("continueOffer, a cancelled task", () => {
  const cancelled = (over: Partial<Task> = {}): Task => failed({ state: "cancelled", failure: undefined, ...over });
  const both = [machine([CAPABILITIES.continueTask, CAPABILITIES.continueSession, CAPABILITIES.continueCancelled])];

  test("offered with an assignment on a machine advertising both capabilities, leftRunning or not", () => {
    const at = { deviceId: "dev-a", exclave: "default", clone: "app" };
    expect(continueOffer(cancelled(), both, [])).toEqual({ ok: true, at });
    expect(continueOffer(cancelled({ leftRunning: true }), both, [])).toEqual({ ok: true, at });
  });

  test("refused without continueCancelled, naming the update", () => {
    const offer = continueOffer(cancelled(), able, []);
    expect(offer.ok).toBe(false);
    expect(offer.ok ? "" : offer.reason).toContain("continue a cancelled session");
  });

  test("refused with no assignment, or when its session had already finished", () => {
    const reasonOf = (task: Task): string => {
      const offer = continueOffer(task, both, []);
      return offer.ok ? "" : offer.reason;
    };
    expect(reasonOf(cancelled({ assignment: undefined }))).toContain("cancelled before it started");
    expect(reasonOf(cancelled({ endedAt: 5 }))).toContain("had already finished");
  });

  test("a session_closed task is offered like a session_failed one", () => {
    const closed = failed({ failure: { code: "session_closed", message: "its window was closed" } });
    expect(continueOffer(closed, able, [closed])).toEqual({ ok: true, at: expect.anything() });
  });

  test("done and every failure but session_failed and session_closed are never offered", () => {
    const refused: readonly Task[] = [
      failed({ state: "done", failure: undefined }),
      ...["lost_expired", "merge_expired", "dispatch_unconfirmed", "continue_expired", "pin_expired"].map((code) =>
        failed({ failure: { code, message: "m" } }),
      ),
    ];
    for (const task of refused) expect(continueOffer(task, both, []).ok, task.failure?.code ?? task.state).toBe(false);
  });
});

describe("continueOffer, once", () => {
  const old = failed();
  const both = [machine([CAPABILITIES.continueTask, CAPABILITIES.continueSession, CAPABILITIES.continueCancelled])];
  const continuation = (
    state: Task["state"],
    over: Partial<Task> = {},
    continues = "t-old",
    id = `t-${state}`,
  ): Task => ({
    id,
    spec: {
      repo: old.spec.repo,
      mode: "continue",
      continues: { task: continues, at: { deviceId: "dev-a", exclave: "default", clone: "app" } },
    },
    state,
    createdAt: 2,
    ...over,
  });
  const failing = (code: string): Task => continuation("failed", { failure: { code, message: "m" } });

  test("a continuation that landed holds the offer", () => {
    for (const state of ["reserved", "running", "needs-input", "lost", "awaiting-merge", "done"] as const) {
      const offer = continueOffer(old, able, [old, continuation(state)]);
      expect(offer.ok, state).toBe(false);
      expect(offer.ok ? "" : offer.reason, state).toContain("already underway or finished");
    }
  });

  test("one that failed after landing, or was cancelled after placement, holds it and names itself", () => {
    const takers = [
      failing("session_failed"),
      failing("session_closed"),
      failing("lost_expired"),
      failing("merge_expired"),
      continuation("cancelled", { assignment }),
    ];
    for (const taker of takers) {
      const offer = continueOffer(old, both, [old, taker]);
      expect(offer.ok, taker.state).toBe(false);
      expect(offer.ok ? "" : offer.reason, taker.state).toContain(taker.id);
    }
  });

  test("a finished taker is pointed at only when it could itself be continued", () => {
    const reasonOf = (taker: Task): string => {
      const offer = continueOffer(old, both, [old, taker]);
      return offer.ok ? "" : offer.reason;
    };
    for (const taker of [
      failing("session_failed"),
      failing("session_closed"),
      continuation("cancelled", { assignment }),
    ]) {
      expect(reasonOf(taker)).toContain("continue that one instead");
    }
    for (const taker of [
      failing("lost_expired"),
      failing("merge_expired"),
      continuation("cancelled", { assignment, endedAt: 5 }),
    ]) {
      const reason = reasonOf(taker);
      expect(reason).toContain("nothing left to continue");
      expect(reason).not.toContain("continue that one instead");
    }
  });

  test("one still waiting withholds it, naming itself; another task's waiting one does not", () => {
    for (const state of ["queued", "blocked", "ready"] as const) {
      const y = continuation(state);
      expect(waitingContinuation(old, [old, y]), state).toBe(y);
      const offer = continueOffer(old, both, [old, y]);
      expect(offer.ok, state).toBe(false);
      expect(offer.ok ? "" : offer.reason, state).toBe(
        `already continuing as task ${y.id}, which is still waiting in the queue`,
      );
    }
    const elsewhere = continuation("queued", {}, "t-other");
    expect(waitingContinuation(old, [old, elsewhere])).toBeUndefined();
    expect(continueOffer(old, able, [old, elsewhere]).ok).toBe(true);
  });

  test("of several waiting, the oldest is named whatever the list order", () => {
    const older = continuation("ready", { createdAt: 5 }, "t-old", "t-older");
    const newer = continuation("queued", { createdAt: 9 }, "t-old", "t-newer");
    expect(waitingContinuation(old, [old, newer, older])).toBe(older);
    expect(waitingContinuation(old, [old, older, newer])).toBe(older);
  });

  test("a landed taker outranks a waiting one: the offer moves to the taker", () => {
    const taker = failing("session_failed");
    const waiting = continuation("queued", {}, "t-old", "t-waiting");
    expect(waitingContinuation(old, [old, waiting, taker])).toBeUndefined();
    const offer = continueOffer(old, both, [old, waiting, taker]);
    expect(offer.ok ? "" : offer.reason).toContain("continue that one instead");
  });

  test("one that ended without landing leaves it open; so does another task's", () => {
    const open: readonly Task[] = [
      failing("not_continuable"),
      failing("continue_expired"),
      failing("dispatch_unconfirmed"),
      continuation("failed"),
      continuation("cancelled"),
    ];
    for (const y of open) {
      expect(waitingContinuation(old, [old, y])).toBeUndefined();
      expect(continueOffer(old, able, [old, y]).ok, `${y.state} ${y.failure?.code}`).toBe(true);
    }
    expect(continueOffer(old, able, [old, continuation("running", {}, "t-other")]).ok).toBe(true);
  });

  test("along a chain the newest landed task holds the offer", () => {
    const y = continuation("failed", { failure: { code: "session_failed", message: "m" }, assignment }, "t-old", "t-y");
    const z = continuation("running", {}, "t-y", "t-z");
    expect(continueOffer(old, able, [old, y, z]).ok).toBe(false);
    expect(continueOffer(y, able, [old, y, z]).ok).toBe(false);
    const expired = continuation("failed", { failure: { code: "continue_expired", message: "m" } }, "t-y", "t-z");
    expect(continueOffer(y, able, [old, y, expired]).ok).toBe(true);
    const waiting = continuation("ready", {}, "t-y", "t-z");
    const offer = continueOffer(y, able, [old, y, waiting]);
    expect(offer.ok ? "" : offer.reason).toContain("task t-z, which is still waiting");
    expect(continueOffer(old, able, [old, y, waiting]).ok).toBe(false);
  });
});

describe("continuationSpec", () => {
  const at = { deviceId: "dev-a", exclave: "default", clone: "app" };

  test("copies what shapes and settles the session, drops what places or orders it", () => {
    const task = failed(
      {},
      {
        title: "fix it",
        model: "opus",
        effort: "high",
        autonomy: "auto",
        until: "reported",
        linear: { issue: "ENG-1" },
        skill: "ship",
        pin: { deviceId: "dev-z" },
        avoid: ["dev-y"],
        lineage: { deviceId: "dev-x", exclave: "default" },
        base: { deviceId: "dev-x", exclave: "default" },
        batch: { id: "b", index: 1 },
        deps: [{ task: "t-0", after: "merged" }],
        client: "pwa",
        // The files were the first launch's; a continuation finds them in the worktree, and the mode refuses them.
        attachments: [
          {
            id: "0b6f0c9e-1a2b-4c3d-8e9f-001122334455",
            name: "a.png",
            type: "image/png",
            size: 1,
            hash: "A".repeat(43),
          },
        ],
      },
    );
    const spec = continuationSpec(task, at);
    expect(spec).toEqual({
      repo: "github.com/acme/app",
      mode: "continue",
      title: "fix it",
      model: "opus",
      effort: "high",
      autonomy: "auto",
      until: "reported",
      linear: { issue: "ENG-1" },
      continues: { task: "t-old", at },
    });
    // The result is a spec a leader's parser keeps whole.
    expect(parseTaskSpec(spec)).toEqual(spec);
  });

  test("a steer task continues at checkpoint, out of plan mode, however it asked for steer", () => {
    for (const fields of [{ plan: true, autonomy: "steer" }, { plan: true }] as const) {
      const spec = continuationSpec(failed({}, fields), at);
      expect(spec.autonomy).toBe("checkpoint");
      expect(spec).not.toHaveProperty("plan");
      expect(parseTaskSpec(spec)).toEqual(spec);
    }
  });

  test("the old prompt is not carried; a note is, trimmed, and a blank one is left out", () => {
    expect(continuationSpec(failed(), at)).not.toHaveProperty("prompt");
    expect(continuationSpec(failed(), at, "  \n ")).not.toHaveProperty("prompt");
    expect(continuationSpec(failed(), at, "  retry the build  ").prompt).toBe("retry the build");
  });
});

describe("continuationUnderway", () => {
  const link = (id: string, continues: string, state: Task["state"]): Task => ({
    id,
    state,
    createdAt: 2,
    spec: {
      repo: "github.com/acme/app",
      mode: "worktree",
      continues: { task: continues, at: { deviceId: "dev-a", exclave: "default", clone: "app" } },
    },
  });
  const origin = failed({ id: "t-0", state: "awaiting-merge" });

  test("no continuation, or only finished ones, is not underway", () => {
    expect(continuationUnderway(origin, [origin])).toBe(false);
    expect(continuationUnderway(origin, [origin, link("t-1", "t-0", "done")])).toBe(false);
    expect(continuationUnderway(origin, [origin, link("t-1", "t-0", "failed"), link("t-2", "t-9", "queued")])).toBe(
      false,
    );
  });

  test("a waiting, dispatching or placed continuation is", () => {
    for (const state of ["queued", "blocked", "ready", "reserved", "running", "needs-input", "lost"] as const) {
      expect(continuationUnderway(origin, [origin, link("t-1", "t-0", state)])).toBe(true);
    }
  });

  test("the walk follows a chain, where a later continuation continues the previous one", () => {
    const chain = [origin, link("t-1", "t-0", "done"), link("t-2", "t-1", "running")];
    expect(continuationUnderway(origin, chain)).toBe(true);
    expect(continuationUnderway(origin, chain.toReversed())).toBe(true);
  });

  test("a cycle ends the walk", () => {
    const a = link("t-a", "t-b", "done");
    const b = link("t-b", "t-a", "done");
    expect(continuationUnderway(a, [a, b])).toBe(false);
  });
});

const continuationAt: Target = { deviceId: "dev-a", exclave: "default", clone: "app" };

function continuationOf(id: string, state: Task["state"], continues = "t-old"): Task {
  return {
    id,
    state,
    createdAt: 2,
    spec: { repo: "github.com/acme/app", mode: "continue", continues: { task: continues, at: continuationAt } },
  };
}

describe("continueOffer, an awaiting-merge task whose PR is blocked", () => {
  const caps = [CAPABILITIES.continueTask, CAPABILITIES.continueSession, CAPABILITIES.continueHandoff] as const;
  const handoffable = [machine(caps)];
  const stuck = (over: Partial<Task> = {}, spec: Partial<TaskSpec> = {}): Task =>
    failed(
      {
        state: "awaiting-merge",
        failure: undefined,
        prUrl: "https://github.com/acme/app/pull/7",
        pr: { state: "open", required: "failing", failing: ["test (ubuntu)", "lint"], merge: "blocked", at: 1 },
        ...over,
      },
      spec,
    );
  const context = { now: 2, leaderHandoff: true } as const;
  const target = { deviceId: "dev-a", exclave: "default", clone: "app" };

  test("is offered, resuming the task itself, with the fixed brief naming the PR and the failing checks", () => {
    const offer = continueOffer(stuck(), handoffable, [], context);
    expect(offer).toMatchObject({ ok: true, at: target });
    if (!offer.ok) return;
    expect(offer).not.toHaveProperty("resumes");
    expect(offer.brief).toContain("https://github.com/acme/app/pull/7");
    expect(offer.brief).toContain("Failing required checks: test (ubuntu), lint.");
    expect(offer.brief).toContain("hand_off_task");
  });

  test("each way it is not offered says why", () => {
    const refusals: readonly (readonly [
      string,
      Task,
      readonly Machine[],
      readonly Task[],
      OfferContext | undefined,
    ])[] = [
      ["the PR is not blocked", stuck({ pr: { state: "open", merge: "clean", at: 1 } }), handoffable, [], context],
      ["until: reported", stuck({}, { until: "reported" }), handoffable, [], context],
      ["no context", stuck(), handoffable, [], undefined],
      ["the leader lacks it", stuck(), handoffable, [], { now: 2, leaderHandoff: false }],
      ["the machine lacks continueHandoff", stuck(), able, [], context],
      ["a continuation waits in the list", stuck(), handoffable, [continuationOf("t-c", "queued")], context],
      [
        "the pointer says live",
        stuck({ continuedBy: { task: "t-c", createdAt: 2, live: true } }),
        handoffable,
        [],
        context,
      ],
      ["here mode", stuck({}, { mode: "here" }), handoffable, [], context],
      ["never placed", stuck({ assignment: undefined }), handoffable, [], context],
    ];
    for (const [name, task, machines, tasks, ctx] of refusals) {
      const offer = continueOffer(task, machines, tasks, ctx);
      expect(offer.ok, name).toBe(false);
      expect(offer.ok ? "" : offer.reason.length, name).toBeGreaterThan(0);
    }
  });

  test("the leader's pointer names the session to resume, with an empty list", () => {
    const task = stuck({ continuedBy: { task: "t-c1", createdAt: 2 } });
    const offer = continueOffer(task, handoffable, [], context);
    expect(offer).toMatchObject({ ok: true, resumes: "t-c1", at: target });
  });

  test("a session older than the launch ledger keeps is refused, from the task and from the pointer; the bound itself is offered", () => {
    const bound = LAUNCH_LEDGER_MAX_AGE_MS;
    expect(continueOffer(stuck(), handoffable, [], { now: 1 + bound, leaderHandoff: true }).ok).toBe(true);
    expect(continueOffer(stuck(), handoffable, [], { now: 2 + bound, leaderHandoff: true }).ok).toBe(false);
    const pointed = stuck({ continuedBy: { task: "t-c1", createdAt: 100 } });
    expect(continueOffer(pointed, handoffable, [], { now: 100 + bound, leaderHandoff: true }).ok).toBe(true);
    const old = continueOffer(pointed, handoffable, [], { now: 101 + bound, leaderHandoff: true });
    expect(old.ok).toBe(false);
  });

  test("failed and cancelled offers take no context and are unchanged", () => {
    expect(continueOffer(failed(), able, [])).toEqual({ ok: true, at: target });
    expect(continueOffer(failed(), able, [], context)).toEqual({ ok: true, at: target });
  });

  test("offeredSpec resumes the offer's session, from the tapped task's spec, with the brief ahead of the note", () => {
    const task = stuck({ continuedBy: { task: "t-c1", createdAt: 2 } }, { model: "opus" });
    const offer = continueOffer(task, handoffable, [], context);
    if (!offer.ok) throw new Error(offer.reason);
    const spec = offeredSpec(task, offer, "  mind the lockfile  ");
    expect(spec.continues).toEqual({ task: "t-c1", at: target });
    expect(spec.model).toBe("opus");
    expect(spec.prompt).toBe(`${offer.brief}\n\nmind the lockfile`);
    expect(offeredSpec(task, offer).prompt).toBe(offer.brief);
    const plain = continueOffer(stuck(), handoffable, [], context);
    if (!plain.ok) throw new Error(plain.reason);
    expect(offeredSpec(stuck(), plain).continues).toEqual({ task: "t-old", at: target });
  });
});

describe("blockedBrief", () => {
  test("each reason's sentence, and no failing line without names", () => {
    const task = failed({ state: "awaiting-merge", prUrl: "https://github.com/acme/app/pull/7" });
    expect(blockedBrief(task, "conflict")).toContain("merge conflicts with its base branch");
    expect(blockedBrief(task, "behind")).toContain("behind its base branch");
    expect(blockedBrief(task, "unarmed")).toContain("gh pr merge --auto");
    expect(blockedBrief(task, "checks")).not.toContain("Failing required checks");
  });
});

describe("newestLanded", () => {
  const origin = failed({ id: "t-0", state: "awaiting-merge", failure: undefined });
  const link = (id: string, continues: string, state: Task["state"], over: Partial<Task> = {}): Task => ({
    ...continuationOf(id, state, continues),
    ...over,
  });

  test("walks a chain to its newest landed link", () => {
    const chain = [origin, link("t-1", "t-0", "done"), link("t-2", "t-1", "running")];
    expect(newestLanded(origin, chain)?.id).toBe("t-2");
  });

  test("a continuation still waiting, or one that never landed, is not it", () => {
    expect(newestLanded(origin, [origin, link("t-1", "t-0", "queued")])).toBeUndefined();
    const unlanded = link("t-1", "t-0", "failed", { failure: { code: "dispatch_unconfirmed", message: "x" } });
    expect(newestLanded(origin, [origin, unlanded])).toBeUndefined();
  });

  test("of several landed at one link, the newest, a tie going to the greater id", () => {
    const a = link("t-a", "t-0", "done", { createdAt: 5 });
    const b = link("t-b", "t-0", "done", { createdAt: 9 });
    const c = link("t-c", "t-0", "done", { createdAt: 9 });
    expect(newestLanded(origin, [a, b, c])?.id).toBe("t-c");
    expect(newestLanded(origin, [c, b, a])?.id).toBe("t-c");
  });

  test("a cycle ends the walk", () => {
    const a = link("t-a", "t-b", "done");
    const b = link("t-b", "t-a", "done");
    expect(newestLanded(a, [a, b])).toBeDefined();
  });
});
