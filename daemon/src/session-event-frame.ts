// Apart from `session-events.ts` so `seanced session-event`, which runs several
// times a turn in every session, loads only these and not the daemon's side
// (tmux, the launch ledger, the FFI parent walk).

export const SESSION_EVENT_VERSION = 1;

export const SESSION_EVENT_KIND = "session-event";

export const SESSION_EVENT_REPLY_CODES = [
  /** Not a frame this daemon reads: wrong version, mistyped fields, nothing to report. */
  "invalid",
  /** The sender runs in no live tmux pane this daemon can see. */
  "unbound",
  /** This daemon runs no session-event ingest. */
  "unsupported",
  /** A `done` report from a pane that carries no scheduler task: there is nothing to settle. */
  "untasked",
  /** A `done` report for a task this daemon holds no launch of: nothing recorded, nothing sent. */
  "unrecorded",
  /** A `done` report sent but not saved: memory has it and the ledger write failed, so a restart could lose it. */
  "unwritten",
  /** A `done` report refused because the daemon is stopping: nothing recorded, nothing sent. */
  "stopping",
] as const;

export type SessionEventReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: (typeof SESSION_EVENT_REPLY_CODES)[number] };
