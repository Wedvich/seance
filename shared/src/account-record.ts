import {
  APP_ID,
  AT_REST_OPS,
  STORE_PREFIXES,
  type AccountRecord,
  type Envelope,
  type RecordUnreadable,
  type StoreRecord,
} from "./types.ts";
import { parseAccountRecord } from "./parse.ts";
import { openAtRest, sealAtRest } from "./crypto.ts";
import type { UnreadableRecord } from "./task-record.ts";
import type { Machine } from "./app-client.ts";

/**
 * The store key an account lives at: the prefix, then the hex HMAC of its id
 * under the PSK-derived account key, so the relay and a token holder see a
 * stable pseudonym, never the id. `oauth|` namespaces the input should another
 * kind of account id ever join.
 */
export async function accountStoreKey(accountKey: CryptoKey, accountId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", accountKey, new TextEncoder().encode(`oauth|${accountId}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${STORE_PREFIXES.account.prefix}${hex}`;
}

/** A signed-in account as the registry reports it: what a label is built from, display only. */
export interface KnownAccount {
  readonly accountId: string;
  readonly email: string | undefined;
}

/**
 * The accounts a client knows: every one some machine's exclave reports signed
 * in, once each, with the first email any of them reports (one account has one).
 */
export function knownAccounts(machines: readonly Pick<Machine, "exclaves">[]): KnownAccount[] {
  const known = new Map<string, KnownAccount>();
  for (const machine of machines) {
    for (const { accountId, email } of machine.exclaves ?? []) {
      if (accountId === null) continue;
      const held = known.get(accountId);
      if (held === undefined || held.email === undefined) known.set(accountId, { accountId, email });
    }
  }
  return [...known.values()];
}

function fallbackName(accountId: string, email: string | undefined): string {
  if (email !== undefined) return email;
  const account = accountId.split(":").at(-1) ?? accountId;
  return `acct ${account.slice(0, 8)}`;
}

/**
 * What an account is called to a person: its alias, else its email, else the
 * account half of `organizationUuid:accountUuid` shortened. Every client's one
 * rule. Display only, never a key.
 *
 * One person on a personal plan and a Team org has one email and one account
 * half under two org halves, so where another account in `known` would read
 * the same the org half is appended. An alias is per account and left alone.
 */
export function accountName(
  accountId: string,
  email: string | undefined,
  alias?: string,
  known: readonly KnownAccount[] = [],
): string {
  if (alias !== undefined) return alias;
  const name = fallbackName(accountId, email);
  const twin = known.some(
    (other) => other.accountId !== accountId && fallbackName(other.accountId, other.email) === name,
  );
  if (!twin) return name;
  const colon = accountId.lastIndexOf(":");
  const org = colon < 0 ? accountId : accountId.slice(0, colon);
  return `${name} (org ${org.slice(0, 8)})`;
}

/** `accountName` for an id alone, its email whatever `known` reports for it. */
export function accountNameIn(known: readonly KnownAccount[], accountId: string, alias?: string): string {
  const email = known.find((account) => account.accountId === accountId)?.email;
  return accountName(accountId, email, alias, known);
}

/**
 * The one place a writer builds a record. The alias is trimmed and an empty one
 * is a clear (null); null back means the alias is no name (over its bound).
 */
export function accountRecord(accountId: string, alias: string | null, version: number): AccountRecord | null {
  const trimmed = alias?.trim() ?? "";
  return parseAccountRecord({ version, accountId, alias: trimmed === "" ? null : trimmed });
}

/**
 * An `account:<hmac>` record as the store holds it: op `account`, sealed to
 * `APP_ID` from its writer. `record.version` must be the version the put will
 * produce, or every reader refuses it (`openAccountRecord`).
 */
export function sealAccountRecord(key: CryptoKey, from: string, record: AccountRecord): Promise<Envelope> {
  return sealAtRest(key, { to: APP_ID, from }, AT_REST_OPS.account, record);
}

/**
 * The only way into a stored account record. Kept only when it is sealed to the
 * app under op `account`, its sealed version is the relay's (an older blob put
 * back lands at a higher version, so it reads `version_mismatch`), and its
 * `accountId` hashes to its own key (a blob moved to another key reads
 * `key_mismatch`). `from` is not checked: any PSK holder may name an account,
 * as any may enqueue a task.
 */
export async function openAccountRecord(
  key: CryptoKey,
  accountKey: CryptoKey,
  stored: StoreRecord,
): Promise<AccountRecord | RecordUnreadable> {
  if (stored.env.to !== APP_ID) return "unopenable";
  let payload: unknown;
  try {
    payload = (await openAtRest(key, stored.env, AT_REST_OPS.account)).payload;
  } catch {
    return "unopenable";
  }
  const record = parseAccountRecord(payload);
  if (record === null) return "malformed";
  if (record.version !== stored.version) return "version_mismatch";
  if ((await accountStoreKey(accountKey, record.accountId)) !== stored.key) return "key_mismatch";
  return record;
}

export interface AccountEntry {
  readonly key: string;
  readonly record: AccountRecord;
}

/**
 * Every record of an `account:` listing, opened one by one. The relay is
 * untrusted, so the listing is checked too, as `openTaskListing` does: a key
 * outside the prefix, or listed twice, is `key_mismatch` for every copy.
 */
export async function openAccountListing(
  key: CryptoKey,
  accountKey: CryptoKey,
  records: readonly StoreRecord[],
): Promise<{ readonly accounts: AccountEntry[]; readonly unreadable: UnreadableRecord[] }> {
  const copies = new Map<string, number>();
  for (const stored of records) copies.set(stored.key, (copies.get(stored.key) ?? 0) + 1);
  const opened = await Promise.all(
    records.map(async (stored): Promise<AccountRecord | RecordUnreadable> =>
      !stored.key.startsWith(STORE_PREFIXES.account.prefix) || (copies.get(stored.key) ?? 0) > 1
        ? "key_mismatch"
        : openAccountRecord(key, accountKey, stored),
    ),
  );
  const accounts: AccountEntry[] = [];
  const unreadable: UnreadableRecord[] = [];
  records.forEach((stored, i) => {
    const read = opened[i];
    if (read === undefined) return;
    if (typeof read === "string") unreadable.push({ key: stored.key, version: stored.version, reason: read });
    else accounts.push({ key: stored.key, record: read });
  });
  return { accounts, unreadable };
}
