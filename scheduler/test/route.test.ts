import { describe, expect, test } from "bun:test";
import type { Machine } from "@seance/shared";
import { DEFAULT_CONFIG, route, type Candidate, type Decision, type SchedulerConfig, type Task } from "../src/index.ts";
import { clone, exclave, machine, NOW, NOW_S, obs, spec, status } from "./fixtures.ts";

function task(fields: Partial<Task> = {}): Task {
  return { id: "t", spec: spec(), state: "ready", createdAt: NOW, ...fields };
}

function decide(
  machines: readonly Machine[],
  fields: { task?: Task; tasks?: readonly Task[]; config?: Partial<SchedulerConfig> } = {},
): Decision {
  return route({
    task: fields.task ?? task(),
    machines,
    tasks: fields.tasks ?? [],
    now: NOW,
    config: { ...DEFAULT_CONFIG, ...fields.config },
  });
}

function only(decision: Decision): Candidate {
  expect(decision.candidates).toHaveLength(1);
  const [candidate] = decision.candidates;
  if (candidate === undefined) throw new Error("no candidate");
  return candidate;
}

function codes(candidate: Candidate): string[] {
  return candidate.rejected.map((r) => r.code);
}

/** An in-flight task held on `deviceId`'s `main` exclave. */
function held(id: string, deviceId: string, state: Task["state"] = "running"): Task {
  const target = { deviceId, exclave: "main", clone: "app" };
  return task({
    id,
    state,
    ...(state === "reserved" ? { reservation: { ...target, expiresAt: NOW + 1 } } : { assignment: target }),
  });
}

describe("filter", () => {
  test("a healthy machine is scored and chosen", () => {
    const decision = decide([machine("a")]);
    expect(only(decision).rejected).toEqual([]);
    expect(decision.chosen).toEqual({ deviceId: "a", exclave: "main", clone: "app" });
  });

  test("offline: a disconnected machine is filtered even with its kept status, which still lends its quota", () => {
    // The laptop slept with a fresher reading of the shared account than the desktop has.
    const laptop = machine("laptop", {
      connected: false,
      exclaves: [exclave("main", "org:shared")],
      status: status({ at: NOW_S - 3600, quota: [obs(0, { h: 70, at: NOW_S - 3600 })] }),
    });
    const desktop = machine("desktop", {
      exclaves: [exclave("main", "org:shared")],
      status: status({ quota: [obs(0, { h: 5, at: NOW_S - 7200 })] }),
    });
    const decision = decide([laptop, desktop]);
    const [chosen, rejected] = decision.candidates;
    expect(codes(rejected ?? chosen!)).toEqual(["offline"]);
    expect(chosen?.deviceId).toBe("desktop");
    expect(chosen?.quota).toEqual({ observedAt: NOW_S - 3600, observer: "laptop", source: "session" });
  });

  test("status_stale: connected with no status, or one older than three beats", () => {
    expect(codes(only(decide([machine("a", { status: undefined })])))).toContain("status_stale");
    const stale = only(decide([machine("a", { status: status({ at: NOW_S - 91, quota: [obs(0)] }) })]));
    expect(codes(stale)).toEqual(["status_stale"]);
  });

  test("task_id_unsupported: a daemon not advertising taskId is never reserved against", () => {
    const decision = decide([machine("a", { capabilities: ["metrics"] })]);
    expect(codes(only(decision))).toEqual(["task_id_unsupported"]);
    expect(decision.chosen).toBeNull();
    expect(codes(only(decide([machine("a", { capabilities: undefined })])))).toEqual(["task_id_unsupported"]);
  });

  test("exclaves_unknown: a daemon predating exclaves is one exclave-less candidate", () => {
    const candidate = only(decide([machine("a", { exclaves: undefined, status: status() })]));
    expect(candidate.exclave).toBeNull();
    expect(codes(candidate)).toEqual(["exclaves_unknown"]);
  });

  test("exclaves_unknown: an empty list is recorded the same way, not dropped from the record", () => {
    const candidate = only(decide([machine("a", { exclaves: [], status: status() })]));
    expect(candidate.exclave).toBeNull();
    expect(codes(candidate)).toEqual(["exclaves_unknown"]);
  });

  test("disk_low: under the 1 GiB floor; an unreported free is not a reason", () => {
    const low = only(decide([machine("a", { status: status({ free: 1023, quota: [obs(0)] }) })]));
    expect(low.rejected).toEqual([{ code: "disk_low", freeMib: 1023 }]);
    const { free: _free, ...unreported } = status({ quota: [obs(0)] });
    expect(only(decide([machine("a", { status: unreported })])).rejected).toEqual([]);
  });

  test("pressure_unknown: a status with neither cpu nor mem", () => {
    const candidate = only(decide([machine("a", { status: { at: NOW_S, scan: 1, quota: [obs(0)] } })]));
    expect(codes(candidate)).toEqual(["pressure_unknown"]);
  });

  test("pin_mismatch: by machine and by exclave", () => {
    const fleet = [
      machine("a", {
        exclaves: [exclave("main", "org:a"), exclave("work", "org:w")],
        repos: [clone("app", "main"), clone("app-1", "work")],
        status: status({ quota: [obs(0), obs(1)] }),
      }),
      machine("b"),
    ];
    const decision = decide(fleet, { task: task({ spec: spec({ pin: { deviceId: "a", exclave: "work" } }) }) });
    expect(decision.chosen).toEqual({ deviceId: "a", exclave: "work", clone: "app-1" });
    const reasons = Object.fromEntries(decision.candidates.map((c) => [`${c.deviceId}/${c.exclave}`, c.rejected]));
    expect(reasons["a/main"]).toEqual([{ code: "pin_mismatch", field: "exclave" }]);
    expect(reasons["b/main"]).toEqual([
      { code: "pin_mismatch", field: "deviceId" },
      { code: "pin_mismatch", field: "exclave" },
    ]);
  });

  test("repo_absent: an exclave with no clone of the task's origin, whatever the local name", () => {
    const candidate = only(decide([machine("a", { repos: [clone("app", "main", "github.com/acme/other")] })]));
    expect(codes(candidate)).toEqual(["repo_absent"]);
    expect(candidate.clone).toBeUndefined();
  });

  test("auth_missing: signed out, or a config dir without a signed-in account", () => {
    expect(codes(only(decide([machine("a", { exclaves: [exclave("main", null)] })])))).toEqual(["auth_missing"]);
    const revoked = machine("a", { exclaves: [exclave("main", "org:a", { authOk: false })] });
    expect(codes(only(decide([revoked])))).toEqual(["auth_missing"]);
  });

  describe("quota_unknown — never scored as 0%", () => {
    test("an account no status carries is filtered, even where 0% would have won", () => {
      const unobserved = machine("idle", { status: status({ cpu: 0, mem: 0 }) });
      const busy = machine("busy", { status: status({ cpu: 60, mem: 60, quota: [obs(0, { h: 60, d: 60 })] }) });
      const decision = decide([unobserved, busy]);
      expect(decision.chosen?.deviceId).toBe("busy");
      const idle = decision.candidates.find((c) => c.deviceId === "idle");
      expect(idle?.rejected).toEqual([{ code: "quota_unknown", why: "unobserved" }]);
      expect(idle?.score).toBeUndefined();
    });

    test("an observation with no window in it is no reading", () => {
      const empty = machine("a", { status: status({ quota: [{ x: 0, s: "cache", at: NOW_S }] }) });
      expect(only(decide([empty])).rejected).toEqual([{ code: "quota_unknown", why: "unobserved" }]);
    });

    test("trimmed out of a hosting status, with only an older reading elsewhere", () => {
      const trimmed = machine("a", {
        exclaves: [exclave("main", "org:a"), exclave("work", "org:shared")],
        repos: [clone("app", "work")],
        status: status({ quota: [obs(0)], tr: 1 }),
      });
      const older = machine("b", {
        connected: false,
        exclaves: [exclave("main", "org:shared")],
        repos: [],
        status: status({ at: NOW_S - 600, quota: [obs(0, { at: NOW_S - 600 })] }),
      });
      const candidate = decide([trimmed, older]).candidates.find((c) => c.exclave === "work");
      expect(candidate?.rejected).toEqual([{ code: "quota_unknown", why: "trimmed" }]);
    });

    test("trimmed, but a reading newer than the trimmed status exists: known", () => {
      const trimmed = machine("a", {
        exclaves: [exclave("main", "org:a"), exclave("work", "org:shared")],
        repos: [clone("app", "work")],
        status: status({ at: NOW_S - 30, quota: [obs(0)], tr: 1 }),
      });
      const newer = machine("b", {
        exclaves: [exclave("main", "org:shared")],
        repos: [],
        status: status({ quota: [obs(0, { at: NOW_S - 5 })] }),
      });
      const candidate = decide([trimmed, newer]).candidates.find((c) => c.exclave === "work");
      expect(candidate?.rejected).toEqual([]);
      expect(candidate?.quota?.observer).toBe("b");
    });

    test("a trimmed status that still carries the account leaves it known", () => {
      const candidate = only(decide([machine("a", { status: status({ quota: [obs(0)], tr: 0 }) })]));
      expect(candidate.rejected).toEqual([]);
    });
  });

  describe("quota_over_line", () => {
    test("projected usage — current plus the estimate — over 90% filters", () => {
      const at85 = only(decide([machine("a", { status: status({ quota: [obs(0, { h: 85 })] }) })]));
      expect(at85.rejected).toEqual([]);
      const at86 = only(decide([machine("a", { status: status({ quota: [obs(0, { h: 86 })] }) })]));
      expect(at86.rejected).toEqual([{ code: "quota_over_line", window: "5h", projectedPct: 91 }]);
    });

    test("every in-flight task on the account adds an estimate", () => {
      const fleet = [machine("a", { status: status({ quota: [obs(0, { d: 81 })] }) })];
      expect(only(decide(fleet, { tasks: [held("x", "a")] })).rejected).toEqual([
        { code: "quota_over_line", window: "7d", projectedPct: 91 },
      ]);
      expect(only(decide(fleet)).rejected).toEqual([]);
    });

    test("a per-model weekly counts like the all-models one", () => {
      const fleet = [machine("a", { status: status({ quota: [obs(0, { w: [{ m: "Fable", p: 88 }] })] }) })];
      expect(only(decide(fleet)).rejected).toEqual([{ code: "quota_over_line", window: "7d Fable", projectedPct: 93 }]);
    });

    test("a window resetting within 15 min counts as empty; one past its reset reads 0%", () => {
      const soon = obs(0, { h: 99, hr: NOW_S + 14 * 60 });
      expect(only(decide([machine("a", { status: status({ quota: [soon] }) })])).rejected).toEqual([]);
      const later = obs(0, { h: 99, hr: NOW_S + 16 * 60 });
      expect(codes(only(decide([machine("a", { status: status({ quota: [later] }) })])))).toEqual(["quota_over_line"]);
      const past = obs(0, { h: 99, hr: NOW_S - 1, at: NOW_S - 6 * 3600 });
      expect(only(decide([machine("a", { status: status({ quota: [past] }) })])).rejected).toEqual([]);
    });

    test("extra usage on: not filtered, scored, and flagged as a credits spill", () => {
      const fleet = [
        machine("a", {
          exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
          status: status({ quota: [obs(0, { h: 95 })] }),
        }),
      ];
      const candidate = only(decide(fleet));
      expect(candidate.rejected).toEqual([]);
      expect(candidate.spill).toEqual({ window: "5h", projectedPct: 100 });
      expect(candidate.score).toBeDefined();
    });

    test("extra usage unknown (null) reads as off", () => {
      const fleet = [
        machine("a", {
          exclaves: [exclave("main", "org:a", { extraUsageEnabled: null })],
          status: status({ quota: [obs(0, { h: 95 })] }),
        }),
      ];
      expect(codes(only(decide(fleet)))).toEqual(["quota_over_line"]);
    });
  });

  test("cap_reached: the global max counts every in-flight task, reserved included", () => {
    const tasks = [held("x", "b"), held("y", "b", "reserved"), task({ id: "z", state: "done" })];
    const candidate = only(decide([machine("a")], { tasks, config: { globalMax: 2 } }));
    expect(candidate.rejected).toEqual([{ code: "cap_reached", inFlight: 2, max: 2 }]);
  });

  test("every reason that applies is recorded, not just the first", () => {
    const candidate = only(
      decide([machine("a", { connected: false, capabilities: [], exclaves: [exclave("main", null)], repos: [] })]),
    );
    expect(codes(candidate)).toEqual(["offline", "task_id_unsupported", "repo_absent", "auth_missing"]);
  });
});

describe("score", () => {
  test("account_pressure: the convex cost at projected usage, worst window wins", () => {
    // 45% + 5% = 50% → (0.5/0.5)² = 1; the 7d window at 20% + 5% costs (0.25/0.75)² ≈ 0.11.
    const candidate = only(decide([machine("a", { status: status({ quota: [obs(0, { h: 45, d: 20 })] }) })]));
    expect(candidate.score?.components.accountPressure).toBeCloseTo(1, 10);
  });

  test("account_pressure: discounted by the share of the window still to run", () => {
    const halfway = obs(0, { h: 45, d: 0, hr: NOW_S + 2.5 * 3600 });
    const candidate = only(decide([machine("a", { status: status({ quota: [halfway] }) })]));
    expect(candidate.score?.components.accountPressure).toBeCloseTo(0.5, 10);
  });

  test("account_pressure: the emptier account wins at equal load", () => {
    const decision = decide([
      machine("full", { status: status({ quota: [obs(0, { h: 70 })] }) }),
      machine("fresh", { status: status({ quota: [obs(0, { h: 20 })] }) }),
    ]);
    expect(decision.chosen?.deviceId).toBe("fresh");
    expect(decision.candidates.map((c) => c.deviceId)).toEqual(["fresh", "full"]);
  });

  test("machine_pressure: max of cpu and mem as a fraction; disk never scores", () => {
    const candidate = only(decide([machine("a", { status: status({ cpu: 30, mem: 70, disk: 99, quota: [obs(0)] }) })]));
    expect(candidate.score?.components.machinePressure).toBe(0.7);
    const decision = decide([
      machine("busy", { status: status({ cpu: 90, quota: [obs(0)] }) }),
      machine("calm", { status: status({ cpu: 5, disk: 95, quota: [obs(0)] }) }),
    ]);
    expect(decision.chosen?.deviceId).toBe("calm");
  });

  test("dependency_distance: 0 at the base, 0.25 another exclave on its machine, 0.5 elsewhere", () => {
    const fleet = [
      machine("a", {
        exclaves: [exclave("main", "org:a"), exclave("work", "org:a")],
        repos: [clone("app", "main"), clone("app-1", "work")],
        status: status({ quota: [obs(0), obs(1)] }),
      }),
      machine("b"),
    ];
    const decision = decide(fleet, { task: task({ spec: spec({ base: { deviceId: "a", exclave: "work" } }) }) });
    const distance = Object.fromEntries(
      decision.candidates.map((c) => [`${c.deviceId}/${c.exclave}`, c.score?.components.dependencyDistance]),
    );
    expect(distance).toEqual({ "a/work": 0, "a/main": 0.25, "b/main": 0.5 });
    expect(decision.chosen?.exclave).toBe("work");
  });

  test("queue_pressure: in-flight scheduler tasks on the machine, reservations included", () => {
    const decision = decide([machine("a"), machine("b")], { tasks: [held("x", "a"), held("y", "a", "reserved")] });
    const pressure = Object.fromEntries(
      decision.candidates.map((c) => [c.deviceId, c.score?.components.queuePressure]),
    );
    expect(pressure).toEqual({ a: 2, b: 0 });
    expect(decision.chosen?.deviceId).toBe("b");
  });

  test("weights come from config, and the total is their weighted sum", () => {
    const candidate = only(
      decide([machine("a", { status: status({ cpu: 50, quota: [obs(0, { h: 45, d: 0 })] }) })], {
        tasks: [held("x", "a")],
        config: { weights: { accountPressure: 2, machinePressure: 3, dependencyDistance: 5, queuePressure: 7 } },
      }),
    );
    // A held task on the same account adds a second estimate: 45 + 10 = 55%.
    const account = (0.55 / 0.45) ** 2;
    expect(candidate.score?.total).toBeCloseTo(2 * account + 3 * 0.5 + 7 * 1, 10);
  });

  test("an exact tie goes to the lowest deviceId, then exclave", () => {
    expect(decide([machine("b"), machine("a")]).chosen?.deviceId).toBe("a");
  });
});

describe("stickiness", () => {
  const fleet = [
    machine("owner", { status: status({ cpu: 30, quota: [obs(0)] }) }),
    machine("other", { status: status({ cpu: 10, quota: [obs(0)] }) }),
  ];

  test("without lineage the less loaded machine wins and no bonus applies", () => {
    const decision = decide(fleet);
    expect(decision.chosen?.deviceId).toBe("other");
    expect(decision.candidates.every((c) => c.score?.sticky === 0)).toBe(true);
  });

  test("a continuation goes back to its lineage owner over a small difference", () => {
    const decision = decide(fleet, { task: task({ spec: spec({ lineage: { deviceId: "owner", exclave: "main" } }) }) });
    expect(decision.chosen?.deviceId).toBe("owner");
    expect(decision.candidates[0]?.score?.sticky).toBe(DEFAULT_CONFIG.stickyBonus);
  });

  test("the bonus never overrides a filter", () => {
    const filtered = [machine("owner", { connected: false }), fleet[1]!];
    const decision = decide(filtered, {
      task: task({ spec: spec({ lineage: { deviceId: "owner", exclave: "main" } }) }),
    });
    expect(decision.chosen?.deviceId).toBe("other");
  });
});

/** One machine, a `default` and a `work` exclave, so only the account differs. */
function twoAccounts(defaultPct: number, workPct: number): Machine[] {
  return [
    machine("a", {
      exclaves: [exclave("default", "org:phone"), exclave("work", "org:work")],
      repos: [clone("app", "default"), clone("app-1", "work")],
      status: status({ quota: [obs(0, { h: defaultPct, d: 0 }), obs(1, { h: workPct, d: 0 })] }),
    }),
  ];
}

describe("default-account penalty", () => {
  test("an emptier default account loses to another one with headroom", () => {
    const decision = decide(twoAccounts(0, 40));
    expect(decision.chosen?.exclave).toBe("work");
    const preserve = Object.fromEntries(decision.candidates.map((c) => [c.exclave, c.score?.preserve]));
    expect(preserve).toEqual({ default: DEFAULT_CONFIG.defaultAccountPenalty, work: 0 });
  });

  test("once the other account fills past the penalty, the default is used", () => {
    // 60% + 5% → (0.65/0.35)² ≈ 3.4, over the default's 0.003 + 1.
    expect(decide(twoAccounts(0, 60)).chosen?.exclave).toBe("default");
  });

  test("keyed by account: the default's account in a named exclave elsewhere pays too", () => {
    // b's default holds org:phone without a clone, so it only marks the account.
    const decision = decide([
      machine("a", {
        exclaves: [exclave("work", "org:phone"), exclave("side", "org:side")],
        repos: [clone("app", "work"), clone("app-1", "side")],
        status: status({ quota: [obs(0), obs(1)] }),
      }),
      machine("b", { exclaves: [exclave("default", "org:phone")], repos: [] }),
    ]);
    const scored = decision.candidates.filter((c) => c.score !== undefined);
    expect(Object.fromEntries(scored.map((c) => [c.exclave, c.score?.preserve]))).toEqual({ work: 1, side: 0 });
    expect(decision.chosen?.exclave).toBe("side");
  });

  test("the penalty comes from config; 0 turns it off", () => {
    const decision = decide(twoAccounts(0, 40), { config: { defaultAccountPenalty: 0 } });
    expect(decision.chosen?.exclave).toBe("default");
  });
});

describe("decision record", () => {
  test("scored candidates first by total, then the rejected; nothing placeable chooses nothing", () => {
    const decision = decide([
      machine("off", { connected: false }),
      machine("b"),
      machine("a", { status: status({ cpu: 80, quota: [obs(0)] }) }),
    ]);
    expect(decision.candidates.map((c) => c.deviceId)).toEqual(["b", "a", "off"]);
    expect(decision.at).toBe(NOW);
    expect(decide([machine("off", { connected: false })]).chosen).toBeNull();
  });
});
