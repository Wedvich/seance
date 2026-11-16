# Closing a machine and draining it — what is left of the spec

**Status: build order items 1 (Close), 2 (the leader's outside pass and the report) and 3 (the session ask)
are built** and recorded in DESIGN.md, "Closing a machine", "The drain's outside pass" and "The drain's session
ask", as are §6's close warning and §12's time-to-empty line. This file keeps the index of names, the decisions
the owner made, §11, §12's list of measures (every one now read from a line that exists), and what is not built:
§6's "Later" and §13, the soft close (decided 2026-11-16, not built). Drafted 2026-11-13. Like
docs/leaving.md, it is the working record until the code lands; each part folded into DESIGN.md as it was built,
and its text here went.

Scope: something the owner sets ahead of time. Not the SIGTERM path; docs/leaving.md is what happens when the box
actually goes, and the two are complementary (§11).

## Names

| Concept                          | Name                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The machine's state              | **open** / **closed** (closed = takes no new scheduled work)                                                                     |
| Setting it                       | **close**, **reopen**                                                                                                            |
| Closing without draining (§13)   | **soft close**: the default close; nothing running is asked, interrupted or passed until the owner drains                        |
| Starting the drain later (§13)   | **Drain** (ask, then pass, after the grace) and **Drain now** (no grace), on a closed machine                                    |
| Drain start (§13)                | `MachineStatus.dr` (unix ms the drain began; only beside `cl`), `closed.drainAt` in `state.json`                                 |
| Soft close on the wire (§13)     | `availability { open: false, soft: true }`; capability `softClose` (daemon honours it and reports `dr`; leader drains from `dr`) |
| Moving the work off a closed box | **drain** (the act); a task moved by it is **drained**                                                                           |
| Status key                       | `MachineStatus.cl` (unix ms the machine was closed)                                                                              |
| Route reason                     | `closed`                                                                                                                         |
| Daemon refusal of a spawn        | `machine_closed` (`SPAWN_ERROR_CODES`)                                                                                           |
| App → daemon request op          | `availability` (payload `{ open: boolean; now?: true }`)                                                                         |
| Successor trigger                | `succeeds.trigger: "drain"` (the leader's outside pass, and a session's own pass marked `drain` from a closed machine)           |
| Capabilities                     | `close` (daemon), `drain` (leader routes), `drainPass` (leader passes), `drainAsk` (daemon asks and honours `now`) — all built   |
| Audit origin (typed prompt)      | `drain`                                                                                                                          |
| CLI                              | `seanced close [<machine>] [--now] [--wait]`, `seanced open [<machine>]`                                                         |
| MCP                              | `set_machine_open { machine, open, now? }`                                                                                       |
| PWA                              | "Open for work" switch in the machine's menu; "Drain now" on the close sheet                                                     |

Not "unavailable": offline and asleep machines already read as unavailable, and closed is a choice, not a
condition. Not "draining" for the state: `drn` is the restart's launch gate (DESIGN.md, "Restart waits for task
launches") and means something else. Not "cordon": correct in Kubernetes, jargon everywhere else.

## Decisions

**Decided by the owner, 2026-11-13:**

- **N1. Open / closed** are the names (above).
- **N2. Closed is sticky** across restarts and reboots until reopened (DESIGN.md, "Closing a machine").
- **N3. O2 stands:** the daemon never WIP-commits for a drain. A dirty tree the session did not commit is
  reported, never forced (DESIGN.md, "The drain's outside pass"); the session ask is how a session commits
  its own work first.
- **N4. A `needs-input` task is interrupted and moved.** The drain is the person's own act, so it overrides
  Q2's "never moved while a person is asked" for `trigger: "drain"` only. Built as: an open question is
  Escaped at once, a permission wait at the deadline like a busy turn, and nothing waits on the person beyond 5
  minutes (DESIGN.md, "The drain's session ask").

**Decided by the owner, 2026-11-16:**

- **N5. A close is soft by default** (§13; answers the open question "Close, let finish as a second mode?" the
  other way round). Closing stops new scheduled work and nothing else. The drain (the session ask, then the
  leader's outside pass) starts only when the owner presses **Drain** or **Drain now** on the closed machine, or
  closes with either. Why: most closes mean "stop giving this box work", not "this box is going away now"; a pass
  costs a fresh session rebuilding its context from a branch and a record, and the box actually going away is
  docs/leaving.md's SIGTERM path. Today's close becomes the **Drain** step unchanged (ask at the turn end, Escape
  at 5 minutes, pass at 10), and "Drain now" keeps its meaning.

## Where each part went

One line each; the text is in DESIGN.md.

- **§1 Closed is the daemon's own state, §2 routing and the gate, §3 closing drains, §7 reopening, §10 skew:**
  "Closing a machine".
- **§4 The drain: ask, then pass, then report.** Step A (the session ask, with its two spikes): "The drain's
  session ask". Steps B and C (the outside pass, the report): "The drain's outside pass".
- **§5 Progress, and "empty":** `drainView` in `shared/src/drain.ts`, "The drain's outside pass".
- **§6 Leadership** (a closed leader keeps leading; the close sheet's, `seanced close`'s and
  `set_machine_open`'s warning): "Closing a machine". Its "Later" stays below.
- **§8 Surfaces:** PWA switch, close sheet, drain row, `seanced close`/`open`, MCP `set_machine_open` and
  `list_machines`' `drain`: "Closing a machine", "The drain's outside pass" and "The drain's session ask" (`now`,
  "Drain now", the ask's wording). Raycast: none (spawn-only).
- **§9 Threat model:** the invariants list ("Closing is the owner's act", "The drain's session ask is constant
  keys…") and `CLAUDE.md`.
- **§12's time from close to empty:** "The drain's outside pass" (the daemon's `drain: empty` line).
- **Build order:** items 1 to 3 are built, in that order, each in its own PR.

## Left

### 6. Leadership — _Later_

Register without the `lead` role once the machine is empty, if another nominee is connected, so the queue keeps
running through the outage.

### 13. Soft close by default (N5)

**Wire.** `availability { open: false, soft: true }` closes without draining. `soft` is accepted only as `true`
(any other value is dropped, as `now` is) and never persisted. The plain `{ open: false }` keeps today's meaning,
close and drain, so an older client that sends it still gets the behaviour its wording describes; a new client
sends `soft` for the default close and leaves it off for **Drain**. On a machine already closed: `{ open: false }`
starts the drain (if not started), `now` starts it with no grace, and `soft` on a machine already draining
changes nothing (a drain is stopped only by reopening). `soft` beside `now` is `invalid_request`. The audit line
gains ` soft=true` only when it was set, so existing lines stay byte-identical.

**State.** `state.json`'s `closed` becomes `{ at, drainAt? }`; `drainAt` is set once per close and survives
restarts like `at`. A `drainAt` `loadOrInitState` cannot read loads as not draining, with a warning: unlike
`closed` (which fails closed so a damaged file never reopens a box), failing toward a drain would interrupt and
move work on a damaged file, and the owner can press Drain. Reopen clears both.

**Status.** `MachineStatus.dr` is `drainAt` in unix ms, sent only beside `cl` and, like `cl`, never trimmed by
`fitStatus` (a trimmed `dr` would stop a drain the owner started). A set `dr` asks for a fresh status
(`StatusLoop.refresh`).

**Who starts on what.** The daemon's session ask starts at `drainAt`, not at the close; its deadline is
`drainAt + DRAIN_INTERRUPT_MS` (`now`: the request time). The leader's outside pass reads the drain's start
through one predicate, `drainStart(machine)`: `dr` when present; else `cl` for a machine that does not advertise
`softClose` (an older daemon's close always drained); else none, and nothing is passed. `drainWaitMs` counts the
grace from that start. A `session-pass` from a soft-closed machine is still marked `drain` (the session chose to
pass, and the machine is closed); only the ask and the outside pass wait for `dr`.

**Capability and skew.** `CAPABILITIES.softClose` on both: a daemon that honours `soft` and reports `dr`, and a
leader that drains from `drainStart`. A client offers the soft close only to a target advertising `softClose`
under a verified leader advertising it; otherwise it offers today's close, worded as today (an older daemon
would drop `soft` and drain; an older leader would pass on `cl` alone). A leader change to an older version
after a soft close drains that machine on `cl` after its grace: accepted, it is the old behaviour and the
version floor makes it rare, and the PWA's drain row shows the passes as they happen.

**Surfaces.**

- PWA: the close sheet's primary action is **Close** (soft), worded "Stops new work here. Running tasks keep
  going until they finish or you drain the machine", with **Close and drain** and **Drain now** as quieter
  actions. A closed machine that is not draining shows **Drain** and **Drain now** in its drain row and menu; a
  draining one shows **Drain now** while its grace runs.
- `drainView` tells soft from draining, and on a soft-closed machine says what it waits on: sessions running
  versus idle at their prompt (one idle at its prompt never finishes on its own, so the row is how the owner
  knows when to drain).
- `seanced close` is soft; `--drain` is today's close; `--now` implies `--drain`. `--wait` on a soft close waits
  for the tasks to finish on their own, and says so. MCP `set_machine_open { machine, open, drain?, now? }`
  likewise, `drain` and `now` `true` only.
- §6's warning applies to a soft close too: the box keeps leading while closed.

**Threat model.** No new power: `soft` only withholds the ask and the pass a close used to start. The op stays
the owner's sealed act (CLAUDE.md, "Closing a machine"), whose invariants gain: `soft` is `true` only and never
persisted, `MachineStatus.dr` is never trimmed, and the leader drains a machine only from `drainStart`.

**Build.** Two PRs. (1) The wire, daemon and leader: `soft`, `closed.drainAt`, `dr`, `drainStart`, the ask
keyed off the drain's start, `CAPABILITIES.softClose`, DESIGN.md and CLAUDE.md. (2) The surfaces: the PWA's
sheet, drain row and menu, `seanced close --drain`, MCP `drain`, `drainView`'s soft state.

## Kept here

### 11. Relation to docs/leaving.md

Closing is what you do before the box goes; `leaving` is the note it sends as it goes. A drained, empty box that
then shuts down sends `leaving { r: "shutdown" }`, and nothing is interrupted. A box shut down mid-drain gets
leaving.md's handling for whatever was left. The daemon's launch gate for a restart (`drn`) is unchanged and
independent: a closed machine that restarts still closes its gate for the restart, and reopens it closed.

### 12. Measures

From audit and leader logs, with no new storage: drains per week (`availability` request lines with
`open=false`); tasks moved per drain by step (`trigger=drain` pass lines, with the self path told apart by the
daemon's `origin=successor` push and the ask by its `audit drain` lines); stuck items by reason; time from close
to empty (the closed daemon's `drain: empty cl=… after_ms=… peak=…` line, `grep 'drain: empty'` in its log; one
per `cl` per process, so fold repeats by `cl`: DESIGN.md, "The drain's outside pass").

(The earlier second question, the default grace before interrupting a turn, is settled and built: 5 minutes,
`--now` and "Drain now" for 0.)
