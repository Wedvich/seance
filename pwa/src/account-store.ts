import type { AccountRecord, UnreadableRecord } from "@seance/shared";
import {
  accountRecord,
  failureReasonText,
  isStoreKey,
  RequestFailure,
  sentence,
  STORE_PREFIXES,
  type RelayClient,
} from "@seance/shared";
import type { AccountsState } from "./state.ts";
import type { AppState } from "./view.ts";

/** One retry of a first listing the relay refused: the `account:` list bucket is shared by every app, so a cold load can lose it. */
export const LIST_RETRY_MS = 8_000;

const TOO_LONG = "Names are at most 64 characters";
const CONFLICT = "Renamed elsewhere — showing the latest name; rename again to replace it";

function refusalText(code: string): string {
  switch (code) {
    case "store_full":
      return "The relay holds its limit of account records";
    case "rate_limited":
      return "Too many writes — try again in a minute";
    default:
      return `Rename refused (${code})`;
  }
}

/**
 * The app's side of account aliases, apart from `Store`: lists `account:` when
 * the socket reopens, re-reads one key when another client's write nudges it,
 * and renames by compare-and-set. What it shows lives in the `AppState`
 * `Store` holds (`accounts`), read and patched through the constructor's two
 * seams. An alias is display-only: it never leaves this module as anything but
 * text for a card.
 */
export class AccountStore {
  readonly #client: RelayClient;
  readonly #getState: () => AppState;
  readonly #patch: (next: Partial<AppState>) => void;
  /** Relay version per store key, unreadable records included: a rename overwrites at it. */
  readonly #versions = new Map<string, number>();
  /** The account a readable record at a key names; an unreadable one has none. */
  readonly #accountByKey = new Map<string, string>();
  /** Whether a listing has landed on this socket: until then `#versions` may miss records the relay holds. */
  #listed = false;
  /** Bumped on every reopen: a listing sent on an earlier socket answers for a view since replaced. */
  #generation = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;

  constructor(client: RelayClient, getState: () => AppState, patch: (next: Partial<AppState>) => void) {
    this.#client = client;
    this.#getState = getState;
    this.#patch = patch;
  }

  get #accounts(): AccountsState {
    return this.#getState().accounts;
  }

  #set(next: Partial<AccountsState>): void {
    this.#patch({ accounts: { ...this.#accounts, ...next } });
  }

  /** A relay change with the socket open: a reopen lists again, since nudges sent meanwhile are lost. */
  onOpen(reopened: boolean): void {
    if (!reopened || !this.#client.accountsNamed) return;
    this.#generation += 1;
    this.#listed = false;
    this.#stopRetry();
    void this.#list(true);
  }

  dispose(): void {
    this.#generation += 1;
    this.#stopRetry();
  }

  #stopRetry(): void {
    if (this.#retry === null) return;
    clearTimeout(this.#retry);
    this.#retry = null;
  }

  async #list(mayRetry: boolean): Promise<void> {
    const generation = this.#generation;
    let landed = false;
    try {
      const listing = await this.#client.listAccounts();
      if (generation !== this.#generation) return;
      if (listing?.ok === true) {
        landed = true;
        this.#versions.clear();
        this.#accountByKey.clear();
        const aliases: Record<string, string> = {};
        for (const { key, record } of listing.accounts) {
          this.#versions.set(key, record.version);
          this.#accountByKey.set(key, record.accountId);
          if (record.alias !== null) aliases[record.accountId] = record.alias;
        }
        for (const { key, version } of listing.unreadable) this.#versions.set(key, version);
        this.#listed = true;
        this.#set({ aliases });
      }
    } catch (err) {
      // What is held stays up, and a read that fails says nothing: the name was never a promise.
      if (!(err instanceof RequestFailure)) throw err;
    }
    if (landed || this.#listed || !mayRetry) return;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#list(false);
    }, LIST_RETRY_MS);
  }

  /** A `store-changed` nudge: relay plaintext, so only a hint to re-read a key, and only a newer version is worth it. */
  onStoreChanged(key: string, version: number): void {
    if (!key.startsWith(STORE_PREFIXES.account.prefix) || !isStoreKey(key)) return;
    if (!this.#client.accountsNamed) return;
    // Showing the tab again re-dials (`attach`), and the reopen lists whole.
    if (document.visibilityState !== "visible") return;
    if (version <= (this.#versions.get(key) ?? 0)) return;
    void this.#refresh(key);
  }

  /** Re-reads one key and takes what the relay holds. False when no answer came. */
  async #refresh(key: string): Promise<boolean> {
    const generation = this.#generation;
    try {
      const lookup = await this.#client.getAccountRecord(key);
      if (generation !== this.#generation || lookup?.ok !== true) return false;
      this.#take(key, lookup.version, lookup.entry);
      return true;
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err;
      return false;
    }
  }

  #take(key: string, version: number, entry: AccountRecord | UnreadableRecord | null): void {
    const was = this.#accountByKey.get(key);
    this.#accountByKey.delete(key);
    if (entry === null) this.#versions.delete(key);
    else this.#versions.set(key, version);
    const aliases = { ...this.#accounts.aliases };
    if (was !== undefined) delete aliases[was];
    if (entry !== null && "accountId" in entry) {
      this.#accountByKey.set(key, entry.accountId);
      if (entry.alias !== null) aliases[entry.accountId] = entry.alias;
    }
    this.#set({ aliases });
  }

  /** Names an account (a blank `text` clears it) at the version held for its key; a lost race re-reads and says so. */
  async rename(accountId: string, text: string): Promise<void> {
    if (this.#accounts.saving !== null || !this.#client.accountsNamed) return;
    if (accountRecord(accountId, text, 1) === null) {
      this.#set({ notice: TOO_LONG });
      return;
    }
    this.#set({ saving: accountId, notice: null });
    try {
      const key = await this.#client.accountStoreKey(accountId);
      // Without a listing the version held may be 0 for a key the relay has: read it first, or the put reads as a conflict.
      if (!this.#listed) await this.#refresh(key);
      const written = await this.#client.putAccountAlias(accountId, text, this.#versions.get(key) ?? 0);
      if (written === null) {
        this.#set({ notice: "The relay's answer was unreadable — reopen to see whether it landed" });
      } else if (written.ok) {
        this.#take(key, written.record.version, written.record);
      } else if (written.code === "version_conflict") {
        await this.#refresh(key);
        this.#set({ notice: CONFLICT });
      } else {
        this.#set({ notice: refusalText(written.code) });
      }
    } catch (err) {
      this.#set({
        notice: err instanceof RequestFailure ? sentence(failureReasonText(err)) : "The rename failed",
      });
    } finally {
      this.#set({ saving: null });
    }
  }

  dismissNotice(): void {
    if (this.#accounts.notice !== null) this.#set({ notice: null });
  }
}
