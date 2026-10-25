import { describe, expect, test } from "bun:test";
import { importAccountKey, importPsk, sealAtRest, toBase64 } from "./crypto.ts";
import {
  accountName,
  accountNameIn,
  accountRecord,
  accountStoreKey,
  knownAccounts,
  openAccountListing,
  openAccountRecord,
  sealAccountRecord,
} from "./account-record.ts";
import { isStoreKey } from "./parse.ts";
import { APP_ID, AT_REST_OPS, SCHEDULER_ID, type AccountRecord, type ExclaveInfo, type StoreRecord } from "./types.ts";

const psk = toBase64(new Uint8Array(32).fill(5));
const key = await importPsk(psk);
const accountKey = await importAccountKey(psk);

const ID = "e2e-org:e2e-account";
const OTHER_ID = "e2e-org:other";

async function stored(
  record: AccountRecord,
  version: number = record.version,
  id: string = record.accountId,
): Promise<StoreRecord> {
  return { key: await accountStoreKey(accountKey, id), version, env: await sealAccountRecord(key, APP_ID, record) };
}

describe("account store keys", () => {
  test("derive to a fixed key that passes isStoreKey", async () => {
    const storeKey = await accountStoreKey(accountKey, ID);
    expect(storeKey).toBe("account:1f652c16eb58eb2f14e0bd9d415830667e36180580775ac6609edf4f7d666a09");
    expect(isStoreKey(storeKey)).toBe(true);
  });

  test("another PSK or another account id is another key", async () => {
    const otherPsk = await importAccountKey(toBase64(new Uint8Array(32).fill(6)));
    const base = await accountStoreKey(accountKey, ID);
    expect(await accountStoreKey(otherPsk, ID)).not.toBe(base);
    expect(await accountStoreKey(accountKey, OTHER_ID)).not.toBe(base);
  });
});

describe("accountRecord", () => {
  test("trims the alias, turns a blank one into a clear and refuses one past the bound", () => {
    expect(accountRecord(ID, "  work ", 3)).toEqual({ version: 3, accountId: ID, alias: "work" });
    expect(accountRecord(ID, "  ", 1)).toEqual({ version: 1, accountId: ID, alias: null });
    expect(accountRecord(ID, null, 1)).toEqual({ version: 1, accountId: ID, alias: null });
    expect(accountRecord(ID, "x".repeat(65), 1)).toBeNull();
  });
});

describe("account records at rest", () => {
  test("a sealed record opens and binds, a cleared one included", async () => {
    for (const alias of ["work", null]) {
      const record: AccountRecord = { version: 1, accountId: ID, alias };
      const env = await sealAccountRecord(key, APP_ID, record);
      expect(env.to).toBe(APP_ID);
      expect(await openAccountRecord(key, accountKey, await stored(record))).toEqual(record);
    }
  });

  test("another key, another op or another addressee is unopenable", async () => {
    const record: AccountRecord = { version: 1, accountId: ID, alias: "work" };
    const base = { key: await accountStoreKey(accountKey, ID), version: 1 };
    const foreign = await sealAccountRecord(await importPsk(toBase64(new Uint8Array(32).fill(9))), APP_ID, record);
    const wrongOp = await sealAtRest(key, { to: APP_ID, from: APP_ID }, AT_REST_OPS.task, record);
    const toScheduler = await sealAtRest(key, { to: SCHEDULER_ID, from: APP_ID }, AT_REST_OPS.account, record);
    for (const env of [foreign, wrongOp, toScheduler]) {
      expect(await openAccountRecord(key, accountKey, { ...base, env })).toBe("unopenable");
    }
  });

  test("an alias that is blank or past the bound is malformed", async () => {
    const base = { key: await accountStoreKey(accountKey, ID), version: 1 };
    for (const alias of ["", "x".repeat(65)]) {
      const env = await sealAtRest(key, { to: APP_ID, from: APP_ID }, AT_REST_OPS.account, {
        version: 1,
        accountId: ID,
        alias,
      });
      expect(await openAccountRecord(key, accountKey, { ...base, env })).toBe("malformed");
    }
  });

  test("a version-1 blob put back by overwrite lands higher and reads version_mismatch", async () => {
    const v1 = await stored({ version: 1, accountId: ID, alias: "work" });
    expect(await openAccountRecord(key, accountKey, { ...v1, version: 2 })).toBe("version_mismatch");
  });

  test("a blob moved to another account's key reads key_mismatch", async () => {
    const a = await stored({ version: 1, accountId: ID, alias: "work" });
    const b = await stored({ version: 1, accountId: OTHER_ID, alias: "home" });
    expect(await openAccountRecord(key, accountKey, { ...b, env: a.env })).toBe("key_mismatch");
  });
});

describe("openAccountListing", () => {
  test("keeps readable records and reports the rest by key and reason", async () => {
    const good = await stored({ version: 1, accountId: ID, alias: "work" });
    const stale = { ...(await stored({ version: 1, accountId: OTHER_ID, alias: "home" })), version: 2 };
    const listing = await openAccountListing(key, accountKey, [good, stale]);
    expect(listing.accounts).toEqual([{ key: good.key, record: { version: 1, accountId: ID, alias: "work" } }]);
    expect(listing.unreadable).toEqual([{ key: stale.key, version: 2, reason: "version_mismatch" }]);
  });

  test("a key listed twice and a key outside the prefix are key_mismatch", async () => {
    const good = await stored({ version: 1, accountId: ID, alias: "work" });
    const other = await stored({ version: 1, accountId: OTHER_ID, alias: "home" });
    const foreign = { ...other, key: "task:abc" };
    const listing = await openAccountListing(key, accountKey, [good, good, foreign]);
    expect(listing.accounts).toEqual([]);
    expect(listing.unreadable.map((u) => u.reason)).toEqual(["key_mismatch", "key_mismatch", "key_mismatch"]);
  });
});

describe("account labels", () => {
  const exclave = (accountId: string | null, email?: string): ExclaveInfo => ({
    id: "default",
    accountId,
    ...(email === undefined ? {} : { email }),
    extraUsageEnabled: null,
    authOk: accountId !== null,
    skills: [],
  });
  const PERSONAL = "1a2b3c4d-personal:acct-0123456789";
  const TEAM = "9f8e7d6c-team:acct-0123456789";
  const OTHER = "1a2b3c4d-personal:acct-ffffffff";
  const machines = [
    { exclaves: [exclave(PERSONAL, "me@example.com"), exclave(null)] },
    { exclaves: [exclave(TEAM)] },
    { exclaves: [exclave(TEAM, "me@example.com"), exclave(OTHER, "you@example.com")] },
    {},
  ];

  test("knownAccounts lists each signed-in account once, with the email some exclave reports", () => {
    expect(knownAccounts(machines)).toEqual([
      { accountId: PERSONAL, email: "me@example.com" },
      { accountId: TEAM, email: "me@example.com" },
      { accountId: OTHER, email: "you@example.com" },
    ]);
  });

  test("an email two known accounts share gains each one's org; a unique email or an alias reads as itself", () => {
    const known = knownAccounts(machines);
    expect(accountNameIn(known, PERSONAL)).toBe("me@example.com (org 1a2b3c4d)");
    expect(accountNameIn(known, TEAM)).toBe("me@example.com (org 9f8e7d6c)");
    expect(accountNameIn(known, OTHER)).toBe("you@example.com");
    expect(accountNameIn(known, TEAM, "work")).toBe("work");
    // Without the other org in view there is nothing to tell apart.
    expect(accountName(PERSONAL, "me@example.com", undefined, known.slice(0, 1))).toBe("me@example.com");
  });

  test("a short id two known accounts share gains the org too, and an id the registry lacks is labelled against it", () => {
    const known = [
      { accountId: PERSONAL, email: undefined },
      { accountId: TEAM, email: undefined },
    ];
    expect(accountNameIn(known, PERSONAL)).toBe("acct acct-012 (org 1a2b3c4d)");
    expect(accountNameIn(known, "elsewhere:acct-0123456789")).toBe("acct acct-012 (org elsewher)");
    expect(accountNameIn(known, OTHER)).toBe("acct acct-fff");
    expect(accountName("work", undefined)).toBe("acct work");
  });
});
