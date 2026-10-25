import { accountNameIn, knownAccounts, type AccountListing, type ExclaveInfo, type StoreRefusal } from "@seance/shared";

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

/**
 * The aliases from one listing. Anything short of a readable listing — no
 * socket, a refusal, a reply this build cannot read, a throw — is no aliases:
 * names fall back to the email or short id, and the form never fails for it.
 */
export async function readAliases(list: () => Promise<AccountListing | StoreRefusal | null>): Promise<AccountAliases> {
  let listing: AccountListing | StoreRefusal | null;
  try {
    listing = await list();
  } catch {
    return NO_ALIASES;
  }
  if (listing?.ok !== true) return NO_ALIASES;
  const aliases = new Map<string, string>();
  for (const { record } of listing.accounts) {
    if (record.alias !== null) aliases.set(record.accountId, record.alias);
  }
  return aliases;
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
