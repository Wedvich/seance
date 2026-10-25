import {
  accountNameIn,
  knownAccounts,
  RequestFailure,
  type AccountListing,
  type ExclaveInfo,
  type StoreRefusal,
} from "@seance/shared";

/** accountId to alias, for the accounts that have one. Display only, never a key. */
export type AccountAliases = ReadonlyMap<string, string>;

/** The live registry's view of a machine this module reads: the cached projection carries no exclaves. */
export interface AccountMachine {
  readonly deviceId: string;
  readonly exclaves?: readonly ExclaveInfo[];
}

export const NO_ALIASES: AccountAliases = new Map();

/**
 * Whether a listing is worth its share of the relay's `account:` list bucket,
 * which every app shares: only when some machine reports an account to name.
 */
export function reportsAccounts(machines: readonly AccountMachine[]): boolean {
  return machines.some((machine) => machine.exclaves?.some((exclave) => exclave.accountId !== null) === true);
}

/** What one listing came to: the aliases it read, and whether the socket was lost under it. */
export interface AliasRead {
  readonly aliases: AccountAliases;
  /** Dropped with the socket, not answered: the only outcome worth asking again for once it reopens. */
  readonly lost: boolean;
}

/**
 * Where an open's listing stands. `settled` is an answer of any kind (aliases, a refusal, a reply
 * this build cannot read, a timeout) and is never asked for again; `lost` is a socket dropped
 * under it.
 */
export type ListingProgress = "none" | "inflight" | "settled" | "lost";

/**
 * Whether to send the open's `account:` listing now. The relay's list bucket is shared with every
 * app, so: once the socket is open and its registry settled, only when some machine reports an
 * account, and not again after any answer, only after one lost to a disconnect.
 */
export function shouldListAccounts(
  state: { readonly status: string; readonly registrySettled: boolean },
  machines: readonly AccountMachine[],
  progress: ListingProgress,
): boolean {
  if (state.status !== "open" || !state.registrySettled) return false;
  if (progress !== "none" && progress !== "lost") return false;
  return reportsAccounts(machines);
}

/**
 * The aliases from one listing. Anything short of a readable listing (no
 * socket, a refusal, a reply this build cannot read, a throw) is no aliases:
 * names fall back to the email or short id, and the form never fails for it.
 */
export async function readAliases(list: () => Promise<AccountListing | StoreRefusal | null>): Promise<AliasRead> {
  let listing: AccountListing | StoreRefusal | null;
  try {
    listing = await list();
  } catch (err) {
    const lost = err instanceof RequestFailure && (err.reason === "disconnected" || err.reason === "dropped");
    return { aliases: NO_ALIASES, lost };
  }
  if (listing?.ok !== true) return { aliases: NO_ALIASES, lost: false };
  const aliases = new Map<string, string>();
  for (const { record } of listing.accounts) {
    if (record.alias !== null) aliases.set(record.accountId, record.alias);
  }
  return { aliases, lost: false };
}

/**
 * The accounts signed in on one machine, each named as every client names it
 * (`accountNameIn`: alias, else email, else short id, twins tagged against the
 * whole fleet). Null when the machine is unknown here or predates exclaves;
 * nothing to say is not the same as nobody signed in.
 */
export function accountLine(
  machines: readonly AccountMachine[],
  deviceId: string | null,
  aliases: AccountAliases,
): string | null {
  const machine = machines.find((entry) => entry.deviceId === deviceId);
  if (machine?.exclaves === undefined) return null;
  const known = knownAccounts(machines);
  const ids = new Set(machine.exclaves.flatMap(({ accountId }) => (accountId === null ? [] : [accountId])));
  if (ids.size === 0) return "None signed in";
  return [...ids].map((accountId) => accountNameIn(known, accountId, aliases.get(accountId))).join(", ");
}
