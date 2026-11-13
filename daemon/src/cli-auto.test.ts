import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES,
  isRecord,
  RequestFailure,
  storeErrorText,
  TASK_REQUEST_LIMITS,
  toBase64,
  type Capability,
  type ExclaveInfo,
  type Machine,
  type SchedulerAvailability,
  type Task,
  type TaskSpec,
} from "@seance/shared";
import { startBrokerDouble } from "../test/broker-double.ts";
import { fakeRelay, machine } from "../test/fake-app-relay.ts";
import { LazyRelay } from "./app-relay.ts";
import { waitForDrain } from "./availability-client.ts";
import { brokerFail, brokerOk } from "./broker-protocol.ts";
import {
  autoFleet,
  availabilityViaFleet,
  continueTaskAuto,
  passTaskAuto,
  spawnAuto,
  startTaskAuto,
} from "./cli-auto.ts";
import type { ContinueCliArgs, SpawnCliArgs } from "./cli.ts";
import type { Config } from "./config.ts";
import { relayFleet, SCHEDULER_NEEDS_NEWER_DAEMON } from "./fleet.ts";

const ORIGIN = "github.com/m/seance";
const NOW_HINT = "`seanced spawn --now` spawns on this machine without the relay, the key or the daemon.";
const LEADING = { kind: "ready", deviceId: "device-1", term: 3 } as const;

function scheduledRelay(scheduler: SchedulerAvailability = LEADING): ReturnType<typeof fakeRelay> {
  const fake = fakeRelay([
    machine({ repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main", origin: ORIGIN }] }),
  ]);
  fake.setState({ scheduler });
  return fake;
}

async function run(
  fake: ReturnType<typeof fakeRelay>,
  args: Partial<SpawnCliArgs> = {},
  self: () => Promise<string | null> = async () => "device-self",
): Promise<{ ok: boolean; text: string; audited: readonly string[] }> {
  const lazy = new LazyRelay({ create: () => fake });
  const audited: string[] = [];
  try {
    const outcome = await spawnAuto(
      { repo: "seance", here: false, prompt: "fix it", ...args },
      relayFleet(lazy),
      (line) => {
        audited.push(line);
      },
      { self },
    );
    return { ...outcome, audited };
  } finally {
    lazy.stop();
  }
}

describe("spawnAuto", () => {
  test("queues a task for the clone's origin as the CLI's, audited origin=cli client=cli, naming no MCP tool", async () => {
    const fake = scheduledRelay();
    const { ok, text, audited } = await run(fake, { here: true, title: "Fix it" });
    expect(ok).toBe(true);
    expect(fake.creates).toHaveLength(1);
    const [created] = fake.creates;
    expect(text).toStartWith(`task ${created?.id}: queued`);
    expect(text).toContain("the app's queue shows where it lands");
    expect(text).not.toContain("get_queue");
    expect(text).not.toContain("cancel_task");
    expect(text).not.toContain("No scheduler is leading");
    expect(created?.state).toBe("queued");
    expect(created?.spec).toEqual({
      repo: ORIGIN,
      mode: "here",
      title: "Fix it",
      prompt: "fix it",
      client: "cli",
    } satisfies TaskSpec);
    // Never the prompt.
    expect(audited).toEqual([
      `audit enqueue origin=cli client=cli task="${created?.id}" createdAt=${created?.createdAt} queued`,
    ]);
    // An enqueue is a store write: nothing asked of the scheduler or a machine.
    expect(fake.requests).toEqual([]);
  });

  test("--autonomy reaches the task; steer is sealed with plan for a leader that drops the level", async () => {
    const auto = scheduledRelay();
    expect((await run(auto, { autonomy: "auto" })).ok).toBe(true);
    expect(auto.creates[0]?.spec).toMatchObject({ autonomy: "auto" });
    expect(auto.creates[0]?.spec).not.toHaveProperty("plan");

    const steer = scheduledRelay();
    expect((await run(steer, { autonomy: "steer" })).ok).toBe(true);
    expect(steer.creates[0]?.spec).toMatchObject({ autonomy: "steer", plan: true });
  });

  test("a keyless shell's --autonomy reaches the enqueue frame the daemon seals, steer with its plan", async () => {
    const fleetMachines = [
      machine({ repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main", origin: ORIGIN }] }),
    ];
    for (const [autonomy, extra] of [
      ["steer", { plan: true }],
      ["checkpoint", {}],
      ["auto", {}],
    ] as const) {
      const frames: Record<string, unknown>[] = [];
      // oxlint-disable-next-line no-await-in-loop -- one broker double per level, stopped before the next
      const double = await startBrokerDouble((raw, id) => {
        if (!isRecord(raw)) return brokerFail(id, "invalid_request", "not a frame");
        frames.push(raw);
        if (raw["action"] === "fleet") return brokerOk(id, { machines: fleetMachines, scheduler: LEADING });
        if (raw["schedulerOp"] === "enqueue") return brokerOk(id, { ok: true, landedEarlier: false });
        return brokerFail(id, "unsupported", "not in this double");
      });
      try {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
        // oxlint-disable-next-line no-await-in-loop -- as above
        const outcome = await spawnAuto(
          { repo: "seance", here: false, prompt: "fix it", autonomy },
          built.fleet,
          () => {},
          { keyless: built.keyless, self: async () => "device-self" },
        );
        expect(outcome.ok).toBe(true);
        const sent = frames.find((frame) => frame["schedulerOp"] === "enqueue");
        expect(sent).toMatchObject({ spec: { autonomy, client: "cli", ...extra } });
        if (!("plan" in extra)) expect(sent?.["spec"]).not.toHaveProperty("plan");
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await double.stop();
      }
    }
  });

  test("with no leader the task still queues, and the answer says it waits for one", async () => {
    const fake = scheduledRelay({ kind: "none" });
    const { ok, text } = await run(fake);
    expect(ok).toBe(true);
    expect(fake.creates).toHaveLength(1);
    expect(text).toContain("No scheduler is leading right now");
    // The one time --now is worth naming beside a queued task, with the double run it risks.
    expect(text).toContain("`seanced spawn --now` now would start a second session");
  });

  test("an unverified nominee is not a leaderless fleet: no --now advice, which would double-run on a healthy one", async () => {
    const fake = scheduledRelay({ kind: "unverified", deviceId: "device-1", term: 3 });
    const { ok, text } = await run(fake);
    expect(ok).toBe(true);
    expect(text).toContain("No scheduler is leading right now");
    expect(text).not.toContain("--now");
  });

  test("a failure that may have queued the task never offers --now, which would run it twice", async () => {
    const lost = scheduledRelay();
    lost.onCreate = () => new RequestFailure("dropped", "the relay socket closed", "relay");
    expect((await run(lost)).text).not.toContain("--now");
    const hard = scheduledRelay();
    let tries = 0;
    hard.onCreate = () => {
      tries += 1;
      return tries === 1 ? new RequestFailure("timeout", "no reply", "relay") : new Error("boom");
    };
    const outcome = await run(hard);
    expect(outcome.text).toContain("may have queued");
    expect(outcome.text).not.toContain("--now");
  }, 20_000);

  test("a failure that provably queued nothing offers --now on the CLI only", async () => {
    const unsent = scheduledRelay();
    unsent.onCreate = () => new RequestFailure("disconnected", "no socket", "relay");
    const notSent = await run(unsent);
    expect(notSent.ok).toBe(false);
    expect(notSent.text).toBe(`spawn: not queued — the relay was unreachable after 3 tries; try again. ${NOW_HINT}`);
    expect(notSent.audited).toEqual([]);
    const hard = scheduledRelay();
    hard.onCreate = () => new Error("boom");
    const failedFirst = await run(hard);
    expect(failedFirst.ok).toBe(false);
    expect(hard.creates).toHaveLength(1);
    expect(failedFirst.text).toBe(`spawn failed: boom. ${NOW_HINT}`);
  }, 10_000);

  test("a store refusal is worded and audited, and not retried", async () => {
    const fake = scheduledRelay();
    fake.onCreate = () => ({ ok: false, code: "store_full" });
    const { ok, text, audited } = await run(fake);
    expect(ok).toBe(false);
    expect(fake.creates).toHaveLength(1);
    expect(text).toBe(`spawn refused (store_full): ${storeErrorText("store_full")}`);
    expect(audited).toEqual([
      expect.stringMatching(/^audit enqueue origin=cli client=cli .* refused code="store_full"$/u),
    ]);
  });

  test("every try unanswered names the task and the app's queue, not an MCP tool", async () => {
    const fake = scheduledRelay();
    fake.onCreate = () => new RequestFailure("dropped", "the relay socket closed", "relay");
    const { ok, text, audited } = await run(fake);
    expect(ok).toBe(false);
    expect(text).toBe(
      `spawn: no answer from the relay after 3 tries — task ${fake.creates[0]?.id} may have queued; check the app's queue before retrying`,
    );
    expect(audited).toEqual([
      `audit enqueue origin=cli client=cli task="${fake.creates[0]?.id}" createdAt=${fake.creates[0]?.createdAt} unanswered`,
    ]);
  }, 10_000);

  test("a hard failure after an earlier try was sent may have queued: audited unanswered, naming the task", async () => {
    const fake = scheduledRelay();
    let tries = 0;
    fake.onCreate = () => {
      tries += 1;
      return tries === 1 ? new RequestFailure("timeout", "no reply", "relay") : new Error("the socket exploded");
    };
    const { ok, text, audited } = await run(fake);
    expect(ok).toBe(false);
    expect(fake.creates).toHaveLength(2);
    expect(text).toBe(
      `spawn failed: the socket exploded — task ${fake.creates[0]?.id} may have queued; check the app's queue before retrying`,
    );
    expect(audited).toEqual([expect.stringMatching(/^audit enqueue origin=cli client=cli .* unanswered$/u)]);
  }, 10_000);

  test("a repo no machine reports is refused, with nothing written", async () => {
    const fake = scheduledRelay();
    const { ok, text, audited } = await run(fake, { repo: "nope" });
    expect(ok).toBe(false);
    expect(text).toBe(`spawn refused: no repo "nope" for the fleet — known origins: ${ORIGIN}`);
    expect(fake.creates).toEqual([]);
    expect(audited).toEqual([]);
  });

  test("a prompt over the bound is refused before the relay is dialled", async () => {
    const fake = scheduledRelay();
    const { ok, text } = await run(fake, { prompt: "x".repeat(TASK_REQUEST_LIMITS.prompt + 1) });
    expect(ok).toBe(false);
    expect(text).toStartWith("spawn refused: the prompt is");
    expect(text).toContain("pass --now to spawn here directly");
    expect(fake.started).toBe(0);
  });
});

function config(overrides: Partial<Config>): Config {
  return {
    name: "Test",
    relayUrl: "ws://127.0.0.1:1/daemon",
    bearerToken: "token",
    psk: "",
    repoRoots: [],
    tmuxSession: "main",
    ...overrides,
  };
}

describe("autoFleet", () => {
  const KEYLESS_ARGS = { repo: "seance", here: false, prompt: "fix it" } as const;

  test("a shell that can read no key asks the daemon, and with none running says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-cliauto-"));
    try {
      const built = await autoFleet(config({ psk: "" }), {
        stores: [],
        broker: { path: join(dir, "absent.sock") },
      });
      expect(built.keyless).toBe(true);
      const outcome = await spawnAuto(
        KEYLESS_ARGS,
        built.fleet,
        () => {
          throw new Error("nothing may be audited");
        },
        { keyless: built.keyless },
      );
      expect(outcome.ok).toBe(false);
      // The unreadable key first, then the broker's reason, then what still works.
      expect(outcome.text).toStartWith("spawn: not queued — this shell could not read the PSK");
      expect(outcome.text.indexOf("could not read the PSK")).toBeLessThan(outcome.text.indexOf("is seanced running?"));
      // --now needs neither the key nor the daemon, so it closes every keyless failure.
      expect(outcome.text).toEndWith(NOW_HINT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a keyless shell whose daemon hangs up without answering is pointed at --now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-cliauto-"));
    const silent = Bun.listen<undefined>({
      unix: join(dir, "silent.sock"),
      socket: { data: (sock): void => void sock.end() },
    });
    try {
      const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: join(dir, "silent.sock") } });
      const outcome = await spawnAuto(
        KEYLESS_ARGS,
        built.fleet,
        () => {
          throw new Error("nothing may be audited");
        },
        { keyless: built.keyless },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toEndWith(NOW_HINT);
    } finally {
      silent.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a keyless shell whose own daemon predates traits refuses --requires, whoever runs the suite", async () => {
    const double = await startBrokerDouble((raw, id) => {
      if (!isRecord(raw)) return brokerFail(id, "invalid_request", "not a frame");
      if (raw["action"] === "fleet") {
        return brokerOk(id, {
          machines: [machine({ deviceId: "device-self", capabilities: [] })],
          scheduler: LEADING,
        });
      }
      return brokerFail(id, "unsupported", "not in this double");
    });
    try {
      const self = async (): Promise<string | null> => "device-self";
      const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path }, self });
      const outcome = await spawnAuto(
        { repo: "seance", here: false, prompt: "fix it", requires: ["atlas"] },
        built.fleet,
        () => {},
        { keyless: built.keyless, self },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain("daemon is older than this seanced");
    } finally {
      await double.stop();
    }
  });

  test("a keyless shell whose daemon does not broker is told to read the key itself, not about an MCP server", async () => {
    const double = await startBrokerDouble((_raw, id) =>
      brokerFail(id, "broker_disabled", "this daemon does not broker"),
    );
    try {
      const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
      const outcome = await spawnAuto(
        KEYLESS_ARGS,
        built.fleet,
        () => {
          throw new Error("nothing may be audited");
        },
        { keyless: built.keyless },
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toStartWith("spawn: not queued — this shell could not read the PSK");
      expect(outcome.text).toContain("not service-delivered, so it does not broker");
      expect(outcome.text).toContain("this process has to read the PSK itself");
      expect(outcome.text).toContain("seanced doctor");
      expect(outcome.text).not.toContain("seanced mcp");
      expect(outcome.text).not.toContain("update");
      expect(outcome.text).toEndWith(NOW_HINT);
    } finally {
      await double.stop();
    }
  });

  test("a keyless shell whose daemon predates brokered auto is told to update it, and nothing is enqueued", async () => {
    const double = await startBrokerDouble((raw, id) => {
      const action = typeof raw === "object" && raw !== null && "action" in raw ? raw.action : undefined;
      if (action === "machines") return brokerOk(id, [machine()]);
      return brokerFail(id, "unsupported", "action is not brokered");
    });
    try {
      const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
      const outcome = await spawnAuto(
        KEYLESS_ARGS,
        built.fleet,
        () => {
          throw new Error("nothing may be audited");
        },
        { keyless: built.keyless },
      );
      expect(outcome).toEqual({ ok: false, text: `spawn unavailable: ${SCHEDULER_NEEDS_NEWER_DAEMON}. ${NOW_HINT}` });
      const actions = double.frames.map((frame) =>
        typeof frame === "object" && frame !== null && "action" in frame ? frame.action : null,
      );
      expect(actions).toEqual(["fleet", "machines"]);
    } finally {
      await double.stop();
    }
  });

  test("an unreachable relay ends in a clear 'not queued' within the connect bound, with nothing audited", async () => {
    // A port that was just bound and released: nothing listens there.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const { port } = probe;
    await probe.stop(true);
    const psk = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const built = await autoFleet(config({ psk, relayUrl: `ws://127.0.0.1:${port}/daemon` }), {
      stores: [],
      connectTimeoutMs: 300,
    });
    const audited: string[] = [];
    try {
      const outcome = await spawnAuto({ repo: "seance", here: false, prompt: "fix it" }, built.fleet, (line) => {
        audited.push(line);
      });
      expect(outcome).toEqual({
        ok: false,
        text: `spawn: not queued — the relay did not answer within 300ms. ${NOW_HINT}`,
      });
    } finally {
      built.fleet.stop();
    }
    expect(audited).toEqual([]);
  });
});

describe("spawnAuto's placement flags", () => {
  const EMAIL = "me@pengefix.no";
  const exclaveOf = (accountId: string): ExclaveInfo => ({
    id: "default",
    accountId,
    email: EMAIL,
    extraUsageEnabled: false,
    authOk: true,
    skills: [],
  });
  const clone = { name: "seance", path: "/repos/seance", defaultBranch: "main", exclave: "default", origin: ORIGIN };
  /** This box leads and routes on accounts; another box holds the employer account. */
  const placingRelay = (capabilities: readonly Capability[] = [CAPABILITIES.pinAccount]) => {
    const fake = fakeRelay([
      machine({
        deviceId: "device-self",
        name: "Thad",
        exclaves: [exclaveOf("org-a:me")],
        repos: [clone],
        capabilities,
      }),
      machine({ deviceId: "device-other", name: "WSL", exclaves: [exclaveOf("org-b:me")], repos: [clone] }),
    ]);
    fake.setState({ scheduler: { kind: "ready", deviceId: "device-self", term: 3 } });
    fake.accounts = [{ accountId: "org-b:me", alias: "employer", version: 1 }];
    return fake;
  };

  test("--machine here pins this box by its deviceId, with no account listing", async () => {
    const fake = placingRelay();
    const { ok } = await run(fake, { machine: "here" });
    expect(ok).toBe(true);
    expect(fake.creates[0]?.spec.pin).toEqual({ deviceId: "device-self" });
    expect(fake.accountLists).toBe(0);
  });

  test("--account takes an alias, stores only the accountId, and the answer names it by id and email", async () => {
    const fake = placingRelay();
    const { ok, text, audited } = await run(fake, { account: "employer" });
    expect(ok).toBe(true);
    expect(fake.creates[0]?.spec.pin).toEqual({ account: "org-b:me" });
    expect(text).toContain(`pinned to account org-b:me (${EMAIL})`);
    expect(JSON.stringify(fake.creates[0])).not.toContain(EMAIL);
    expect(audited.join("\n")).not.toContain(EMAIL);
  });

  test("--not here keeps it off this box; naming the pinned machine is refused by flag", async () => {
    const fake = placingRelay();
    expect((await run(fake, { not: ["here", "WSL"] })).ok).toBe(true);
    expect(fake.creates[0]?.spec.avoid).toEqual(["device-self", "device-other"]);
    const contradiction = await run(fake, { machine: "WSL", not: ["wsl"] });
    expect(contradiction.ok).toBe(false);
    expect(contradiction.text).toContain(
      "spawn refused: --not names WSL (device-other), the machine the task is pinned to",
    );
    const unknown = await run(fake, { machine: "nope" });
    expect(unknown.text).toContain('spawn refused: --machine: no machine named "nope"');
    expect(fake.creates).toHaveLength(1);
  });

  test("--account and --not are refused unless the leader advertises pinAccount", async () => {
    for (const args of [{ account: "employer" }, { not: ["WSL"] }]) {
      const fake = placingRelay([]);
      // oxlint-disable-next-line no-await-in-loop -- one fake each
      const { ok, text } = await run(fake, args);
      expect(ok).toBe(false);
      expect(text).toContain("leader does not route on --account / --not yet");
      expect(fake.creates).toEqual([]);
      expect(fake.accountLists).toBe(0);
    }
  });

  describe("--requires", () => {
    /** This box (atlas) leads; the other holds gpu. */
    const withTraits = (leaderCaps: readonly Capability[] = [CAPABILITIES.traits]) => {
      const fake = fakeRelay([
        machine({
          deviceId: "device-self",
          name: "Thad",
          exclaves: [{ ...exclaveOf("org-a:me"), traits: ["atlas"] }],
          repos: [clone],
          capabilities: leaderCaps,
        }),
        machine({
          deviceId: "device-other",
          name: "WSL",
          exclaves: [{ ...exclaveOf("org-b:me"), traits: ["gpu"] }],
          repos: [clone],
        }),
      ]);
      fake.setState({ scheduler: { kind: "ready", deviceId: "device-self", term: 3 } });
      return fake;
    };

    test("is stored as given on a leader that advertises traits, and the audit counts it without naming it", async () => {
      const fake = withTraits();
      const { ok, audited } = await run(fake, { requires: ["atlas"] });
      expect(ok).toBe(true);
      expect(fake.creates[0]?.spec.requires).toEqual(["atlas"]);
      expect(audited.join("\n")).not.toContain("atlas");
    });

    test("is refused, before anything is created, by a leader that does not route on it", async () => {
      const fake = withTraits([]);
      const { ok, text } = await run(fake, { requires: ["atlas"] });
      expect(ok).toBe(false);
      expect(text).toContain("leader does not route on --requires yet");
      expect(fake.creates).toEqual([]);
    });

    test("an unknown trait names the ones that exist; a spec nothing could carry is refused too", async () => {
      const fake = withTraits();
      const typo = await run(fake, { requires: ["atlsa"] });
      expect(typo.ok).toBe(false);
      expect(typo.text).toContain("spawn refused: --requires: no machine declares the trait atlsa — known: atlas, gpu");
      expect(typo.audited).toEqual(["audit enqueue origin=cli client=cli refused=unknown_trait requires=1 unknown=1"]);

      const split = await run(fake, { requires: ["atlas", "gpu"] });
      expect(split.ok).toBe(false);
      expect(split.text).toContain("no exclave this task can reach carries atlas and gpu together");
      expect(fake.creates).toEqual([]);
    });
  });

  test("here without a state file is refused before the relay is dialled", async () => {
    const fake = placingRelay();
    const { ok, text } = await run(fake, { not: ["here"] }, async () => null);
    expect(ok).toBe(false);
    expect(text).toContain("`here` names this machine, which has no seanced state yet");
    expect(fake.started).toBe(0);
  });
});

describe("continueTaskAuto", () => {
  const AT = { deviceId: "device-2", exclave: "work", clone: "seance" };
  const failedTask: Task = {
    id: "t-1",
    state: "failed",
    createdAt: 4_000,
    failure: { code: "session_failed", message: "the session ended with exit 137" },
    spec: { repo: ORIGIN, mode: "worktree", prompt: "fix it", title: "fix-it" },
    assignment: { ...AT, window: "fix-it" },
  };
  const CAN = [CAPABILITIES.continueTask, CAPABILITIES.continueSession];

  /** The leader (device-1) and the box the task ran on (device-2). */
  const machines = (advertising: { readonly leader?: boolean } = {}): Machine[] => [
    machine({ deviceId: "device-1", name: "Leader", ...(advertising.leader === false ? {} : { capabilities: CAN }) }),
    machine({ deviceId: "device-2", name: "Linux Box", capabilities: CAN }),
  ];

  async function runContinue(
    queue: readonly Task[],
    fleetMachines: readonly Machine[] = machines(),
    args: ContinueCliArgs | undefined = undefined,
  ): Promise<{ ok: boolean; text: string; audited: readonly string[]; fake: ReturnType<typeof fakeRelay> }> {
    const fake = fakeRelay(fleetMachines, (op) => (op === "queue" ? { tasks: queue, at: 6_000 } : new Error(op)));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    const audited: string[] = [];
    try {
      const outcome = await continueTaskAuto(args ?? { taskId: "t-1" }, relayFleet(lazy), (line) => {
        audited.push(line);
      });
      return { ...outcome, audited, fake };
    } finally {
      lazy.stop();
    }
  }

  test("queues the continuation as the CLI's: an exact target, the note, origin=cli, naming no MCP tool", async () => {
    const { ok, text, audited, fake } = await runContinue([failedTask], machines(), { taskId: "t-1", prompt: "go on" });
    expect(ok).toBe(true);
    const [created] = fake.creates;
    expect(created?.spec).toEqual({
      repo: ORIGIN,
      mode: "continue",
      prompt: "go on",
      title: "fix-it",
      continues: { task: "t-1", at: AT },
      client: "cli",
    } satisfies TaskSpec);
    expect(text).toStartWith("continuing task t-1\n");
    expect(text).toContain(`task ${created?.id}: queued`);
    expect(text).not.toContain("get_queue");
    expect(audited).toEqual([
      `audit enqueue origin=cli client=cli task="${created?.id}" continues="t-1" createdAt=${created?.createdAt} queued`,
    ]);
  });

  test("refuses a task nobody lists, one that is not a failed session, and a leader that cannot continue; nothing is queued", async () => {
    const cases: [string, Awaited<ReturnType<typeof runContinue>>][] = [
      ["not in the leader's list", await runContinue([])],
      [
        "only a task whose session failed or whose window was closed, or that was cancelled",
        await runContinue([{ ...failedTask, state: "done" }]),
      ],
      [
        "the scheduler's leader cannot continue a session yet",
        await runContinue([failedTask], machines({ leader: false })),
      ],
      [
        "a continuation of it is already underway or finished",
        await runContinue([
          failedTask,
          {
            id: "t-2",
            spec: { repo: ORIGIN, mode: "continue", continues: { task: "t-1", at: AT } },
            state: "needs-input",
            createdAt: 2,
          },
        ]),
      ],
      [
        "already continuing as task t-3, which is still waiting in the queue",
        await runContinue([
          failedTask,
          {
            id: "t-3",
            spec: { repo: ORIGIN, mode: "continue", continues: { task: "t-1", at: AT } },
            state: "queued",
            createdAt: 2,
          },
        ]),
      ],
    ];
    for (const [reason, outcome] of cases) {
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toStartWith("continue refused: ");
      expect(outcome.text).toContain(reason);
      expect(outcome.fake.creates).toEqual([]);
      expect(outcome.audited).toEqual([]);
    }
  });

  describe("through the daemon's broker, for a shell that cannot read the key", () => {
    const answer =
      (frames: Record<string, unknown>[], fleetMachines: readonly Machine[]) =>
      (raw: unknown, id: string): ReturnType<typeof brokerOk> => {
        if (!isRecord(raw)) return brokerFail(id, "invalid_request", "not a frame");
        frames.push(raw);
        if (raw["action"] === "fleet") return brokerOk(id, { machines: fleetMachines, scheduler: LEADING });
        if (raw["schedulerOp"] === "queue") return brokerOk(id, { tasks: [failedTask], at: 6_000 });
        if (raw["schedulerOp"] === "enqueue") return brokerOk(id, { ok: true, landedEarlier: false });
        return brokerFail(id, "unsupported", "not in this double");
      };

    test("the enqueue frame carries the continue spec, for the daemon to seal", async () => {
      const frames: Record<string, unknown>[] = [];
      const double = await startBrokerDouble(answer(frames, machines()));
      try {
        const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
        const audited: string[] = [];
        const outcome = await continueTaskAuto({ taskId: "t-1" }, built.fleet, (line) => void audited.push(line), {
          keyless: built.keyless,
        });
        expect(outcome.ok).toBe(true);
        const sent = frames.find((frame) => frame["schedulerOp"] === "enqueue");
        expect(sent).toMatchObject({
          spec: { mode: "continue", continues: { task: "t-1", at: AT }, client: "cli" },
        });
        // This shell's own line, as on the direct path; the daemon writes its `local-broker` one when it seals.
        expect(audited).toEqual([expect.stringContaining('continues="t-1"')]);
      } finally {
        await double.stop();
      }
    });

    test("a leader that cannot continue is refused before any enqueue frame", async () => {
      const frames: Record<string, unknown>[] = [];
      const double = await startBrokerDouble(answer(frames, machines({ leader: false })));
      try {
        const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
        const outcome = await continueTaskAuto({ taskId: "t-1" }, built.fleet, () => {}, { keyless: true });
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toContain("the scheduler's leader cannot continue a session yet");
        expect(frames.some((frame) => frame["schedulerOp"] === "enqueue")).toBe(false);
      } finally {
        await double.stop();
      }
    });

    test("a daemon that predates the broker is told to update", async () => {
      const double = await startBrokerDouble((raw, id) =>
        isRecord(raw) && raw["action"] === "machines"
          ? brokerOk(id, [machine()])
          : brokerFail(id, "unsupported", "action is not brokered"),
      );
      try {
        const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
        const outcome = await continueTaskAuto({ taskId: "t-1" }, built.fleet, () => {}, { keyless: true });
        expect(outcome).toEqual({ ok: false, text: `continue unavailable: ${SCHEDULER_NEEDS_NEWER_DAEMON}` });
      } finally {
        await double.stop();
      }
    });
  });
});

describe("start", () => {
  const reservedOn = (id: string): Task => ({
    id,
    state: "reserved",
    createdAt: 4_000,
    spec: { repo: ORIGIN, mode: "worktree" },
    reservation: { deviceId: "device-2", exclave: "work", clone: "seance", expiresAt: 65_000 },
  });

  /** The leader (device-1), advertising `runNow` unless held back, and the box tasks start on. */
  const machines = (runNow = true): Machine[] => [
    machine({
      deviceId: "device-1",
      name: "Leader",
      repos: [{ name: "seance", path: "/repos/seance", defaultBranch: "main", origin: ORIGIN }],
      ...(runNow ? { capabilities: [CAPABILITIES.runNow] } : {}),
    }),
    machine({ deviceId: "device-2", name: "Linux Box" }),
  ];

  async function runSpawnStart(fake: ReturnType<typeof fakeRelay>, polls = 3): Promise<{ ok: boolean; text: string }> {
    const lazy = new LazyRelay({ create: () => fake });
    try {
      return await spawnAuto(
        { repo: "seance", here: false, prompt: "fix it", start: true },
        relayFleet(lazy),
        () => {},
        { self: async () => "device-self", startPolls: { pollMs: 1, polls } },
      );
    } finally {
      lazy.stop();
    }
  }

  test("spawn --start reads the new task until it is ready, then sends run-now for it once", async () => {
    let reads = 0;
    const fake = fakeRelay(machines(), (op, payload) => {
      const created = fake.creates[0];
      if (created === undefined) return new Error("no create yet");
      // Not yet in the leader's view, then queued, then admitted: as a leader's passes would show it.
      if (op === "queue") {
        reads += 1;
        if (reads === 1) return { tasks: [], at: 6_000 };
        return { tasks: [{ ...created, state: reads === 2 ? "queued" : "ready" }], at: 6_000 };
      }
      if (op === "run-now") {
        expect(payload).toEqual({ taskId: created.id });
        return { task: reservedOn(created.id) };
      }
      return new Error(`unexpected ${op}`);
    });
    fake.setState({ scheduler: LEADING });
    const { ok, text } = await runSpawnStart(fake);
    expect(ok).toBe(true);
    const id = fake.creates[0]?.id;
    expect(text).toContain(`task ${id}: queued`);
    expect(text).toContain(`task ${id}: started past the queue on Linux Box/work`);
    expect(fake.requests.map((r) => r.op)).toEqual(["queue", "queue", "queue", "run-now"]);
  });

  test("spawn --start that never sees the task ready leaves it queued, says so, and still exits ok", async () => {
    const fake = fakeRelay(machines(), (op) => {
      const created = fake.creates[0];
      if (op === "queue" && created !== undefined) return { tasks: [{ ...created, state: "blocked" }], at: 6_000 };
      return new Error(`unexpected ${op}`);
    });
    fake.setState({ scheduler: LEADING });
    const { ok, text } = await runSpawnStart(fake, 2);
    // The task is queued: a failed exit would invite a retry that queues it twice.
    expect(ok).toBe(true);
    expect(text).toContain("not started: it was not ready to start within");
    expect(text).toContain(`\`seanced start ${fake.creates[0]?.id}\` tries again`);
    expect(fake.requests.map((r) => r.op)).toEqual(["queue", "queue"]);
  });

  test("spawn --start with a leader that cannot start, or none, queues nothing", async () => {
    for (const [fleetMachines, scheduler] of [
      [machines(false), LEADING],
      [machines(), { kind: "none" }],
    ] as const) {
      const fake = fakeRelay(fleetMachines);
      fake.setState({ scheduler });
      const { ok, text } = await runSpawnStart(fake);
      expect(ok).toBe(false);
      expect(text).toStartWith("spawn refused: --start: ");
      expect(fake.creates).toEqual([]);
    }
  });

  test("seanced start sends run-now once, through the daemon's broker for a shell that cannot read the key", async () => {
    const frames: Record<string, unknown>[] = [];
    const double = await startBrokerDouble((raw, id) => {
      if (!isRecord(raw)) return brokerFail(id, "invalid_request", "not a frame");
      frames.push(raw);
      if (raw["action"] === "fleet") return brokerOk(id, { machines: machines(), scheduler: LEADING });
      if (raw["schedulerOp"] === "run-now") return brokerOk(id, { task: reservedOn("t-1") });
      return brokerFail(id, "unsupported", "not in this double");
    });
    try {
      const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
      const outcome = await startTaskAuto({ taskId: "t-1" }, built.fleet, { keyless: built.keyless });
      expect(outcome).toEqual({ ok: true, text: "task t-1: started past the queue on Linux Box/work" });
      expect(frames.filter((frame) => frame["action"] === "scheduler")).toEqual([
        expect.objectContaining({ schedulerOp: "run-now", taskId: "t-1" }),
      ]);
    } finally {
      await double.stop();
    }
  });

  test("seanced start refuses a malformed id before anything is sent, and words a refusal", async () => {
    const fake = fakeRelay(machines(), () => ({ ok: false, code: "unplaceable", message: "held" }));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const bad = await startTaskAuto({ taskId: "not a task id!" }, relayFleet(lazy));
      expect(bad).toEqual({ ok: false, text: 'start refused: "not a task id!" is not a task id' });
      expect(fake.requests).toEqual([]);
      const held = await startTaskAuto({ taskId: "t-1" }, relayFleet(lazy));
      expect(held.ok).toBe(false);
      expect(held.text).toStartWith("start refused (unplaceable): something besides the concurrency cap");
      // Not a lost answer: nothing to check.
      expect(held.text).not.toContain("may have landed");
    } finally {
      lazy.stop();
    }
  });
});

describe("pass", () => {
  const AT = { deviceId: "device-2", exclave: "work", clone: "seance" };
  const running: Task = {
    id: "t-1",
    state: "running",
    createdAt: 4_000,
    spec: { repo: ORIGIN, mode: "worktree" },
    assignment: { ...AT, window: "fix-it" },
  };

  /** The leader (device-1) and the box the task runs on, each advertising `successor`. */
  const machines = (): Machine[] => [
    machine({ deviceId: "device-1", name: "Leader", capabilities: [CAPABILITIES.successor] }),
    machine({ deviceId: "device-2", name: "Linux Box", capabilities: [CAPABILITIES.successor] }),
  ];

  const passed = {
    task: { ...running, state: "superseded", successor: "t-2" },
    successorId: "t-2",
    successor: null,
  };

  test("seanced pass reads the queue, sends pass once, and names the successor", async () => {
    const fake = fakeRelay(machines(), (op) => {
      if (op === "queue") return { tasks: [running], at: 6_000 };
      if (op === "pass") return passed;
      return new Error(`unexpected ${op}`);
    });
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const outcome = await passTaskAuto({ taskId: "t-1" }, relayFleet(lazy));
      expect(outcome.ok).toBe(true);
      expect(outcome.text).toContain("task t-1 passed to successor t-2");
      expect(fake.requests.map((r) => [r.op, r.payload])).toEqual([
        ["queue", {}],
        ["pass", { taskId: "t-1" }],
      ]);
    } finally {
      lazy.stop();
    }
  });

  test("a task already passed is answered with its successor, and no pass is sent", async () => {
    const fake = fakeRelay(machines(), (op) =>
      op === "queue"
        ? { tasks: [{ ...running, state: "superseded", successor: "t-2" }], at: 6_000 }
        : new Error(`unexpected ${op}`),
    );
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const outcome = await passTaskAuto({ taskId: "t-1" }, relayFleet(lazy));
      expect(outcome.ok).toBe(true);
      expect(outcome.text).toContain("already passed to successor t-2");
      expect(fake.requests.map((r) => r.op)).toEqual(["queue"]);
    } finally {
      lazy.stop();
    }
  });

  test("a malformed id and a task the shared rule refuses send no pass", async () => {
    const waiting: Task = { ...running, state: "needs-input" };
    const fake = fakeRelay(machines(), (op) =>
      op === "queue" ? { tasks: [waiting], at: 6_000 } : new Error(`unexpected ${op}`),
    );
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const bad = await passTaskAuto({ taskId: "not a task id!" }, relayFleet(lazy));
      expect(bad).toEqual({ ok: false, text: 'pass refused: "not a task id!" is not a task id' });
      expect(fake.requests).toEqual([]);
      const refused = await passTaskAuto({ taskId: "t-1" }, relayFleet(lazy));
      expect(refused.ok).toBe(false);
      expect(refused.text).toStartWith("pass refused: it is waiting for you");
      expect(fake.requests.map((r) => r.op)).toEqual(["queue"]);
    } finally {
      lazy.stop();
    }
  });

  test("a lost answer says the pass may have landed, and is never retried", async () => {
    const fake = fakeRelay(machines(), (op) =>
      op === "queue" ? { tasks: [running], at: 6_000 } : new RequestFailure("timeout", "no reply within 180000ms"),
    );
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const lost = await passTaskAuto({ taskId: "t-1" }, relayFleet(lazy));
      expect(lost.ok).toBe(false);
      expect(lost.text).toContain("the pass may have landed anyway — check the app's queue");
      expect(fake.requests.filter((r) => r.op === "pass")).toHaveLength(1);
    } finally {
      lazy.stop();
    }
  });

  test("seanced pass sends pass once, through the daemon's broker for a shell that cannot read the key", async () => {
    const frames: Record<string, unknown>[] = [];
    const double = await startBrokerDouble((raw, id) => {
      if (!isRecord(raw)) return brokerFail(id, "invalid_request", "not a frame");
      frames.push(raw);
      if (raw["action"] === "fleet") return brokerOk(id, { machines: machines(), scheduler: LEADING });
      if (raw["schedulerOp"] === "queue") return brokerOk(id, { tasks: [running], at: 6_000 });
      if (raw["schedulerOp"] === "pass") return brokerOk(id, passed);
      return brokerFail(id, "unsupported", "not in this double");
    });
    try {
      const built = await autoFleet(config({ psk: "" }), { stores: [], broker: { path: double.path } });
      const outcome = await passTaskAuto({ taskId: "t-1" }, built.fleet, { keyless: built.keyless });
      expect(outcome.ok).toBe(true);
      expect(outcome.text).toContain("passed to successor t-2");
      expect(frames.filter((frame) => frame["action"] === "scheduler")).toEqual([
        expect.objectContaining({ schedulerOp: "queue" }),
        expect.objectContaining({ schedulerOp: "pass", taskId: "t-1" }),
      ]);
    } finally {
      await double.stop();
    }
  });
});

describe("seanced close / open", () => {
  const self = machine({ capabilities: ["close", "drain"] });

  test("no argument acts on this machine, by its own device id, over the relay", async () => {
    const fake = fakeRelay([self], () => ({ ok: true, closed: 9_000 }));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const outcome = await availabilityViaFleet(null, false, relayFleet(lazy), () => Promise.resolve("device-1"));
      expect(outcome.ok).toBe(true);
      expect(fake.requests).toEqual([{ deviceId: "device-1", op: "availability", payload: { open: false } }]);
    } finally {
      lazy.stop();
    }
  });

  test("a machine with no daemon state has no this-machine to act on", async () => {
    const fake = fakeRelay([self]);
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const outcome = await availabilityViaFleet(null, true, relayFleet(lazy), () => Promise.resolve(null));
      expect(outcome).toMatchObject({ ok: false });
      expect(outcome.text).toContain("no daemon state");
      expect(fake.requests).toEqual([]);
    } finally {
      lazy.stop();
    }
  });

  test("a keyless box refuses and points to the PWA", async () => {
    const double = await startBrokerDouble((raw, id) =>
      isRecord(raw) && raw["action"] === "fleet"
        ? brokerOk(id, { machines: [self], scheduler: LEADING })
        : brokerFail(id, "unsupported", "not in this double"),
    );
    try {
      const { fleet } = await autoFleet(config({ psk: "" }), {
        broker: { path: double.path },
        self: () => Promise.resolve("device-1"),
        stores: [],
      });
      const outcome = await availabilityViaFleet(null, false, fleet, () => Promise.resolve("device-1"));
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain("PWA");
      expect(double.frames.every((frame) => isRecord(frame) && frame["action"] === "fleet")).toBe(true);
      fleet.stop();
    } finally {
      await double.stop();
    }
  });
});

describe("seanced close --wait", () => {
  const CL = 9_000;
  const closedBox = (fields: Partial<Machine> = {}): Machine =>
    machine({
      capabilities: ["close", "drain", "drainPass"],
      status: { at: 1, scan: 1, cpu: 0, mem: 0, free: 1, cl: CL },
      ...fields,
    });
  const task = (id: string, fields: Partial<Task> = {}): Task => ({
    id,
    spec: { repo: ORIGIN, mode: "worktree", prompt: "x" },
    state: "running",
    createdAt: 1,
    assignment: { deviceId: "device-1", exclave: "main", clone: "seance" },
    ...fields,
  });
  const pane = (taskId?: string): { window: string; repo: string; path: string; taskId?: string } => ({
    window: "w",
    repo: "seance",
    path: "/x",
    ...(taskId === undefined ? {} : { taskId }),
  });

  /** A relay whose `sessions` and `queue` answers come from what the test says for each poll. */
  function polled(box: Machine, script: { sessions: () => unknown; queue: (payload: unknown) => unknown }) {
    const fake = fakeRelay([box], (op, payload) => {
      if (op === "sessions") return script.sessions();
      if (op === "queue") return script.queue(payload);
      return {};
    });
    fake.setState({ scheduler: LEADING });
    return fake;
  }

  async function wait(
    fake: ReturnType<typeof fakeRelay>,
    pollMs = 1,
  ): Promise<{ code: number; text: string; printed: string[] }> {
    const lazy = new LazyRelay({ create: () => fake });
    const printed: string[] = [];
    try {
      const outcome = await waitForDrain({
        fleet: relayFleet(lazy),
        deviceId: "device-1",
        closedAt: CL,
        pollMs,
        print: (line) => printed.push(line),
      });
      return { ...outcome, printed };
    } finally {
      lazy.stop();
    }
  }

  test("under a leader without drainPass it refuses before anything is sent", async () => {
    const old = closedBox({ capabilities: ["close", "drain"], status: undefined });
    const fake = fakeRelay([old], () => ({ ok: true, closed: CL }));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const outcome = await availabilityViaFleet(
        null,
        false,
        relayFleet(lazy),
        () => Promise.resolve("device-1"),
        true,
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain("--wait");
      expect(fake.requests).toEqual([]);
    } finally {
      lazy.stop();
    }
  });

  test("a close under a drainPass leader names the machine and its cl, and says tasks are passed in 10 minutes", async () => {
    const open = closedBox({ status: undefined });
    const fake = fakeRelay([open], () => ({ ok: true, closed: CL }));
    fake.setState({ scheduler: LEADING });
    const lazy = new LazyRelay({ create: () => fake });
    try {
      const outcome = await availabilityViaFleet(
        null,
        false,
        relayFleet(lazy),
        () => Promise.resolve("device-1"),
        true,
      );
      expect(outcome).toMatchObject({ ok: true, closed: { deviceId: "device-1", at: CL } });
      expect(outcome.text).toContain("passed to other machines in 10 minutes unless you reopen it");
    } finally {
      lazy.stop();
    }
  });

  test("exits 0 once the sessions are empty, printing progress only when it changes", async () => {
    let polls = 0;
    const fake = polled(closedBox(), {
      sessions: () => {
        polls += 1;
        return { sessions: polls < 4 ? [pane("t1")] : [], at: 1 };
      },
      queue: () => ({ tasks: [task("t1")], at: 1 }),
    });
    const outcome = await wait(fake);
    expect(outcome.code).toBe(0);
    expect(outcome.text).toBe("MacBook Pro is empty");
    expect(outcome.printed).toEqual(["MacBook Pro: moving 1"]);
  });

  test("exits 2 listing what cannot move, one line each", async () => {
    const fake = polled(closedBox(), {
      sessions: () => ({ sessions: [pane("t1"), pane()], at: 1 }),
      queue: () => ({ tasks: [task("t1", { spec: { repo: ORIGIN, mode: "here", prompt: "x" } })], at: 1 }),
    });
    const outcome = await wait(fake);
    expect(outcome.code).toBe(2);
    expect(outcome.text).toBe(
      "MacBook Pro still runs:\nt1 Can't move: runs in the clone\n- Not a task: close it yourself",
    );
  });

  test("keeps waiting while a task is moving, even beside stuck ones", async () => {
    let polls = 0;
    const fake = polled(closedBox(), {
      sessions: () => {
        polls += 1;
        return { sessions: polls < 3 ? [pane("t1"), pane()] : [pane()], at: 1 };
      },
      // Once its pane is gone the task has settled as superseded.
      queue: () => ({ tasks: [task("t1", polls < 3 ? {} : { state: "superseded" })], at: 1 }),
    });
    const outcome = await wait(fake);
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(outcome.code).toBe(2);
  });

  test("a failed sessions read is tried again, never an exit", async () => {
    let polls = 0;
    const fake = polled(closedBox(), {
      sessions: () => {
        polls += 1;
        return polls === 1 ? { ok: false, code: "internal_error", message: "no" } : { sessions: [], at: 1 };
      },
      queue: () => ({ tasks: [], at: 1 }),
    });
    const outcome = await wait(fake);
    expect(outcome.code).toBe(0);
    expect(outcome.printed[0]).toContain("could not read its sessions");
  });

  test("a status that has not shown the close yet is not a reopen; one that shows it gone is", async () => {
    let polls = 0;
    const fake = polled(closedBox({ status: undefined }), {
      sessions: () => {
        polls += 1;
        // The close lands in status on the second poll, and is lifted on the fourth.
        if (polls === 2) fake.setState({ machines: [closedBox()] });
        if (polls === 4) fake.setState({ machines: [closedBox({ status: undefined })] });
        return { sessions: [pane("t1")], at: 1 };
      },
      queue: () => ({ tasks: [task("t1")], at: 1 }),
    });
    const outcome = await wait(fake);
    expect(polls).toBe(4);
    expect(outcome).toMatchObject({ code: 1, text: "MacBook Pro was reopened; the drain stopped" });
  });

  test("a disconnect shorter than three polls is a blip, not an exit", async () => {
    const fake = polled(closedBox({ connected: false }), {
      sessions: () => ({ sessions: [], at: 1 }),
      queue: () => ({ tasks: [], at: 1 }),
    });
    setTimeout(() => fake.setState({ machines: [closedBox()] }), 25);
    expect((await wait(fake, 20)).code).toBe(0);
  });

  test("an older close's cl is not a reopen", async () => {
    let polls = 0;
    const older = { at: 1, scan: 1, cpu: 0, mem: 0, free: 1, cl: CL - 1 };
    const fake = polled(closedBox({ status: older }), {
      sessions: () => {
        polls += 1;
        if (polls === 2) fake.setState({ machines: [closedBox()] });
        return { sessions: polls < 4 ? [pane("t1")] : [], at: 1 };
      },
      queue: () => ({ tasks: [task("t1")], at: 1 }),
    });
    expect((await wait(fake)).code).toBe(0);
    expect(polls).toBe(4);
  });

  test("a machine that goes offline ends the wait with 1", async () => {
    const fake = polled(closedBox({ connected: false }), {
      sessions: () => ({ sessions: [], at: 1 }),
      queue: () => ({ tasks: [], at: 1 }),
    });
    expect(await wait(fake)).toMatchObject({ code: 1, text: "MacBook Pro went offline while draining" });
  });

  test("a pane's task the capped queue left out is asked for by id, so it still counts as moving", async () => {
    const asked: unknown[] = [];
    let polls = 0;
    const fake = polled(closedBox(), {
      sessions: () => {
        polls += 1;
        return { sessions: polls < 3 ? [pane("old-t")] : [], at: 1 };
      },
      queue: (payload) => {
        asked.push(payload);
        const wanted = isRecord(payload) ? payload["tasks"] : undefined;
        return {
          tasks: Array.isArray(wanted) ? [task("old-t", { spec: { repo: ORIGIN, mode: "here", prompt: "x" } })] : [],
          at: 1,
        };
      },
    });
    const outcome = await wait(fake);
    expect(asked).toContainEqual({ tasks: ["old-t"] });
    // Found by id as a `here` task, it is stuck rather than guessed moving: exit 2 on the first poll.
    expect(outcome.code).toBe(2);
    expect(outcome.text).toContain("old-t Can't move: runs in the clone");
  });
});
