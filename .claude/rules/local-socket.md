---
paths:
  - "daemon/src/{local-socket,local-client,broker,broker-client,broker-protocol,mcp,peer}.ts"
  - "daemon/src/{session-event*,settings-hooks*,usage-refresh,report-done*,handoff*}.ts"
  - "daemon/src/{launch-ledger*,pane-activity*,conversations,claude-process,agent-session-file*}.ts"
  - "daemon/src/owner-labels*.ts"
  - "daemon/src/codex/{sessions,events}.ts"
  - "shared/src/tags.ts"
---

# The local op socket, session events and session identity

Requirements, not observations. DESIGN.md's "Local op socket", "Fleet broker", "Session events",
"Session identity" and "The owner's label" are the record. CLAUDE.md's recurring rules (peer-pid
binding, data-channel stdouts, the owner's sealed act, no text in logs, a new act is a threat-model
change) hold throughout; the `message`, `inbox` and `watch` frames have files of their own
(messages.md, watches.md).

## The socket

- `daemon/src/local-socket.ts` is what makes MCP's `get_sessions` and `despawn_session` aimed at this
  machine skip the relay (`spawn` stays on its allowlist only for a `seance mcp` started before spawns
  became tasks).
- Its access control is the **0700 `stateDir()/run` directory**, not the socket's own mode:
  `Bun.listen({ unix })` creates it 0755 and the `chmod` races.
- Its op allowlist is `sessions`, `spawn`, `despawn` and `rescan` only; widening it is a threat-model
  change (DESIGN.md's "Local op socket" records why `despawn` and `rescan` got in).

## The fleet broker

- On a daemon whose key is service-delivered (`source: "credential"`) — and only there — the same socket
  carries the fleet broker (`broker.ts`): its own frame kind, never a `Plain` or an `OpName`, four
  actions — `machines`, `fleet`, `request` (`sessions`, `spawn` and `despawn`, never `rescan`) and `scheduler` (`enqueue`,
  `queue`, `cancel`, `run-now`, `pass`, `amend`, `accounts`). DESIGN.md's "Fleet broker" is the record;
  any widening, including running it on other daemons, is a threat-model change.
- A brokered enqueue is a create at `expect: 0` of a task the daemon sealed itself from a parsed spec,
  with the daemon's own `createdAt`, no lineage or base:
  - a continue spec's `continues` is carried, and only while the leader advertises `continueTask`;
  - its `requires` is carried only while the leader advertises `traits` and the broker's own daemon does
    (an older one would drop it and queue the task unrestricted);
  - its `tags` are only `creator.*` and only while the leader advertises `taskTags`, and its `amend`
    never carries `ownerTags`.
- It serves a client of `mcp` or `cli` only, audited as `claimed_client` (the peer's unverified word). A
  `landedEarlier` on it is the relay's answer for a peer-chosen id: it may stand for a tombstone or
  another client's task, never an overwrite.

## `session-event`: ingest-only, bound by peer pid

`session-events.ts`. The frame's `pane` decides only on a host that names no peer at all
(`peerPidSupported`), never for one connection whose pid came back null. Its five acts past ingest are
these; giving it any other act, or taking a session or task id from the frame to bind by, is a
threat-model change.

1. **Usage refresh.** Poking the bound exclave's `/usage` refresh (`usage-refresh.ts`), which spawns only
   on a stale reading, with fixed argv and an env built from the scan — no frame field reaches either.
2. **`done`.** Only `report_task_done` sends one (`seance session-event` drops a `done` unsent). The
   daemon notes it in the launch ledger and forwards it once, both for the pane's own task only, and
   answers `untasked` for a pane with none and `unrecorded` for a task its ledger holds no launch of
   (nothing sent). The leader settles that task only under `until: "reported"`, or under
   `until: "merged"` while it holds no PR and no successor (`reportSettles`), and only from the machine
   it was placed or reserved on.
3. **Clearing `interrupted`.** Its own pane's task's `interrupted` mark in the launch ledger, only on an
   `ended` or `done` frame (proof the session ran; never when ingest is stopped), bound to the pane like
   the `done` report (including on a host with no peer pid), never to an id from the frame.
4. **Hand-off.** Only `hand_off_task` sends one (`seance session-event` drops one unsent). It carries no
   state, and is taken only for the pane's own task when its launch ledger holds a launch and a PR URL of
   it (`untasked`, `unrecorded`, `prless` otherwise). That PR URL is one its session reported; or, for a
   continuation, the one that ledger noted on it at launch from the launch it continues (`continuedPr`,
   from any launch but one the scheduler cancelled: a despawn sealed from the scheduler naming
   `client: "scheduler"`, noted `cancelled`); or, for a successor, the one that ledger noted on it at
   launch from the spawn's `inheritedPr` (`SpawnRequest`).
   - `inheritedPr` is taken only on a worktree spawn sealed `from` the scheduler with
     `client: "scheduler"` (or the leader's in-process dispatch) carrying a task id, held exact to
     `httpsUrl`, ignored (never refused) from any other sender, beside any other mode, or when
     unreadable, kept out of `progress` and never logged (the audit line says `inheritedPr=true`). The
     leader sets it only from the dispatched task's own `prUrl`, only for a task carrying `succeeds` and
     never under `until: "reported"`, never from a session-event frame.
   - The daemon marks the pane in memory and, at that pane's next `idle` carrying `turnEnded` (its turn's
     end, never a respawn's idle), closes it through the graceful despawn after re-reading that it still
     carries that task, audited `origin=handoff` (`handoff.ts`), never a pane or task a frame names.
5. **Pass.** Only `pass_to_successor` sends one (`seance session-event` drops one unsent). It carries no
   state and a `record` bounded by `SUCCESSOR_RECORD_MAX` (prompt text, never logged, never used to bind,
   route or close anything), and is taken only for the pane's own task when its launch ledger holds a
   worktree launch of it (`untasked`, `unrecorded`, `here` otherwise).
   - The daemon pushes that worktree's branch through `pushTaskBranch` with no `expect` (`hasPr` from its
     ledger), audited `origin=successor`, marks the pane in memory, sends one `session-pass`, and closes
     the session through the same graceful despawn, audited `origin=successor`, only when both that
     pane's next `idle` carrying `turnEnded` (a later `busy` or `needs-input` clears it) and a
     `pass-close` sealed `from` the scheduler (or the leader in process) naming that pane's task have
     arrived, after re-reading that it still carries the task.
   - An `ended`, a pane reused for another task or a restart drops the mark; `pass-close` arms only a live
     pane carrying the task (`no_pane` otherwise), never a pane or task a frame names.

A `ref` (`SpawnRequest.ref`, a task's `creator.ref` and URL) is taken only from a spawn sealed `from` the
scheduler with `client: "scheduler"` and a task id, in any mode, ignored from any other sender, kept as
`parseRef` and `httpsUrl` hold it, noted in the launch ledger (`TaskNote.ref`) and sent only in an
adapter's `task.ref`, never logged and never used to bind, route or move anything.

### The frame's other claims: display or timing only

- `agent` (`kind`, `session`, `remote`; `remoteSession` read as `remote`'s fallback): each kept only as
  its parser (`parseTagValue`, `shared/src/tags.ts`; `agent.remote` through `isRemoteSessionId`) passes
  it, display-only (`agent.remote` is the PWA's claude.ai link), never used to bind, route or move
  anything. `agent.session` is verified only against the launch ledger or the `claude` process's own
  `sessions/<pid>.json`, opened as `custodian-remote.ts` opens it (`readSessionFile`), re-read at each
  act (`atAct`), a refuted claim dropped, and is used only to address the owner's `session-tag` (below)
  and adapter delivery through a subscription (`toSession`, DESIGN.md "Adapters", "The subscription"),
  never a reply.
- `reason`: kept only as a known `NEEDS_INPUT_REASONS` value beside `needs-input` (dropped otherwise,
  never the event). `question` makes the leader alert that needs-input stay at once instead of after its
  debounce (`questionAlert`), only for the task's own machine and once per stay, and, on a closed
  machine, makes the drain ask send its one Escape to that pane at once instead of at the deadline.
  `permission` and `elicitation` have no effect. It never binds, routes, moves or settles anything.
- `tool`: only beside `permission` and only as `isToolName` passes it, display-only like `agent.remote`
  (written onto `Task.inputTool`, never used to bind, route, move, settle or alert, and kept out of
  `get_queue`).
- A `stop` note, sent alone by the settings `Stop`/`StopFailure` hooks (`seance session-event --hook`,
  DESIGN.md "Settings hooks"): counts by `BACKGROUND_KINDS` and a `STOP_ERRORS` value only, never a
  command, description or prompt; held in memory for the pane's own pid and task (an untasked pane's too,
  forwarded nowhere), joined to a tasked pane's `idle` and dropped at any other state or when a frame
  finds the pane gone or under another pid; kept by the leader beside its idle clock and in `queue`'s
  idle entries only (never on a record). Display-only like `tool` but for one effect: a held note with
  any count makes the custodian's `close` answer `busy` and the seat count no round due for that pane
  (`awaitsWake`, which a live watch on the pane also makes true), never a hand-off's or pass's close.
- While this machine is draining, a bound, tasked frame's state, `turnEnded` and `reason` also time the
  drain ask's constant keys for that pane (`onState`), and never choose what is typed or which pane.
- A bound `busy` following an `idle` this process retained for that pane (`isNewTurn`; a pane with no
  state retained is not a new turn) also lifts the pane's own `stuck` or `look` flag, by one `unflag` at
  the leader and then in the flags file: an act on the pane's own entry only, never one a frame names.

### Retention, not acts

Nothing kept below is run or sent, and no reply depends on it.

- Each `ours` pane's last state and `turnEnded`, tasked or not, in memory (`pane-activity.ts`, only while
  a custodian seat runs). Its screen sampler keeps only a hash of `capture-pane` and timestamps, never the
  text. Its one write is the daemon's own 0600 `custodian/activity.json` (`pane-activity-store.ts`):
  those facts, keyed by pane id and the pane process's pid and start time, never screen text; a reloaded
  entry stays hidden from every reader until the pane's process matches and a fresh sample hashes its
  screen the same, and is dropped otherwise.
- For each pane whose peer resolves to a `claude` process (tasked or not, `ours` or not), that process's
  last state, `reason` and `agent` claims, keyed on the process (`<pid>:<start time>`), with the
  conversation table beside it (`conversations.ts`, memory only). Its tags reach only an app's `sessions`
  (`SessionEntry.tags`: never a scheduler-sealed one, and MCP's `get_sessions` only
  `AGENT_VISIBLE_TAG_KEYS`), never a log, an audit line or argv.

## A Codex pane's events: its own server, bound by construction

DESIGN.md, "Codex session events". The second source of session events is the daemon's own connection to
the `codex app-server` of a pane it launched (or, on a restart, of a pane of ours whose start command names a
0700 run dir of its uid and whose `thread` file names the thread the launch ledger noted for its task).

- A notification enters only through `codexSignals`, and only for the session's own thread: another thread's
  is dropped. It reaches the pipeline only through `SessionEvents.codex`, which re-reads the pane listing
  (live, same pid and task, still Codex's) before `ingest`, the step a bound frame reaches after binding.
  Giving it any act a bound frame lacks, or taking a pane, task or thread from a notification, is a
  threat-model change.
- The daemon sends a server only constant methods with daemon-held params (the thread it started, a turn id
  its server named) and never answers a server request: an approval is never granted by the daemon.
- A Codex pane's own local `session-event` frames take `done` and `handoff` only; `pass` is `unsupported`
  and a state is dropped, so nothing else running in the pane speaks for it. `sessionOf`'s session for a
  Codex pane is the innermost `codex` (`CODEX_PANES.process`), the pane's server.

## A session's name is the owner's sealed act

DESIGN.md, "Session identity", "The owner's label".

- `session-tag` (`parseSessionTagRequest`; audited `key-count` and `outcome`, never the label or an id)
  acts only on an untasked pane's newest live `claude` whose conversation is the one named, verified and
  unconflicted, re-checked with `atAct` at the act (`tasked`, `moved`, `unverified`, `ambiguous`, `ended`
  otherwise).
- The label is the one text in the daemon's 0600 `conversations.json` (written whole through
  `writeDurable`, at most 256 entries, a 30-day idle prune, a file it cannot read loading empty), never
  logged, and joined as `owner.label` only to an untasked process while that conversation's one claimant
  is verified.
- The PWA offers rename only for a connected machine advertising `CAPABILITIES.sessionTag`.
