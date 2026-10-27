import {
  APP_ID,
  AT_REST_OPS,
  STORE_PREFIXES,
  type AccountRecord,
  type Envelope,
  type RecordUnreadable,
  type ExclaveInfo,
  type StoreRecord,
} from "./types.ts";
import { parseAccountRecord } from "./parse.ts";
import { openAtRest, sealAtRest } from "./crypto.ts";
import type { UnreadableRecord } from "./task-record.ts";

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
 * `extraIds` are accounts a screen names that no machine reports (a pin, a
 * hold): kept with no email, so a label rule sees them as twins too; the
 * registry's entry wins for the email.
 */
export function knownAccounts(
  machines: readonly { readonly exclaves?: readonly ExclaveInfo[] }[],
  extraIds: Iterable<string> = [],
): KnownAccount[] {
  const known = new Map<string, KnownAccount>();
  for (const machine of machines) {
    for (const { accountId, email } of machine.exclaves ?? []) {
      if (accountId === null) continue;
      const held = known.get(accountId);
      if (held === undefined || held.email === undefined) known.set(accountId, { accountId, email });
    }
  }
  for (const accountId of extraIds) {
    if (!known.has(accountId)) known.set(accountId, { accountId, email: undefined });
  }
  return [...known.values()];
}

function fallbackName(accountId: string, email: string | undefined): string {
  if (email !== undefined) return email;
  const account = accountId.split(":").at(-1) ?? accountId;
  return `acct ${account.slice(0, 8)}`;
}

// Case-folded: `daemon/src/auto.ts` matches a pin's email case-insensitively, so two emails
// differing in case are one person's one name here too.
const nameKey = (accountId: string, email: string | undefined): string => fallbackName(accountId, email).toLowerCase();

const orgHalf = (accountId: string): string => {
  const colon = accountId.lastIndexOf(":");
  return colon < 0 ? "" : accountId.slice(0, colon);
};

/**
 * The tag that tells an account from its twins (others reading the same): the org
 * half's first eight characters; the whole org half where a twin's would match;
 * the whole account id where a twin shares the org half (two accounts of one org
 * whose account halves share a prefix) or there is no org half to name.
 */
function twinTag(accountId: string, twins: readonly KnownAccount[]): string {
  const org = orgHalf(accountId);
  if (org === "" || twins.some((twin) => orgHalf(twin.accountId) === org)) return `id ${accountId}`;
  const short = org.slice(0, 8);
  return twins.some((twin) => orgHalf(twin.accountId).slice(0, 8) === short) ? `org ${org}` : `org ${short}`;
}

/**
 * What an account is called to a person: its alias, else its email, else the
 * account half of `organizationUuid:accountUuid` shortened. Every client's one
 * rule. Display only, never a key.
 *
 * One person on a personal plan and a Team org has one email and one account
 * half under two org halves, so where another account in `known` would read
 * the same (case aside) a tag is appended that tells them apart: the org half's
 * first eight characters, longer where that would still collide. An alias is per
 * account and left alone, but `known` carries none, so an aliased account's
 * unaliased twin is tagged all the same: the label of one account then reads
 * alike in every client, whether or not that client could read the aliases
 * (a keyless `seanced mcp`, a refused listing).
 */
export function accountName(
  accountId: string,
  email: string | undefined,
  alias?: string,
  known: readonly KnownAccount[] = [],
): string {
  if (alias !== undefined) return alias;
  const name = fallbackName(accountId, email);
  const key = name.toLowerCase();
  const twins = known.filter((other) => other.accountId !== accountId && nameKey(other.accountId, other.email) === key);
  return twins.length === 0 ? name : `${name} (${twinTag(accountId, twins)})`;
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
