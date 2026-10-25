import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  accountStoreKey,
  APP_ID,
  parseStoreReply,
  sealAccountRecord,
  type Envelope,
  type StoreReplyFrame,
} from "@seance/shared";
import { pollUntil } from "../daemon/test/fixtures.ts";
import { connectApp, type Client } from "../relay/test/harness.ts";
import { deriveMachines } from "../pwa/src/machines-view.ts";
import type { AppState } from "../pwa/src/view.ts";
import { E2E_ACCOUNT_ID, startApp, type AppHandle, type Stack } from "./harness.ts";
import { startSuite, type Suite } from "./suite.ts";

let suite: Suite | undefined;
let stack: Stack;

beforeAll(async () => {
  suite = await startSuite("e2e-accounts");
  ({ stack } = suite);
});

afterAll(async () => {
  // startSuite failing in beforeAll leaves suite unset, having torn down what it started.
  await suite?.dispose();
});

const OTHER_ID = "e2e-org:other";

/** The relay's `account:` list bucket is shared by every app (and the cap is 64): few keys, few apps. */
async function reply(
  raw: Client,
  frame: { readonly id: string; readonly [field: string]: unknown },
): Promise<StoreReplyFrame | null> {
  raw.send(frame);
  return parseStoreReply(await raw.waitForRe<{ re: string }>(frame.id, 10_000));
}

async function rawPut(raw: Client, key: string, held: number, env: Envelope): Promise<StoreReplyFrame | null> {
  return reply(raw, { t: "store-put", id: crypto.randomUUID(), key, expect: held, env });
}

async function rawGet(raw: Client, key: string): Promise<{ version: number; env: Envelope } | null> {
  const answer = await reply(raw, { t: "store-get", id: crypto.randomUUID(), key });
  if (answer?.t !== "store-record") throw new Error(`no store-record: ${JSON.stringify(answer)}`);
  return answer.record === null ? null : { version: answer.record.version, env: answer.record.env };
}

/** The account's card as the Machines screen would draw it, aliases included. */
function cardOf(state: AppState): ReturnType<typeof deriveMachines>["accounts"][number] | undefined {
  return deriveMachines(state.relay.machines, Date.now(), state.relay.scheduler, state.accounts.aliases).accounts.find(
    (account) => account.accountId === E2E_ACCOUNT_ID,
  );
}

/** Counts what the app's account store reads off the relay; patched before the socket opens, so the first listing is counted. */
function countReads(app: AppHandle): { lists: () => number; listed: () => number; gets: () => number } {
  const { client } = app;
  const list = client.listAccounts.bind(client);
  const get = client.getAccountRecord.bind(client);
  let lists = 0;
  let listed = 0;
  let gets = 0;
  client.listAccounts = async () => {
    lists += 1;
    try {
      return await list();
    } finally {
      listed += 1;
    }
  };
  client.getAccountRecord = async (key) => {
    gets += 1;
    return get(key);
  };
  return { lists: () => lists, listed: () => listed, gets: () => gets };
}

describe("account aliases across clients", () => {
  test("a record filed under a key it does not hash to names no account, while a genuine one beside it does", async () => {
    const raw = await connectApp(stack.relay);
    const apps: AppHandle[] = [];
    try {
      const genuineKey = await accountStoreKey(stack.accountKey, OTHER_ID);
      const genuine = await sealAccountRecord(stack.appKey, APP_ID, {
        version: 1,
        accountId: OTHER_ID,
        alias: "genuine",
      });
      const forgedKey = `account:${"0".repeat(64)}`;
      const forged = await sealAccountRecord(stack.appKey, APP_ID, {
        version: 1,
        accountId: E2E_ACCOUNT_ID,
        alias: "forged",
      });
      // Both land before either app starts: one listing reads both, so the genuine one's alias proves the forged one was read too.
      expect((await rawPut(raw, forgedKey, 0, forged))?.t).toBe("store-written");
      expect((await rawPut(raw, genuineKey, 0, genuine))?.t).toBe("store-written");

      apps.push(startApp(stack, {}, null, { accounts: true }), startApp(stack, {}, null, { accounts: true }));
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new Error("apps did not start");
      const seen = await b.waitForApp(
        (state) => state.accounts.aliases[OTHER_ID] === "genuine",
        "B to list the genuine alias",
      );
      expect(seen.accounts.aliases[E2E_ACCOUNT_ID]).toBeUndefined();
      expect(seen.accounts.aliases).toEqual({ [OTHER_ID]: "genuine" });
      const withCard = await b.waitForApp((state) => cardOf(state) !== undefined, "B's account card");
      expect(cardOf(withCard)?.detail).not.toContain("forged");
    } finally {
      for (const app of apps) app.stop();
      raw.close();
    }
  });

  test("a rename reaches another client by nudge alone, clears to the short id, and a put-back older blob never resurfaces", async () => {
    const raw = await connectApp(stack.relay);
    const a = startApp(stack, {}, null, { accounts: true });
    const b = startApp(stack, {}, null, { accounts: true });
    const reads = countReads(b);
    try {
      await pollUntil(() => reads.listed() >= 1, "B's first listing", 10_000);
      await b.waitForApp((state) => cardOf(state) !== undefined, "B's account card");
      await a.waitForApp((state) => state.accounts.nameable, "A to be able to name accounts");
      await pollUntil(() => a.store.getState().accounts.saving === null, "A idle");

      await a.store.renameAccount(E2E_ACCOUNT_ID, "work");
      expect(a.store.getState().accounts.notice).toBeNull();
      const named = await b.waitForApp(
        (state) => state.accounts.aliases[E2E_ACCOUNT_ID] === "work",
        "B to show the new name",
      );
      expect(cardOf(named)?.detail).toStartWith("work · on ");
      // A nudge and one read, not a re-list.
      expect(reads.lists()).toBe(1);
      expect(reads.gets()).toBe(1);

      const key = await accountStoreKey(stack.accountKey, E2E_ACCOUNT_ID);
      const first = await rawGet(raw, key);
      if (first === null) throw new Error("the renamed account has no record");
      expect(first.version).toBe(1);

      await a.store.renameAccount(E2E_ACCOUNT_ID, "");
      const cleared = await b.waitForApp(
        (state) => state.accounts.aliases[E2E_ACCOUNT_ID] === undefined,
        "B to show the clear",
      );
      expect(cardOf(cleared)?.detail).toStartWith("acct e2e-acco · on ");

      await a.store.renameAccount(E2E_ACCOUNT_ID, "home");
      await b.waitForApp((state) => state.accounts.aliases[E2E_ACCOUNT_ID] === "home", "B to show home");

      // The genuine version-1 `work` blob, put back by overwrite: it lands at version 4.
      const held = await rawGet(raw, key);
      expect(held?.version).toBe(3);
      expect((await rawPut(raw, key, 3, first.env))?.t).toBe("store-written");
      // `home` going away is B processing the nudge; what it falls back to is the point.
      const rolledBack = await b.waitForApp(
        (state) => state.accounts.aliases[E2E_ACCOUNT_ID] !== "home",
        "B to read the put-back blob",
      );
      expect(rolledBack.accounts.aliases[E2E_ACCOUNT_ID]).toBeUndefined();
      expect(cardOf(rolledBack)?.detail).toStartWith("acct e2e-acco · on ");
      await a.waitForApp(
        (state) => state.accounts.aliases[E2E_ACCOUNT_ID] === undefined,
        "A to read the put-back blob",
      );

      // The record is unreadable, not gone: the next rename overwrites it at the relay's version.
      await a.store.renameAccount(E2E_ACCOUNT_ID, "again");
      expect(a.store.getState().accounts.notice).toBeNull();
      await b.waitForApp(
        (state) => state.accounts.aliases[E2E_ACCOUNT_ID] === "again",
        "B to show the rename after the put-back",
      );
    } finally {
      a.stop();
      b.stop();
      raw.close();
    }
  });
});
