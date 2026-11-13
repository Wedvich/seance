import type { RelayClient } from "@seance/shared";
import type { AppState } from "./view.ts";

/** How often the card's counts are read again while the Machines screen is on screen. */
export const ARCHIVE_STATUS_REFRESH_MS = 60_000;

/**
 * The Machines screen's archivist counts, apart from `Store`: read when the
 * screen is on screen in a visible tab and the archivist is connected, again every minute while
 * it stays so, and dropped when the seat moves to another device or goes
 * offline. Refreshing only while someone looks keeps the archivist from
 * answering for nobody. A failed or unanswered read leaves no counts — the
 * card shows without rows — and never throws.
 */
export class ArchiveStore {
  readonly #client: RelayClient;
  readonly #getState: () => AppState;
  readonly #patch: (next: Partial<AppState>) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** The generation of the read in flight: a seat change starts a new read without waiting out the old one. */
  #inFlight: number | null = null;
  #lastFetchAt: number | null = null;
  /** Bumped by a seat change and by dispose: a reply sent before either answers for a view since replaced. */
  #generation = 0;

  constructor(client: RelayClient, getState: () => AppState, patch: (next: Partial<AppState>) => void) {
    this.#client = client;
    this.#getState = getState;
    this.#patch = patch;
  }

  /** Called wherever the screen's visibility or the archivist may have changed; cheap when nothing needs doing. */
  sync(): void {
    const state = this.#getState();
    const archivist = state.relay.archivist;
    const held = state.archiveStatus;
    // A hidden tab reads nothing: `Store.attach`'s show path calls `sync` again on return.
    const visible = (state.machines || state.wide) && document.visibilityState === "visible";
    if (held !== null && (archivist === null || !archivist.connected || held.deviceId !== archivist.deviceId)) {
      this.#generation += 1;
      this.#lastFetchAt = null;
      this.#patch({ archiveStatus: null });
    }
    if (!visible || archivist === null || !archivist.connected) {
      this.#clearTimer();
      return;
    }
    if (this.#timer === null) this.#timer = setTimeout(() => this.#tick(), ARCHIVE_STATUS_REFRESH_MS);
    // A read on a down socket fails at once and would spend the minute's budget (and the held counts) on nothing;
    // the reopen's registry push calls `sync` again.
    if (state.relay.status !== "open") return;
    const stale = this.#lastFetchAt === null || Date.now() - this.#lastFetchAt >= ARCHIVE_STATUS_REFRESH_MS;
    if (this.#inFlight !== this.#generation && stale) void this.#fetch(archivist.deviceId);
  }

  dispose(): void {
    this.#generation += 1;
    this.#clearTimer();
  }

  #tick(): void {
    this.#timer = null;
    this.sync();
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #fetch(deviceId: string): Promise<void> {
    const generation = this.#generation;
    this.#inFlight = generation;
    this.#lastFetchAt = Date.now();
    let held: AppState["archiveStatus"] = null;
    try {
      const reply = await this.#client.archiveStatus();
      if (reply?.ok === true) held = { deviceId, reply };
    } catch {
      // Offline, timed out or refused: nothing worth a banner, the card simply has no counts.
    }
    if (this.#inFlight === generation) this.#inFlight = null;
    if (generation === this.#generation) this.#patch({ archiveStatus: held });
  }
}
