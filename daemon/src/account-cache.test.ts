import { describe, expect, test } from "bun:test";
import { RequestFailure, type AccountRecord } from "@seance/shared";
import { fakeRelay } from "../test/fake-app-relay.ts";
import { AccountCache } from "./account-cache.ts";

const RECORDS: readonly AccountRecord[] = [{ accountId: "org-a:me", alias: "personal", version: 1 }];

function cached(): { relay: ReturnType<typeof fakeRelay>; cache: AccountCache } {
  const relay = fakeRelay([]);
  relay.accounts = RECORDS;
  return { relay, cache: new AccountCache(relay) };
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

  test("a refused or lost listing reads as null and is not kept", async () => {
    const { relay, cache } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    expect(await cache.read()).toBeNull();
    relay.accounts = new RequestFailure("timeout", "no answer");
    expect(await cache.read()).toBeNull();
    relay.accounts = RECORDS;
    expect(await cache.read()).toEqual(RECORDS);
    expect(relay.accountLists).toBe(3);
  });

  test("anything but a request failure still throws", async () => {
    const { relay, cache } = cached();
    relay.accounts = new Error("bug");
    expect(cache.read()).rejects.toThrow("bug");
  });
});
