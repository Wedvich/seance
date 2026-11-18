import { describe, expect, test } from "bun:test";
import { CAPABILITIES, type ParsedWatchSet, type WatchSet } from "@seance/shared";
import { fakeRelay, machine, type FakeRelay } from "../test/fake-app-relay.ts";
import { pollUntil } from "../test/fixtures.ts";
import { LazyRelay } from "./app-relay.ts";
import { createWatchLeader, type WatchLeader } from "./watch-leader.ts";

const BOOT = "44444444-4444-4444-8444-444444444444";
const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const SET: WatchSet = {
  gen: { boot: BOOT, n: 1 },
  watches: [{ id: ID, kind: "pr", url: "https://github.com/octo/widgets/pull/42", seen: [] }],
};

interface Harness {
  readonly leader: WatchLeader;
  readonly fakes: FakeRelay[];
  readonly nominees: number[];
  readonly relayed: WatchSet[];
  readonly inProcess: ParsedWatchSet[];
  readonly lead: { self: boolean; accepts: boolean };
}

const LEADER = machine({ deviceId: "leader-1", capabilities: [CAPABILITIES.watches] });

function harness(options: { fake?: () => FakeRelay; settleMs?: number } = {}): Harness {
  const fakes: FakeRelay[] = [];
  const nominees: number[] = [];
  const relayed: WatchSet[] = [];
  const inProcess: ParsedWatchSet[] = [];
  const lead = { self: false, accepts: true };
  const lazy = new LazyRelay({
    create: () => {
      const fake = options.fake?.() ?? fakeRelay([LEADER]);
      fakes.push(fake);
      return fake;
    },
  });
  const leader = createWatchLeader({
    selfLeads: () => lead.self,
    inProcess: (set) => {
      inProcess.push(set);
      return lead.accepts;
    },
    sendRelay: (set) => {
      relayed.push(set);
      return Promise.resolve(true);
    },
    relay: lazy,
    onNominee: () => void nominees.push(nominees.length),
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
  });
  return { leader, fakes, nominees, relayed, inProcess, lead };
}

const ready = { kind: "ready", deviceId: "leader-1", term: 1 } as const;

describe("check", () => {
  test("a ready leader that advertises watches is ready", async () => {
    const fake = fakeRelay([LEADER]);
    fake.setState({ scheduler: ready });
    const h = harness({ fake: () => fake });
    expect(await h.leader.check()).toBe("ready");
    h.leader.stop();
  });

  test("a ready leader without the capability is unsupported", async () => {
    const fake = fakeRelay([machine({ deviceId: "leader-1", capabilities: [] })]);
    fake.setState({ scheduler: ready });
    const h = harness({ fake: () => fake });
    expect(await h.leader.check()).toBe("unsupported");
    h.leader.stop();
  });

  test("no nominee is none", async () => {
    const h = harness();
    expect(await h.leader.check()).toBe("none");
    h.leader.stop();
  });

  test("an unverified nominee that turns ready within the settle window is ready, and one that does not is none", async () => {
    const turning = fakeRelay([LEADER]);
    turning.setState({ scheduler: { kind: "unverified", deviceId: "leader-1", term: 1 } });
    const h = harness({ fake: () => turning, settleMs: 2_000 });
    const verdict = h.leader.check();
    await Bun.sleep(20);
    turning.setState({ scheduler: ready });
    expect(await verdict).toBe("ready");
    h.leader.stop();

    const stuck = fakeRelay([LEADER]);
    stuck.setState({ scheduler: { kind: "unverified", deviceId: "leader-1", term: 1 } });
    const s = harness({ fake: () => stuck, settleMs: 30 });
    expect(await s.leader.check()).toBe("none");
    s.leader.stop();
  });

  test("a failed acquire is none", async () => {
    const h = harness({ fake: () => fakeRelay([], () => ({}), "rejected") });
    expect(await h.leader.check()).toBe("none");
    h.leader.stop();
  });

  test("a daemon that leads is ready without dialling anything", async () => {
    const h = harness();
    h.lead.self = true;
    expect(await h.leader.check()).toBe("ready");
    expect(h.fakes).toHaveLength(0);
    h.leader.stop();
  });

  test("a check releases its own acquire: stopping the leader closes the lazy client", async () => {
    const h = harness();
    await h.leader.check();
    expect(h.fakes).toHaveLength(1);
    h.leader.stop();
    expect(h.fakes[0]?.stopped).toBe(true);
  });
});

describe("hold", () => {
  test("calls onNominee once per new verified nominee, not for the baseline or a repeated state push", async () => {
    const fake = fakeRelay([LEADER]);
    fake.setState({ scheduler: ready });
    const h = harness({ fake: () => fake });
    h.leader.hold();
    h.leader.hold();
    await pollUntil(() => fake.started === 1, "the held leg to dial");
    // The baseline read lands after the acquire resolves.
    await Bun.sleep(20);
    expect(h.nominees).toHaveLength(0);

    fake.setState({ machines: [LEADER, machine({ deviceId: "m2" })] });
    expect(h.nominees).toHaveLength(0);

    fake.setState({ scheduler: { kind: "ready", deviceId: "leader-2", term: 2 } });
    expect(h.nominees).toHaveLength(1);
    fake.setState({ scheduler: { kind: "none" } });
    fake.setState({ scheduler: { kind: "ready", deviceId: "leader-2", term: 2 } });
    expect(h.nominees).toHaveLength(1);
    fake.setState({ scheduler: { kind: "ready", deviceId: "leader-2", term: 3 } });
    expect(h.nominees).toHaveLength(2);
    h.leader.stop();
  });

  test("release stops listening for a nominee", async () => {
    const fake = fakeRelay([LEADER]);
    const h = harness({ fake: () => fake });
    h.leader.hold();
    await pollUntil(() => fake.started === 1, "the held leg to dial");
    await Bun.sleep(20);
    h.leader.release();
    fake.setState({ scheduler: ready });
    expect(h.nominees).toHaveLength(0);
    h.leader.stop();
    expect(fake.stopped).toBe(true);
  });

  test("a failed acquire is retried at the next hold", async () => {
    let attempts = 0;
    const h = harness({
      fake: () => {
        attempts += 1;
        return attempts === 1 ? fakeRelay([], () => ({}), "rejected") : fakeRelay([LEADER]);
      },
    });
    h.leader.hold();
    await pollUntil(() => attempts === 1, "the first attempt");
    await Bun.sleep(20);
    h.leader.hold();
    await pollUntil(() => attempts === 2, "the retry");
    h.leader.stop();
  });
});

describe("send", () => {
  test("goes in process, parsed, when this daemon leads, and never on the relay leg", async () => {
    const h = harness();
    h.lead.self = true;
    expect(await h.leader.send(SET)).toBe(true);
    expect(h.inProcess).toHaveLength(1);
    expect(h.inProcess[0]?.watches[0]?.id).toBe(ID);
    expect(h.relayed).toHaveLength(0);
    h.lead.accepts = false;
    expect(await h.leader.send(SET)).toBe(false);
    h.leader.stop();
  });

  test("a set that does not parse is never handed to the leader", async () => {
    const h = harness();
    h.lead.self = true;
    // A duplicate id drops the whole frame at the leader's parser.
    const bad: WatchSet = { gen: SET.gen, watches: [...SET.watches, ...SET.watches] };
    expect(await h.leader.send(bad)).toBe(false);
    expect(h.inProcess).toHaveLength(0);
    h.leader.stop();
  });

  test("goes on the daemon leg otherwise, through no app client", async () => {
    const h = harness();
    expect(await h.leader.send(SET)).toBe(true);
    expect(h.relayed).toEqual([SET]);
    expect(h.inProcess).toHaveLength(0);
    expect(h.fakes).toHaveLength(0);
    h.leader.stop();
  });
});
