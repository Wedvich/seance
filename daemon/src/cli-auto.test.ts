import { describe, expect, test } from "bun:test";
import {
  RequestFailure,
  storeErrorText,
  TASK_REQUEST_LIMITS,
  toBase64,
  type SchedulerAvailability,
  type TaskSpec,
} from "@seance/shared";
import { fakeRelay, machine } from "../test/fake-app-relay.ts";
import { LazyRelay } from "./app-relay.ts";
import { autoFleet, KEYLESS_TEXT, spawnAuto } from "./cli-auto.ts";
import type { SpawnCliArgs } from "./cli.ts";
import type { Config } from "./config.ts";
import { relayFleet } from "./fleet.ts";

const ORIGIN = "github.com/m/seance";
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
): Promise<{ ok: boolean; text: string; audited: readonly string[] }> {
  const lazy = new LazyRelay({ create: () => fake });
  const audited: string[] = [];
  try {
    const outcome = await spawnAuto(
      { repo: "seance", here: false, prompt: "fix it", auto: true, ...args },
      relayFleet(lazy),
      (line) => {
        audited.push(line);
      },
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
  });

  test("a store refusal is worded and audited, and not retried", async () => {
    const fake = scheduledRelay();
    fake.onCreate = () => ({ ok: false, code: "store_full" });
    const { ok, text, audited } = await run(fake);
    expect(ok).toBe(false);
    expect(fake.creates).toHaveLength(1);
    expect(text).toBe(`auto refused (store_full): ${storeErrorText("store_full")}`);
    expect(audited).toEqual([
      expect.stringMatching(/^audit enqueue origin=cli client=cli .* refused code="store_full"$/u),
    ]);
  });

  test("every try unanswered names the task and the app's queue, not an MCP tool", async () => {
    const fake = scheduledRelay();
    fake.onCreate = () => new RequestFailure("dropped", "the relay socket closed", "relay");
    const { ok, text } = await run(fake);
    expect(ok).toBe(false);
    expect(text).toBe(
      `auto: no answer from the relay after 3 tries — task ${fake.creates[0]?.id} may have queued; check the app's queue before retrying`,
    );
  }, 10_000);

  test("a repo no machine reports is refused, with nothing written", async () => {
    const fake = scheduledRelay();
    const { ok, text, audited } = await run(fake, { repo: "nope" });
    expect(ok).toBe(false);
    expect(text).toBe(`auto refused: no repo "nope" for auto — known origins: ${ORIGIN}`);
    expect(fake.creates).toEqual([]);
    expect(audited).toEqual([]);
  });

  test("a prompt over the bound is refused before the relay is dialled", async () => {
    const fake = scheduledRelay();
    const { ok, text } = await run(fake, { prompt: "x".repeat(TASK_REQUEST_LIMITS.prompt + 1) });
    expect(ok).toBe(false);
    expect(text).toStartWith("auto refused: the prompt is");
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
  test("a shell that can read no key is refused, never brokered", async () => {
    const built = await autoFleet(config({ psk: "" }), { stores: [] });
    expect(built).toEqual({ error: KEYLESS_TEXT });
    expect(KEYLESS_TEXT).toContain("needs this machine's own key");
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
    if ("error" in built) throw new Error(built.error);
    const audited: string[] = [];
    try {
      const outcome = await spawnAuto(
        { repo: "seance", here: false, prompt: "fix it", auto: true },
        built.fleet,
        (line) => {
          audited.push(line);
        },
      );
      expect(outcome).toEqual({ ok: false, text: "auto: not queued — the relay did not answer within 300ms" });
    } finally {
      built.fleet.stop();
    }
    expect(audited).toEqual([]);
  });
});
