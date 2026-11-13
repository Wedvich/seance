# Closing a machine and draining it — what is left of the spec

**Status: build order items 1 (Close), 2 (the leader's outside pass and the report) and 3 (the session ask)
are built** and recorded in DESIGN.md, "Closing a machine", "The drain's outside pass" and "The drain's session
ask". This file keeps the index of names, the decisions the owner made, and what is not built: §6's sheet
warning and its "Later", §12's time-to-empty measure, and the open question below. Drafted 2026-11-13. Like
docs/leaving.md, it is the working record until the code lands; each part folded into DESIGN.md as it was built,
and its text here went.

Scope: something the owner sets ahead of time. Not the SIGTERM path; docs/leaving.md is what happens when the box
actually goes, and the two are complementary (§11).

## Names

| Concept                          | Name                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The machine's state              | **open** / **closed** (closed = takes no new scheduled work)                                                                   |
| Setting it                       | **close**, **reopen**                                                                                                          |
| Moving the work off a closed box | **drain** (the act); a task moved by it is **drained**                                                                         |
| Status key                       | `MachineStatus.cl` (unix ms the machine was closed)                                                                            |
| Route reason                     | `closed`                                                                                                                       |
| Daemon refusal of a spawn        | `machine_closed` (`SPAWN_ERROR_CODES`)                                                                                         |
| App → daemon request op          | `availability` (payload `{ open: boolean; now?: true }`)                                                                       |
| Successor trigger                | `succeeds.trigger: "drain"` (the leader's outside pass, and a session's own pass marked `drain` from a closed machine)         |
| Capabilities                     | `close` (daemon), `drain` (leader routes), `drainPass` (leader passes), `drainAsk` (daemon asks and honours `now`) — all built |
| Audit origin (typed prompt)      | `drain`                                                                                                                        |
| CLI                              | `seanced close [<machine>] [--now] [--wait]`, `seanced open [<machine>]`                                                       |
| MCP                              | `set_machine_open { machine, open, now? }`                                                                                     |
| PWA                              | "Open for work" switch in the machine's menu; "Drain now" on the close sheet                                                   |

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

## Where each part went

One line each; the text is in DESIGN.md.

- **§1 Closed is the daemon's own state, §2 routing and the gate, §3 closing drains, §7 reopening, §10 skew:**
  "Closing a machine".
- **§4 The drain: ask, then pass, then report.** Step A (the session ask, with its two spikes): "The drain's
  session ask". Steps B and C (the outside pass, the report): "The drain's outside pass".
- **§5 Progress, and "empty":** `drainView` in `shared/src/drain.ts`, "The drain's outside pass".
- **§8 Surfaces:** PWA switch, close sheet, drain row, `seanced close`/`open`, MCP `set_machine_open` and
  `list_machines`' `drain`: "Closing a machine", "The drain's outside pass" and "The drain's session ask" (`now`,
  "Drain now", the ask's wording). Raycast: none (spawn-only).
- **§9 Threat model:** the invariants list ("Closing is the owner's act", "The drain's session ask is constant
  keys…") and `CLAUDE.md`.
- **Build order:** items 1 to 3 are built, in that order, each in its own PR.

## Not built

### 6. Leadership

A closed machine keeps leading. The drain's passes need a leader, and moving the term mid-drain only adds a
takeover. It stops leading when it leaves (leaving.md §1 resigns at SIGTERM). If the box you close is the leader
and no other nominee is connected, the queue stops while it is down. The PWA's confirm sheet should say so
("Thad runs the queue; no other machine can take over"). _Later:_ register without the `lead` role once the
machine is empty, if another nominee is connected, so the queue keeps running through the outage.

### 11. Relation to docs/leaving.md

Closing is what you do before the box goes; `leaving` is the note it sends as it goes. A drained, empty box that
then shuts down sends `leaving { r: "shutdown" }`, and nothing is interrupted. A box shut down mid-drain gets
leaving.md's handling for whatever was left. The daemon's launch gate for a restart (`drn`) is unchanged and
independent: a closed machine that restarts still closes its gate for the restart, and reopens it closed.

### 12. Measures

From audit and leader logs, with no new storage: drains per week (`availability` request lines with
`open=false`); tasks moved per drain by step (`trigger=drain` pass lines, with the self path told apart by the
daemon's `origin=successor` push and the ask by its `audit drain` lines); stuck items by reason. **Not built:**
time from close to empty (logged by the daemon when `drainView` first reads empty after a close); only the first
three read from lines that exist.

## Open questions

1. **"Close, let finish" as a second mode?** Proposed: not in v1. The session ask is gentle already: it waits
   for the turn to end (5 minutes, then an interrupt). A cordon-only mode is a flag away later if wanted.

(The earlier second question, the default grace before interrupting a turn, is settled and built: 5 minutes,
`--now` and "Drain now" for 0.)
