import { describe, expect, test } from "bun:test";
import { RequestFailure, type AccountRecord, type ExclaveInfo } from "@seance/shared";
import { accountLine, readAliases, reportsAccounts, shouldListAccounts, type AccountMachine } from "./accounts.ts";

/** One person in two orgs: one email, two accounts — the case a tag tells apart. */
const PERSONAL = "org-a1234567:me";
const EMPLOYER = "org-b7654321:me";
const EMAIL = "me@pengefix.no";

function exclave(id: string, accountId: string | null, email?: string): ExclaveInfo {
  return {
    id,
    accountId,
    extraUsageEnabled: false,
    authOk: accountId !== null,
    skills: [],
    ...(email === undefined ? {} : { email }),
  };
}

const listingOf = (records: readonly AccountRecord[]) => () =>
  Promise.resolve({
    ok: true as const,
    accounts: records.map((record) => ({ key: `account:${record.accountId}`, record })),
    unreadable: [],
  });

describe("readAliases", () => {
  test("maps each aliased account to its alias, skipping a cleared one", async () => {
    const { aliases } = await readAliases(
      listingOf([
        { accountId: PERSONAL, alias: "personal", version: 2 },
        { accountId: EMPLOYER, alias: null, version: 3 },
      ]),
    );
    expect([...aliases]).toEqual([[PERSONAL, "personal"]]);
  });

  test("a refusal, an unreadable reply, a missing key or any throw is no aliases, never a failure", async () => {
    const lists = [
      () => Promise.resolve({ ok: false as const, code: "rate_limited" as const }),
      () => Promise.resolve(null),
      () => Promise.reject(new RequestFailure("disconnected", "no socket to the relay", "relay")),
      () => Promise.reject(new RequestFailure("timeout", "no answer", "relay")),
      () => Promise.reject(new RequestFailure("unsupported", "this install has no account key", "relay")),
      () => Promise.reject(new Error("boom")),
    ];
    for (const list of lists) {
      // oxlint-disable-next-line no-await-in-loop -- one failure each, compared alike
      expect((await readAliases(list)).aliases.size).toBe(0);
    }
  });

  test("only a listing lost to the socket reads as lost: a refusal or timeout is an answer", async () => {
    const lostReasons = ["disconnected", "dropped"] as const;
    for (const reason of lostReasons) {
      // oxlint-disable-next-line no-await-in-loop -- one reason each
      const read = await readAliases(() => Promise.reject(new RequestFailure(reason, "gone", "relay")));
      expect(read.lost, reason).toBe(true);
    }
    const answered = [
      () => Promise.resolve({ ok: false as const, code: "rate_limited" as const }),
      () => Promise.resolve(null),
      () => Promise.reject(new RequestFailure("timeout", "no answer", "relay")),
      () => Promise.reject(new Error("boom")),
      listingOf([]),
    ];
    for (const list of answered) {
      // oxlint-disable-next-line no-await-in-loop -- one outcome each
      expect((await readAliases(list)).lost).toBe(false);
    }
  });
});

describe("accountLine", () => {
  const machines: AccountMachine[] = [
    { deviceId: "mac", exclaves: [exclave("default", PERSONAL, EMAIL), exclave("work", EMPLOYER, EMAIL)] },
    // The same account twice on one machine is named once.
    { deviceId: "linux", exclaves: [exclave("a", "org-z:0123456789ab"), exclave("b", "org-z:0123456789ab")] },
    { deviceId: "spare", exclaves: [exclave("default", null)] },
    { deviceId: "old" },
  ];

  test("names each account by its alias, else its email (org-tagged against its twin), else a short id", () => {
    const aliases = new Map([[PERSONAL, "personal"]]);
    expect(accountLine(machines, "mac", aliases)).toBe("personal, me@pengefix.no (org org-b765)");
    expect(accountLine(machines, "linux", aliases)).toBe("acct 01234567");
  });

  test("without aliases both twins read by email, each tagged", () => {
    expect(accountLine(machines, "mac", new Map())).toBe(
      "me@pengefix.no (org org-a123), me@pengefix.no (org org-b765)",
    );
  });

  test("a machine reporting exclaves with none signed in says so; one predating exclaves or unknown says nothing", () => {
    expect(accountLine(machines, "spare", new Map())).toBe("None signed in");
    expect(accountLine(machines, "old", new Map())).toBeNull();
    expect(accountLine(machines, "gone", new Map())).toBeNull();
    expect(accountLine(machines, null, new Map())).toBeNull();
  });
});

describe("reportsAccounts", () => {
  test("true only when some machine reports an account signed in", () => {
    expect(reportsAccounts([{ deviceId: "a" }, { deviceId: "b", exclaves: [exclave("x", null)] }])).toBe(false);
    expect(reportsAccounts([{ deviceId: "a" }, { deviceId: "b", exclaves: [exclave("x", PERSONAL)] }])).toBe(true);
  });
});

describe("shouldListAccounts", () => {
  const withAccount: AccountMachine[] = [{ deviceId: "a", exclaves: [exclave("x", PERSONAL)] }];
  const settled = { status: "open", registrySettled: true };

  test("lists once the socket is open and its registry settled, when some machine reports an account", () => {
    expect(shouldListAccounts(settled, withAccount, "none")).toBe(true);
  });

  test("waits for an open socket, a settled registry and an account to name", () => {
    expect(shouldListAccounts({ status: "connecting", registrySettled: true }, withAccount, "none")).toBe(false);
    expect(shouldListAccounts({ status: "open", registrySettled: false }, withAccount, "none")).toBe(false);
    expect(shouldListAccounts(settled, [{ deviceId: "a" }], "none")).toBe(false);
  });

  test("never again while in flight or after any answer, but again after one lost to a disconnect", () => {
    expect(shouldListAccounts(settled, withAccount, "inflight")).toBe(false);
    expect(shouldListAccounts(settled, withAccount, "settled")).toBe(false);
    expect(shouldListAccounts(settled, withAccount, "lost")).toBe(true);
    // A lost listing still waits for the socket to be open again.
    expect(shouldListAccounts({ status: "connecting", registrySettled: true }, withAccount, "lost")).toBe(false);
  });
});
