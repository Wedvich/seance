# Closing a machine and draining it — spec

**Status: build order items 1 (Close) and 2 (the leader's outside pass and the report) are built** and
recorded in DESIGN.md, "Closing a machine" and "The drain's outside pass"; §1, §2, §3, §4 steps B and C,
§5, §7, the PWA/CLI/MCP half of §8, §10 and §12's measure are pointers to them. Item 3 (step A, the
session ask) is spec only. Drafted 2026-11-13. Like docs/leaving.md, this file is the working record
until the code lands; each part folds into DESIGN.md as it is built, and its text here goes.

## Problem

Taking a box down today means one of two bad options. Waiting for its sessions to finish can take
minutes to hours. Killing them settles each task `session_closed` (or, once docs/leaving.md lands,
"interrupted"), and the work waits for that box to come back. Meanwhile the scheduler keeps
placing new work there, unless every queued task is given `avoid` by hand.

The pieces to do better exist. A pass moves unfinished work to a successor on another machine or
account (DESIGN.md, "Passing to a successor"), and routing already has machine filters
(`draining`, `dark_wake` in the leaving spec). What is missing:

- a machine-level **"no new work here"** that the owner sets and that survives a daemon restart;
- a way to **move the work already there** to other machines, without waiting for it to finish.

Use cases: "I need to shut down Thad", "I need to restart the tmux server on the Mac", "WSL is
about to update". In each, the owner wants to say so once, see the work move, and know when the
box is empty.

Scope: something the owner sets ahead of time. Not the SIGTERM path; docs/leaving.md is what
happens when the box actually goes, and the two are complementary (§11).

## Names

| Concept                          | Name                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The machine's state              | **open** / **closed** (closed = takes no new scheduled work)                                                    |
| Setting it                       | **close**, **reopen**                                                                                           |
| Moving the work off a closed box | **drain** (the act); a task moved by it is **drained**                                                          |
| Status key                       | `MachineStatus.cl` (unix ms the machine was closed)                                                             |
| Route reason                     | `closed`                                                                                                        |
| Daemon refusal of a spawn        | `machine_closed` (`SPAWN_ERROR_CODES`)                                                                          |
| App → daemon request op          | `availability` (payload `{ open: boolean; now?: boolean }`)                                                     |
| Successor trigger                | `succeeds.trigger: "drain"`                                                                                     |
| Capabilities                     | `close` (daemon), `drain` (leader routes), `drainPass` (leader passes; built), `drainAsk` (daemon asks; item 3) |
| Audit origin (typed prompt)      | `drain`                                                                                                         |
| CLI                              | `seanced close [<machine>] [--now] [--wait]`, `seanced open [<machine>]`                                        |
| MCP                              | `set_machine_open { machine, open, now? }`                                                                      |
| PWA                              | "Open for work" switch in the machine's menu                                                                    |

Not "unavailable": offline and asleep machines already read as unavailable, and closed is a
choice, not a condition. Not "draining" for the state: `drn` is the restart's launch gate
(DESIGN.md, "Restart waits for task launches") and means something else. Not "cordon": correct
in Kubernetes, jargon everywhere else.

## Decisions

**Decided by the owner, 2026-11-13:**

- **N1. Open / closed** are the names (above).
- **N2. Closed is sticky** across restarts and reboots until reopened (§1).
- **N3. O2 stands:** the daemon never WIP-commits for a drain. A dirty tree the session did not
  commit is reported, never forced (§4, step B).
- **N4. A `needs-input` task is interrupted and moved.** The drain is the person's own act, so it
  overrides Q2's "never moved while a person is asked" for `trigger: "drain"` only (§4, step A).

Everything else below is proposed, open to change at build time.

### 1. Closed is the daemon's own state, persisted, advertised in `status`

**Built** (build order item 1): DESIGN.md, "Closing a machine" holds the op, the sticky
`closed: { at }` in `state.json`, `MachineStatus.cl` and the rejected alternatives (a leader-owned
store record, a `config.json` field, reopening on a new boot id). `now?` on `availability` arrives
with item 2; item 1's request carries `open` only, and a daemon of this build accepts `now` and ignores it.

### 2. Routing: `closed` is a machine filter, and the daemon gates as well

**Built:** DESIGN.md, "Closing a machine". Two details differ from the first draft. The leader
tells the daemon it routes closed machines (`SpawnRequest.routesClosed`), and only then does a
closed daemon answer `machine_closed`; to a leader that does not say so it answers `internal_error`,
unrecorded: an older leader fails a task on an unknown refusal code (`verdict`, `settle.ts`), which is why the flag exists, while `internal_error` keeps it reserved until the TTL, when `sessions` proves it never landed and it returns to `ready`. A successor can never land on the box
being drained, so a drain needs no `avoid` (D9's "any clone, the old one included" still holds for
open machines). The gate also looks up a live
pane for the task first and answers `task_running`, so a retry after a lost reply never reads as
closed.

### 3. Closing drains

**Built:** one switch; closing also drains, after the grace (DESIGN.md, "The drain's outside pass"). There
is no "close but let finish" in v1 (open question 1). Reopening stops a drain in progress (§7).

### 4. The drain: ask, then pass, then report

Every task on the closed machine goes through up to three steps. Step A is the daemon's, since it
owns the panes. Step B is the leader's, since a pass is a leader op. Neither needs a new
daemon → leader frame.

**Step A: ask the session (daemon).** For each pane whose launch ledger holds a worktree launch of
a `running` task (a `needs-input` one: below), the daemon types a fixed prompt, `DRAIN_PROMPT`, into
the pane at the pane's next `idle` carrying `turnEnded` (at once if it is already idle). The prompt
tells the session that the machine is closing, asks it to stop where it is, commit everything (a WIP
commit is fine) and call
`pass_to_successor` with a record of where it stands and what comes next, then end its turn. From
there the self path (2b) runs unchanged: the daemon pushes, the leader creates the successor, the
daemon closes the pane at its turn end. The daemon marks its `session-pass` frame for a drained pane
so that the leader writes `succeeds.trigger: "drain"`, not `"session"`.

- **Why ask first.** A session mid-work nearly always has a dirty tree, and an outside pass refuses
  `dirty_worktree` (O2: the daemon never makes WIP commits). The session itself is the only party
  that can commit its work and write a useful record. An outside pass on its own would refuse most of
  a real drain.
- **A long turn.** If the turn has not ended `DRAIN_INTERRUPT_MS` (5 min) after the close, the daemon
  interrupts it with the Esc that the graceful despawn already sends, then types the prompt.
  `--now` (and the PWA's "Drain now") sets that wait to 0 (open question 2).
- **Typing.** A constant string, never text from a frame, sent with `send-keys -l` followed by Enter.
  DESIGN.md rejected `send-keys` for the _seed_ prompt because it put private text in argv and raced
  the TUI's startup. Neither applies here: the text is public and fixed, and the session is live and
  idle. A draft the person left in the input box is cleared first, using the graceful despawn's
  measured key sequence. Never a bare second Ctrl+C, which exits Claude Code.
- **A task waiting on the person (N4).** A `needs-input` pane has no turn to wait for, so the daemon
  sends Esc at once. Esc denies a pending permission and dismisses a question, which ends the turn.
  The prompt is typed only at the `idle` carrying `turnEnded` that follows. **Never while the pane
  is `needs-input`**: Enter on a permission dialog can approve it. No such idle within 30 s means
  the pane is skipped and reported. `DRAIN_PROMPT` asks the session to put the question it was
  waiting on in its record, so the successor asks it again. The self path already accepts a pass
  from a `needs-input` task.

**Spike, 2026-11-13, Claude Code 2.1.323** (a live session in a private tmux server, `-f /dev/null`,
manual permission mode, with a throwaway mod logging the engine's `turn.start`, `turn.complete`,
`tool.check` and `tool.call`, the events the session-events mod reads). All four held:

- **Typed text plus Enter at a turn-ended idle starts a new turn.** `send-keys -l` with a one-line
  508-character prompt (non-ASCII included), then `Enter`: `turn.start` carried the whole text,
  unchanged. The prompt must stay one line: a newline in `-l` text would submit early.
- **The draft-clearing sequence never exits.** The graceful despawn's `Escape`, `C-c` (150 ms apart):
  Esc arms "Esc again to clear", Ctrl+C clears the draft (a single line, a two-line one, and an empty
  box alike) and arms "Press Ctrl-C again to exit", which the typed text disarms. Claude Code stayed up
  in every case; the following prompt reached `turn.start` with no trace of the draft.
- **Esc on a permission dialog** (Bash `touch b.txt`, `decision=ask approver=person`) rejected the
  tool call ("Interrupted · What should Claude do instead?"), the file was not created, and the main
  loop's `turn.complete` followed at once (`reason=answer`, `isAborted=false`): the mod reports that as
  `idle` with `turnEnded`.
- **Esc on an AskUserQuestion** ("User declined to answer questions"): the same, `turn.complete`
  at once (`reason=answer`).
- Also measured: Esc on a busy turn (a long answer, no tools) ends it with `turn.complete`
  (`reason=aborted`, `isAborted=true`), so the interrupt after `DRAIN_INTERRUPT_MS` is followed by a
  turn-ended idle too. Esc on an idle box raises no event at all.

**Step B: pass from outside (leader).** **Built** (item 2): DESIGN.md, "The drain's outside pass" holds
the trigger, the 10-minute grace on every machine (the first draft's "at once when the machine lacks
`successorSelf`" was not built), `needs-input` and every autonomy level, placement not gating the pass,
one pass at a time per machine, the `Task.drained` stamp with its retry and `held`.

**Step C: report what did not move.** **Built** (item 2): the same section; what is left behind (`here`,
an untasked pane, a refused pass, a successor `unplaced`) is shown by the close sheet, the machine's
row, `seanced close --wait` and `list_machines`. After a reboot such tasks settle "interrupted"
(leaving.md §4) and Continue resumes them from their worktree once the box is back and reopened.

### 5. Progress, and "empty"

**Built:** `drainView` in `shared/src/drain.ts`, one rule for the PWA, MCP and `seanced close --wait`
(exits 0 empty, 2 stuck, 1 failure); DESIGN.md, "The drain's outside pass". **Empty** means no live pane
on the machine, tasked or not: the bar for "safe to shut down or restart tmux".

### 6. Leadership

A closed machine keeps leading. The drain's passes need a leader, and moving the term mid-drain only
adds a takeover. It stops leading when it leaves (leaving.md §1 resigns at SIGTERM). If the box you
close is the leader and no other nominee is connected, the queue stops while it is down. The PWA's
confirm sheet says so ("Thad runs the queue; no other machine can take over"). _Later:_ register
without the `lead` role once the machine is empty, if another nominee is connected, so the queue keeps
running through the outage.

### 7. Reopening

The switch back sends `availability { open: true }`, which clears `closed` and `cl`, and routing
places work there again (built: item 1). Tasks already passed stay passed. The leader's half (built:
item 2) stops on `cl`'s absence, and a reopen inside the grace stops the drain before any session is
touched. Item 3's daemon half: reopening drops pending prompts; a prompt already typed stays typed. If
that session goes on to pass itself, its successor may land anywhere, this box included. Harmless.

### 8. Surfaces

**Built** (items 1 and 2; DESIGN.md, "Closing a machine" and "The drain's outside pass"): the PWA's
"Open for work" switch, confirm sheet with counts, and a closed machine's drain row; `seanced close
[<machine>] [--wait]` and `seanced open`; MCP `set_machine_open` with `closed` and `drain` on
`list_machines`. What the sheet still lacks of the first draft: a separate "N waiting on you will have
its question dismissed" line (item 3's Esc) and the "Drain now" button (`now`, with item 3). `--now`
on the CLI and MCP's `now` arrive with item 3 too. Raycast: none (spawn-only).

### 9. Threat model

- **No new power for a PSK holder.** Closing every machine stops the queue, and draining passes every
  task. Both are already possible through `pause` and `pass`/`cancel`. The op is sealed and
  replay-guarded like every other request; `cl` rides the sealed status, so the relay learns nothing.
- **Typing into a pane is a new daemon act**, so it gets an invariant: constant text and Esc only
  (no field of any frame reaches `send-keys`), only into a pane its own launch ledger binds to a
  `running` or `needs-input` task on this machine, the text only at an `idle` carrying `turnEnded`
  and never while the pane is `needs-input` (so the drain can deny a permission but never grant one),
  only while this machine is closed, and audited
  `audit drain origin=drain task=<id> outcome=<typed|interrupted|skipped>`, never the text. It is
  prompt text for a session the same person runs, so it sits under the prompt-injection item
  (Threat model, item 6), like the successor record.
- The leader's step-B pass audits as every pass does: `audit pass task=… successor=… trigger=drain`.

### 10. Skew

**Built:** DESIGN.md, "Closing a machine" (item 1's rows: new daemon with an old leader, old daemon
with a new leader, old PWA) and "The drain's outside pass" ("Skew": a `trigger: "drain"` successor, a
leader rollback). Item 3 adds the daemon's side: `drainAsk` is advertised by nobody until it lands.

Deploy order: daemons, then PWA/CLI. No relay change.

### 11. Relation to docs/leaving.md

Closing is what you do before the box goes; `leaving` is the note it sends as it goes. A drained,
empty box that then shuts down sends `leaving { r: "shutdown" }`, and nothing is interrupted. A box
shut down mid-drain gets leaving.md's handling for whatever was left. The daemon's launch gate for a
restart (`drn`) is unchanged and independent: a closed machine that restarts still closes its gate
for the restart, and reopens it closed.

### 12. Measures

From audit and leader logs, with no new storage: drains per week (`availability` request lines with
`open=false`); tasks moved per drain by step (`trigger=drain` pass lines, with the self path told
apart by the daemon's `origin=successor` push); stuck items by reason. **Not built:** time from close to
empty (logged by the daemon when `drainView` first reads empty after a close); only the first three read
from lines that exist.

## Build order

Capabilities: the names stay `close` and `drain`, but in item 1 `drain` means only "routes around `cl`
and sends `routesClosed`". Items 2 and 3 each add a capability of their own (the leader's outside pass;
the daemon's session ask), so a client gates "Drain now", the per-task counts and `now` on those, never
on `close` or `drain`.

Each PR lands on its own; ship without a soak in between.

1. **Close (built).** Daemon state and `availability` op, `cl` in status, the `closed` filter and
   `machine_closed` gate, PWA switch and badge, CLI `close`/`open`, MCP. Useful alone: no new work
   lands, and running work finishes in place.
2. **Drain, step B and C (built).** Leader outside pass with `trigger: "drain"`, `Task.drained`,
   `drainView`, the confirm sheet's list, `--wait`; recorded in DESIGN.md, "The drain's outside pass".
3. **Drain, step A.** `DRAIN_PROMPT`, the turn-end typing and the interrupt, the `session-pass`
   drain mark, the `needs-input` Esc, the audit origin. Spike first, on a live session: typed text
   plus Enter at a `turnEnded` idle is taken as a new turn; the draft-clearing sequence never exits;
   Esc on a permission dialog and on an AskUserQuestion both end the turn with a `turnEnded` idle.

## Open questions

1. **"Close, let finish" as a second mode?** Proposed: not in v1. Step A is gentle already: it waits
   for the turn to end. A cordon-only mode is a flag away later if wanted.
2. **Default grace before interrupting a turn.** Proposed: 5 min, with Drain now / `--now` for 0.
