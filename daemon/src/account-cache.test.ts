import { describe, expect, test } from "bun:test";
import { RequestFailure, type AccountListing, type AccountRecord, type StoreRefusal } from "@seance/shared";
import { fakeRelay } from "../test/fake-app-relay.ts";
import { AccountCache, NULL_HOLD_MS } from "./account-cache.ts";

const RECORDS: readonly AccountRecord[] = [{ accountId: "org-a:me", alias: "personal", version: 1 }];

type Answer = AccountListing | StoreRefusal | null;

/** A listing the test answers when it chooses; each call to `next` is one more in-flight listing. */
function deferred(): { listAccounts: () => Promise<Answer>; answers: ((answer: Answer) => void)[] } {
  const answers: ((answer: Answer) => void)[] = [];
  return {
    answers,
    listAccounts: () =>
      new Promise<Answer>((resolve) => {
        answers.push(resolve);
      }),
  };
}

const LISTING: AccountListing = {
  ok: true,
  accounts: RECORDS.map((record) => ({ key: `account:${record.accountId}`, record })),
  unreadable: [],
};

function cached(): { relay: ReturnType<typeof fakeRelay>; cache: AccountCache; tick: (ms: number) => void } {
  const relay = fakeRelay([]);
  relay.accounts = RECORDS;
  let now = 1_000_000;
  return { relay, cache: new AccountCache(relay, () => now), tick: (ms) => void (now += ms) };
}

describe("AccountCache", () => {
  test("lists once for every read, concurrent or later, until something drops it", async () => {
    const { relay, cache } = cached();
    const [a, b] = await Promise.all([cache.read({ hold: true }), cache.read({ hold: true })]);
    expect(await cache.read({ hold: true })).toEqual(RECORDS);
    expect([a, b]).toEqual([RECORDS, RECORDS]);
    expect(relay.accountLists).toBe(1);
  });

  test("an account: nudge drops it, another prefix's does not", async () => {
    const { relay, cache } = cached();
    await cache.read({ hold: true });
    relay.storeChanged("task:abc", 2);
    await cache.read({ hold: true });
    expect(relay.accountLists).toBe(1);
    relay.storeChanged("account:abc", 2);
    await cache.read({ hold: true });
    expect(relay.accountLists).toBe(2);
  });

  test("a reopened socket drops it: nudges sent while it was down are lost", async () => {
    const { relay, cache } = cached();
    await cache.read({ hold: true });
    relay.setState({ status: "connecting" });
    await cache.read({ hold: true });
    expect(relay.accountLists).toBe(1);
    relay.setState({ status: "open" });
    await cache.read({ hold: true });
    expect(relay.accountLists).toBe(2);
  });

  test("a refused or lost listing reads as null, and is held as null for a window, not listed again per call", async () => {
    const { relay, cache, tick } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    expect(await cache.read({ hold: true })).toBeNull();
    relay.accounts = RECORDS;
    expect(await cache.read({ hold: true })).toBeNull();
    tick(NULL_HOLD_MS - 1);
    expect(await cache.read({ hold: true })).toBeNull();
    expect(relay.accountLists).toBe(1);
    tick(1);
    expect(await cache.read({ hold: true })).toEqual(RECORDS);
    expect(relay.accountLists).toBe(2);

    // A lost listing is held alike.
    const lost = cached();
    lost.relay.accounts = new RequestFailure("timeout", "no answer");
    expect(await lost.cache.read({ hold: true })).toBeNull();
    lost.relay.accounts = RECORDS;
    expect(await lost.cache.read({ hold: true })).toBeNull();
    expect(lost.relay.accountLists).toBe(1);
  });

  test("neither a reopen nor a store-changed ends the hold: a flapping socket must not list again at once", async () => {
    const { relay, cache, tick } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    await cache.read({ hold: true });
    relay.accounts = RECORDS;
    relay.storeChanged("account:abc", 2);
    relay.setState({ status: "connecting" });
    relay.setState({ status: "open" });
    expect(await cache.read({ hold: true })).toBeNull();
    expect(relay.accountLists).toBe(1);
    tick(NULL_HOLD_MS);
    expect(await cache.read({ hold: true })).toEqual(RECORDS);
  });

  test("a read that bypasses the hold lists again, and a readable answer clears the hold", async () => {
    const { relay, cache } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    await cache.read({ hold: true });
    relay.accounts = RECORDS;
    expect(await cache.read()).toEqual(RECORDS);
    expect(await cache.read({ hold: true })).toEqual(RECORDS);
    expect(relay.accountLists).toBe(2);
  });

  test("anything but a request failure still throws", async () => {
    const { relay, cache } = cached();
    relay.accounts = new Error("bug");
    await expect(cache.read({ hold: true })).rejects.toThrow("bug");
    // The rejection is not kept: a bypassing read lists again.
    relay.accounts = RECORDS;
    expect(await cache.read()).toEqual(RECORDS);
  });

  test("a stale listing finishing last neither sets nor clears the hold", async () => {
    const staleNull = cached();
    const { answers, listAccounts } = deferred();
    staleNull.relay.accounts = listAccounts;
    const first = staleNull.cache.read({ hold: true });
    staleNull.relay.storeChanged("account:x", 2);
    const second = staleNull.cache.read({ hold: true });
    answers[1]?.(LISTING);
    expect(await second).toEqual(RECORDS);
    answers[0]?.(null);
    expect(await first).toBeNull();
    // The stale null must not hold: drop the view and the next label read lists.
    staleNull.relay.storeChanged("account:x", 3);
    staleNull.relay.accounts = RECORDS;
    expect(await staleNull.cache.read({ hold: true })).toEqual(RECORDS);

    const staleOk = cached();
    const { answers: resolvers, listAccounts: listStale } = deferred();
    staleOk.relay.accounts = listStale;
    const old = staleOk.cache.read({ hold: true });
    staleOk.relay.storeChanged("account:x", 2);
    const current = staleOk.cache.read({ hold: true });
    resolvers[1]?.({ ok: false, code: "rate_limited" });
    expect(await current).toBeNull();
    resolvers[0]?.(LISTING);
    await old;
    // The stale success must not clear the current refusal's hold.
    staleOk.relay.accounts = RECORDS;
    expect(await staleOk.cache.read({ hold: true })).toBeNull();
  });

  test("a label read during a hold joins a listing already in flight", async () => {
    const { relay, cache } = cached();
    relay.accounts = { ok: false, code: "rate_limited" };
    await cache.read({ hold: true });
    const { answers, listAccounts } = deferred();
    relay.accounts = listAccounts;
    const pin = cache.read();
    const label = cache.read({ hold: true });
    answers[0]?.(LISTING);
    expect(await label).toEqual(RECORDS);
    expect(await pin).toEqual(RECORDS);
    expect(relay.accountLists).toBe(2);
  });

  test("an unexpected error is held too, so a deterministic bug does not list on every call", async () => {
    const { relay, cache, tick } = cached();
    relay.accounts = new Error("bug");
    await expect(cache.read({ hold: true })).rejects.toThrow("bug");
    relay.accounts = RECORDS;
    expect(await cache.read({ hold: true })).toBeNull();
    expect(relay.accountLists).toBe(1);
    tick(NULL_HOLD_MS);
    expect(await cache.read({ hold: true })).toEqual(RECORDS);
  });
});
