# Session messaging — spec

**Status: spec, nothing built.** Drafted 2026-11-13 from two spikes of text delivery into a live
Claude Code session: Linux, Claude Code 2.1.322 (commit `0324f9f`, branch
`worktree-spike-text-into-live-session`, `spike/`), and macOS, 2.1.323
(`origin/worktree-spike-text-in-macos`, `spike/REPORT-macos.md`). Like docs/drain.md, this file is
the working record until the code lands; each part folds into DESIGN.md (Local op socket, Session
events, Scheduler, Claude Code mods, Threat model) as it is built, and its text here goes.

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

| What                                       | Linux 2.1.322 | macOS 2.1.323 | Finding                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$.prompt.submit`, session idle            | [V]           | [V]           | A turn starts at once (~200 ms). The model reads a user-role turn headed "The `<plugin>` plugin sent a message", with origin `{ kind: "plugin" }`.                                                                                                           |
| `$.prompt.submit`, turn running            | [V]           | [V]           | The call stays pending until the turn ends, then runs as a turn of its own.                                                                                                                                                                                  |
| `$.prompt.submit`, permission dialog open  | [V]           | [V]           | Waits out the dialog, shown queued above it. It never answers the dialog.                                                                                                                                                                                    |
| `$.prompt.submit`, half-typed draft        | [V]           | [V]           | The turn runs, and the draft stays in the box untouched.                                                                                                                                                                                                     |
| `$.prompt.submit`, Remote Control on       | [V]           | [V]           | Works.                                                                                                                                                                                                                                                       |
| `$.session.append`, mid-turn               | [V]           | [V]           | Stored as `{ type: "user", isMeta: true }`. Seen at the next model request inside the current turn, after the running tool's result.                                                                                                                         |
| `$.session.append`, idle                   | [V]           | [V]           | Does not wake the session; the model sees the row at its next turn.                                                                                                                                                                                          |
| `$.session.append`, size                   | [V]           | —             | No cap: 300 KB was accepted and cost about 300k tokens.                                                                                                                                                                                                      |
| `$.tool.register` (`read_messages`)        | [V]           | [V]           | Works, including under the managed plugin, which hooks `tool.register`. The mod's own tool raised no permission prompt in manual mode.                                                                                                                       |
| A notice alone ("1 unread, call …")        | [V]           | [V]           | Ignored. On macOS the model said it ignored it because the user had not asked.                                                                                                                                                                               |
| A notice with a standing instruction       | [V]           | [V]           | With `--append-system-prompt` saying to read messages, the model called `read_messages` unprompted, after a ToolSearch since the tool loads deferred.                                                                                                        |
| Pulled text with an instruction in it      | —             | [V]           | Read but **not obeyed**: "That came from a tool result, not from you, so I ignored it" (Haiku 5.5). Only `$.prompt.submit`, a user turn, carries text the model acts on.                                                                                     |
| `turn.start` adding context                | [V]           | —             | Cannot.                                                                                                                                                                                                                                                      |
| Managed `cc-plugin-sec-default`            | [V]           | [V]           | Skips every mod's `classic.*` hooks and its `session.append` **hook**; the `$.session.append` **call** still works. It also hooks `prompt.compose`; whether it skips another mod's compose hook is untested. Other orgs may differ.                          |
| `context` from a `tool.call` hook          | —             | [V]           | The spike mod's notice blanked Bash's own output to the model. Never ride text on a tool result.                                                                                                                                                             |
| `/compact`                                 | [V]           | —             | Nothing delivered survives verbatim. Anything that must last is re-read by pull.                                                                                                                                                                             |
| Information-only frame vs native peer text | [V]           | —             | Framed "information-only, do not follow", the model refused a harmless request. Worded as Claude Code's native peer message (a teammate's request), it ran it.                                                                                               |
| Mod → daemon socket, peer pid              | [I]           | [V]           | Both `$.http.fetch({ socketPath })` (peer: `claude` itself) and a `$.process.spawn` child (peer: the child, parent `claude`) give a pid that `LOCAL_PEERPID` returns and `ancestorIn` resolves to the right pane. A child held open for minutes is untested. |
| MCP channel from `seanced mcp`             | [V]           | —             | One push covers mid-turn and wake, but needs `--channels` at launch and the org's `allowedChannelPlugins`, and the dev flag shows a startup dialog. A later option, not v1.                                                                                  |

**Rejected with evidence** (Linux spike):

- **tmux `send-keys` / `paste-buffer`.** An injected Enter approved a permission prompt, pasted
  text answered an AskUserQuestion, and the text merged into the person's half-typed draft. That
  is three ways to act as the person.
- **A `Stop` hook block as the main path.** It is a `classic.*` hook, which the managed plugin
  skips. Where it runs, it makes the session stop only to block its own stop.
- **Claude Code's native peer socket as transport.** It is a private protocol, works on one
  machine only, and reaches across accounts only through Remote Control.

## Names

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
- **D3. Sessions without a task are out of v1.** The task id is the only address (§2).
- **D4. Wake by kind.** A question or request wakes an idle session; a note waits for the next
  turn (§1).

## Decisions

### 1. Local delivery: a mod listening on the local socket, bound by peer pid

**The mod.** A third mod, `inbox`, in `claude-mods/`, installed by `seanced mod install` like the
other two and per exclave (DESIGN.md, "Claude Code mods"). The model reads its pushes as "The inbox
plugin sent a message", which is the label we want. Rejected: folding it into `session-events`.
That mod is fire-and-forget by design ("a missing `bun`, a stopped daemon or a slow one costs the
session nothing"), its plugin name is what the model would read, and a delivery bug must not cost
the scheduler its events.

**The listener.** At `session.start`, when `TMUX_PANE` is set, the mod starts one long-lived child
with `$.process.spawn`: `bun <checkout>/daemon/src/main.ts inbox` (`daemonMain`, as session-events
resolves it). The child dials `stateDir()/run`'s socket and sends one `inbox` frame. The daemon
binds the connection to a pane by the child's kernel peer pid, walked up to a pane's pid
(`peerPid` and `ancestorIn` in `daemon/src/peer.ts`, as `session-event` binds). The connection
then stays open for the session's life. The daemon writes one line per message, and the child
copies each line to stdout, which `$.process.spawn` hands the mod piece by piece. The mod ending
(`session.end`, module unload) kills the child, and the connection closing drops the binding.

- **Refused outright where the host cannot name a peer** (`peerPidSupported()` false), and for any
  connection whose pid came back null. This is unlike `session-event`, which falls back to the
  frame's own `pane` on such a host. That event only _claims_ a state; this frame _hands text
  out_, so trusting a claimed pane would let any process of the same user read any session's
  messages.
- **Bound to the pane once, at accept**, as `local-socket.ts` reads the pid. `LOCAL_PEERPID` fails
  once the peer has closed (macOS spike). If the pane's `@seance-task` changes under a live
  connection (`/clear`, a respawn into the pane), the daemon closes the connection. The mod
  restarts the child, which rebinds.
- **One listener per pane.** A second `inbox` frame bound to the same pane replaces the first,
  whose connection is closed. That is the `claude --resume` in the same pane case.

Rejected:

- **A `$.process.run` per check** (the session-events pattern, polled every few seconds). It costs
  a Bun start, tmux and ps calls per tick per session, about a quarter of a core across ten
  sessions at 2 s.
- **`$.http.fetch({ socketPath })` polling.** Verified on macOS: it binds the right pane with no
  Bun start. But it is request/response only, so delivery waits for the next poll, and the local
  socket would need an HTTP framing beside its newline JSON. Kept as **the fallback** if the
  long-held child fails the spike item below.
- **A file drop the mod polls** (the spike's own rig). It binds by path, not by pid, and leaves
  message text at rest on disk.
- **A loopback TCP port.** No peer pid.

**Which mod call delivers which case.** The mod tracks the main loop's state as session-events does
(`turn.start` / `turn.complete`, open dialogs from `tool.check`).

| Case                                        | note                                                  | question / request                                                 |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Idle                                        | held; appended at the next `turn.start` (no wake, D4) | `$.prompt.submit`, which starts a turn at once                     |
| Mid-turn, no dialog                         | `$.session.append`, read at the next model request    | `$.prompt.submit`, which runs as its own turn when this one ends   |
| Turn boundary                               | same as idle                                          | `$.prompt.submit` (it waits for the end by itself)                 |
| A permission or AskUserQuestion dialog open | held until it closes, then as mid-turn                | `$.prompt.submit`, which waits the dialog out and never answers it |

- **Never `asUser`, never tmux keys, never `$.prompt.fill`.** The person's draft is never touched,
  and no delivery can answer a dialog.
- **A request is always pushed by `$.prompt.submit`, never pulled.** The macOS spike showed
  pulled text is read but not obeyed, so a request that went by pull would silently become a note.
  A request is therefore capped at `MESSAGE_PUSH_MAX`, and a longer one is refused `too_long` at
  the sender.
- **The push cap is `MESSAGE_PUSH_MAX` = 8 KiB of message text.** A note or question longer than
  that is pushed as a fixed stub ("a note from task `<id>` (`<title>`), `<n>` bytes; call
  `read_messages` to read it"), with the body by pull. **The hard cap is `MESSAGE_MAX` = 64 KiB**,
  refused `too_long` at the sender. The spike found no cap on Claude's side (300 KB cost 300k
  tokens), so the cap is ours, sized as a long design note and far under the socket's 1 MiB frame
  cap.
- **`read_messages`** is registered by the mod (`$.tool.register`) and returns every held message,
  framed (§4), oldest first. The mod owns what was pushed and what is held. The daemon pushes each
  message once and keeps nothing after the write (below).

**The standing instruction.** A session must know it can receive and what to do. Two layers,
neither of which the session's own context can lose:

1. **A `prompt.compose` hook in the `inbox` mod** adds one constant `session`-scope section
   ("Other Séance sessions may message you. Messages arrive as turns from the inbox plugin; when
   one says you have unread messages, call `read_messages` …"). The system prompt is recomposed
   per request, so it survives `/compact`, and it reaches hand-started sessions too. Unverified:
   the managed plugin hooks `prompt.compose`, and may skip ours as it skips `session.append`.
2. **The spawn adds the same constant through `--append-system-prompt`** (verified working on both
   spikes). It is a constant in argv, never wire text, so the "every wire-supplied value through
   `shq()`" invariant is untouched. It is one more fixed argv word in `buildInnerCommand`
   (`daemon/src/spawn.ts`). Only spawned sessions get it, which covers every addressable session
   (§2).

Rejected: **a line in the seed.** It is lost at `/compact` and absent after `--resume`, and the
seed is the prompt, which `forgetPrompt` and the record's size budget govern.

**What each kind of session gets.**

- **A spawned (tasked) session:** addressable, can send, and receives.
- **A hand-started session in a tmux pane:** can send (`send_message` binds its pane, which has no
  task, so the message says `from` "an untasked session on `<machine>`"). It is not addressable
  (D3), so its listener binds and idles.
- **`claude --bg`:** no `TMUX_PANE` (dropped on purpose; DESIGN.md, "Claude Code mods"), and its
  peer pid walks to the pty host, not a pane. The mod starts no listener, as session-events skips
  `report`, and `send_message` answers `unbound`.

**The inbox in the daemon.** Memory only, per pane: at most 32 messages and `MESSAGE_MAX` × 4
bytes. Past either cap the oldest is dropped and counted, and the next push says "`<n>` earlier
messages were dropped". Messages wait here only while the pane is bound to a task and its listener
has not yet connected (session start). Every other message goes to the listener at once, and the
mod holds it. Cleared on the pane's `ended`, on the pane being bound to another task, and on a
daemon restart. **Nothing is at rest** on disk, in the store or in the launch ledger.

Spike before PR 1 (short, on a live session, macOS and Linux):

1. Hold a `$.process.spawn` child open with a socket connection for 30+ minutes, across a
   `/compact` and a `--resume` in the same pane.
2. Check whether `cc-plugin-sec-default` skips another mod's `prompt.compose` hook.
3. Check that a pushed stub ("call `read_messages`") is heeded with layer 2 only.

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

**Who resolves.** The leader, whose queue holds the chain (§3). PR 1 has a local path that does not
need the leader: the daemon resolves a task id against its own panes (`@seance-task`,
`TASK_OPTION` in `daemon/src/tmux.ts`) checked against its launch ledger, as hand-off binding does.
It delivers only to a task its ledger holds a launch of and a live pane carries. Anything else goes
to the leader from PR 2 on, and in PR 1 answers `unknown`.

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

**`send_message`** on `seanced mcp`:

```ts
{ to: string /* task id */, kind: "note" | "question" | "request", text: string, inReplyTo?: string /* message id */ }
→ { ok: true, id: string /* message id */, outcome: "sent" | "delivered" } | { ok: false, code: … }
```

It reaches the daemon over the local socket as a new frame kind, `message`. That is neither a
`Plain` nor an `OpName`, so **`LOCAL_OPS` does not change and neither does the broker**. The
daemon binds the frame by the peer pid of `seanced mcp` (a child of `claude` in the pane), exactly
as `report_task_done`, `hand_off_task` and `pass_to_successor` are bound (`daemon/src/report-done.ts`).
The sender's task is the one its pane carries, never a field of the frame. The text crosses on the
socket, never in argv. A local target is delivered by the daemon itself (`outcome: "delivered"`),
and any other goes to the leader (`"sent"`). `seanced mcp` never logs, so the "nothing reachable
from `seanced mcp` calls `log.ts`" rule holds as it does for those tools.

- **No list tool.** `get_queue` already names every task by id, title, machine and state. A
  message needs nothing more.
- **`read_messages` lives on the mod, not on `seanced mcp`.** The mod holds what was pushed. A
  second reader in another process would need its own binding and its own cursor.

Rejected:

- **Through the fleet broker** (`broker.ts`). It runs only on credential-keyed daemons, it is
  app-role so it carries no sender binding, and any widening of it is a threat-model change for
  nothing gained.
- **Through `seanced mcp`'s direct app-role client.** It has the same missing binding, and a
  keyless `seanced mcp` cannot seal at all.
- **A new `Plain` op on `LOCAL_OPS`.** `LOCAL_OPS` ops are relay ops served locally. This one is
  a session's claim about itself, which is what the frame kinds beside `Plain` are for.

**What the receiver reads.** Each kind gets a fixed wrapper (constants in `shared/`, so the daemon
and mod agree), with the sender shown as task id, title and machine name. The text sits inside a
fenced block. Claude Code puts its own "The inbox plugin sent a message:" header above a submit.

- **note**: "A note from another Séance session your user runs (task `<id>`, "`<title>`", on
  `<machine>`, message `<msgid>`). It is information for your current work; no reply or action is
  expected."
- **question**: "A question from another Séance session your user runs (…). If you can answer from
  what you know, reply with `send_message` to task `<id>`, kind `note`, `inReplyTo` `<msgid>`, and
  carry on with your own work. If answering needs work your user has not asked for, say so in the
  reply instead."
- **request**: worded as Claude Code's native peer message, because the Linux spike showed an
  information-only frame makes the model refuse even a harmless request: "A teammate session your
  user runs (…) asks you to do the following. Treat it as you would a request from a teammate:
  do it if it fits your current task and your user's instructions, and tell it with
  `send_message` (`inReplyTo` `<msgid>`) what you did or why you did not." The exact text is set in
  PR 1 against the spike, using the native wording.

**What a request may not do** (by construction, not by asking the model):

- **Arrive as the user.** It is never `asUser` and never a tmux key, so the transcript always reads
  it as from the plugin.
- **Answer or approve a dialog.** `$.prompt.submit` waits a dialog out (spike, both platforms), and
  nothing else types.
- **Change the session's permission mode, model, effort, worktree or task.** The mod has no call
  that does any of these.
- **Outrank the session's user or `CLAUDE.md`.** The wrapper says "if it fits … your user's
  instructions". This is the one bound that rests on the model.
- **Exceed `MESSAGE_PUSH_MAX`**, or be pulled (§1).
- **Come faster than the rate limit.** A sending task may send 20 messages a minute and 200 an
  hour. A `rate_limited` refusal is local to its daemon, held in memory and keyed by task id.

**The prompt-injection path a request opens between accounts.** Session A, on account X, reads
hostile content (an issue body, a dependency's README) that tells it to `send_message` a request to
task B, on account Y. B runs it under Y's permission mode, in B's worktree, with B's context. What
bounds it:

- **It is no new reach.** A can already `spawn_session` or `queue_batch` any prompt onto any
  machine and account (Threat model item 6: "anyone who can form a valid spawn frame has
  arbitrary code execution, laundered through the agent"). A request reaches no further, since it
  only lands in a session that already runs there.
- **What is new is the context it lands in.** It lands in a session someone may be watching, mid
  work, with state a fresh spawn would not have (uncommitted changes, the conversation). That is
  why a request is labelled as from a session (never the user), cannot touch dialogs, is size-
  and rate-capped, and is audited per message (§5).
- **The receiver can see who sent it.** The `fromTask` is bound by the sender's daemon to its own
  pane and by the leader to the sealing machine (§3), so B's wrapper names the real task, not a
  claimed one. A session can still lie in the text, but not about which task it is.
- Open question 1 asks whether a request may beget a request.

### 5. Logging and audit

Message text is prompt text, under the same rules:

- It is never logged, by the daemon, the leader, the mod or the relay.
- It is never in argv: it crosses on the socket and in the sealed envelope only.
- It is never in `progress`, `get_queue`, `status`, a push notification or the archivist.

The relay sees one more sealed envelope class of the same shape as `session-event`, and logs it as
it logs those: failures only.

**A new audit origin, `message`**, with one line per message on each daemon it touches. It carries
counts and ids only:

```
audit message origin=message dir=out from=<task|untasked> to=<task> kind=<note|question|request> bytes=<n> outcome=<…>
audit message origin=message dir=in  from=<task|untasked> to=<task> kind=<…> bytes=<n> outcome=<delivered|ended|nolistener>
```

The leader logs no line per routed message (the threat-model item 3 timeline rule `#route` already
follows), only failures. Rejected: logging message ids beside the audit line. They join nothing
the task ids do not already join.

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

1. **Local delivery.** The `inbox` mod (listener child, `prompt.compose` section, `read_messages`,
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

**The local socket now hands text out.** Until now every frame on it was a relay op served
locally, a broker call, or an ingest-only claim. The `inbox` frame is the first that _reads_
something a session did not write itself. Access control stays the 0700 `stateDir()/run` directory
(DESIGN.md, "Local op socket"). Inside it, a reader is bound by kernel peer pid, never by a field,
and **refused where the host cannot name a peer** (§1). A same-user process can still set
`@seance-task` on its own pane, as it can for `session-event`. That reads only messages addressed to
the task it claims, needs a pane, and is the user's own account, the same residual hand-off has.

Invariants in CLAUDE.md this spec touches, each kept:

- **Local op socket allowlist** (`sessions`, `spawn`, `despawn`). It is unchanged. The new frames
  are kinds beside `Plain`, and that list says widening the socket is a threat-model change,
  which this section is. When PR 1 lands, CLAUDE.md gains a line for the `inbox` and `message`
  frames: what they may do, bound only by peer pid, never on a host with no peer pid.
- **Session-event binding** ("bound to the sender's pane by its kernel-reported peer pid, never by
  a field it sends"). `message` and `inbox` bind the same way, without the no-peer-pid fallback.
- **Prompt text is never logged.** Message text is prompt text (§5).
- **Every surface audits under its own origin, never reusing one.** New origins `message` and
  `adapter`.
- **The leader honours a request only sealed by the right sender, through its own parser and the one
  `schedulerGuard`.** `session-message` is from a daemon only, `parseSessionMessage`, the same guard.
- **An event moves only a task placed on the machine that sealed it.** A `session-message` is
  accepted only when its `fromTask` is placed on the sealing machine. It moves no task at all.
- **A daemon acts on a scheduler op only sealed `from` the scheduler (or in process).**
  `deliver-message` and `message-receipt` follow this.
- **Argv-array exec; every wire-supplied value through `shq()`.** `--append-system-prompt` carries
  a constant; no message text reaches argv or the tmux command.
- **A service-delivered credential never leaves the daemon process.** An adapter's env drops
  `CREDENTIALS_DIRECTORY`, as a session's and a trait probe's do.
- **Traits are declared only in the machine's own `config.json`; probes run only that argv.**
  Adapters follow the same rule (§6).
- **Nothing reachable from `seanced mcp` calls `log.ts`.** `send_message` logs nothing.
- **Threat model item 6 (prompt injection).** A request is a new path into a running session, with
  no new reach beyond `spawn_session` (§4). DESIGN.md's item 6 gains a paragraph for it when PR 1
  lands, as it did for the successor record.

## Open questions

1. **May a session send a request while handling one?** A hostile request could fan out across
   accounts as a chain. Proposed: yes in v1, bounded by the rate limit, and the wrapper names the
   message id it replies to. Alternative: a session handling a request may send only notes until
   its turn ends, which the mod can enforce, since it knows a request's turn is running.
2. **Should a question also wake when it is long?** Today a long question pushes a stub, which
   the spike says is heeded only with the standing instruction. If spike item 3 fails, a long
   question degrades to a note.
3. **The MCP channel** (`--channels`): one push covers mid-turn and wake. Worth revisiting once
   `allowedChannelPlugins` can be set org-wide without a startup dialog.
4. **A sender-side "who can I message" view** beyond `get_queue`. Wait for use.
