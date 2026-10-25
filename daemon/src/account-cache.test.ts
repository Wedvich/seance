import { describe, expect, test } from "bun:test";
import { RequestFailure, type AccountRecord } from "@seance/shared";
import { fakeRelay } from "../test/fake-app-relay.ts";
import { AccountCache, NULL_HOLD_MS } from "./account-cache.ts";

const RECORDS: readonly AccountRecord[] = [{ accountId: "org-a:me", alias: "personal", version: 1 }];

function cached(): { relay: ReturnType<typeof fakeRelay>; cache: AccountCache; tick: (ms: number) => void } {
  const relay = fakeRelay([]);
  relay.accounts = RECORDS;
  let now = 1_000_000;
  return { relay, cache: new AccountCache(relay, () => now), tick: (ms) => void (now += ms) };
}

describe("AccountCache", () => {
  test("lists once for every read, concurrent or later, until something drops it", async () => {
    const { relay, cache } = cached();
    const [a, b] = await Promise.all([cache.read(), cache.read()]);
    expect(await cache.read()).toEqual(RECORDS);
    expect([a, b]).toEqual([RECORDS, RECORDS]);
    expect(relay.accountLists).toBe(1);
  });

  test("an account: nudge drops it, another prefix's does not", async () => {
    const { relay, cache } = cached();
    await cache.read();
    relay.storeChanged("task:abc", 2);
    await cache.read();
    expect(relay.accountLists).toBe(1);
    relay.storeChanged("account:abc", 2);
    await cache.read();
    expect(relay.accountLists).toBe(2);
  });

  test("a reopened socket drops it: nudges sent while it was down are lost", async () => {
    const { relay, cache } = cached();
    await cache.read();
    relay.setState({ status: "connecting" });
    await cache.read();
    expect(relay.accountLists).toBe(1);
    relay.setState({ status: "open" });
    await cache.read();
    expect(relay.accountLists).toBe(2);
  });

  test("a refused or lost listing reads as null, and is held as null for a window, not listed again per call", async () => {
    const { relay, cache, tick } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    expect(await cache.read()).toBeNull();
    relay.accounts = RECORDS;
    expect(await cache.read()).toBeNull();
    tick(NULL_HOLD_MS - 1);
    expect(await cache.read()).toBeNull();
    expect(relay.accountLists).toBe(1);
    tick(1);
    expect(await cache.read()).toEqual(RECORDS);
    expect(relay.accountLists).toBe(2);

    // A lost listing is held alike.
    const lost = cached();
    lost.relay.accounts = new RequestFailure("timeout", "no answer");
    expect(await lost.cache.read()).toBeNull();
    lost.relay.accounts = RECORDS;
    expect(await lost.cache.read()).toBeNull();
    expect(lost.relay.accountLists).toBe(1);
  });

  test("neither a reopen nor a store-changed ends the hold: a flapping socket must not list again at once", async () => {
    const { relay, cache, tick } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    await cache.read();
    relay.accounts = RECORDS;
    relay.storeChanged("account:abc", 2);
    relay.setState({ status: "connecting" });
    relay.setState({ status: "open" });
    expect(await cache.read()).toBeNull();
    expect(relay.accountLists).toBe(1);
    tick(NULL_HOLD_MS);
    expect(await cache.read()).toEqual(RECORDS);
  });

  test("a read that bypasses the hold lists again, and a readable answer clears the hold", async () => {
    const { relay, cache } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    await cache.read();
    relay.accounts = RECORDS;
    expect(await cache.read({ bypassHold: true })).toEqual(RECORDS);
    expect(await cache.read()).toEqual(RECORDS);
    expect(relay.accountLists).toBe(2);
  });

  test("anything but a request failure still throws", async () => {
    const { relay, cache } = cached();
    relay.accounts = new Error("bug");
    await expect(cache.read()).rejects.toThrow("bug");
    // The rejection is not kept: a later read lists again.
    relay.accounts = RECORDS;
    expect(await cache.read()).toEqual(RECORDS);
  });
});
