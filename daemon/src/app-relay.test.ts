import { describe, expect, test } from "bun:test";
import { fakeRelay, machine, type FakeRelay } from "../test/fake-app-relay.ts";
import { pollUntil } from "../test/fixtures.ts";
import { LazyRelay } from "./app-relay.ts";

describe("LazyRelay", () => {
  test("does not dial until the first acquire, and shares one client after", async () => {
    let created = 0;
    const lazy = new LazyRelay({
      create: () => {
        created += 1;
        return fakeRelay([machine()]);
      },
    });
    expect(created).toBe(0);
    const [a, b] = await Promise.all([lazy.acquire(), lazy.acquire()]);
    expect(created).toBe(1);
    expect(a).toBe(b);
    lazy.stop();
  });

  test("hangs up after the idle window and redials on the next call", async () => {
    const fakes: FakeRelay[] = [];
    const lazy = new LazyRelay({
      create: () => {
        const fake = fakeRelay([machine()]);
        fakes.push(fake);
        return fake;
      },
      idleMs: 20,
    });
    await lazy.acquire();
    lazy.release();
    await pollUntil(() => fakes[0]?.stopped === true, "the idle timer to stop the client");
    await lazy.acquire();
    expect(fakes).toHaveLength(2);
    lazy.stop();
  });

  test("a rejected token surfaces as an error instead of a silent retry loop", async () => {
    const lazy = new LazyRelay({ create: () => fakeRelay([], () => ({}), "rejected") });
    await expect(lazy.acquire()).rejects.toThrow("bearer token");
  });

  test("a relay that never answers fails the call instead of riding the backoff forever", async () => {
    const lazy = new LazyRelay({
      create: () => fakeRelay([], () => ({}), "connecting"),
      connectTimeoutMs: 30,
    });
    await expect(lazy.acquire()).rejects.toThrow("did not answer");
  });

  test("stop() during a pending connect stops the dialing client instead of adopting it", async () => {
    let fake: FakeRelay | undefined;
    const lazy = new LazyRelay({
      create: () => {
        fake = fakeRelay([machine()], () => ({}), "connecting");
        return fake;
      },
    });
    const pending = lazy.acquire();
    lazy.stop();
    fake?.setState({ status: "open", registrySettled: true });
    await expect(pending).rejects.toThrow("stopped");
    expect(fake?.stopped).toBe(true);
  });

  test("open then rejected before the registry settles fails the call, and the next call redials", async () => {
    const fakes: FakeRelay[] = [];
    const lazy = new LazyRelay({
      create: () => {
        const fake = fakeRelay([machine()], () => ({}), "connecting");
        fakes.push(fake);
        return fake;
      },
    });
    const first = lazy.acquire();
    // The relay accepts the upgrade, then closes 4401: open is seen, settled never comes.
    await pollUntil(() => fakes[0]?.started === 1, "the first dial");
    fakes[0]?.setState({ status: "open" });
    fakes[0]?.setState({ status: "rejected", rejection: "unauthorized" });
    await expect(first).rejects.toThrow("bearer token");
    expect(fakes[0]?.stopped).toBe(true);

    const second = lazy.acquire();
    await pollUntil(() => fakes.length === 2, "a fresh dial after the failure");
    fakes[1]?.setState({ status: "open", registrySettled: true });
    expect(await second).toBe(fakes[1]);
    lazy.stop();
  });

  test("a registry that never settles fails the call instead of hanging every later one", async () => {
    const fakes: FakeRelay[] = [];
    const lazy = new LazyRelay({
      create: () => {
        const fake = fakeRelay([machine()], () => ({}), "open");
        fake.setState({ registrySettled: false });
        fakes.push(fake);
        return fake;
      },
      registrySettleMs: 30,
    });
    await expect(lazy.acquire()).rejects.toThrow("did not settle");
    await expect(lazy.acquire()).rejects.toThrow("did not settle");
    expect(fakes).toHaveLength(2);
  });

  test("a cached client the relay later rejected is dropped and redialled", async () => {
    const fakes: FakeRelay[] = [];
    const lazy = new LazyRelay({
      create: () => {
        const fake = fakeRelay([machine()]);
        fakes.push(fake);
        return fake;
      },
    });
    await lazy.acquire();
    lazy.release();
    fakes[0]?.setState({ status: "rejected", rejection: "unauthorized" });
    const next = await lazy.acquire();
    expect(fakes).toHaveLength(2);
    expect(fakes[0]?.stopped).toBe(true);
    expect(next).toBe(fakes[1]);
    lazy.stop();
  });
});
