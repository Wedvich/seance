# Closing a machine and draining it — what is left of the spec

**Status: build order items 1 (Close), 2 (the leader's outside pass and the report) and 3 (the session ask)
are built** and recorded in DESIGN.md, "Closing a machine", "The drain's outside pass" and "The drain's session
ask", as are §6's close warning, §12's time-to-empty line and the soft close by default (N5: the wire, daemon and
leader, and the PWA's, `seance close`'s and MCP's surfaces), and so is §6's "Later" (a closed, empty machine leads
only as a fallback). Every part is built. This file keeps the index of names, the decisions the owner made, §11 and
§12's list of measures (every one now read from a line that exists). Drafted 2026-11-13. Like docs/leaving.md, it is the working record until the code lands; each part folded
into DESIGN.md as it was built, and its text here went.

Scope: something the owner sets ahead of time. Not the SIGTERM path; docs/leaving.md is what happens when the box
actually goes, and the two are complementary (§11).

## Names

| Concept                          | Name                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The machine's state              | **open** / **closed** (closed = takes no new scheduled work)                                                                                                                                                          |
| Setting it                       | **close**, **reopen**                                                                                                                                                                                                 |
| Closing without draining (N5)    | **soft close**: the default close where the target and the verified leader advertise `softClose`; nothing running is asked, interrupted or passed until the owner drains                                              |
| Starting the drain later (N5)    | **Drain** (ask, then pass, after the grace) and **Drain now** (no grace), on a closed machine: a plain or `now` `availability` close; Drain now on a draining machine only until its interrupt deadline               |
| Drain start                      | `MachineStatus.dr` (unix ms the drain began; only beside `cl`), `closed.drainAt` in `state.json`, `drainStart` (`shared/src/status-reader.ts`)                                                                        |
| Soft close on the wire           | `availability { open: false, soft: true }`; capability `softClose` (daemon honours it and reports `dr`; leader drains from `drainStart`)                                                                              |
| Moving the work off a closed box | **drain** (the act); a task moved by it is **drained**                                                                                                                                                                |
| Status key                       | `MachineStatus.cl` (unix ms the machine was closed)                                                                                                                                                                   |
| Route reason                     | `closed`                                                                                                                                                                                                              |
| Daemon refusal of a spawn        | `machine_closed` (`SPAWN_ERROR_CODES`)                                                                                                                                                                                |
| App → daemon request op          | `availability` (payload `{ open: boolean; now?: true; soft?: true }`)                                                                                                                                                 |
| Successor trigger                | `succeeds.trigger: "drain"` (the leader's outside pass, and a session's own pass marked `drain` from a closed machine)                                                                                                |
| Capabilities                     | `close` (daemon), `drain` (leader routes), `drainPass` (leader passes), `drainAsk` (daemon asks and honours `now`), `softClose` (daemon honours `soft` and reports `dr`; leader drains from `drainStart`) — all built |
| A closed, empty machine's lead   | signed role **`fallback`** beside `scheduler`: the relay nominates it only while no other nominee is connected                                                                                                        |
| Audit origin (typed prompt)      | `drain`                                                                                                                                                                                                               |
| CLI                              | `seance close [<machine>] [--drain] [--now] [--wait]` (soft unless `--drain`; `--now` implies it), `seance open [<machine>]`                                                                                          |
| MCP                              | `set_machine_open { machine, open, drain?, now? }` (`drain` and `now` `true` only; `now` implies `drain`)                                                                                                             |
| PWA                              | "Open for work" switch in the machine's menu; the close sheet's Close (soft), "Close and drain" and "Drain now"; "Drain" and "Drain now" in a closed machine's drain row and menu                                     |

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

- **N5. A close is soft by default** (answers the open question "Close, let finish as a second mode?" the other
  way round). Closing stops new scheduled work and nothing else. The drain (the session ask, then the leader's
  outside pass) starts only when the owner presses **Drain** or **Drain now** on the closed machine, or closes
  with either. Why: most closes mean "stop giving this box work", not "this box is going away now"; a pass costs a
  fresh session rebuilding its context from a branch and a record, and the box actually going away is
  docs/leaving.md's SIGTERM path. Today's close becomes the **Drain** step unchanged (ask at the turn end, Escape
  at 5 minutes, pass at 10), and "Drain now" keeps its meaning.

## Where each part went

One line each; the text is in DESIGN.md.

- **§1 Closed is the daemon's own state, §2 routing and the gate, §3 closing drains, §7 reopening, §10 skew:**
  "Closing a machine".
- **§4 The drain: ask, then pass, then report.** Step A (the session ask, with its two spikes): "The drain's
  session ask". Steps B and C (the outside pass, the report): "The drain's outside pass".
- **§5 Progress, and "empty":** `drainView` in `shared/src/drain.ts`, "The drain's outside pass".
- **§6 Leadership** (a closed leader keeps leading until empty; the close sheet's, `seance close`'s and
  `set_machine_open`'s warning, a soft close's included) and its "Later" (once empty, it registers with the signed
  role `fallback` and the relay prefers any other connected nominee): "Closing a machine".
- **§8 Surfaces:** PWA switch, close sheet, drain row, `seance close`/`open`, MCP `set_machine_open` and
  `list_machines`' `drain`: "Closing a machine", "The drain's outside pass" and "The drain's session ask" (`now`,
  "Drain now", the ask's wording). Raycast: none (spawn-only).
- **§9 Threat model:** the invariants list ("Closing is the owner's act", "The drain's session ask is constant
  keys…") and `CLAUDE.md`.
- **§12's time from close to empty:** "The drain's outside pass" (the daemon's `drain: empty` line).
- **§13 Soft close by default (N5):** the wire, daemon and leader in "Closing a machine" (state, `soft`, `dr`, skew
  and the daemon-rollback hazard), "The drain's outside pass" (`drainStart`) and "The drain's session ask" (the ask
  keyed off the drain's start); the client offer and its gate, the PWA's sheet, row and menu, `seance close
  --drain` and MCP `drain` in "Closing a machine" (Capabilities, Surfaces); `drainView`'s soft state and its idle
  source in "The drain's outside pass"; Drain now's bound in "The drain's session ask".
- **Build order:** items 1 to 3 are built, in that order, each in its own PR; the soft close after them, in two;
  §6's "Later" last.

## Kept here

### 11. Relation to docs/leaving.md

Closing is what you do before the box goes; `leaving` is the note it sends as it goes. A drained, empty box that
then shuts down sends `leaving { r: "shutdown" }`, and nothing is interrupted. A box shut down mid-drain gets
leaving.md's handling for whatever was left. The daemon's launch gate for a restart (`drn`) is unchanged and
independent: a closed machine that restarts still closes its gate for the restart, and reopens it closed.

### 12. Measures

From audit and leader logs, with no new storage: drains per week (`availability` lines with `outcome=closed`
without `soft=true`, plus `outcome=drain_started`); tasks moved per drain by step (`trigger=drain` pass lines, with the self path told apart by the
daemon's `origin=successor` push and the ask by its `audit drain` lines); stuck items by reason; time from close
to empty (the closed daemon's `drain: empty cl=… after_ms=… peak=…` line, `grep 'drain: empty'` in its log; one
per `cl` per process, so fold repeats by `cl`: DESIGN.md, "The drain's outside pass"; on a soft close, with no drain running, it measures the sessions' own finish from `cl`: read it beside the `soft=true` availability line).

(The earlier second question, the default grace before interrupting a turn, is settled and built: 5 minutes,
`--now` and "Drain now" for 0.)
