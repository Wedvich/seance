import type { SessionEvents } from "./session-events.ts";
import type { Watches } from "./watches.ts";

/** What keeps a pane's session from being closed on the custodian's say-so, read late: each source may not exist. */
export interface PaneHoldSources {
  readonly events: () => Pick<SessionEvents, "awaitsWake" | "marked"> | undefined;
  /** The drain ask's `holds`: a pane it has a live entry for, which `SessionEvents.marked` does not know. */
  readonly drain: () => ((pane: string) => boolean) | undefined;
  readonly watches: () => Pick<Watches, "holds"> | undefined;
}

export interface PaneHolds {
  /** A hand-off, pass or drain ask marked it. A watch is not among them: those closes are the session's or the owner's own acts. */
  readonly untouchable: (pane: string) => boolean;
  /** Its last turn left background work or a cron, or a live watch waits on it: `close` refuses it and no round is due. */
  readonly awaitsWake: (pane: string, taskId?: string | null) => boolean;
  /** Either of the two: the seat's due check, which has no use for a pane the `close` verb would refuse. */
  readonly seatHolds: (pane: string) => boolean;
}

/** One composition for the seat's due check and the `close` verb (`run-capabilities.ts`), apart so a test can hold it. */
export function paneHolds(sources: PaneHoldSources): PaneHolds {
  const untouchable = (pane: string): boolean =>
    sources.events()?.marked(pane) === true || sources.drain()?.(pane) === true;
  const awaitsWake = (pane: string, taskId?: string | null): boolean =>
    sources.events()?.awaitsWake(pane, taskId) === true || sources.watches()?.holds(pane, taskId) === true;
  return { untouchable, awaitsWake, seatHolds: (pane) => untouchable(pane) || awaitsWake(pane) };
}
