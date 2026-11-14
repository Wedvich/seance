# The custodian — spec

**Status: spec; build order items 1 (the nothing-lost rule in `reap` and reap's defaults under a
custodian, now DESIGN.md, Reap, "Nothing lost"), 2 (C15, now DESIGN.md, "Session events"), 3 (the
seat and the round, now DESIGN.md, "The custodian's seat") and 4 (the `custodian` frame with `sessions`,
`close`, `notes` and `done`, the round log, now DESIGN.md, "The custodian frame kind") built and folded
into DESIGN.md. Rounds run on any machine whose config carries the `custodian` key; what is left is the
Machines row, the shell's status verbs, flags, nudge and interrupt (items 5–8).** Decided with the owner on 2026-11-12 and 2026-11-13. Like
docs/messaging.md and docs/leaving.md, this file is the working record until the code lands; each
part folds into DESIGN.md as it is built, and its text here goes.

## Problem

Séance starts sessions and mostly leaves them where they end. What closes a session by itself
today is narrow (DESIGN.md, "Session events", "Reap"): a hand-off or a pass at the turn's end, a
dead task pane, a scheduler cancel. Everything else waits for the owner, per machine, pane by pane:

- **A finished session stays open.** It gave its report, has no question open and waits for
  nothing, and it holds memory until someone types `/exit`. `report_task_done` does not close it
  on purpose ("killing a session on a claim would turn a report into a despawn").
- **Its worktree stays.** Despawn always answers Keep, and `reap` removes a worktree only after
  `minAgeDays` (4) and only when its merged check passes, which misses squash-merged work often
  enough that worktrees pile up.
- **A stuck session stays stuck.** A session waiting on a CI watch whose condition it lost, or
  idle mid-task without a report, sits until the owner asks it what is going on. The needs-input
  alert covers only a session waiting on the owner.
- **Nothing reads a pane's meaning.** Code looks at a live session's screen to spot an exit dialog and,
  since C15, hashes it once a minute to tell a still screen from a moving one; nothing can tell
  "finished" from "waiting" from "hung" by what it says.

The custodian is a cheap agent, one seat per machine, that walks the machine's sessions on a
timer, closes the finished ones, nudges the stuck ones and flags what it cannot settle.

Scope: sessions Séance started on the custodian's own machine. **Not** in scope: sessions on other
machines, routing, any act on a session waiting on the owner, adopting hand-started sessions (a
later spec; §2 keeps it open).

## Names

| Concept                                  | Name                                          |
| ---------------------------------------- | --------------------------------------------- |
| The role, one seat per machine           | **custodian**                                 |
| One run of the agent                     | **round**                                     |
| What a round can do to a session         | **close**, **nudge**, **interrupt**, **flag** |
| What a round leaves for the next         | **notes** (`stateDir()/custodian/notes.md`)   |
| CLI                                      | `seanced custodian <verb>`                    |
| Config key                               | `custodian` in the machine's `config.json`    |
| Capability                               | `CAPABILITIES.custodian`                      |
| Status key                               | `MachineStatus.cu`                            |
| Audit origin                             | `custodian`                                   |
| Local-socket frame kind, the round's own | `custodian`                                   |
| Daemon → leader event op                 | `custodian-event`                             |
| App → daemon request op                  | `custodian` (round now, pause, resume)        |
| Flag reasons                             | `stuck`, `dirty`, `unpushed`, `look`          |
| Verb refusals                            | see §5                                        |

## Decisions

Each is the owner's unless marked _derived_.

### 1. The seat

- **C1–C4.** Built: DESIGN.md, "The custodian's seat".

### 2. Scope

- **C5.** Phase 1 acts only on panes Séance started (`pane.ours`, `daemon/src/sessions.ts`), task
  sessions and untracked spawns alike, plus dead and empty-shell panes among them.
- **C6.** The round's session list (§5) reports every pane in the tmux server, hand-started ones
  marked `foreign`. Every acting verb refuses a `foreign` pane. Adopting hand-started sessions
  later then widens one rule, and no reader changes.
- **C7.** _Derived._ The custodian never acts on its own pane, on a pane carrying a hand-off, pass
  or drain-ask mark (`SessionEvents.marked`), or on a session whose last state is `needs-input`.
  A session waiting on the owner is the needs-input alert's, never the custodian's.

### 3. A round

- **C8–C14.** Built: DESIGN.md, "The custodian's seat".
  C14's due check is narrowed there to the panes C7 allows and a built verb could act on (today: idle since a turn's end), and
  "Round now" and the pause (§9) are not built yet.
- **C15.** Built: DESIGN.md, "Session events", "Per-pane retention and the screen sampler".
- **C16, C17.** Built: DESIGN.md, "The custodian's seat".

### 4. What the agent may do

- **C18–C21.** Built: DESIGN.md, "The custodian's seat". The deny list there is generated, with the additions
  the launch battery found (tmux's shell runners and state setters, `gh`'s further write verbs). C19 is
  what holds under injection, and is the verbs' (item 4, built: DESIGN.md, "The custodian frame kind").
- **C22.** Raw keystrokes into another session's pane are never the custodian's. docs/messaging.md
  rejected `send-keys` delivery on evidence (an injected Enter approved a permission prompt,
  pasted text answered an AskUserQuestion, text merged into a draft); a nudge goes through that
  spec's delivery (§5), and the one keystroke the custodian can cause is the interrupt verb's
  single Escape. This replaces the owner's earlier answer ("raw send-keys allowed"), on the
  owner's review of that evidence, 2026-11-13.

### 5. The verbs

`seanced custodian <verb>` reaches the daemon over the local socket as a new frame kind,
`custodian`, neither a `Plain` nor an `OpName`, so `LOCAL_OPS` and the broker do not change. The
daemon binds the frame by kernel peer pid to the pane carrying `@seance-custodian`, as
`session-event` binds a pane; a frame from any other process is refused `not_custodian`, and so is
every frame on a host that cannot name a peer. A pane is named by its tmux id and re-read at the
moment of the act.

| Verb               | Does                                                        | Refused when                                                                                     |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sessions`         | Lists every pane with the daemon's facts (below)            | —                                                                                                |
| `close <pane>`     | Graceful despawn, then worktree cleanup (§6)                | `foreign`, `marked`, `waiting`, `busy`, `too_soon`, `unobserved`                                 |
| `nudge <pane>`     | Delivers a request message, text on stdin                   | `foreign`, `marked`, `waiting`, `untasked`, `limit`, `once_per_round`, `too_long`, `unsupported` |
| `interrupt <pane>` | Sends one Escape                                            | `foreign`, `marked`, `waiting`, `not_busy`, `too_soon`, `limit`                                  |
| `flag <pane>`      | Marks the session for the owner: a reason, an optional note | `foreign`, `bad_reason`, `too_long`                                                              |
| `notes`            | Replaces the notes file, text on stdin (§7)                 | `too_long`                                                                                       |
| `done`             | Reports the round finished, summary on stdin                | `too_long`                                                                                       |

**Built (item 4): `sessions`, `close`, `notes` and `done`**, DESIGN.md, "The custodian frame kind". The
refusal codes there add `gone` and `invalid` to `close`, `round_done` to `close` and `notes`, `invalid` to
`notes` (an empty text) and `too_late` to `done`, and every verb `not_custodian` and `unsupported`.
`nudge`, `interrupt` and `flag` are items 6 and 8.

- **C23. `sessions`** answers, per pane: tmux id, window name, `ours` or `foreign`, classification
  (`live`, `dead`, `shell`, `starting`, `exit-prompt`, `background-prompt`), last state and how
  long, how long the screen has been unchanged, task id and title, PR URL, worktree path, nudges
  sent, whether it was interrupted, its open flag, and any mark that makes it untouchable. It also
  lists the worktrees `reap` last refused and why (§6), so the round's report says what is holding
  disk. _Built:_ with a task id and no title (a pane's title is the scheduler's), `nudges`, `interrupted` and
  `flag` as placeholders until those verbs exist, and each pane's `close` verdict as it would be answered
  right then, plus when retention began (a pane with no state before it is unobserved, not hung).
- **C24. `close`** is allowed only when the daemon's own facts agree the session is at rest:
  - a `live` pane whose last frame is a turn-ended `idle` (an `idle` carrying `turnEnded`) that
    has stood for `closeAfterMinutes`. A live pane the daemon has no events for is `unobserved`
    and is never closed: the screen alone does not prove a turn ended;
  - a `dead` pane among `ours` at once, with no wait (a `shell` pane is `unobserved`: it is never a session at rest, so `close` refuses it).

  It then runs the existing graceful despawn (`daemon/src/despawn.ts`), audited
  `origin=custodian`. A task session closed this way settles exactly as one the owner typed
  `/exit` into: nothing about task state is the custodian's. _Built, with two additions:_ a `live` pane whose
  input box holds any text, or whose box cannot be found, is `waiting` (the despawn clears the box with
  Escape and Ctrl+C, and nothing else sees a draft: the screen is read with its attributes, so a prompt suggestion,
  which Claude Code draws faint or grey, is not one, and any other text is), and a dead task pane is harvested (its exit status noted, then closed) rather than
  killed.

- **C25. What "finished" means** is the agent's judgement, from the screen and the session's last
  message, within C24's bounds:
  - finished: it gave its final report, has no question open, and waits for nothing it is still
    responsible for. A session waiting only on a merge (auto-merge armed, or it said the merge is
    the owner's) is finished; the leader keeps tracking the PR as it does after a hand-off;
  - not finished: it is still responsible for something (it said it will fix CI if it fails) while
    that thing is in flight.
- **C26. `nudge`** delivers one `request` message through docs/messaging.md's local delivery (the
  `inbox` mod's `$.prompt.submit`), so it can never answer a dialog or touch a draft. The daemon is
  the sender; the receiver reads it as from "the custodian on `<machine>`", in that spec's fixed
  wrapper. The text is the agent's, capped at `MESSAGE_PUSH_MAX`, and says what it observed ("your
  CI run finished 40 minutes ago; check it and continue"). At most `maxNudges` (3) per session and
  one per round, counted by the daemon. Tasked sessions only, as messaging addresses only tasks
  (its D3); an untasked session can be closed or flagged, never nudged.
- **C27. `interrupt`** exists for a session hung inside a command, where a message would wait for
  a turn that never ends. It sends a single Escape, the drain ask's verified key (DESIGN.md, "The
  drain's session ask": Esc on a busy turn ends it and a turn-ended idle follows). Allowed only
  when the last state is `busy`, never `needs-input` (an Escape there would dismiss the owner's
  question), the screen has been unchanged for `interruptAfterMinutes` (30), and at most once per
  session. The agent follows it with a nudge in the same round.
- **C28. Never killed for being stuck.** After `maxNudges` the agent flags the session `stuck` and
  stops. No verb force-closes a busy session, and none requeues or continues a task.
- **C29. `flag`** records a reason from the fixed set and an optional note of at most 200
  characters. `dirty` and `unpushed` are also set by the daemon itself when a close keeps a
  worktree (§6). A flag clears when the session next goes `busy`, or closes with nothing kept.
- **C30.** _Derived._ Nudge and interrupt counts and open flags are the daemon's, persisted in
  `stateDir()/custodian/state.json` (0600) keyed by task id, or by pane for an untasked session,
  and dropped when the session ends. The agent cannot reset them, and they survive a daemon
  restart.

### 6. Worktrees, and what "nothing would be lost" means

- **C31.** A close removes the session's worktree when nothing would be lost. The owner cannot
  recall wanting a closed session's worktree back; the disk is the point.
- **C32. The rule** is built: `nothingLost` in `daemon/src/reap-git.ts`, used by `reap` and by the
  close. Its record, the `gh` lookup's shape included, is DESIGN.md, Reap, "Nothing lost". The close
  adds guards the rule does not know (DESIGN.md, "The custodian frame kind"): the worktree must sit under
  its clone's `.claude/worktrees/`, not have been touched since the turn ended (where a live session's turn end was observed), not be locked by anyone but
  a dead Claude, and have no pane in it.
- **C33.** When the rule fails, the worktree is kept, the session is still closed, and the daemon
  flags it `dirty` or `unpushed`. When the rule cannot be evaluated, the worktree is kept and
  nothing is flagged; `reap` tries again later. _Built:_ the rule's three-way verdict and `reap`'s
  keeping (DESIGN.md, Reap, "Nothing lost"), and the close's keeping and its reply and audit line
  (`kept why=dirty|unpushed|…`). _Not built:_ the flags (item 6): a no-op seam (`onKept`) marks where
  they go.
- **C34.** The local branch is left for `reap`'s merged-branch sweep. A later `continue` of the
  task re-adds the worktree at its old path from that branch (DESIGN.md, "Continuing a session",
  "Re-adding a removed worktree"), so the conversation resumes. That covers pushed-but-unmerged work
  (an awaiting-merge or cancelled task): the sweep keeps an unmerged branch, but takes a merged one
  in the same pass, and the continue is then refused, there being nothing left to resume onto.
- **C35.** Old worktrees with no session in them are `reap`'s, not the agent's: the check is code
  and needs no model. _Built:_ reap's defaults under a `custodian` key (DESIGN.md, Reap, "Surfaces").
- **C36.** _Built:_ the daemon's forge read (DESIGN.md, Threat model, "A daemon reads a forge only
  for reap's nothing-lost rule").

### 7. Notes

- **C37.** One file per machine, `stateDir()/custodian/notes.md`, 0600, capped at 8 KiB. Each
  round gets it in its seed and must write back a folded version through the `notes` verb: what it
  is watching per live session, and a few standing lessons ("this repo's CI takes 25 minutes").
- **C38.** The file is sections keyed by task id or pane, plus one `standing` section. The daemon
  drops the section of any session that no longer exists, and keeps the previous file when a round
  writes none or one over the cap. It cannot grow without bound.
- **C39.** _Derived._ Notes are model-written from untrusted pane text, so they are the one way an
  injection could outlive a round. They are capped, never logged, never leave the machine, and
  `seanced custodian notes --clear` empties them. _Built (C37–C39):_ the `notes` verb and the pruning;
  `--clear` is done by the CLI in the owner's shell, never through the daemon.

### 8. Health

- **C40.** A round is healthy when it called `done` before its deadline. One that was killed at the
  deadline, or exited without `done`, failed.
- **C41.** After three failed rounds in a row the seat is `failing`: the Machines card says so and
  the leader sends one push, and again only after a healthy round and a new run of three. Rounds
  keep being started; a failing seat is not turned off.
- **C42.** _Derived._ The last 20 rounds are kept in `stateDir()/custodian/rounds.jsonl` (0600):
  start, end, exclave, outcome, the daemon's own counts of each verb, and the agent's summary (at
  most 1 KiB). The summary may quote a pane, so it is read only on the machine
  (`seanced custodian log`) and never crosses the wire or reaches a log. _Built (C40, C42's file):_ the
  `done` verb and the log (DESIGN.md, "The custodian frame kind"); `seanced custodian log` is item 5.

### 9. What the owner sees and controls

- **C43. Machines card.** Each machine with the capability gets one row: state (`idle`, `running`,
  `paused`, `failing`), when the last round ended, and what it did ("closed 2 · nudged 1 · flagged
  1"). While a round runs, the row links to its Remote Control session. A machine with no
  custodian configured shows no row.
- **C44. On a task card.** A flagged task shows its flag: the reason, and the note when there is
  one. A `stuck` flag sends one push per flag, with fixed text per reason like every push.
- **C45. Controls**, in the machine card's menu: "Round now", "Pause for 1 hour", "Pause until
  resumed", "Resume". The same at the shell: `seanced custodian round | pause [--for 1h] | resume
  | status | log`.
- **C46.** On, off, the model and every threshold stay in the machine's `config.json` (C2).
- **C47.** _Derived._ How it travels:
  - `MachineStatus.cu` carries the state, the last round's end time and its three counts. It is
    never trimmed by `fitStatus`, like `drn` and `cl`.
  - A flag and the `failing` transition go to the leader as a sealed `custodian-event`. The leader
    honours a flag only from the machine the task is placed on, writes it onto the task record
    (reason, note, time) through the one task sealer, and sends the push. A flag on an untasked
    session stays on its machine and shows only in the card's count.
  - The controls are a `custodian` op, answered only when sealed `from: "app"` on the relay leg,
    parsed by its own parser and audited, like `availability`. Neither `LOCAL_OPS` nor `BROKER_OPS`
    carries it. A pause is persisted in `state.json`; one the daemon cannot read loads as paused.
  - A flag's note is display-only: bounded, never logged, never in a push, and never used to bind,
    route, move or settle anything.

### 10. Audit and logging

- **C48.** Every round start, end and kill, and every close, nudge, interrupt, flag and worktree
  removal, is audited under origin `custodian`, through the one formatter. A line carries the pane,
  the task id and the outcome or refusal code.
- **C49.** Never logged or audited: nudge text, a flag's note, the notes file, a round's summary,
  and anything read from a pane.

## Threat model

To be folded into DESIGN.md's as each part lands. The round as a reader of untrusted text behind a
fenced shell, its pane option and the seat record are folded (DESIGN.md, Threat model).

- **A new reader of untrusted text that can act.** The agent reads every session's screen. Assume
  an injection can make it call any verb with any argument. The bounds are the verbs' own checks:
  a close only of a session at rest for the grace period, with the worktree removed only under
  C32; a nudge only as a message, counted; one Escape, only on a long-unchanged busy session, never
  on one waiting on the owner; a flag, bounded.
- **A wrong close is the worst accepted outcome.** It costs a continuation of the task, never work:
  C32 keeps anything that exists only locally.
- **Nudge text is a new path from one session's output into another's input**, through a model.
  The receiver reads it as a request from the custodian. It is bounded by the count, the cap and
  messaging's wrapper, and it is local to the machine.
- **Notes persist model-written text** (C39).
- **Peer binding.** Only the round's own pane may call the verbs. A same-user process that can
  make itself a descendant of that pane can call them; that process could already type into any
  pane.

## Rejected alternatives

- **The daemon patrols and a headless model only returns verdicts.** Cheapest and tightest, but it
  cannot investigate: telling "CI still running" from "CI finished and the session never noticed"
  needs `gh` and judgement. The owner chose the flexible agent with its acts fenced.
- **A fixed tool set and no shell.** The same objection.
- **A standing, long-lived session, recycled.** Needs recycle rules, a liveness check and carries
  context cost between rounds, to gain only the ability to chat with it. A fresh agent per round in
  a visible pane, with notes, covers it (C8, C9).
- **Raw `tmux send-keys` for nudges** (C22).
- **Nudge, interrupt, then close and requeue.** The one escalation that can burn quota in a loop
  on a task that is stuck for a real reason (C28).
- **Close at once / flag only.** At once leaves no time to reply to a report; flag-only keeps the
  manual round this exists to remove.
- **Always remove the worktree.** Loses uncommitted or unpushed work for good.
- **The agent sweeps old worktrees.** Tokens for a decision code already makes (C35).
- **A fixed account in config, or placement by the leader.** A fixed one burns an account that is
  nearly out; the leader's placement makes a per-machine seat depend on the leader and contradicts
  "not a task".
- **Counting as a session slot / skipping when quota is tight.** A full or tight machine is when
  stuck sessions cost most.
- **Thresholds editable from the PWA.** Per-machine behaviour settable from a frame is what the
  traits rule forbids.
- **A registry role with a relay secret, as the archivist has.** The archivist is one seat per
  fleet that the relay must refuse a second of. The custodian is per machine and local; the relay
  has nothing to enforce.
- **Names.** `janitor` (not the theme), `reaper` (`seanced reap` is a different mechanism, and it
  names only the closing half), `sentinel` and `warden` (the watch without the cleanup), `cerberus`
  (one entity, not a job held per machine), `familiar`, `sexton`, `acolyte`, `nightwatch`. A run is
  a `round`, not a `patrol`.

## Build order

Small PRs, each landing on its own. Milestone 3 waits on docs/messaging.md's PR 1 (local
delivery); nothing else here does.

**Milestone 1 — close and clean**

1. _Built._ The nothing-lost rule (C32–C34, C36) in `reap-git.ts`, used by `reap`, with the new
   defaults under a configured custodian (C35).
2. ~~Per-pane state and screen-change tracking for every `ours` pane (C15).~~ Built 2026-11-13
   (`daemon/src/pane-activity.ts`); its read API is `activity(paneId)`.
3. ~~The seat: config, `CAPABILITIES.custodian`, the due check, the exclave pick, the round's launch
   with its agent definition and fence, the deadline, and audit origin `custodian` (C1–C4,
   C8–C17, C18–C21).~~ Built 2026-11-13 (`daemon/src/custodian-seat.ts`).
4. ~~The `custodian` frame kind with `sessions`, `close`, `notes` and `done`, and the round log
   (C23–C25, C37–C39, C42).~~ Built 2026-11-14 (`daemon/src/custodian-verbs.ts`); rounds are live.
5. `MachineStatus.cu` and the Machines row; `seanced custodian status | log | round | pause |
   resume` at the shell (C40, C43, C45).

**Milestone 2 — flags and controls**

6. `flag`, `custodian-event`, the flag on the task record and card, the `stuck` push, and the
   `failing` push (C29, C41, C44, C47).
7. The `custodian` app op and the card's menu (C45, C47).

**Milestone 3 — nudge and interrupt**

8. `nudge` over messaging's local delivery, and `interrupt` (C26–C28, C30).

## Open details (build time)

- **The live link.** `cu` is in a fixed-size frame; whether the round's Remote Control id rides
  there or in a reply to a card's own request.
- **`unobserved` sessions.** A session in an exclave without the `session-events` mod is never
  closed (C24); `seanced doctor` now warns about it (built). The retained state is per process, so a
  session already at rest when the daemon restarts is `unobserved` too until its next frame; `sessions` says
  when retention began (`retainedSince`), which is how the round can tell, though not why per pane.
- **Prompt suggestions.** `close` reads the box through `capture-pane -e` and ignores faint and grey cells
  (DESIGN.md, "The custodian frame kind"). Measure the attributes a real Claude Code release draws the suggestion
  with: a style the daemon does not list reads as a draft and the session is refused `waiting`, which is safe and
  silent.
- **What "unchanged on screen" cannot see.** The change hash drops Claude's input box and footer and masks
  elapsed timers and the spinner glyph (DESIGN.md, "Per-pane retention"), matched on wording from Claude
  Code 2.1.x. A release that rewords them, or a repaint nobody has listed (a rotating tip, a clock in the
  transcript), moves the hash while the session is hung, so C27's `interrupt` would read it as moving:
  it fails to fire, never fires wrongly. Worth checking against a live busy session when PR 3 or 5 builds
  on it. A resize (another client attaching at another size) moves it too.
