import {
  knownAccounts,
  RequestFailure,
  type ArchivedTask,
  type ArchiveTasksErrorCode,
  type ArchiveTasksRequest,
  type RelayClient,
} from "@seance/shared";
import { ARCHIVE_NO_ANSWER, ARCHIVE_UNDELIVERED, ARCHIVE_UNREADABLE } from "./archivist-store.ts";
import { liveTaskIds, olderRequest } from "./older-view.ts";
import { CLOSED_OLDER, NO_OLDER_FILTERS, type OlderList, type OlderPick, type OlderState } from "./state.ts";
import type { AppState } from "./view.ts";

/** How long the search waits on typing before it asks: one read per pause, not per keystroke. */
export const OLDER_SEARCH_MS = 300;

/**
 * Pages one read may chain past pages of live duplicates. The live list holds at most
 * `QUEUE_MAX_TASKS` (100) rows, so five 20-row pages cover it; beyond that Load older takes over.
 */
export const OLDER_READ_ON_MAX = 6;

const ARCHIVE_TASKS_ERRORS: Record<ArchiveTasksErrorCode, string> = {
  invalid_request: "The archivist refused the request. Update the archivist and the app to matching versions.",
  internal_error: "The archivist couldn't read its task history.",
  too_large: "The archivist's answer was too large for one reply.",
};

function failureText(err: unknown): string {
  if (!(err instanceof RequestFailure)) return "Couldn't load the older tasks.";
  // `offline` is the client's refusal unsent: the registry shows no connected archivist.
  if (err.reason === "timeout" || err.reason === "offline") return ARCHIVE_NO_ANSWER;
  return ARCHIVE_UNDELIVERED;
}

type Ok = Extract<OlderList, { kind: "ok" }>;

/**
 * The Queue screen's Older section (DESIGN.md, Archivist, A34, A35, A36g–A36j),
 * apart from `Store`: reads the archive page by page only while the section is
 * open, and only while the registry shows a connected archivist. Like
 * `ArchiveStore`, every read is generation-guarded, so an answer for filters or
 * a seat since replaced lands nowhere, and a failure becomes a line, never a throw.
 */
export class OlderStore {
  readonly #client: RelayClient;
  readonly #getState: () => AppState;
  readonly #patch: (next: Partial<AppState>) => void;
  /** Bumped by every new first page, a drop and dispose. */
  #generation = 0;
  /** The first page's request: Load older repeats it from the cursor, so a dates bound doesn't move between pages. */
  #base: ArchiveTasksRequest | null = null;
  #searchTimer: ReturnType<typeof setTimeout> | null = null;
  #keying = false;

  constructor(client: RelayClient, getState: () => AppState, patch: (next: Partial<AppState>) => void) {
    this.#client = client;
    this.#getState = getState;
    this.#patch = patch;
  }

  get #older(): OlderState {
    return this.#getState().older;
  }

  #set(next: Partial<OlderState>): void {
    this.#patch({ older: { ...this.#older, ...next } });
  }

  /** Called wherever the archivist, the socket or the screen may have changed; cheap when nothing needs doing. */
  sync(): void {
    const state = this.#getState();
    const { older } = state;
    const archivist = state.relay.archivist;
    if (archivist === null || !archivist.connected) {
      // Gone with the registry push that drops it (A36g); a sheet still up is closed by `Store`, through history.
      if (older.open || older.list !== null || older.deviceId !== null || older.filters !== NO_OLDER_FILTERS) {
        this.#drop();
        this.#set({ ...CLOSED_OLDER, sheet: older.sheet, accountKeys: older.accountKeys });
      }
      return;
    }
    if (older.deviceId !== null && older.deviceId !== archivist.deviceId) {
      this.#drop();
      this.#set({ list: null, deviceId: null });
    }
    const shown = state.queue || state.wide;
    if (!this.#older.open) return;
    // Here, not only on open: the registry may settle, or an account sign in, while Older stays open.
    void this.#keyAccounts();
    if (this.#older.list === null && shown && state.relay.status === "open") void this.#first();
  }

  toggle(): void {
    const open = !this.#older.open;
    if (open) {
      this.#set({ open });
      this.sync();
      return;
    }
    // Closed, Older keeps nothing: a list kept would answer filters that have since moved on.
    this.#drop();
    this.#set({ open, list: null, deviceId: null });
  }

  /** The search field's text: shown at once, asked for once typing pauses. */
  search(title: string): void {
    this.#set({ filters: { ...this.#older.filters, title } });
    this.#clearSearchTimer();
    this.#searchTimer = setTimeout(() => {
      this.#searchTimer = null;
      void this.#first();
    }, OLDER_SEARCH_MS);
  }

  pick(pick: OlderPick): void {
    this.#set({ filters: { ...this.#older.filters, ...pick } });
    void this.#first();
  }

  clear(): void {
    this.#clearSearchTimer();
    this.#set({ filters: NO_OLDER_FILTERS });
    void this.#first();
  }

  /** Reads page one again (the screen's ↻); nothing while the section is closed. */
  refresh(): void {
    if (this.#older.open) void this.#first();
  }

  loadMore(): void {
    const { list } = this.#older;
    if (list?.kind !== "ok" || list.next === null || list.loadingMore || this.#base === null) return;
    void this.#page(this.#generation, { ...this.#base, before: list.next }, list);
  }

  /** The Queue screen closed: Older starts closed and empty next time, as the Asleep toggle does. */
  close(): void {
    const { older } = this.#getState();
    if (!older.open && older.list === null) return;
    this.#drop();
    this.#set({ ...CLOSED_OLDER, sheet: older.sheet, accountKeys: older.accountKeys });
  }

  dispose(): void {
    this.#drop();
  }

  #drop(): void {
    this.#generation += 1;
    this.#base = null;
    this.#clearSearchTimer();
  }

  #clearSearchTimer(): void {
    if (this.#searchTimer === null) return;
    clearTimeout(this.#searchTimer);
    this.#searchTimer = null;
  }

  async #first(): Promise<void> {
    const archivist = this.#getState().relay.archivist;
    if (archivist === null || !archivist.connected || !this.#older.open) return;
    this.#clearSearchTimer();
    this.#generation += 1;
    // A socket re-dialling leaves the registry entry connected; `sync` reads once it opens.
    if (this.#getState().relay.status !== "open") {
      this.#base = null;
      this.#set({ list: null });
      return;
    }
    const base = olderRequest(this.#older.filters, Date.now());
    this.#base = base;
    this.#set({ list: { kind: "loading" }, deviceId: archivist.deviceId });
    await this.#page(this.#generation, base, null);
  }

  /**
   * One page, appended to `held`. A page made only of tasks the live queue
   * lists shows nothing, so the next is read at once: the live Finished list
   * holds the newest finished tasks, so those pages come first and are few.
   */
  async #page(generation: number, request: ArchiveTasksRequest, held: Ok | null, chained = 0): Promise<void> {
    if (held !== null) this.#set({ list: { ...held, loadingMore: true, moreError: null } });
    // A first page's failure replaces the list; a later one's keeps the rows already read.
    const fail = (message: string): void =>
      this.#set({
        list: held === null ? { kind: "failed", message } : { ...held, loadingMore: false, moreError: message },
      });
    let reply: Awaited<ReturnType<RelayClient["archiveTasks"]>>;
    try {
      reply = await this.#client.archiveTasks(request);
    } catch (err) {
      if (generation === this.#generation) fail(failureText(err));
      return;
    }
    if (generation !== this.#generation) return;
    if (reply === null) {
      fail(ARCHIVE_UNREADABLE);
      return;
    }
    if (!reply.ok) {
      fail(ARCHIVE_TASKS_ERRORS[reply.code]);
      return;
    }
    const seen = new Set((held?.tasks ?? []).map((row) => row.task.id));
    const added = reply.tasks.filter((row) => !seen.has(row.task.id));
    const tasks: readonly ArchivedTask[] = [...(held?.tasks ?? []), ...added];
    const list: Ok = {
      kind: "ok",
      tasks,
      total: reply.total,
      next: reply.next,
      // Only page one carries them; a later page keeps what it said.
      machines: held === null ? (reply.machines ?? null) : held.machines,
      loadingMore: false,
      moreError: null,
    };
    const live = liveTaskIds(this.#getState());
    // Only a page that added rows and showed none reads on: an empty or repeated page means a cursor that goes nowhere.
    const duplicates = added.length > 0 && added.every((row) => live.has(row.task.id));
    if (reply.next !== null && duplicates && chained < OLDER_READ_ON_MAX) {
      await this.#page(generation, { ...request, before: reply.next }, list, chained + 1);
      return;
    }
    this.#set({ list });
  }

  /** Store keys for the accounts this install knows, so an archived account reads by its name; an install with no account key has none. */
  async #keyAccounts(): Promise<void> {
    if (this.#keying || !this.#client.accountsNamed) return;
    this.#keying = true;
    try {
      const held = new Set(Object.values(this.#older.accountKeys));
      const missing = knownAccounts(this.#getState().relay.machines).filter((a) => !held.has(a.accountId));
      if (missing.length === 0) return;
      const keyed = await Promise.all(
        missing.map(async ({ accountId }) => [await this.#client.accountStoreKey(accountId), accountId] as const),
      );
      this.#set({ accountKeys: { ...this.#older.accountKeys, ...Object.fromEntries(keyed) } });
    } catch {
      // Unkeyed, an archived account still reads by the alias the archive kept.
    } finally {
      this.#keying = false;
    }
  }
}
