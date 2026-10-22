// Apart from `session-events.ts` so `seance session-event`, which runs several
// times a turn in every session, loads only these and not the daemon's side
// (tmux, the launch ledger, the FFI parent walk).

export const SESSION_EVENT_VERSION = 1;

export const SESSION_EVENT_KIND = "session-event";
