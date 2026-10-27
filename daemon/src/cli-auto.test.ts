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
import { brokerFail, brokerOk } from "./broker-protocol.ts";
import { autoFleet, continueTaskAuto, spawnAuto } from "./cli-auto.ts";
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
  const CAN = [CAPABILITIES.continueTask];

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
