# The custodian — spec

**Status: spec, nothing built.** Decided with the owner on 2026-11-12 and 2026-11-13. Like
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
- **Nothing reads a pane.** No code looks at a live session's screen except to spot an exit dialog,
  so nothing can tell "finished" from "waiting" from "hung".

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

- **C1.** One custodian seat per machine, held by that machine's daemon. It is a daemon capability
  like `reapSchedule` and `traitProbes` (`DAEMON_CAPABILITIES`, `daemon/src/run-capabilities.ts`),
  not a registry role: the relay learns nothing new, and there is no nomination, term or secret.
- **C2.** Off until the machine's own `config.json` carries a `custodian` key. Like traits, it is
  declared only in that file, never from a frame, the PWA or another machine.

  ```json
  "custodian": {
    "model": "haiku",
    "everyMinutes": 15,
    "closeAfterMinutes": 15,
    "roundTimeoutMinutes": 10,
    "maxNudges": 3,
    "interruptAfterMinutes": 30
  }
  ```

  Every field is optional; the values shown are the defaults.

- **C3.** The daemon and the agent watch each other. The daemon starts each round, kills one that
  overruns and reports the seat's health (§8). The agent watches every other session the daemon
  started.
- **C4.** _Derived._ A fleet with no custodian behaves exactly as it does today. Nothing waits on
  a round: the daemon's own closes (hand-off, pass, harvest, drain, cancel) are unchanged and run
  whether the seat is on, off, paused or failing.

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

- **C8.** A round is a fresh Claude session. Nothing carries over in the model's context; what must
  persist is in the notes (§7) and in the daemon's own counters (§5). There is no compaction and no
  recycling rule: a corrupted agent is gone at the end of its round.
- **C9.** It runs in a tmux window in Séance's group, named `custodian`, with Remote Control, so the
  owner can watch a round live or open it from the PWA while it runs. It exits when the round is
  reported.
- **C10.** It is not a task. It has no task id, takes no queue space, holds no session slot and is
  not counted in `MachineStatus.sess`. _Derived:_ its window carries a pane option of its own
  (`@seance-custodian`) so every reader of panes can tell it apart, and it is never a spawn,
  despawn or message target.
- **C11.** Model: the config's `model`, default `haiku`. The instructions are written for a cheap
  model: a short fixed checklist, not open-ended investigation.
- **C12.** Account: per round, the daemon picks the exclave on this machine with the most
  headroom, using the scheduler's own quota scoring over this machine's exclaves (the same
  function, imported, never a copy). An exclave whose auth has lapsed is skipped.
- **C13.** A round always runs when it is due, however tight quota is. It never counts against a
  slot, so it cannot block a task.
- **C14.** When a round is due. The daemon checks once a minute, with no model call, and starts a
  round only when all of these hold:
  - at least one `ours` pane has been idle, or unchanged on screen, for `everyMinutes`;
  - the last round ended at least `everyMinutes` ago;
  - no round is running, the seat is not paused (§9) and the daemon is not restarting (`drn`).

  No sessions, or every session busy and moving, means no round and no tokens. "Round now" (§9)
  skips the first two conditions.

- **C15.** _Derived._ What the daemon keeps per pane to decide this, in memory only: the last
  session state and when it began (session events already reach the daemon for untasked panes
  too; today they are dropped after the `/usage` poke), and when the pane's visible content last
  changed, as a hash sampled each minute. The screen text itself is never kept.
- **C16.** A round has `roundTimeoutMinutes` to report. One that has not is closed through the
  graceful despawn, then killed, and counts as failed (§8).
- **C17.** _Derived._ The seed is a constant plus the notes; the session list comes from a verb,
  not the seed. The constant is shipped in the repo as an agent definition, with the settings that
  fence it (§4).

### 4. What the agent may do

- **C18.** A near-full shell for looking: Bash and Read, with `tmux capture-pane`, `git`, `gh` and
  the like free to use on any path. It can read anything the owner's user can.
- **C19.** Everything that changes a session or a worktree exists only as a `seanced custodian`
  verb (§5), which checks its preconditions in code and audits. The agent's instructions decide
  _whether_; the daemon decides _if it may_.
- **C20.** The shell is fenced against a cheap model's mistakes:
  - the OS sandbox allows writes nowhere but the round's own scratch directory;
  - denied outright: `rm`, `kill`/`pkill`, `git worktree remove`, `git branch -d/-D`, `git push`,
    `git reset`, `git clean`, `git checkout`/`switch`, `git stash`, every `tmux` subcommand that
    types or kills (`send-keys`, `paste-buffer`, `kill-*`, `respawn-*`), `gh` commands that write,
    and every `seanced` command but `seanced custodian`;
  - no Edit, Write, web or MCP tools;
  - a command outside the rules is refused, never asked about (a round has nobody to answer).
- **C21.** The fence is not a security boundary, and the spec does not claim one. Every pane the
  custodian reads belongs to a session that already has a full shell as the same user, so an
  injected custodian gains an attacker little; and a deny list of command prefixes can be worked
  around. What holds under injection is C19: a wrong close, nudge, interrupt or flag is bounded by
  the verb's own checks.
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

- **C23. `sessions`** answers, per pane: tmux id, window name, `ours` or `foreign`, classification
  (`live`, `dead`, `shell`, `starting`, `exit-prompt`, `background-prompt`), last state and how
  long, how long the screen has been unchanged, task id and title, PR URL, worktree path, nudges
  sent, whether it was interrupted, its open flag, and any mark that makes it untouchable. It also
  lists the worktrees `reap` last refused and why (§6), so the round's report says what is holding
  disk.
- **C24. `close`** is allowed only when the daemon's own facts agree the session is at rest:
  - a `live` pane whose last frame is a turn-ended `idle` (an `idle` carrying `turnEnded`) that
    has stood for `closeAfterMinutes`. A live pane the daemon has no events for is `unobserved`
    and is never closed: the screen alone does not prove a turn ended;
  - a `dead` or `shell` pane among `ours` at once, with no wait.

  It then runs the existing graceful despawn (`daemon/src/despawn.ts`), audited
  `origin=custodian`. A task session closed this way settles exactly as one the owner typed
  `/exit` into: nothing about task state is the custodian's.

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
- **C32. The rule**, one function used by the custodian's close and by `reap`:
  1. the tree is clean: no modified, staged or untracked files (ignored files do not count); and
  2. the local tip is safe elsewhere, by either of:
     - it is the tip, or an ancestor of the tip, of its branch on `origin` (fetched first); or
     - GitHub reports a **merged** PR for that branch whose head contains the local tip.

  The second is what squash merging needs: it trusts the PR, not ancestry or a patch-id match, so
  it holds when the default branch has moved on and the remote branch is deleted. `reap`'s existing
  checks (`ancestor`, `squash`, `gone` in `daemon/src/reap-git.ts`) stay as further ways to pass,
  never as the only ones.

- **C33.** When the rule fails, the worktree is kept, the session is still closed, and the daemon
  flags it `dirty` or `unpushed`. When the rule cannot be evaluated (no network, `gh` failing), the
  worktree is kept and nothing is flagged; `reap` tries again later.
- **C34.** The local branch is left for `reap`'s merged-branch sweep. A later `continue` of the
  task then still finds it.
- **C35.** Old worktrees with no session in them are `reap`'s, not the agent's: the check is code
  and needs no model. On a machine with the custodian configured, `reap`'s timer defaults to on
  (every 6 hours) and its untouched age to 1 day instead of 4; an explicit `reap` key still wins.
- **C36.** _Derived, and a threat-model change._ The merged-PR check is a daemon reading a forge,
  which today only the leader does (`readPrHead`, bound to a task's `prUrl`). The daemon's read is
  its own `gh`, argv-array, bound to the worktree's own branch name and `origin`, its values passed
  as variables, its output never logged; it is read-only and decides only whether a worktree on
  this machine is removed. DESIGN.md's threat model gains the entry when it is built.

### 7. Notes

- **C37.** One file per machine, `stateDir()/custodian/notes.md`, 0600, capped at 8 KiB. Each
  round gets it in its seed and must write back a folded version through the `notes` verb: what it
  is watching per live session, and a few standing lessons ("this repo's CI takes 25 minutes").
- **C38.** The file is sections keyed by task id or pane, plus one `standing` section. The daemon
  drops the section of any session that no longer exists, and keeps the previous file when a round
  writes none or one over the cap. It cannot grow without bound.
- **C39.** _Derived._ Notes are model-written from untrusted pane text, so they are the one way an
  injection could outlive a round. They are capped, never logged, never leave the machine, and
  `seanced custodian notes --clear` empties them.

### 8. Health

- **C40.** A round is healthy when it called `done` before its deadline. One that was killed at the
  deadline, or exited without `done`, failed.
- **C41.** After three failed rounds in a row the seat is `failing`: the Machines card says so and
  the leader sends one push, and again only after a healthy round and a new run of three. Rounds
  keep being started; a failing seat is not turned off.
- **C42.** _Derived._ The last 20 rounds are kept in `stateDir()/custodian/rounds.jsonl` (0600):
  start, end, exclave, outcome, the daemon's own counts of each verb, and the agent's summary (at
  most 1 KiB). The summary may quote a pane, so it is read only on the machine
  (`seanced custodian log`) and never crosses the wire or reaches a log.

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

To be folded into DESIGN.md's as each part lands.

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
- **The shell fence is for mistakes** (C21).
- **Notes persist model-written text** (C39).
- **The daemon reads a forge** (C36).
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

1. The nothing-lost rule (C32–C34, C36) in `reap-git.ts`, used by `reap`, with the new defaults
   under a configured custodian (C35).
2. Per-pane state and screen-change tracking for every `ours` pane (C15).
3. The seat: config, `CAPABILITIES.custodian`, the due check, the exclave pick, the round's launch
   with its agent definition and fence, the deadline, and audit origin `custodian` (C1–C4,
   C8–C17, C18–C21).
4. The `custodian` frame kind with `sessions`, `close`, `notes` and `done`, and the round log
   (C23–C25, C37–C39, C42).
5. `MachineStatus.cu` and the Machines row; `seanced custodian status | log | round | pause |
   resume` at the shell (C40, C43, C45).

**Milestone 2 — flags and controls**

6. `flag`, `custodian-event`, the flag on the task record and card, the `stuck` push, and the
   `failing` push (C29, C41, C44, C47).
7. The `custodian` app op and the card's menu (C45, C47).

**Milestone 3 — nudge and interrupt**

8. `nudge` over messaging's local delivery, and `interrupt` (C26–C28, C30).

## Open details (build time)

- **The launch.** Which Claude Code flags carry the agent definition, the permission rules and the
  sandbox, and whether a refused command can be made a refusal rather than a prompt in every
  permission mode. Verify against the current Claude Code docs before PR 3.
- **Where a round runs.** An exclave is decided by the session's path, so each exclave needs a
  directory for a round to start in.
- **Importing the scheduler's scoring.** `scheduler/test/layering.test.ts` lets only the leader's
  modules host the scheduler library. C12 needs the pure scoring function outside them: either the
  test's list grows by the custodian's one module, or the function moves somewhere both import.
- **The live link.** `cu` is in a fixed-size frame; whether the round's Remote Control id rides
  there or in a reply to a card's own request.
- **`unobserved` sessions.** A session in an exclave without the `session-events` mod is never
  closed (C24). Whether `seanced doctor` should warn about it.
- **The `gh` lookup's shape** for C32: by head branch, and how the PR's head is fetched to test
  that it contains the local tip once the remote branch is deleted.
- **A closed machine.** Whether rounds run while a machine is draining. C7 already keeps the
  custodian off any pane the drain has marked.
