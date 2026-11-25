# The Work screen: sessions beside tasks

**Status: built and folded into DESIGN.md (Order steps 1 to 3, all 2026-11-24).** The owner's brief (2026-11-23): the
session list, then the task queue, also lists sessions that are not tasks. This is the place #567 left open when it took
the session list off the Machines card "until its place is decided" (DESIGN.md, "Tags and session identity", "The PWA's
per-namespace view"). Step 3 renamed the screen from Queue to Work. Every built choice, its rejected alternatives and its
threat model are recorded in DESIGN.md (index below); what stays here is the owner's decisions.

## Owner's decisions (2026-11-23)

- **WS1. One list.** The Queue screen lists every live session a machine reports beside the queue's tasks: a session
  carrying a task folds into that task's row, one carrying none is a row of its own.
- **WS2. Placed by live state.** An untasked row sits in Needs you, Running or Idle by its session's live state, marked
  as not a task, never in a section of its own. This needs the state on the wire; a stateless "Sessions" section was
  the rejected alternative.
- **WS3. The screen is renamed Work.** Its sections still say what each row is (Waiting and Finished hold only tasks).
- **WS4. Live state places task rows too.** A running task whose session's `live` was read is placed by it: Idle the
  moment its turn ends, not `idleReleaseAfterMs` (10 minutes) later. The leader's idle list (`QueueResponse.idle`) stays
  what frees a slot and what the drain's soft view reads; the screen falls back to it for a task whose machine sends no
  `live` or whose sessions are unread. One rule for both row kinds, so a tasked and an untasked session at rest read alike.
- **WS5. No push alert for an untasked session waiting on you** in this spec. The leader never sees one, so it would be a
  new, daemon-side push sender: later, decided on its own.
- **WS6. `live` stays off MCP.** `get_sessions` does not carry it. What one session may learn of another's state is
  docs/presence.md's question (its `status` answered from presence), decided there, not leaked here first.
- **WS7. The drain row links to the session.** Each "Not a task" line on a closed machine's card names the session
  (`displayName`) and opens its Work row, where Close is (only when the daemon sends the pane id). A task's stuck line
  opens the task's row the same way.

## Where each part is recorded

- The wire (step 1): `SessionEntry.live`, `MachineStatus.sg`, `CAPABILITIES.sessionLive`, their rejected alternatives
  and threat model: DESIGN.md, "Tags and session identity", "Live state and the session generation", and the surface
  table above it ("PWA (Work, task details)", "`sessions` op to an app").
- The reversed rejection of a per-pane state on `sessions`: DESIGN.md, "The drain's outside pass", "Soft or draining".
- The screen (step 2 and the rename): what a session that is not a task is, the reads, the join, the row kinds, the
  sections, the order within one, Close on a tasked row, and the `Screen` key kept `"queue"`: DESIGN.md, PWA, "The
  Work screen" (the bullet before "The Queue screen", which still describes the task rows).
- The drain row's links (WS7), `seance close --wait`'s naming and `list_machines`' `window` and `pane`: DESIGN.md,
  "The drain's outside pass", "Surfaces".
- Close as the graceful despawn: DESIGN.md, Daemon, "Despawn".

## Open questions

None: WS4–WS7 settled the brief's (2026-11-24, the owner taking the recommendations).

## Order

1. Daemon: `SessionEntry.live`, `MachineStatus.sg`, `CAPABILITIES.sessionLive`. Built 2026-11-24.
2. PWA: the join, untasked rows and task rows by `live` (WS4), the reads and `sg` refresh. Built 2026-11-24.
3. PWA: the drain row's links (WS7) and the rename to Work. Built 2026-11-24.
