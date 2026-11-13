# Closing a machine and draining it — spec

**Status: spec, nothing built.** Drafted 2026-11-13. Like docs/leaving.md, this file is the
working record until the code lands; each part folds into DESIGN.md (Scheduler, "The library";
Daemon; "Passing to a successor"; PWA; MCP server) as it is built, and its text here goes.

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

| Concept                          | Name                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| The machine's state              | **open** / **closed** (closed = takes no new scheduled work)             |
| Setting it                       | **close**, **reopen**                                                    |
| Moving the work off a closed box | **drain** (the act); a task moved by it is **drained**                   |
| Status key                       | `MachineStatus.cl` (unix ms the machine was closed)                      |
| Route reason                     | `closed`                                                                 |
| Daemon refusal of a spawn        | `machine_closed` (`SPAWN_ERROR_CODES`)                                   |
| App → daemon request op          | `availability` (payload `{ open: boolean; now?: boolean }`)              |
| Successor trigger                | `succeeds.trigger: "drain"`                                              |
| Capabilities                     | `CAPABILITIES.close` (daemon), `CAPABILITIES.drain` (leader)             |
| Audit origin (typed prompt)      | `drain`                                                                  |
| CLI                              | `seanced close [<machine>] [--now] [--wait]`, `seanced open [<machine>]` |
| MCP                              | `set_machine_open { machine, open, now? }`                               |
| PWA                              | "Open for work" switch in the machine's menu                             |

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

- **Set by a request op**, `availability { open, now? }`, sealed `from: "app"` and checked against
  the daemon's replay guard like `sessions`/`despawn`. The daemon writes `closed: { at }` to
  `state.json` (absent when open), then asks the status loop for a fresh status
  (`StatusLoop.refresh`, as the `drn` gate does), so the leader hears it within the relay's floor.
- **`MachineStatus.cl`**: the close time, absent when open; the parser takes a finite positive
  number only. A few bytes against the 1047 budget.
- **Sticky.** A closed machine stays closed across daemon restarts, tmux restarts and reboots until
  someone reopens it. A box you took down for maintenance should not take work again because it
  booted (N2). _Rejected:_ reopening automatically when the daemon starts on a new boot id. Less
  friction after a planned reboot, but it reopens a box you took down because it was broken.
- _Rejected:_ a leader-owned store record (`machine:<deviceId>`). It would let you close an offline
  machine, but it needs a new store prefix (rules, caps, a threat-model entry), and an offline
  machine takes no work anyway. A machine that wakes and takes a task before you can close it is the
  accepted gap. _Rejected:_ a `config.json` field. That is the operator's file, edited on the box,
  read at start, and out of reach from a phone.

### 2. Routing: `closed` is a machine filter, and the daemon gates as well

- **`closed`** joins `draining` as a machine filter on every routing path: pinned tasks,
  `run-now`, continuations and successors included. A pinned task or a continuation (bound to its
  machine's worktree) waits, worded "Waiting: Thad is closed". A successor can never land on the box
  being drained, so a drain needs no `avoid` (D9's "any clone, the old one included" still holds for
  open machines).
- **The daemon's own gate.** A closed daemon refuses a scheduler-sealed spawn `machine_closed`. This
  covers the seconds before the leader hears `cl` and a leader too old to read it. A drain-capable
  leader treats `machine_closed` like `draining`: it drops the reservation and routes again on the
  next tick, without waiting out the reservation TTL.
- **Direct spawns still run.** A spawn the person aimed at this machine (`--now`, the PWA's direct
  pick, Raycast) is their explicit choice; the spawn sheet shows the machine as closed. Closing is
  about what the scheduler does, not about locking the box.

### 3. Closing drains

One switch, as the owner asked: closing a machine also drains it. There is no "close but let
finish" in v1 (open question 1). Reopening stops a drain in progress (§7).

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

**Step B: pass from outside (leader).** A task on a closed machine that is still `running` with no
`successor` `DRAIN_SELF_PASS_MS` (10 min) after `cl`, or at once when step A cannot run (the
machine lacks `successorSelf`), gets the existing `pass` with `trigger: "drain"`. It goes through
the in-flight guard (D15), so it joins a self-pass already under way rather than racing it. This
catches a session that committed but never called the tool, and one idle on a clean tree. Passes
run one at a time per machine, to keep that box's pushes and the relay's write floor bounded. A box
with eight tasks takes eight pushes of a few seconds each.

- **Placement does not gate the pass.** The quota trigger passes only when routing would place the
  successor now. A drain passes regardless: the box is going away, and a successor waiting `ready`
  for a free machine is better than a session that gets killed. The report (step C) says
  "waiting for a machine" when that happens.
- **`needs-input` too (N4).** `trigger: "drain"` lifts the outside paths' `needs_input` refusal
  (D11). Step A has normally moved such a task already; step B covers one whose Esc never brought it
  back to idle. Every other trigger keeps the refusal.
- **Every autonomy level.** The quota trigger moves only `auto` tasks unasked. A drain is the
  person's own act, so `checkpoint` and `steer` tasks are passed too (`successorSpec` already maps
  `steer` to `checkpoint`).
- **Takeover.** The leader stamps `Task.drained { at }` (the close time) before it passes, as it
  stamps `quotaExhausted`, so a new leader does not pass the task twice; the stamp is dropped when the
  task finishes. The guard and step 5's `ok`-with-the-successor already make a second pass harmless.
  The stamp only saves the push.

**Step C: report what did not move.** Nothing below is moved. The person decides: cancel, or shut
down anyway. After a reboot such tasks settle "interrupted" (leaving.md §4) and Continue
resumes them from their worktree once the box is back and reopened.

| Left behind                       | Why                                                                  | Shown as                        |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `mode: "here"`                    | No branch of its own to pass                                         | "Can't move: runs in the clone" |
| A session with no task            | Interactive or direct spawn; nothing to pass                         | "Not a task: close it yourself" |
| A pass refused                    | `dirty_worktree`, `push_rejected`, `default_branch`, … (D11's codes) | the code's existing wording     |
| Successor created, not yet placed | No open machine can take it now                                      | "Moved, waiting for a machine"  |

### 5. Progress, and "empty"

- **One rule for every client.** `drainView(machine, tasks, sessions)` in `shared/src/drain.ts`
  (beside `passOffer`) derives `{ moving, moved, stuck: [{ taskId?, reason }], empty }` from the
  queue reply and the machine's `sessions` reply. The PWA, MCP and the CLI cannot disagree, and the
  leader exposes nothing new.
- **Empty** means no live pane on the machine, tasked or not. That is the bar for "safe to shut down
  or restart tmux"; a closed machine that is empty says so.
- **`seanced close --wait`** blocks until the machine is empty (exit 0) or only stuck items remain
  (exit 2, listing them), so `seanced close --wait && sudo reboot` does what it reads as.

### 6. Leadership

A closed machine keeps leading. The drain's passes need a leader, and moving the term mid-drain only
adds a takeover. It stops leading when it leaves (leaving.md §1 resigns at SIGTERM). If the box you
close is the leader and no other nominee is connected, the queue stops while it is down. The PWA's
confirm sheet says so ("Thad runs the queue; no other machine can take over"). _Later:_ register
without the `lead` role once the machine is empty, if another nominee is connected, so the queue keeps
running through the outage.

### 7. Reopening

The switch back sends `availability { open: true }`, which clears `closed` and `cl`, and routing
places work there again. Tasks already passed stay passed. Reopening mid-drain stops steps A and B
for every task not yet passed: the daemon drops pending prompts and the leader stops on `cl`'s
absence. A prompt already typed stays typed. If that session goes on to pass itself, its successor
may land anywhere, this box included. Harmless.

### 8. Surfaces

- **PWA.** The machine row's menu gets a `MenuSwitchItem` "Open for work" (checked = open), beside
  History. Switching it off opens a confirm sheet that lists, from `drainView`, what will happen:
  "3 running tasks will be passed to other machines, 1 waiting on you will have its question
  dismissed and be passed on, 1 session isn't a task". The
  sheet offers Close (5-min grace) or Drain now. The row then reads "Closed · moving 3 · 1 stuck",
  then "Closed · empty". Offered only when the machine advertises `close` and the verified
  leader advertises `drain`.
- **CLI.** `seanced close [<machine>] [--now] [--wait]` and `seanced open [<machine>]`. With no
  machine argument they act on this machine. They go through the relay as app-role, like
  `seanced pass`, so you can close Thad from the Mac.
- **MCP.** `set_machine_open { machine, open, now? }`, plus `closed` and the `drainView` counts on
  `list_machines`. Closing ends other sessions, so the tool belongs on an explicit allowlist, never a
  default one.
- **Raycast:** none (spawn-only).

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

| Combination                       | Behaviour                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New daemon, old leader            | Routing ignores `cl`; the daemon's gate refuses `machine_closed`. **Verify** how an old leader settles an unknown spawn code (expected: route again after the TTL). The PWA hides the switch. |
| Old daemon, new leader            | No `close` capability, so no switch; routing never sees `cl`.                                                                                                                                 |
| Old PWA                           | `parseMachineStatus` drops `cl`, so a closed machine looks open. Display only: routing is the leader's job.                                                                                   |
| Successor with `trigger: "drain"` | An older leader's `parseSucceeds` holds it unreadable, as with `"quota"`. Only a drain-capable leader writes one.                                                                             |

Deploy order: daemons, then PWA/CLI. No relay change: the op rides the existing request path and
`cl` rides the sealed status.

### 11. Relation to docs/leaving.md

Closing is what you do before the box goes; `leaving` is the note it sends as it goes. A drained,
empty box that then shuts down sends `leaving { r: "shutdown" }`, and nothing is interrupted. A box
shut down mid-drain gets leaving.md's handling for whatever was left. The daemon's launch gate for a
restart (`drn`) is unchanged and independent: a closed machine that restarts still closes its gate
for the restart, and reopens it closed.

### 12. Measures

From audit and leader logs, with no new storage: drains per week (`availability` request lines with
`open=false`); tasks moved per drain by step (`trigger=drain` pass lines, with the self path told
apart by the daemon's `origin=successor` push); stuck items by reason; time from close to empty
(logged by the daemon when `drainView` first reads empty after a close).

## Build order

Each PR lands on its own; ship without a soak in between.

1. **Close.** Daemon state and `availability` op, `cl` in status, the `closed` filter and
   `machine_closed` gate, PWA switch and badge, CLI `close`/`open`, MCP. Useful alone: no new work
   lands, and running work finishes in place.
2. **Drain, step B and C.** Leader outside pass with `trigger: "drain"`, `Task.drained`,
   `drainView`, the confirm sheet's list, `--wait`.
3. **Drain, step A.** `DRAIN_PROMPT`, the turn-end typing and the interrupt, the `session-pass`
   drain mark, the `needs-input` Esc, the audit origin. Spike first, on a live session: typed text
   plus Enter at a `turnEnded` idle is taken as a new turn; the draft-clearing sequence never exits;
   Esc on a permission dialog and on an AskUserQuestion both end the turn with a `turnEnded` idle.

## Open questions

1. **"Close, let finish" as a second mode?** Proposed: not in v1. Step A is gentle already: it waits
   for the turn to end. A cordon-only mode is a flag away later if wanted.
2. **Default grace before interrupting a turn.** Proposed: 5 min, with Drain now / `--now` for 0.
