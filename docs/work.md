# The Work screen: sessions beside tasks

**Status: spec; Order step 1 (daemon: `SessionEntry.live`, `MachineStatus.sg`, `CAPABILITIES.sessionLive`) built
2026-11-24, recorded in DESIGN.md ("Tags and session identity", "Live state and the session generation"); steps 2–3
(PWA) not built.** The owner's brief (2026-11-23): the session list, today the task queue, also lists
sessions that are not tasks. This is the place #567 left open when it took the session list off the Machines card
"until its place is decided" (DESIGN.md, "Tags and session identity", "The PWA's per-namespace view"); `sessionRows`,
the `SessionRow` model and `Store.renameSession` were kept for it.

## Owner's decisions (2026-11-23)

- **WS1. One list.** The Queue screen lists every live session a machine reports beside the queue's tasks: a session
  carrying a task folds into that task's row, one carrying none is a row of its own.
- **WS2. Placed by live state.** An untasked row sits in Needs you, Running or Idle by its session's live state, marked
  as not a task, never in a section of its own. This needs the state on the wire (below); a stateless "Sessions"
  section was the rejected alternative.
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
  (`displayName`) and opens its Work row, where Close is.

## What a session that is not a task is

A `claude` in a pane of the daemon's tmux server (the user's default server) with no `@seance-task`: in practice a
hand-started session, or a legacy `spawnUntracked` spawn from an old `seance mcp`. A `claude` in a plain terminal tab or
an IDE is in no pane, binds to nothing and never appears: a limit of the list, not a gap to close here. The custodian's
round is never a session (C10) and stays out, as it is out of `sessions` today.

## Wire

### `SessionEntry.live`

A new optional field on `SessionEntry`, sent only in a `sessions` reply to an app (never one sealed from the scheduler,
never in MCP `get_sessions`: WS6), display-only like `tags`:

```ts
readonly live?: {
  readonly state: "busy" | "idle" | "needs-input";
  /** When the state began (`ProcessView.since`), the daemon's clock. */
  readonly since: number;
  /** Beside `idle`: the idle a turn's own end raised. */
  readonly turnEnded?: true;
  /** Beside `needs-input`, as `NEEDS_INPUT_REASONS` holds it. */
  readonly reason?: NeedsInputReason;
};
```

Its source is the conversation table's `ProcessView` for the pane's newest live `claude` (`daemon/src/conversations.ts`,
which already keeps state, `turnEnded`, `since` and `reason` for every bound `claude`, tasked or not, `ours` or not), joined
in `withTags`'s pass in `daemon/src/handlers.ts`. No state retained (a session that never sent a frame: no hooks, an
exclave without the mod) omits `live`; the client shows that row as Running with "state unknown", never as idle.

**Reversed rejection.** The drain's "Soft or draining" (DESIGN.md, "The drain's outside pass") rejected a per-pane state
on `sessions` as "a wire change for one word on one row" and read `QueueResponse.idle` instead. WS2 makes it the
screen's basis for every untasked row; the DESIGN.md entry is amended with this, and the drain keeps reading
`QueueResponse.idle` for tasks (WS4).

**Precedent.** The adapter feed already sends every session's state to adapters (`ADAPTER_SESSION_STATES`,
`shared/src/adapter-protocol.ts`), so this exposes nothing new to a reader that holds the PSK.

### `MachineStatus.sg`: the session generation

The PWA re-reads a machine's sessions today only when its status's `sess` counts change, and a session going busy to
idle changes no count. `sg` is a number the daemon bumps on any change a `sessions` reply would show: a pane appears or
goes, a `live.state`, `reason` or `since` changes, a label or task changes. Display-only, never trimmed by `fitStatus`, a bad one
dropped alone. The client re-reads a machine's sessions when its `sg` changes, spaced as the drain row's re-read is
(at most once per ten seconds per machine, a trailing read so the last change is never lost).

_Rejected:_ per-session state inside the status (the status's size budget and `fitStatus` trimming; one push per state
change to every client), and a timer poll (a read per machine per tick for nothing).

### Capability

`CAPABILITIES.sessionLive`: a daemon that sends `live` and `sg`. A machine without it contributes its untasked sessions
as Running with "state unknown" (no `sg`: re-read on `sess` changes, as today).

## PWA

- **Reads.** The Work screen reads `sessions` from every connected machine when it opens and on each `sg` change while
  it is open, beside the queue read. An asleep or offline machine keeps its last read, shown under Asleep as its tasks are.
  `Store`'s per-machine `sessions` state is already the drain row's; the Work screen shares it.
- **Join** (`queue-view.ts`, `deriveQueue`). A session whose `taskId` the queue lists folds into that task's row, which
  gains the pane (Close) and the session's tags. A session whose `taskId` the capped queue does not list stays a task row
  with what the session shows. A session with no `taskId` is an untasked row.
- **Untasked row.** Name by `displayName` (owner label, else the window name), the machine and repo, a "Not a task" mark,
  the state line ("waiting on you: permission", "idle 12m"). Actions: Rename (`CAPABILITIES.sessionTag`, as #556),
  Close (the graceful despawn; `despawnSession` already takes any registered pane), Open on claude.ai (`agent.remote`),
  the Tags disclosure. Never Continue, Pass, Mark done or Cancel: those need a record.
- **Sections.** For an untasked row, and a running task row with `live` (WS4): `needs-input` goes to Needs you, `busy`
  or no `live` to Running, `idle` to Idle, an asleep machine's to Asleep. A task row without `live` keeps today's rule
  (the leader's idle list). The summary line counts untasked rows apart from tasks ("3/6 running · 2 sessions"), since the fleet cap counts
  tasks only.
- **Rename.** Header menu, screen title, `Screen` stays `"queue"` internally and in history state (a rename is not worth
  a migration of deep links or persisted state); only the words change.

## Threat model

`live` is a reading of what ingest bound (DESIGN.md, "Session events", retention), handed to an app as `tags` already
are: nothing is run, sent or decided on it, no log, audit line or push carries it, and the scheduler's `sessions` never
does. Close on an untasked row is the existing owner despawn. No new act.

## Open questions

None left from the brief: WS4–WS7 settled them (2026-11-24, the owner taking the recommendations).

## Order

1. Daemon: `SessionEntry.live`, `MachineStatus.sg`, `CAPABILITIES.sessionLive`; DESIGN.md amended.
2. PWA: the join, untasked rows and task rows by `live` (WS4), the reads and `sg` refresh.
3. PWA: the drain row's links (WS7) and the rename to Work.
