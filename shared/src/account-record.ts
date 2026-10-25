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

/**
 * What an account is called to a person: its alias, else its email, else the
 * account half of `organizationUuid:accountUuid` shortened — enough to tell two
 * apart. Every client's one rule. Display only, never a key.
 */
export function accountName(accountId: string, email: string | undefined, alias?: string): string {
  if (alias !== undefined) return alias;
  if (email !== undefined) return email;
  const account = accountId.split(":").at(-1) ?? accountId;
  return `acct ${account.slice(0, 8)}`;
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
