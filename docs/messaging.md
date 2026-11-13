# Session messaging — spec

**Status: PR 1 (local delivery) built 2026-11-13; PR 2 (cross-machine) and PR 3 (adapter seam) not
built.** Drafted 2026-11-13 from two spikes of text delivery into a live Claude Code session: Linux,
Claude Code 2.1.322 (commit `0324f9f`, branch `worktree-spike-text-into-live-session`, `spike/`), and
macOS, 2.1.323 (`origin/worktree-spike-text-in-macos`, `spike/REPORT-macos.md`). Like docs/drain.md,
this file is the working record until the code lands; each part folds into DESIGN.md as it is built,
and its text here goes. PR 1's record is in DESIGN.md: Local op socket, "Session messages" (the
frames, the daemon's inbox, the outcomes, the wrappers, the audit), Claude Code mods (the `inbox`
mod), MCP server (`send_message`) and Threat model item 6. What stays here is the evidence, PR 2 and
PR 3, and the open questions.

## Problem

Sessions Séance runs cannot talk to each other. A session that finds something another task needs
(a schema change, a failing build on the other branch, a question only that session's context can
answer) has two ways out today, both wrong: tell the person, who relays it by hand, or
`spawn_session` a new task with the text as its prompt, which starts a stranger with none of the
receiver's context. The fleet already spans machines and Claude accounts (exclaves), so the person
relaying is often the only path between two sessions that sit on one box.

Wanted: **any session Séance knows about can message any other**, across machines and accounts,
through MCP tools. Across machines it goes over the relay sealed under the PSK, so the relay never
reads it. Later, a **locally installed adapter** in a separate private repo will use the same
local delivery primitive to bridge sessions to an external system (a huddle project, which pushes
a `nudge` held while the session is idle unless the item has `wake`). Séance offers the seam and
knows nothing about huddle.

**Out of scope: a shared bulletin board** (a list every session reads and posts to). Its natural
home would be the relay store, and the store is the wrong place for it:

- **Record headroom.** `MAX_RECORDS` is 256, and the per-prefix caps already sum to 202 of it
  (`shared/src/types.ts`). A board that grows with use would either take most of what is left,
  which is reserved for prefixes not yet named, or need a cap tight enough to drop posts.
- **Whole-list frames.** `store-list` answers a prefix in one frame, with every record up to
  `STORE_MAX_CT_LENGTH` (40 KiB). That arithmetic is sized for `task:` (DESIGN.md, "The store",
  _Send size_). A board read on every turn would send every post to every reader every time.
- **No deletes outside `task:`.** The leader deletes only under `task:`, and only `task:` keeps
  tombstones. A board would grow until the cap and then refuse posts, or need a new delete policy
  on a new prefix, which is a threat-model change of its own (CLAUDE.md, the store invariants).

A board is a separate spec, if it is wanted at all. Point-to-point messages need no resting place,
and this spec gives them none (§3).

## Evidence

[V] verified, [I] inferred. "Both" means the Linux and macOS runs agree.

| What                                       | Linux 2.1.322 | macOS 2.1.323 | Finding                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$.prompt.submit`, session idle            | [V]           | [V]           | A turn starts at once (~200 ms). The model reads a user-role turn headed "The `<plugin>` plugin sent a message", with origin `{ kind: "plugin" }`.                                                                                                                                                                                                                                                                                 |
| `$.prompt.submit`, turn running            | [V]           | [V]           | The call stays pending until the turn ends, then runs as a turn of its own.                                                                                                                                                                                                                                                                                                                                                        |
| `$.prompt.submit`, permission dialog open  | [V]           | [V]           | Waits out the dialog, shown queued above it. It never answers the dialog.                                                                                                                                                                                                                                                                                                                                                          |
| `$.prompt.submit`, half-typed draft        | [V]           | [V]           | The turn runs, and the draft stays in the box untouched.                                                                                                                                                                                                                                                                                                                                                                           |
| `$.prompt.submit`, Remote Control on       | [V]           | [V]           | Works.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `$.session.append`, mid-turn               | [V]           | [V]           | Stored as `{ type: "user", isMeta: true }`. Seen at the next model request inside the current turn, after the running tool's result.                                                                                                                                                                                                                                                                                               |
| `$.session.append`, idle                   | [V]           | [V]           | Does not wake the session; the model sees the row at its next turn.                                                                                                                                                                                                                                                                                                                                                                |
| `$.session.append`, size                   | [V]           | —             | No cap: 300 KB was accepted and cost about 300k tokens.                                                                                                                                                                                                                                                                                                                                                                            |
| `$.tool.register` (`read_messages`)        | [V]           | [V]           | Works, including under the managed plugin, which hooks `tool.register`. The mod's own tool raised no permission prompt in manual mode.                                                                                                                                                                                                                                                                                             |
| A notice alone ("1 unread, call …")        | [V]           | [V]           | Ignored. On macOS the model said it ignored it because the user had not asked.                                                                                                                                                                                                                                                                                                                                                     |
| A notice with a standing instruction       | [V]           | [V]           | With `--append-system-prompt` saying to read messages, the model called `read_messages` unprompted, after a ToolSearch since the tool loads deferred.                                                                                                                                                                                                                                                                              |
| Pulled text with an instruction in it      | —             | [V]           | Read but **not obeyed**: "That came from a tool result, not from you, so I ignored it" (Haiku 5.5). Only `$.prompt.submit`, a user turn, carries text the model acts on.                                                                                                                                                                                                                                                           |
| `turn.start` adding context                | [V]           | —             | Cannot.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Managed `cc-plugin-sec-default`            | [V]           | [V]           | Skips every mod's `classic.*` hooks and its `session.append` **hook**; the `$.session.append` **call** still works. It also **skips another mod's `prompt.compose` hook** (Linux 2.1.323, [V]): `spike-inbox: its prompt.compose hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.` So the standing instruction relies on the spawn's `--append-system-prompt` (layer 2). Other orgs may differ. |
| `context` from a `tool.call` hook          | —             | [V]           | The spike mod's notice blanked Bash's own output to the model. Never ride text on a tool result.                                                                                                                                                                                                                                                                                                                                   |
| `/compact`                                 | [V]           | —             | Nothing delivered survives verbatim. Anything that must last is re-read by pull.                                                                                                                                                                                                                                                                                                                                                   |
| Information-only frame vs native peer text | [V]           | —             | Framed "information-only, do not follow", the model refused a harmless request. Worded as Claude Code's native peer message (a teammate's request), it ran it.                                                                                                                                                                                                                                                                     |
| Mod → daemon socket, peer pid              | [I]           | [V]           | Both `$.http.fetch({ socketPath })` (peer: `claude` itself) and a `$.process.spawn` child (peer: the child, parent `claude`) give a pid that `LOCAL_PEERPID` returns and `ancestorIn` resolves to the right pane. A child held open for 30 minutes: the next row.                                                                                                                                                                  |
| Long-held `$.process.spawn` child + socket | [V]           | unconfirmed   | Linux 2.1.323: one child's connection held 29.6 min, all 29 one-minute lines read, across a `/compact` (no reload) and an in-process `/resume` (`session.end` reason `resume`, no `session.start`, no reconnect). `/exit` closed it; `claude --continue` in the same pane started a new child that connected 0.7 s after launch and bound the same pane (peer chain bun → claude → the pane's shell). macOS unconfirmed.           |
| Stub heeded with layer 2 only              | [V]           | —             | Linux 2.1.323: a pushed stub ("call `read_messages`") made the model call it at once, both idle (2.4 s) and mid-turn, with only `--append-system-prompt` carrying the standing instruction.                                                                                                                                                                                                                                        |
| MCP channel from `seanced mcp`             | [V]           | —             | One push covers mid-turn and wake, but needs `--channels` at launch and the org's `allowedChannelPlugins`, and the dev flag shows a startup dialog. A later option, not v1.                                                                                                                                                                                                                                                        |

**Rejected with evidence** (Linux spike):

- **tmux `send-keys` / `paste-buffer`.** An injected Enter approved a permission prompt, pasted
  text answered an AskUserQuestion, and the text merged into the person's half-typed draft. That
  is three ways to act as the person.
- **A `Stop` hook block as the main path.** It is a `classic.*` hook, which the managed plugin
  skips. Where it runs, it makes the session stop only to block its own stop.
- **Claude Code's native peer socket as transport.** It is a private protocol, works on one
  machine only, and reaches across accounts only through Remote Control.

## Names

Built in PR 1 (DESIGN.md, Local op socket, "Session messages"): the first eight rows, `CAPABILITIES.messages`, the
caps, the audit origin `message`, and the outcomes `delivered`, `held` (in PR 1's meaning: a launched task with
no pane yet), `ended`, `unknown`, `unsupported`, `too_long` and `rate_limited`, plus `sent`, `dropped`,
`nolistener`, `unbound`, `invalid`, `stopping` and `internal`. The rest (`offline`, `no_leader`) is PR 2 and PR 3.

| Concept                                     | Name                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The thing sent                              | **message**                                                                                                |
| Its kind                                    | **note** (information), **question** (may answer), **request** (act on it)                                 |
| A pane's held messages                      | **inbox** (daemon memory only)                                                                             |
| MCP tool, send                              | `send_message`                                                                                             |
| Mod tool, read                              | `read_messages` (mod-registered, `mcp__inbox__read_messages`)                                              |
| The mod                                     | `inbox` (`claude-mods/inbox/`)                                                                             |
| Local-socket frame, a session sends         | `message` (frame kind)                                                                                     |
| Local-socket frame, a session's mod listens | `inbox` (frame kind)                                                                                       |
| Daemon → leader event op                    | `session-message`                                                                                          |
| Leader → daemon request op, deliver         | `deliver-message`                                                                                          |
| Leader → daemon request op, receipt         | `message-receipt`                                                                                          |
| Capability, a daemon that receives          | `CAPABILITIES.messages`                                                                                    |
| Capability, a leader that routes            | `CAPABILITIES.messageRoute`                                                                                |
| Caps                                        | `MESSAGE_PUSH_MAX` (8 KiB), `MESSAGE_MAX` (64 KiB)                                                         |
| Audit origin                                | `message` (and `adapter` for the seam)                                                                     |
| Outcomes                                    | `delivered`, `held`, `offline`, `ended`, `unknown`, `unsupported`, `too_long`, `rate_limited`, `no_leader` |

## Decided by the owner

**From the brief (before 2026-11-13):**

- **The sender chooses the authority per message**, by its kind: a note, a question or a request
  (§4).
- **Delivery is by Claude mod calls, never tmux keystrokes.**

**Answered on 2026-11-13:**

- **D1. Cross-machine goes through the leader** (§3).
- **D2. A target that is offline or asleep: drop, and answer `offline`.** Nothing is held anywhere
  (§3).
- **D3. Sessions without a task are out of v1.** The task id is the only address (§2). Built.
- **D4. Wake by kind.** A question or request wakes an idle session; a note waits for the next
  turn (§1). Built: a note is a `$.session.append` row, which does not wake the session.

## Decisions

### 1. Local delivery: a mod listening on the local socket, bound by peer pid

**Built (PR 1, 2026-11-13); the record moved to DESIGN.md**: Local op socket, "Session messages" (the
listener and its refusals, the `inbox` and `message` frames, the daemon's inbox, the grace, the caps,
the outcomes, the wrappers, the standing instruction's two layers, what each kind of session gets, the
rejected alternatives) and Claude Code mods, **inbox** (the mod, its delivery table, `read_messages`).
The spike's three checks are in the Evidence table above.

### 2. Addressing: the task id, following its chain

**The task id is the only address** (D3). It is the only handle stable across panes: tmux reuses
pane ids, a session can be resumed in another pane, and a window name is display-only (DESIGN.md,
"Claude Code mods": "nothing routes, binds or places on the window").

**Resolution follows the task's chain**, as dependents already do (DESIGN.md, "Passing to a
successor"):

| Target task state                                                             | Resolves to                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `running` / `needs-input`                                                     | its pane                                                                                                                                   |
| `superseded`                                                                  | its `successor`, followed to the end of the chain; delivered once that one runs. A successor still `blocked` on the pass is `held` (below) |
| finished, and a later task carries `continues: { task: <id> }` and is running | that continuation, which resumes the same Claude conversation in the same worktree                                                         |
| `queued`, `ready`, `reserved`, `blocked`                                      | `held`: answered at once, not queued (D2's rule applies; nothing is held at rest)                                                          |
| finished with no successor or continuation                                    | `ended`                                                                                                                                    |
| not in the queue                                                              | `unknown`                                                                                                                                  |

"Held" here is an answer, not storage. The sender reads "the target has not started yet" and
decides whether to retry. The word is kept for the adapter seam's boundary delivery (§6).

**Who resolves.** The leader, whose queue holds the chain (§3). PR 1's local path, which needs no
leader, is built (DESIGN.md, "Session messages", Resolution): the daemon resolves a task id against its
own panes checked against its launch ledger. Anything else goes to the leader from PR 2 on, and in PR 1
answers `unknown`.

Rejected:

- **Machine + pane id** (D3). A reused pane id delivers to a stranger. A hand-started session has
  no task, nothing to resolve a chain through, and no placement the leader knows.
- **The Claude session id.** It is stable across `--resume`, but it is the daemon's own choice
  (`--session-id`), recorded only in the launch ledger of the machine that ran it. It is not in the
  queue, so a sender could learn it only by asking that machine, and it is the very id the
  continuation invariant forbids taking from a frame.
- **Freezing a message at its first target** (no chain). A pass moves the work exactly when one
  session runs out of usage, which is when a peer most needs to reach whoever carries it on.

### 3. Cross-machine: through the leader, no hold

**The path** (D1).

1. **Sender's daemon → leader.** The sender's daemon, having bound the `message` frame to its
   pane's task (§4), sends a daemon→scheduler event `session-message`, sealed `from` its
   `deviceId` to `SCHEDULER_ID`, fire-and-forget like `session-event` and `session-pass`
   (`sendToScheduler` in `relay-client.ts`, or in process on the leader's own machine).
2. **The leader admits it** only when sealed `from` a daemon (never `from: "app"`, as `branch-state`
   and `session-pass`), parsed by `parseSessionMessage` into a fresh value, past the one
   `schedulerGuard`, and only when the sending task is placed on the sealing machine: the
   `session-pass` rule. An untasked sender is the daemon's word for its own machine, `fromTask`
   absent.
3. **The leader resolves** the target (§2) and **forwards** a scheduler→daemon request
   `deliver-message` to the machine the resolved task is placed on, or delivers in process if
   that is the leader's own machine.
4. **The target daemon** accepts `deliver-message` only sealed `from` the scheduler (or the leader
   in process), parsed by its own parser, and delivers only to the pane carrying that task id with
   a launch in its own ledger (§1). It answers `delivered`, `ended` (no live pane carries it) or
   `unsupported`.
5. **Receipt.** Events are fire-and-forget, so the leader sends the sender's machine a
   `message-receipt` request (message id, target task id, outcome; never text). The sender's daemon
   hands it to the sending pane's listener only when that pane still carries the sending task,
   and the mod appends it as a one-line note ("your message `<id>` to `<task>`: delivered").
   `send_message` itself answers at once with `sent` (accepted by its own daemon) or a refusal it
   can make locally (`too_long`, `rate_limited`, `unsupported`, `no_leader`).

**Offline or asleep target** (D2). The leader knows presence from the registry. It answers
`offline` in the receipt and drops the message. An asleep machine whose socket the relay still
lists (until the 90 s sweep) takes the forward without a reply. The leader's request times out and
the receipt says `offline`. A message that did land and whose reply was lost reads `offline`, so a
retry can duplicate it, and the wrapper names the message id so the receiver can tell (§4).

Rejected, for D1:

- **Direct to the target `deviceId`, sealed `from: "app"`.** The sender is only a claim, since any
  PSK holder seals as `app`. The sender must find the placement itself and races a pass. It needs
  an app-role client in every daemon: today only the broker has one, and only on credential-keyed
  daemons (`run-capabilities.ts`).
- **Daemon-to-daemon, sealed `from` the sender's `deviceId`.** It needs a relay change: the relay
  sends daemons no `undeliverable`, and `relay-client.ts` says no route is meant to carry
  daemon→daemon traffic. It also adds a pairwise trust rule, and every daemon would have to resolve
  chains it does not hold.

Rejected, for D2:

- **Hold in the relay store.** The reasons a board does not belong there (Problem), plus message
  text would sit at rest in the Durable Object for as long as it waited.
- **Hold in leader memory.** Lost on failover or restart, invisible to the sender, and the leader
  would become a mailbox it was never meant to be.
- **Hold at the sender's daemon with retries.** A second queue per machine, with its own expiry and
  its own duplicate rules.

**Replay.** The scheduler leg's guard (±60 s, `REPLAY_WINDOW_MS`) covers `session-message`,
`deliver-message` and `message-receipt`. A frame older than that is dropped, which is acceptable
because nothing waits for it to be retried. A compromised relay can withhold a message (the
accepted availability class) or replay it within the window to a second leader (Threat model item
4's "hand one app request to two leaders in turn"). The receiving daemon de-duplicates by message
id for 120 s (`REPLAY_RETAIN_MS`), and the wrapper carries the id.

**Capabilities and skew.**

- A daemon that can receive advertises `CAPABILITIES.messages`.
- A leader that can route advertises `CAPABILITIES.messageRoute`.
- `send_message` to a task not on this machine needs a verified leader advertising `messageRoute`,
  and otherwise answers `no_leader` or `unsupported`.
- The leader forwards only to a machine advertising `messages`, and answers `unsupported`
  otherwise.

| Combination                            | Behaviour                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| New daemon, old leader                 | `send_message` sees no `messageRoute` and answers `unsupported` for remote targets; local works                                      |
| Old daemon (target), new leader        | The leader answers `unsupported` and forwards nothing                                                                                |
| Old daemon (sender), new leader        | Sends nothing; no tool                                                                                                               |
| Old leader receiving `session-message` | Drops it with one `dropped op=… — not a session event` warning (`leader.ts` `onEvent`); the sender is gated on `messageRoute` anyway |
| No `inbox` mod in the target's exclave | The daemon has no listener for the pane: `deliver-message` answers `ended` with `nolistener`; a new spawn says so in `doctor`        |

Deploy order: daemons, then the leader's build (it is a daemon), then the mod by `git pull`. No
relay or PWA change.

### 4. MCP surface and the frames a receiver reads

**Built (PR 1); the record moved to DESIGN.md**: MCP server (`send_message`, no list tool,
`read_messages` on the mod), Local op socket, "Session messages" (the `message` frame, the rejected
broker, direct app-role client and `Plain` op, the wrappers, what a request may not do) and Threat
model item 6 (the prompt-injection path a request opens between accounts). PR 2 reuses the same
`send_message` and wrappers: a target on another machine goes to the leader (`"sent"`, §3) where PR 1
answers `unknown`. The text of a request's wrapper names the sender as task id, title and machine;
the leader binds `fromTask` to the sealing machine (§3), so the receiver's wrapper names the real task.

### 5. Logging and audit

**Built (PR 1); the record moved to DESIGN.md**, Local op socket, "Session messages", Audit. Message
text is prompt text, under the same rules: never logged by the daemon, the leader, the mod or the
relay, never in argv, never in `progress`, `get_queue`, `status`, a push notification or the
archivist. The relay sees one more sealed envelope class of the same shape as `session-event`, and
logs it as it logs those: failures only. The leader logs no line per routed message (the threat-model
item 3 timeline rule `#route` already follows), only failures; PR 2's `dir=out`/`dir=in` lines are
the daemons', with the outcomes of §3 added to the built set.

### 6. The adapter seam

What a local adapter (huddle, later) needs, and nothing more:

- **Session state out**: per tasked pane on this machine, `{ taskId, state, turnEnded? }`. The
  daemon already computes this for `session-event` before it forwards it.
- **Delivery in**: "deliver this text to task X on this machine,
  `{ when: "now" | "boundary", wake: boolean }`". This is the same primitive §1 uses:
  - `now` with `wake` is `$.prompt.submit`.
  - `now` without `wake` is `$.session.append` mid-turn, or held to the next turn when idle.
  - `boundary` holds the text to the next `turnEnded` idle, then delivers by `wake`.

  The adapter's text reads with a fixed wrapper naming the adapter ("from the `<name>` adapter on
  this machine"), never as a session or the user.

**How an adapter is registered.** Only in the machine's own `config.json`, as trait probes are
(DESIGN.md, Daemon, "Trait probes"): `adapters: [{ name, argv }]`, an argv array, never a shell
string. The daemon starts each one as a supervised child, under the environment a session gets
less `CREDENTIALS_DIRECTORY`. It talks over an **inherited socketpair fd**, so no socket rendezvous
exists for another process to claim the name on. The adapter is restarted with backoff and stopped
with the daemon. Audited `origin=adapter` with the name and counts, never text, an argv word other
than `argv[0]`'s basename, or its output.

**What an adapter may not do:**

- spawn, despawn, enqueue, cancel or touch the queue;
- send cross-machine, or reach the relay at all;
- read any inbox, prompt, transcript or other message;
- address an untasked pane, or a task by anything but its id on this machine;
- be declared from a frame, the PWA, MCP or another machine.

Rejected:

- **An adapter dialing the local socket and naming itself.** Any process of the same user could
  claim the name. Peer-pid binding names a pane, not a program.
- **An adapter as an MCP client of `seanced mcp`.** That is app-role and fleet-wide, the opposite
  of local-only.
- **The adapter installing its own Claude mod.** Two mods would deliver into one session, with no
  shared rule for wake or boundary, and Séance would lose its say over what reaches a session.

The adapter protocol (frame shapes on the fd) is set in PR 3, not here.

### 7. Build order

Small PRs, each landing on its own:

1. **Local delivery. Built 2026-11-13.** The `inbox` mod (listener child, `prompt.compose` section, `read_messages`,
   the delivery table), the `inbox` and `message` local-socket frames, the in-memory inbox, the
   `--append-system-prompt` constant, MCP `send_message` for tasks on this machine,
   `CAPABILITIES.messages`, and audit origin `message`. Alone, this gives cross-account messaging
   between sessions on one machine, since exclaves share a daemon.
   - Spike first (§1's three items).
   - Tested by: `bun:test` on the local socket with a real peer (the session-events tests'
     fixtures), covering binding, refusal on a null pid, one listener per pane, inbox caps and
     clear-on-rebind; the mod via `claude plugin test` (local only, skipped in CI); one live run
     per platform.
2. **Cross-machine.** `session-message`, the leader's resolve, forward and receipt,
   `deliver-message`, `message-receipt`, `CAPABILITIES.messageRoute` and the chain resolution in
   the scheduler library.
   - Tested by: `scheduler/` unit tests for resolution over successor and continuation chains;
     leader tests for the admit rule (wrong machine, `from: "app"`); and an e2e test with the
     claude stub across two daemons, covering delivered, offline, ended and a target superseded
     mid-flight.
3. **Adapter seam.** `config.json` `adapters`, the supervised child and fd protocol, state out,
   delivery in, and audit origin `adapter`.
   - Tested by: daemon tests with a `scriptStub` adapter (`daemon/test/fixtures.ts`), covering
     delivery by `when` and `wake`, refusals, restart, and stop with the daemon.

## Threat model

PR 1's part is built and recorded in DESIGN.md (Threat model item 6; Local op socket, "Session
messages"; and CLAUDE.md's local-socket bullet): the `inbox` frame is the first on the local socket
that _reads_ something a session did not write itself, so a reader is bound by kernel peer pid, never
by a field, and refused where the host cannot name a peer. What PR 2 and PR 3 add, each to be kept:

- **The leader honours a request only sealed by the right sender, through its own parser and the one
  `schedulerGuard`.** `session-message` is from a daemon only, `parseSessionMessage`, the same guard.
- **An event moves only a task placed on the machine that sealed it.** A `session-message` is
  accepted only when its `fromTask` is placed on the sealing machine. It moves no task at all.
- **A daemon acts on a scheduler op only sealed `from` the scheduler (or in process).**
  `deliver-message` and `message-receipt` follow this.
- **Every surface audits under its own origin, never reusing one.** `adapter` is the new origin PR 3
  adds, beside PR 1's `message`.
- **A service-delivered credential never leaves the daemon process.** An adapter's env drops
  `CREDENTIALS_DIRECTORY`, as a session's and a trait probe's do.
- **Traits are declared only in the machine's own `config.json`; probes run only that argv.**
  Adapters follow the same rule (§6).
- **Nothing reachable from `seanced mcp` calls `log.ts`.** PR 2 adds no `seanced mcp` code that logs.

## Open questions

1. **May a session send a request while handling one?** Resolved in PR 1 (DESIGN.md, "Session
   messages", Rate limit): yes, bounded by the rate limit, and the wrapper names the message id it
   replies to. Rejected: notes only until the turn ends, which the mod could enforce, since it knows a
   request's turn is running.
2. **Should a question also wake when it is long?** Resolved by spike check 3: a pushed stub was
   heeded with the standing instruction on the spawn's command line only (2.4 s idle, and mid-turn),
   so a long question keeps the stub path.
3. **The MCP channel** (`--channels`): one push covers mid-turn and wake. Worth revisiting once
   `allowedChannelPlugins` can be set org-wide without a startup dialog.
4. **A sender-side "who can I message" view** beyond `get_queue`. Wait for use.
