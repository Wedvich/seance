import { describe, expect, test } from "bun:test";
import { CAPABILITIES, parseTask, type ExclaveInfo, type Machine } from "@seance/shared";
import { DEFAULT_CONFIG, route, type Candidate, type Decision, type SchedulerConfig, type Task } from "../src/index.ts";
import { accountResetAt } from "../src/route.ts";
import { clone, exclave, machine, NOW, NOW_S, obs, spec, status } from "./fixtures.ts";

function task(fields: Partial<Task> = {}): Task {
  return { id: "t", spec: spec(), state: "ready", createdAt: NOW, ...fields };
}

function decide(
  machines: readonly Machine[],
  fields: {
    task?: Task;
    tasks?: readonly Task[];
    config?: Partial<SchedulerConfig>;
    released?: ReadonlySet<string>;
  } = {},
): Decision {
  return route({
    task: fields.task ?? task(),
    machines,
    tasks: fields.tasks ?? [],
    now: NOW,
    config: { ...DEFAULT_CONFIG, ...fields.config },
    ...(fields.released === undefined ? {} : { released: fields.released }),
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

/** Machine `a` with two exclaves on two accounts, both observed and both holding a clone. */
function twoAccounts(): Machine {
  return machine("a", {
    exclaves: [exclave("main", "org:a"), exclave("alt", "org:b")],
    repos: [clone("app", "main"), clone("app2", "alt")],
    status: status({ quota: [obs(0), obs(1)] }),
  });
}

/** When `org:a` resets, read from one machine reporting `quota`. */
function resetOf(quota: ReturnType<typeof obs>): number | null {
  return accountResetAt("org:a", [machine("a", { status: status({ quota: [quota] }) })], [], NOW, DEFAULT_CONFIG);
}

/** Machine `a` with a premium exclave `main` and a standard one `alt`, both observed at `pct`, both holding a clone. */
function seats(pct: number, extra: Partial<ExclaveInfo> = {}): Machine {
  return machine("a", {
    exclaves: [
      exclave("main", "org:a", { seatTier: "team_tier_1", ...extra }),
      exclave("alt", "org:b", { seatTier: "team_standard", ...extra }),
    ],
    repos: [clone("app", "main"), clone("app2", "alt")],
    status: status({ quota: [obs(0, { h: pct }), obs(1, { h: pct })] }),
  });
}

/** Machine `a` with one standard-seat exclave `main`, observed at `quota`. */
function standardSeat(quota: ReturnType<typeof obs>): Machine {
  return machine("a", {
    exclaves: [exclave("main", "org:a", { seatTier: "team_standard" })],
    status: status({ quota: [quota] }),
  });
}

function byExclave(decision: Decision, id: string): Candidate | undefined {
  return decision.candidates.find((c) => c.exclave === id);
}

/** `org:a` on one seat tier, at 60% in a 5h window resetting after its 7d one. */
function seatReading(seatTier: string): Machine {
  return machine("a", {
    exclaves: [exclave("main", "org:a", { seatTier })],
    status: status({ quota: [obs(0, { h: 70, hr: NOW_S + 7200, d: 10, dr: NOW_S + 3600 })] }),
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

  test("draining: a restarting machine takes no task — not by run-now past the caps, not when pinned to it", () => {
    const draining = machine("a", { status: status({ quota: [obs(0)], drn: true }) });
    const healthy = machine("b", { exclaves: [exclave("main", "org:a")] });
    const decision = decide([draining, healthy]);
    expect(decision.chosen?.deviceId).toBe("b");
    expect(codes(decision.candidates.find((c) => c.deviceId === "a")!)).toEqual(["draining"]);

    const runNow = route({
      task: task(),
      machines: [draining],
      tasks: [],
      now: NOW,
      config: DEFAULT_CONFIG,
      uncapped: true,
    });
    expect(runNow.chosen).toBeNull();
    expect(codes(only(runNow))).toEqual(["draining"]);

    const pinned = decide([draining, healthy], { task: task({ spec: spec({ pin: { deviceId: "a" } }) }) });
    expect(pinned.chosen).toBeNull();
    expect(codes(pinned.candidates.find((c) => c.deviceId === "a")!)).toEqual(["draining"]);
  });

  describe("the task's own restrictions", () => {
    /** `a` holds accounts `org:a` and `org:w`; `b` and `c` hold `org:w` too, each with a clone. */
    function fleet(): Machine[] {
      return [
        machine("a", {
          exclaves: [exclave("main", "org:a"), exclave("work", "org:w")],
          repos: [clone("app", "main"), clone("app-1", "work")],
          status: status({ quota: [obs(0), obs(1)] }),
        }),
        machine("b", { exclaves: [exclave("main", "org:w")] }),
        machine("c", { exclaves: [exclave("main", "org:w")] }),
      ];
    }
    const reasonsOf = (decision: Decision): Record<string, readonly unknown[]> =>
      Object.fromEntries(decision.candidates.map((c) => [`${c.deviceId}/${c.exclave}`, c.rejected]));

    test("pin_mismatch by machine and by account: only the pinned account on the pinned machine is left", () => {
      const decision = decide(fleet(), { task: task({ spec: spec({ pin: { deviceId: "a", account: "org:w" } }) }) });
      expect(decision.chosen).toEqual({ deviceId: "a", exclave: "work", clone: "app-1" });
      const reasons = reasonsOf(decision);
      expect(reasons["a/main"]).toEqual([{ code: "pin_mismatch", field: "account" }]);
      expect(reasons["b/main"]).toEqual([{ code: "pin_mismatch", field: "deviceId" }]);
    });

    test("an account pin alone matches the account wherever it is signed in", () => {
      const decision = decide(fleet(), { task: task({ spec: spec({ pin: { account: "org:w" } }) }) });
      const reasons = reasonsOf(decision);
      expect(reasons["a/main"]).toEqual([{ code: "pin_mismatch", field: "account" }]);
      for (const where of ["a/work", "b/main", "c/main"]) expect(reasons[where]).toEqual([]);
      expect(decision.chosen).not.toBeNull();
      expect(decision.chosen).not.toMatchObject({ deviceId: "a", exclave: "main" });
    });

    test("an exclave signed in to no account never matches an account pin", () => {
      const signedOut = machine("a", { exclaves: [exclave("main", null)] });
      const candidate = only(decide([signedOut], { task: task({ spec: spec({ pin: { account: "org:a" } }) }) }));
      expect(candidate.rejected).toContainEqual({ code: "pin_mismatch", field: "account" });
    });

    test("avoided: every exclave of an avoided machine is turned away, the rest are judged as before", () => {
      const decision = decide(fleet(), { task: task({ spec: spec({ avoid: ["a", "b"] }) }) });
      const reasons = reasonsOf(decision);
      for (const where of ["a/main", "a/work", "b/main"]) expect(reasons[where]).toEqual([{ code: "avoided" }]);
      expect(reasons["c/main"]).toEqual([]);
      expect(decision.chosen?.deviceId).toBe("c");
    });

    test("a pin and an avoid list together: each candidate carries every restriction it breaks", () => {
      const restricted = spec({ pin: { deviceId: "a", account: "org:w" }, avoid: ["b"] });
      const decision = decide(fleet(), { task: task({ spec: restricted }) });
      expect(decision.chosen).toEqual({ deviceId: "a", exclave: "work", clone: "app-1" });
      expect(reasonsOf(decision)["b/main"]).toEqual([{ code: "pin_mismatch", field: "deviceId" }, { code: "avoided" }]);
    });

    test("avoiding every machine leaves nothing to choose: the task waits", () => {
      const decision = decide(fleet(), { task: task({ spec: spec({ avoid: ["a", "b", "c"] }) }) });
      expect(decision.chosen).toBeNull();
      expect(decision.candidates.every((c) => c.rejected.some((r) => r.code === "avoided"))).toBe(true);
    });

    test("a machine pin never lifts a limit: the pinned machine keeps its disk, quota and cap reasons, and the others only pin_mismatch", () => {
      const pinned = task({ spec: spec({ pin: { deviceId: "a" } }) });
      const cases: [string, Machine, Partial<SchedulerConfig>, Task[], string][] = [
        ["disk_low", machine("a", { status: status({ free: 1023, quota: [obs(0)] }) }), {}, [], "disk_low"],
        [
          "quota_over_line",
          machine("a", { status: status({ quota: [obs(0, { h: 95 })] }) }),
          {},
          [],
          "quota_over_line",
        ],
        ["cap_reached", machine("a"), { globalMax: 1 }, [held("x", "b")], "cap_reached"],
      ];
      for (const [, held_a, config, tasks, code] of cases) {
        const decision = decide([held_a, machine("b")], { task: pinned, tasks, config });
        const reasons = reasonsOf(decision);
        const onA = decision.candidates.find((c) => c.deviceId === "a");
        expect(onA === undefined ? [] : codes(onA)).toContain(code);
        expect(reasons["b/main"]).toEqual(
          code === "cap_reached"
            ? [
                { code: "cap_reached", inFlight: 1, max: 1 },
                { code: "pin_mismatch", field: "deviceId" },
              ]
            : [{ code: "pin_mismatch", field: "deviceId" }],
        );
        expect(decision.chosen).toBeNull();
      }
    });

    test("unrestricted, the same fleet is judged with no restriction reason at all", () => {
      const decision = decide(fleet());
      expect(decision.candidates.every((c) => c.rejected.length === 0)).toBe(true);
      expect(decision.chosen).not.toBeNull();
    });
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

  describe("skill_absent — only a name the inventory knows restricts", () => {
    /** Machine `a`: exclave `main` with `ship`, `alt` without, each holding a clone. */
    function skilled(): Machine {
      return machine("a", {
        exclaves: [exclave("main", "org:a", { skills: ["ship"] }), exclave("alt", "org:b")],
        repos: [clone("app", "main"), clone("app2", "alt")],
        status: status({ quota: [obs(0), obs(1)] }),
      });
    }

    function reasonsBy(decision: Decision): Record<string, string[]> {
      return Object.fromEntries(decision.candidates.map((c) => [c.exclave ?? "", codes(c)]));
    }

    test("a declared skill restricts to the exclave that has it", () => {
      const decision = decide([skilled()], { task: task({ spec: spec({ skill: "ship" }) }) });
      expect(decision.chosen?.exclave).toBe("main");
      expect(byExclave(decision, "alt")?.rejected).toEqual([{ code: "skill_absent", skill: "ship" }]);
    });

    test("a prompt's /name is the declaration; declared wins over it", () => {
      const prompted = decide([skilled()], { task: task({ spec: spec({ prompt: "/ship the fix" }) }) });
      expect(reasonsBy(prompted)).toEqual({ main: [], alt: ["skill_absent"] });
      const declared = machine("a", {
        exclaves: [exclave("main", "org:a", { skills: ["ship"] }), exclave("alt", "org:b", { skills: ["plan"] })],
        repos: [clone("app", "main"), clone("app2", "alt")],
        status: status({ quota: [obs(0), obs(1)] }),
      });
      const both = decide([declared], { task: task({ spec: spec({ skill: "plan", prompt: "/ship it" }) }) });
      expect(reasonsBy(both)).toEqual({ main: ["skill_absent"], alt: [] });
    });

    test("a /name token anywhere restricts: after whitespace, trailing punctuation stripped", () => {
      for (const prompt of [
        "please /ship this",
        "/ship, then tag",
        " /ship",
        "(see /ship)",
        "/ship\nmore",
        "a\n/ship.",
        "/ship: release 1.2",
        "run `/ship`",
        '"/ship"',
        "(/ship)",
        "[/ship]",
        "'/ship'",
      ]) {
        expect(reasonsBy(decide([skilled()], { task: task({ spec: spec({ prompt }) }) }))).toEqual({
          main: [],
          alt: ["skill_absent"],
        });
      }
      const decision = decide([skilled()], { task: task({ spec: spec({ prompt: "/ship, then tag" }) }) });
      expect(byExclave(decision, "alt")?.rejected).toEqual([{ code: "skill_absent", skill: "ship" }]);
    });

    test("not tokens: a bare slash, a path, and/or, a URL, a second slash, or no slash restricts nothing", () => {
      for (const prompt of [
        "/",
        "/\n",
        "/tmp/x is broken",
        "and/or ship",
        "https://a/ship",
        "/ship/x",
        "ship",
        "/...",
      ]) {
        expect(reasonsBy(decide([skilled()], { task: task({ spec: spec({ prompt }) }) }))).toEqual({
          main: [],
          alt: [],
        });
      }
    });

    test("a plugin:name token keeps its colon mid-token", () => {
      const plugin = machine("a", {
        exclaves: [exclave("main", "org:a", { skills: ["plug:ship"] }), exclave("alt", "org:b")],
        repos: [clone("app", "main"), clone("app2", "alt")],
        status: status({ quota: [obs(0), obs(1)] }),
      });
      const decision = decide([plugin], { task: task({ spec: spec({ prompt: "run /plug:ship now" }) }) });
      expect(reasonsBy(decision)).toEqual({ main: [], alt: ["skill_absent"] });
    });

    test("every known token is required; skill_absent names the first one missing in prompt order", () => {
      const fleet = machine("a", {
        exclaves: [
          exclave("a", "org:a", { skills: ["ship"] }),
          exclave("b", "org:b", { skills: ["ship"] }),
          exclave("c", "org:c"),
        ],
        repos: [
          { ...clone("app-a", "a"), skills: ["deploy"] },
          clone("app-b", "b"),
          { ...clone("app-c", "c"), skills: ["deploy"] },
        ],
        status: status({ quota: [obs(0), obs(1), obs(2)] }),
      });
      const decision = decide([fleet], { task: task({ spec: spec({ prompt: "/ship then /deploy" }) }) });
      expect(byExclave(decision, "a")?.rejected).toEqual([]);
      expect(byExclave(decision, "b")?.rejected).toEqual([{ code: "skill_absent", skill: "deploy" }]);
      expect(byExclave(decision, "c")?.rejected).toEqual([{ code: "skill_absent", skill: "ship" }]);
    });

    test("the clone with every required skill is chosen over the first match", () => {
      const project = machine("a", {
        exclaves: [exclave("main", "org:a", { skills: ["ship"] })],
        repos: [clone("app", "main"), { ...clone("app-2", "main"), skills: ["deploy"] }],
        status: status({ quota: [obs(0)] }),
      });
      const decision = decide([project], { task: task({ spec: spec({ prompt: "/ship then /deploy" }) }) });
      expect(decision.chosen?.clone).toBe("app-2");
    });

    test("an earlier unknown token does not mask a later known one", () => {
      const decision = decide([skilled()], { task: task({ spec: spec({ prompt: "/tmp then /review then /ship" }) }) });
      expect(reasonsBy(decision)).toEqual({ main: [], alt: ["skill_absent"] });
    });

    test("a declared skill the inventory does not know passes, and does not fall back to the prompt", () => {
      const decision = decide([skilled()], { task: task({ spec: spec({ skill: "nope", prompt: "/ship it" }) }) });
      expect(reasonsBy(decision)).toEqual({ main: [], alt: [] });
    });

    test("an unknown name passes everywhere: a built-in, a plugin's, a typo", () => {
      for (const prompt of ["/review", "/plugin:ship", "/shp"]) {
        expect(reasonsBy(decide([skilled()], { task: task({ spec: spec({ prompt }) }) }))).toEqual({
          main: [],
          alt: [],
        });
      }
    });

    test("an offline machine's inventory still makes the name known", () => {
      const holder = machine("b", { connected: false, exclaves: [exclave("main", "org:b", { skills: ["ship"] })] });
      const decision = decide([machine("a"), holder], { task: task({ spec: spec({ prompt: "/ship" }) }) });
      expect(decision.chosen).toBeNull();
      expect(codes(decision.candidates.find((c) => c.deviceId === "a") ?? only(decision))).toEqual(["skill_absent"]);
    });

    test("a project skill passes the clone that has it, on any exclave, and is known through it", () => {
      const project = machine("a", {
        exclaves: [exclave("main", "org:a"), exclave("alt", "org:b")],
        repos: [{ ...clone("app", "main"), skills: ["deploy"] }, clone("app2", "alt")],
        status: status({ quota: [obs(0), obs(1)] }),
      });
      const decision = decide([project], { task: task({ spec: spec({ prompt: "/deploy" }) }) });
      expect(reasonsBy(decision)).toEqual({ main: [], alt: ["skill_absent"] });
    });

    test("with a project skill, the clone that has it is the candidate's clone, not the first match", () => {
      const project = machine("a", {
        exclaves: [exclave("main", "org:a")],
        repos: [clone("app", "main"), { ...clone("app-2", "main"), skills: ["deploy"] }],
        status: status({ quota: [obs(0)] }),
      });
      const withSkill = decide([project], { task: task({ spec: spec({ prompt: "/deploy" }) }) });
      expect(withSkill.chosen?.clone).toBe("app-2");
      const without = decide([project], { task: task({ spec: spec({ prompt: "do it" }) }) });
      expect(without.chosen?.clone).toBe("app");
    });

    test("an exclave's own skill leaves the clone choice at the first match", () => {
      const project = machine("a", {
        exclaves: [exclave("main", "org:a", { skills: ["ship"] })],
        repos: [clone("app", "main"), { ...clone("app-2", "main"), skills: ["ship"] }],
        status: status({ quota: [obs(0)] }),
      });
      expect(decide([project], { task: task({ spec: spec({ skill: "ship" }) }) }).chosen?.clone).toBe("app");
    });

    test("mixed versions: a clone without skills is rejected beside a newer clone that advertises the project skill", () => {
      const older = machine("old", {
        exclaves: [exclave("main", "org:o")],
        repos: [clone("app", "main")], // a daemon predating RepoEntry.skills
        status: status({ quota: [obs(0)] }),
      });
      const newer = machine("new", {
        exclaves: [exclave("main", "org:n")],
        repos: [{ ...clone("app", "main"), skills: ["deploy"] }],
        status: status({ quota: [obs(0)] }),
      });
      const decision = decide([older, newer], { task: task({ spec: spec({ prompt: "/deploy" }) }) });
      expect(decision.chosen?.deviceId).toBe("new");
      expect(codes(decision.candidates.find((c) => c.deviceId === "old") ?? only(decision))).toEqual(["skill_absent"]);
    });

    test("another repo's project skill is not in this task's inventory", () => {
      const other = machine("b", {
        repos: [{ ...clone("lib", "main", "github.com/acme/lib"), skills: ["deploy"] }],
      });
      const decision = decide([machine("a"), other], { task: task({ spec: spec({ prompt: "/deploy" }) }) });
      expect(decision.chosen?.deviceId).toBe("a");
      expect(codes(decision.candidates.find((c) => c.deviceId === "a") ?? only(decision))).toEqual([]);
    });

    test("an exclave without the repo's clone records both reasons", () => {
      const bare = machine("a", { repos: [], exclaves: [exclave("main", "org:a")] });
      const decision = decide([bare, machine("b", { exclaves: [exclave("main", "org:b", { skills: ["ship"] })] })], {
        task: task({ spec: spec({ skill: "ship" }) }),
      });
      expect(decision.chosen?.deviceId).toBe("b");
      expect(codes(decision.candidates.find((c) => c.deviceId === "a") ?? only(decision))).toEqual([
        "repo_absent",
        "skill_absent",
      ]);
    });
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

    test("the fleet quota record informs an account no status carries — its observer may have left the registry", () => {
      const unobserved = machine("idle", { status: status({ cpu: 0, mem: 0 }) });
      const reading = { h: 30, d: 20, s: "cache" as const, at: NOW_S - 120 };
      const fleetQuota = [{ accountId: "org:idle", observer: "retired", reading }];
      const decision = route({
        task: task(),
        machines: [unobserved],
        tasks: [],
        now: NOW,
        config: DEFAULT_CONFIG,
        fleetQuota,
      });
      const candidate = only(decision);
      expect(candidate.rejected).toEqual([]);
      expect(candidate.quota).toEqual({ observedAt: NOW_S - 120, observer: "retired", source: "cache" });
      expect(decision.chosen?.deviceId).toBe("idle");
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
      // A weekly takes the 7d estimate, 1% each: 89 + 1 + 1.
      const fleet = [machine("a", { status: status({ quota: [obs(0, { d: 89 })] }) })];
      expect(only(decide(fleet, { tasks: [held("x", "a")] })).rejected).toEqual([
        { code: "quota_over_line", window: "7d", projectedPct: 91 },
      ]);
      expect(only(decide(fleet)).rejected).toEqual([]);
    });

    test("a per-model weekly binds only that model's tasks", () => {
      const premium = exclave("main", "org:a", { seatTier: "team_tier_1" });
      const fleet = [
        machine("a", { exclaves: [premium], status: status({ quota: [obs(0, { w: [{ m: "Fable", p: 92 }] })] }) }),
      ];
      const fable = decide(fleet, { task: task({ spec: spec({ model: "claude-fable-5-1[1m]" }) }) });
      expect(only(fable).rejected).toEqual([{ code: "quota_over_line", window: "7d Fable", projectedPct: 93 }]);
      // A full Fable week leaves Opus work free, and does not weigh on its score either.
      const opus = only(decide(fleet));
      expect(opus.rejected).toEqual([]);
      const unread = only(decide([machine("a", { exclaves: [premium] })]));
      expect(opus.score?.components.accountPressure).toBe(unread.score?.components.accountPressure);
    });

    test("only another model's weekly read is unknown, never 0%", () => {
      const reading = obs(0, { h: undefined, d: undefined, w: [{ m: "Fable", p: 10 }] });
      const fleet = [machine("a", { status: status({ quota: [reading] }) })];
      expect(only(decide(fleet)).rejected).toEqual([{ code: "quota_unknown", why: "unobserved" }]);
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

    // Spending credits that are already at the cap would launch a task that can't run.
    test("extra usage on but credits spent: filtered, never spilled; credits unreported still spill", () => {
      const over = (credits: { c?: number; cu?: number; cl?: number; at?: number }): ReturnType<typeof only> =>
        only(
          decide([
            machine("a", {
              exclaves: [exclave("main", "org:a", { extraUsageEnabled: true })],
              status: status({ quota: [obs(0, { h: 95, ...credits })] }),
            }),
          ]),
        );
      const spent = over({ c: 100 });
      expect(spent.rejected).toEqual([
        { code: "quota_over_line", window: "5h", projectedPct: 100, creditsSpent: true },
      ]);
      expect(spent.spill).toBeUndefined();
      expect(over({ c: 99 }).spill).toEqual({ window: "5h", projectedPct: 100 });
      expect(over({}).spill).toEqual({ window: "5h", projectedPct: 100 });
      // The amounts decide when present: the percent rounds, so 100 there can leave credits to spend.
      expect(over({ c: 100, cu: 4980, cl: 5000 }).spill).toEqual({ window: "5h", projectedPct: 100 });
      expect(over({ c: 100, cu: 5000, cl: 5000 }).spill).toBeUndefined();
      // Credits reset at 00:00 UTC on the 1st: last month's spent reads as unknown, not spent.
      const lastMonth = Date.UTC(2027, 0, 1) / 1000 - 1;
      expect(over({ c: 100, cu: 5000, cl: 5000, at: lastMonth }).spill).toEqual({ window: "5h", projectedPct: 100 });
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

  describe("cap_reached scope account", () => {
    test("rejects only the full account's candidates, counting reserved and needs-input tasks", () => {
      const tasks = [held("x", "a", "reserved"), held("y", "a", "needs-input"), held("z", "a", "awaiting-merge")];
      const decision = decide([twoAccounts()], { tasks, config: { accountMax: 2 } });
      const main = decision.candidates.find((c) => c.exclave === "main");
      expect(main?.rejected).toEqual([{ code: "cap_reached", inFlight: 2, max: 2, scope: "account" }]);
      expect(decision.chosen).toEqual({ deviceId: "a", exclave: "alt", clone: "app2" });
    });

    test("a task on a machine gone from the registry has no account to count", () => {
      const tasks = [held("x", "gone"), held("y", "gone")];
      expect(only(decide([machine("a")], { tasks, config: { accountMax: 2 } })).rejected).toEqual([]);
    });

    test("the global cap stays unscoped and sits beside the account's", () => {
      const tasks = [held("x", "a"), held("y", "a")];
      const candidate = only(decide([machine("a")], { tasks, config: { globalMax: 2, accountMax: 2 } }));
      expect(candidate.rejected).toEqual([
        { code: "cap_reached", inFlight: 2, max: 2 },
        { code: "cap_reached", inFlight: 2, max: 2, scope: "account" },
      ]);
    });
  });

  describe("a released task holds no slot", () => {
    /** Machine `s`, asleep, signed in to `org:a` as `a` is. */
    const asleep = machine("s", { connected: false, exclaves: [exclave("main", "org:a")] });
    // The leader's to say why; here `s` is asleep, and these are its tasks.
    const released = new Set(["x", "y"]);

    test("in flight, reserved included, it leaves the global count; the rest still count", () => {
      const tasks = [held("x", "s"), held("y", "s", "reserved"), held("z", "b")];
      const candidate = only(decide([machine("a")], { tasks, config: { globalMax: 1 }, released }));
      expect(candidate.rejected).toEqual([{ code: "cap_reached", inFlight: 1, max: 1 }]);
      expect(only(decide([machine("a")], { tasks, config: { globalMax: 2 }, released })).rejected).toEqual([]);
    });

    test("it leaves its account's count, so another machine on the account gets the work", () => {
      const tasks = [held("x", "s"), held("y", "s", "needs-input")];
      const fleet = [machine("a", { exclaves: [exclave("main", "org:a")] }), asleep];
      const holding = decide(fleet, { tasks, config: { accountMax: 2 } });
      expect(byExclave(holding, "main")?.rejected).toEqual([
        { code: "cap_reached", inFlight: 2, max: 2, scope: "account" },
      ]);
      const freed = decide(fleet, { tasks, config: { accountMax: 2 }, released });
      expect(freed.chosen).toEqual({ deviceId: "a", exclave: "main", clone: "app" });
    });

    test("an old record's batch bound is gone: the next member meets only what the caps define", () => {
      // Raw, as an older writer sealed it, through the parser every reader uses.
      const member = (id: string, index: number, strategy: unknown, fields: Record<string, unknown> = {}): Task => {
        const body = parseTask({
          id,
          spec: { ...spec(), batch: { id: "b1", index, strategy } },
          state: "ready",
          createdAt: NOW,
          ...fields,
        });
        if (body === null) throw new Error(`${id} does not parse`);
        return body;
      };
      for (const strategy of [{ mode: "parallel", max: 1 }, { mode: "sequential" }]) {
        const running = member("x", 0, strategy, {
          state: "running",
          assignment: { deviceId: "s", exclave: "main", clone: "app" },
        });
        const next = member("n", 1, strategy);
        const one = { task: next, tasks: [running], config: { globalMax: 1 } };
        // Asleep past the grace, the first holds no slot and nothing else holds the next.
        expect(only(decide([machine("a")], { ...one, released })).rejected).toEqual([]);
        // Awake, it holds the global slot as any task does, and nothing batch-shaped.
        expect(only(decide([machine("a")], one)).rejected).toEqual([{ code: "cap_reached", inFlight: 1, max: 1 }]);
      }
    });
  });

  describe("paused", () => {
    const fleet = [machine("a"), machine("b")];

    test("a whole-queue hold rejects every candidate", () => {
      const decision = route({
        task: task(),
        machines: fleet,
        tasks: [],
        now: NOW,
        config: DEFAULT_CONFIG,
        holds: [{ until: "resume", at: NOW - 1 }],
      });
      expect(decision.chosen).toBeNull();
      expect(decision.candidates.map((c) => c.rejected)).toEqual([
        [{ code: "paused", until: "resume", scope: "queue" }],
        [{ code: "paused", until: "resume", scope: "queue" }],
      ]);
    });

    test("an account hold rejects that account's candidates only; an expired reset hold none", () => {
      const holds = [
        { account: "org:a", until: "reset", at: NOW - 10, resumeAt: NOW + 1 },
        { account: "org:b", until: "reset", at: NOW - 10, resumeAt: NOW },
      ] as const;
      const decision = route({ task: task(), machines: fleet, tasks: [], now: NOW, config: DEFAULT_CONFIG, holds });
      expect(decision.chosen?.deviceId).toBe("b");
      expect(decision.candidates.find((c) => c.deviceId === "a")?.rejected).toEqual([
        { code: "paused", until: "reset", scope: "account" },
      ]);
    });
  });

  describe("accountResetAt", () => {
    test("over the line: the latest reset among the full windows, not an earlier one that leaves it full", () => {
      expect(resetOf(obs(0, { h: 10, hr: NOW_S + 3600, d: 95, dr: NOW_S + 86_400 }))).toBe((NOW_S + 86_400) * 1000);
      expect(resetOf(obs(0, { h: 95, hr: NOW_S + 3600, d: 10, dr: NOW_S + 86_400 }))).toBe((NOW_S + 3600) * 1000);
    });

    test("in-flight tasks on the account count, as routing counts them", () => {
      const reading = machine("a", {
        status: status({ quota: [obs(0, { h: 78, hr: NOW_S + 7200, d: 40, dr: NOW_S + 3600 })] }),
      });
      const running = (id: string): Task =>
        task({ id, state: "running", assignment: { deviceId: "a", exclave: "main", clone: "app" } });
      const inFlight = [running("x"), running("y"), running("z")];
      // 78% plus four tasks of 5% crosses the 90% line in 5h: its reset, the latest of the full ones.
      expect(accountResetAt("org:a", [reading], inFlight, NOW, DEFAULT_CONFIG)).toBe((NOW_S + 7200) * 1000);
      // Alone it is under the line everywhere: the earliest reset.
      expect(accountResetAt("org:a", [reading], [], NOW, DEFAULT_CONFIG)).toBe((NOW_S + 3600) * 1000);
      // Released: they hold no projected usage, as in routing.
      expect(accountResetAt("org:a", [reading], inFlight, NOW, DEFAULT_CONFIG, [], new Set(["x", "y", "z"]))).toBe(
        (NOW_S + 3600) * 1000,
      );
    });

    test("a standard seat's estimate is scaled, as routing scales it", () => {
      // 70% plus one standard-seat task (25%) crosses the line in 5h; on premium it is under everywhere.
      expect(accountResetAt("org:a", [seatReading("team_standard")], [], NOW, DEFAULT_CONFIG)).toBe(
        (NOW_S + 7200) * 1000,
      );
      expect(accountResetAt("org:a", [seatReading("team_tier_1")], [], NOW, DEFAULT_CONFIG)).toBe(
        (NOW_S + 3600) * 1000,
      );
    });

    test("a full per-model weekly does not hold the account: its model's tasks are filtered on their own", () => {
      const reading = obs(0, {
        h: 10,
        hr: NOW_S + 3600,
        d: 10,
        dr: NOW_S + 86_400,
        w: [{ m: "Fable", p: 99, r: NOW_S + 7200 }],
      });
      expect(resetOf(reading)).toBe((NOW_S + 3600) * 1000);
    });

    test("under the line: the earliest reset still ahead", () => {
      expect(resetOf(obs(0, { h: 10, hr: NOW_S - 60, d: 10, dr: NOW_S + 86_400 }))).toBe((NOW_S + 86_400) * 1000);
    });

    test("unknown: no reading, a full window with no reset, or every reset past", () => {
      expect(accountResetAt("org:zz", [machine("a")], [], NOW, DEFAULT_CONFIG)).toBeNull();
      expect(resetOf(obs(0, { h: 95, d: 10, dr: NOW_S + 86_400 }))).toBeNull();
      expect(resetOf(obs(0, { h: 10, hr: NOW_S - 60 }))).toBeNull();
    });
  });

  describe("seats", () => {
    test("a Fable task never lands on a standard seat, even one that may spill into credits", () => {
      for (const model of ["fable", "Fable", "claude-fable-5-1[1m]"]) {
        const decision = decide([seats(10, { extraUsageEnabled: true })], { task: task({ spec: spec({ model }) }) });
        expect(byExclave(decision, "alt")?.rejected).toEqual([{ code: "model_not_included", model: "fable" }]);
        expect(decision.chosen?.exclave).toBe("main");
      }
    });

    test("an unknown seat — an older daemon's, or an unlisted tier — gets no Fable task, other models as before", () => {
      const fleet = [
        machine("a", {
          exclaves: [exclave("main", "org:a"), exclave("alt", "org:b", { seatTier: "enterprise_whatever" })],
          repos: [clone("app", "main"), clone("app2", "alt")],
          status: status({ quota: [obs(0), obs(1)] }),
        }),
      ];
      const fable = decide(fleet, { task: task({ spec: spec({ model: "fable" }) }) });
      expect(fable.chosen).toBeNull();
      expect(fable.candidates.map(codes)).toEqual([["model_not_included"], ["model_not_included"]]);
      expect(decide(fleet).candidates.map(codes)).toEqual([[], []]);
    });

    test("a standard seat's estimate is 5× a premium one's, in the filter and the score", () => {
      // 70% + 25% crosses the line on standard; 70% + 5% does not on premium.
      const decision = decide([seats(70)]);
      expect(byExclave(decision, "alt")?.rejected).toEqual([
        { code: "quota_over_line", window: "5h", projectedPct: 95 },
      ]);
      expect(byExclave(decision, "main")?.rejected).toEqual([]);
      // Both under the line at the same reading, the standard seat still costs more.
      const level = decide([seats(10)]);
      const premium = byExclave(level, "main")?.score?.components.accountPressure ?? 0;
      const standard = byExclave(level, "alt")?.score?.components.accountPressure ?? 0;
      expect(standard).toBeGreaterThan(premium);
      expect(level.chosen?.exclave).toBe("main");
    });

    test("a weekly takes the 7d estimate, not the 5h one, scaled alike", () => {
      // 41% + 2 × 5% stays well under in 7d; the same reading in 5h is 2 × 25% over.
      expect(only(decide([standardSeat(obs(0, { d: 41 }))], { tasks: [held("x", "a")] })).rejected).toEqual([]);
      expect(only(decide([standardSeat(obs(0, { h: 41 }))], { tasks: [held("x", "a")] })).rejected).toEqual([
        { code: "quota_over_line", window: "5h", projectedPct: 91 },
      ]);
      // 85% + 2 × 5% crosses only if the 7d estimate is scaled too; unscaled it would be 87%.
      expect(only(decide([standardSeat(obs(0, { d: 85 }))], { tasks: [held("x", "a")] })).rejected).toEqual([
        { code: "quota_over_line", window: "7d", projectedPct: 95 },
      ]);
    });

    test("in-flight tasks on a standard seat each count at its scaled estimate", () => {
      const standard = standardSeat(obs(0, { h: 20 }));
      // 20% + 2 × 25% is under; one more in flight makes it 95%.
      expect(only(decide([standard], { tasks: [held("x", "a")] })).rejected).toEqual([]);
      expect(only(decide([standard], { tasks: [held("x", "a"), held("y", "a")] })).rejected).toEqual([
        { code: "quota_over_line", window: "5h", projectedPct: 95 },
      ]);
    });
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
    // 45% + 5% = 50% → (0.5/0.5)² = 1; the 7d window at 20% + 1% costs (0.21/0.79)² ≈ 0.07.
    const candidate = only(decide([machine("a", { status: status({ quota: [obs(0, { h: 45, d: 20 })] }) })]));
    expect(candidate.score?.components.accountPressure).toBeCloseTo(1, 10);
  });

  test("account_pressure: a weekly adds the 7d estimate, scaled to the seat", () => {
    // 7d: 80% + 5% = 85% outweighs 5h's 0% + 25%; the 5h estimate there would cap at 99% and cost 9801.
    const candidate = only(decide([standardSeat(obs(0, { h: 0, d: 80 }))]));
    expect(candidate.score?.components.accountPressure).toBeCloseTo((0.85 / 0.15) ** 2, 10);
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

describe("a continue task", () => {
  const capable = [CAPABILITIES.metrics, CAPABILITIES.taskId, CAPABILITIES.continueTask];
  const continuing = (at: { deviceId: string; exclave: string; clone: string }): Task =>
    task({ spec: spec({ mode: "continue", continues: { task: "t-old", at } }) });
  const reasonsOf = (decision: Decision): Record<string, readonly unknown[]> =>
    Object.fromEntries(decision.candidates.map((c) => [`${c.deviceId}/${c.exclave}`, c.rejected]));
  /** `a` is the target; two exclaves, and a second clone of the same repo in `main` that skills would prefer. */
  const fleet = (): Machine[] => [
    machine("a", {
      capabilities: capable,
      exclaves: [exclave("main", "org:a"), exclave("work", "org:w", { skills: ["ship"] })],
      repos: [clone("app", "main"), clone("app-2", "main"), clone("app-w", "work")],
      status: status({ quota: [obs(0), obs(1)] }),
    }),
    machine("b", { capabilities: capable }),
  ];

  test("only the exact machine, exclave and clone is left; the rest say it ran elsewhere", () => {
    const decision = decide(fleet(), { task: continuing({ deviceId: "a", exclave: "main", clone: "app-2" }) });
    expect(decision.chosen).toEqual({ deviceId: "a", exclave: "main", clone: "app-2" });
    const reasons = reasonsOf(decision);
    expect(reasons["a/main"]).toEqual([]);
    expect(reasons["a/work"]).toContainEqual({ code: "continue_elsewhere" });
    expect(reasons["b/main"]).toContainEqual({ code: "continue_elsewhere" });
  });

  test("the named clone is judged on its own skills: another clone's project skill does not stand in", () => {
    const at = { deviceId: "a", exclave: "main", clone: "app-2" };
    const withSkill = [{ ...clone("app", "main"), skills: ["ship"] }, clone("app-2", "main")];
    const decision = decide(
      [machine("a", { capabilities: capable, repos: withSkill, exclaves: [exclave("main", "org:a")] })],
      { task: task({ spec: spec({ mode: "continue", prompt: "/ship it", continues: { task: "t-old", at } }) }) },
    );
    expect(decision.chosen).toBeNull();
    expect(only(decision).rejected).toEqual([{ code: "skill_absent", skill: "ship" }]);
    expect(only(decision).clone).toBe("app-2");
  });

  test("a target without the capability is continue_unsupported, and never chosen", () => {
    const old = machine("a", { capabilities: [CAPABILITIES.metrics, CAPABILITIES.taskId] });
    const decision = decide([old], { task: continuing({ deviceId: "a", exclave: "main", clone: "app" }) });
    expect(decision.chosen).toBeNull();
    expect(only(decision).rejected).toEqual([{ code: "continue_unsupported" }]);
  });

  test("a clone the target no longer has is repo_absent", () => {
    const decision = decide(fleet(), { task: continuing({ deviceId: "a", exclave: "main", clone: "gone" }) });
    expect(decision.chosen).toBeNull();
    expect(reasonsOf(decision)["a/main"]).toEqual([{ code: "repo_absent" }]);
  });

  test("an ordinary task is not held to any of it", () => {
    const decision = decide(fleet());
    expect(decision.candidates.flatMap((c) => c.rejected.map((r) => r.code))).not.toContain("continue_elsewhere");
    expect(decision.candidates.flatMap((c) => c.rejected.map((r) => r.code))).not.toContain("continue_unsupported");
    expect(decision.chosen).not.toBeNull();
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
