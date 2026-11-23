---
paths:
  - "scheduler/src/**"
  - "daemon/src/{leader*,launch-ledger*,version-floor*,run,run-capabilities,spawn,auto,branch-state,settings,settings-store,queue-store,store-frames,report-done*,handoff*}.ts"
  - "shared/src/{successor,amend,amend-client,continue-task,task-record,autonomy,task-prs}*.ts"
  - "pwa/src/{scheduler-store,store,queue-view,decision-view,verdict-view}.ts"
---

# The leader, the launch ledger and task state

Requirements, not observations: DESIGN.md's Threat model and docs/scheduler.md are the record. CLAUDE.md's
recurring rules hold throughout. A task record's shape and sealing is task-records.md; GitHub reads and
the branch push are github.md; the drain's own ask is drain.md.

## Scheduler requests

- The leader honours a scheduler request only when it was sealed `from: "app"`, parsed into a fresh value
  by that op's own parser (`parseQueueRequest`, `parseTaskRequest`, `parseTaskRef`, `parseAmendRequest`,
  `parseSetLimitsRequest`, …), and checked against the one replay guard per daemon process that every
  term's leg and the `not_leader` answer share (`schedulerGuard` in `daemon/src/run.ts`) — never a guard
  per term, which would let the relay replay a `cancel` into each.

## The launch ledger

- The launch ledger (`daemon/src/launch-ledger.ts`) is write-ahead — a task id is on disk before its spawn
  runs, a spawn whose id it cannot record is refused, and `since` only moves forward — since it is what
  makes `ledgerSince` a proof that a spawn never landed.
- An id still pending when the ledger opens is reported `interrupted`, never removed from `ended` (an older
  leader would read the gap as never-landed), and a leader never re-dispatches an interrupted task.
- A task launch the restart drain turns away is answered `internal_error` unrecorded, never held and run
  later.
- A scheduler spawn for a task id the ledger holds as launched is refused `task_launched`, audited, never
  run again.

## Continuations

- A continuation (`mode: "continue"`) runs only for a spawn sealed `from` the scheduler with
  `client: "scheduler"` (or the leader's in-process dispatch), in the worktree this machine's own launch
  ledger noted for the continued task id — never a path from a frame — resuming the Claude session id this
  daemon chose at that launch (`--session-id`) and noted beside it — never an id from a frame — under the
  clone its `repo` name resolved to, and only while no later launch in that ledger noted the same
  worktree.
- A gone worktree is re-added only at that noted path, a direct child of the clone's canonical
  `.claude/worktrees`, on the branch that ledger noted and only while `refs/heads/<branch>` exists, under
  reap's lock, added detached at that ref's sha and then switched onto it (never origin's, never
  `--force`, never `worktree prune`).
- A task record carrying `continues` always carries `mode: "continue"`, which an older leader's parser
  refuses.

## The version floor

- The leader's version floor (`daemon/src/version-floor.ts`) is one per process like `schedulerGuard`,
  persisted 0600, and only ever raised by a read (the leader's own pause write and its own limits write
  alone may set it lower).
- A task record below it is `version_regressed`, a pause below it or missing holds the whole queue, limits
  below it or missing place nothing, and a task record that vanishes without the leader's delete is never
  read as gone.

## Successors and passes

- A task record's `successor` is written only by the leader and only after the successor's create.
- A successor is created only through the leader's app-role leg (`createTask` at `expect: 0`, never the
  daemon leg), sealed through the one task sealer, which appends `SUCCESSOR_DEP_SENTINEL` to its deps for
  an older leader to refuse (the parser drops it only beside `succeeds`, and `openTaskRecord` holds a
  stored record carrying `succeeds` without it `malformed`; its `after` differs from the attachments and
  requires sentinels', so each stays tied to its own field), and is held until its predecessor is
  `superseded` naming it and never spilled into credits.
- The leader passes a task on its own (`trigger: "quota"`) only for `autonomy: "auto"`, never a
  `needs-input` task.
- For a closed machine's tasks (`trigger: "drain"`) it passes only a worktree task (never `here`) placed on
  a connected machine advertising `CAPABILITIES.successor` whose status carries `cl`, only after
  `drainSelfPassMs` past `drainStart`, one at a time per machine, behind a write-ahead `Task.drained`
  stamp (a `conflict` that follows the successor's create is `held`: never retried for that `cl`, or a
  second successor would follow).
- The drain is, with the session's own pass, a trigger that passes a `needs-input` task (the manual and
  quota passes never do; the app's `pass` op cannot reach the drain), and its successor is never placed on
  `succeeds.account`.
- A `superseded` predecessor's dependents follow its `successor` chain, never fail on it.
- A pass is offered, by the PWA, `seance pass` and MCP `pass_task`, only through `passOffer`
  (`shared/src/successor.ts`) to a verified leader and a task machine that advertise
  `CAPABILITIES.successor`, and is sent once and never retried.
- A session's own pass (`pass_to_successor`) is offered only to a verified leader advertising
  `CAPABILITIES.successorSelf` (a 2a leader would drop its `session-pass` after the push) and checks the
  record's length before any push.
- The leader acts on a `session-pass` only when it is sealed `from` the machine the task is placed on,
  never logging its `record` (the successor's prompt) or the branch, and sends `pass-close` only after the
  successor's commit write.
- A daemon sends no pass for a caller whose connection has closed (an interrupted call: checked before and
  after the push) and marks a pane for one close only (a pass outranks a hand-off).

## Events from daemons

- A `branch-state` is never accepted from an app, nor a `session-message` (from a daemon only).
- A `custodian-event` (`flag`, `unflag`, `failing`: daemon to leader, sealed, no capability and no
  sentinel) writes `Task.flag` only when the task's `assignment.deviceId` is the machine that sealed it,
  in any task state (a finish keeps the flag, a move back to `ready` drops it), through the one task
  sealer, a repeat a no-op and a changed note keeping `at`. The leader never acts on one sealed
  `from: "app"`, never logs, audits or pushes the note, and a `failing` event only pushes
  `custodian-failing` carrying the sealer's own device id.
- An event — a session event or a branch state — moves only a task placed (or, for a session event,
  reserved) on the machine that sealed it.

## Amend

- A task's prompt, title, model, effort and not-before time change after its create only by the leader's
  own write on an `amend` (`Scheduler.amend`), only while the task is `queued`, `blocked` or `ready` with
  no spawn out, a prompt change only at the `basis` it names (never a replace on a successor), the record
  re-sealed through the one task sealer, and no prompt text — the amendment's included — in any log or
  audit line.
- Its `owner.*` tags change alone by the same write in any state (`ownerTags`, no `basis`, no forgotten
  decision), never from `amend_task` or the broker.

## Limits and settings records

- The limits record (`settings:scheduler`, DESIGN.md "Routing caps") is written only by the leader, on a
  `set-limits` sealed `from: "app"`, read only through `getLimits` (`openAtRest` under
  `scheduler-settings`, then `parseSchedulerSettingsRecord`, strict down to an unknown key in `limits`).
- One the leader cannot read places nothing (a fleet limit of 0, which `run-now` alone passes) until a
  `set-limits` overwrites it — never read as no limit; no record is no limit, the default.
- `set-limits` is on no MCP tool, broker action or local op (a session must not raise a limit its owner
  set), and a client offers it only to a verified leader advertising `CAPABILITIES.limits`.
- The settings record (`settings:main`) is written only by the leader, held to the version floor, never
  regenerated nor written over when it cannot be read or has regressed, and never logged nor put in
  `queue`, MCP or `status`.
