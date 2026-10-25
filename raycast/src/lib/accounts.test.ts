import { describe, expect, test } from "bun:test";
import { RequestFailure, type AccountRecord, type ExclaveInfo } from "@seance/shared";
import { accountLine, readAliases, reportsAccounts, type AccountMachine } from "./accounts.ts";

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
    const aliases = await readAliases(
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
      () => Promise.reject(new Error("boom")),
    ];
    for (const list of lists) {
      // oxlint-disable-next-line no-await-in-loop -- one failure each, compared alike
      expect((await readAliases(list)).size).toBe(0);
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
