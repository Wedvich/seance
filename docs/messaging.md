# Session messaging — spec

**Status: PR 1 (local delivery) built 2026-11-13, PR 2 (cross-machine) and the reply by handle (D3, amended)
built 2026-11-14; PR 3 (adapter seam): 3a (the child and state out) built 2026-11-18, 3b and 3c not built; §6 revised 2026-11-14, and again 2026-11-17 to build on docs/tags.md
(draft PR #533: session identity, tags, the adapter subscription).** Drafted 2026-11-13 from two spikes of text delivery into a live Claude Code session: Linux,
Claude Code 2.1.322 (commit `0324f9f`, branch `worktree-spike-text-into-live-session`, `spike/`), and
macOS, 2.1.323 (`origin/worktree-spike-text-in-macos`, `spike/REPORT-macos.md`), then the three
pre-PR 1 checks on Linux and on macOS (`origin/worktree-messaging-spike-2-macos`, `spike/REPORT-macos-2.md`). Like docs/drain.md,
this file is the working record until the code lands; each part folds into DESIGN.md as it is built,
and its text here goes. PR 1's and PR 2's record is in DESIGN.md: Local op socket, "Session messages"
(the frames, the daemon's inbox, the outcomes, the wrappers, the audit) and its "Cross-machine"
subsection (the gate, the leader's resolve, forward and receipt, the size budget, the skew table) and its
"Replies by handle" subsection (the two tables, the `claude`-process binding, `wake`, `messageReply`),
Claude Code mods (the `inbox` mod), MCP server (`send_message`) and Threat model item 6. PR 3a's record is DESIGN.md,
"Adapters". What stays here is the evidence, PR 3's whole design (3b and 3c build on it), and the open questions.

## Problem

Sessions Séance runs cannot talk to each other. A session that finds something another task needs
(a schema change, a failing build on the other branch, a question only that session's context can
answer) has two ways out today, both wrong: tell the person, who relays it by hand, or
`spawn_session` a new task with the text as its prompt, which starts a stranger with none of the
receiver's context. The fleet already spans machines and Claude accounts (exclaves), so the person
relaying is often the only path between two sessions that sit on one box.

Wanted: **any session Séance knows about can message any other**, across machines and accounts,
through MCP tools. Across machines it goes over the relay sealed under the PSK, so the relay never
reads it. Later, **adapters**, each a locally installed program in a repository of its own, will bridge
sessions and an external tool both ways through the same local delivery primitive (§6). Séance offers
the seam and names no tool.

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

| What                                       | Linux 2.1.322 | macOS 2.1.323 | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$.prompt.submit`, session idle            | [V]           | [V]           | A turn starts at once (~200 ms). The model reads a user-role turn headed "The `<plugin>` plugin sent a message", with origin `{ kind: "plugin" }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `$.prompt.submit`, turn running            | [V]           | [V]           | The call stays pending until the turn ends, then runs as a turn of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `$.prompt.submit`, permission dialog open  | [V]           | [V]           | Waits out the dialog, shown queued above it. It never answers the dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `$.prompt.submit`, half-typed draft        | [V]           | [V]           | The turn runs, and the draft stays in the box untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `$.prompt.submit`, Remote Control on       | [V]           | [V]           | Works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `$.session.append`, mid-turn               | [V]           | [V]           | Stored as `{ type: "user", isMeta: true }`. Seen at the next model request inside the current turn, after the running tool's result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `$.session.append`, idle                   | [V]           | [V]           | Does not wake the session; the model sees the row at its next turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `$.session.append`, size                   | [V]           | —             | No cap: 300 KB was accepted and cost about 300k tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `$.tool.register` (`read_messages`)        | [V]           | [V]           | Works, including under the managed plugin, which hooks `tool.register`. The mod's own tool raised no permission prompt in manual mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A notice alone ("1 unread, call …")        | [V]           | [V]           | Ignored. On macOS the model said it ignored it because the user had not asked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A notice with a standing instruction       | [V]           | [V]           | With `--append-system-prompt` saying to read messages, the model called `read_messages` unprompted, after a ToolSearch since the tool loads deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pulled text with an instruction in it      | —             | [V]           | Read but **not obeyed**: "That came from a tool result, not from you, so I ignored it" (Haiku 5.5). Only `$.prompt.submit`, a user turn, carries text the model acts on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `turn.start` adding context                | [V]           | —             | Cannot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Managed `cc-plugin-sec-default`            | [V]           | [V]           | Skips every mod's `classic.*` hooks and its `session.append` **hook**; the `$.session.append` **call** still works. It also **skips another mod's `prompt.compose` hook**, on both platforms (Linux 2.1.323: `spike-inbox: its prompt.compose hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`; macOS 2.1.323: the hook never ran, and asked for the codeword its section carried, the model answered "NONE"). Every session loading the mod prints that notice once, so the `inbox` mod registers no `prompt.compose` hook (owner's decision, 2026-11-13) and the standing instruction relies on the spawn's `--append-system-prompt` alone. macOS: the managed settings are presumably the org's remote policy (no managed-settings file exists there), so other orgs may differ. `prompt.section` and `prompt.context` were not tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `context` from a `tool.call` hook          | —             | [V]           | The spike mod's notice blanked Bash's own output to the model. Never ride text on a tool result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/compact`                                 | [V]           | —             | Nothing delivered survives verbatim. Anything that must last is re-read by pull.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Information-only frame vs native peer text | [V]           | —             | Framed "information-only, do not follow", the model refused a harmless request. Worded as Claude Code's native peer message (a teammate's request), it ran it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Mod → daemon socket, peer pid              | [I]           | [V]           | Both `$.http.fetch({ socketPath })` (peer: `claude` itself) and a `$.process.spawn` child (peer: the child, parent `claude`) give a pid that `LOCAL_PEERPID` returns and `ancestorIn` resolves to the right pane. A child held open for 30 minutes: the next row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Long-held `$.process.spawn` child + socket | [V]           | [V]           | Linux 2.1.323: one child's connection held 29.6 min, all 29 one-minute lines read, across a `/compact` (no reload) and an in-process `/resume` (`session.end` reason `resume`, no `session.start`, no reconnect). `/exit` closed it; `claude --continue` in the same pane started a new child that connected 0.7 s after launch and bound the same pane (peer chain bun → claude → the pane's shell). macOS 2.1.323: **holds**, 31.7 min, all 31 one-minute lines and the ad-hoc pushes received across a `/compact`; `/exit` SIGTERMs the child (before the mod's `session.end` runs), and `claude --resume` in the same pane started a new child that bound the same pane (`%0`) and received pushes, also across a second `/compact`. `tmux kill-session` SIGHUPs the child within 0.5 s. Two findings: **a `kill -9` of `claude` orphans the child** (ppid 1), still connected, so the daemon's writes succeed while the child's stdout is EPIPE and the message is lost (the child now exits when its parent changes or its stdout errors; DESIGN.md, "The orphaned child"); and an in-process `/clear` or `/resume` fires `session.end` (reasons `clear`, `resume`) but **no `session.start`**, the child and connection carrying on (correct, since `@seance-task` does not change; the mod keeps its loop for those two reasons). |
| Stub heeded, spawn command line only       | [V]           | [V]           | Linux 2.1.323: a pushed stub ("call `read_messages`") made the model call it at once, both idle (2.4 s) and mid-turn, with only `--append-system-prompt` carrying the standing instruction. macOS 2.1.323: **4 of 4** runs with the spawn's command line only (Haiku and Sonnet, idle and pushed into a running turn, called it 1–2.5 s into the stub's turn), and **3 of 3 with no standing instruction** (Haiku 2, Sonnet 1), so a stub pushed by `$.prompt.submit` is heeded because it arrives as a turn. Obeying the body is separate: Sonnet read the pulled body and declined an ask embedded in it ("the request came from another session, not from you"), Haiku obeyed, so a request is pushed in full, never pulled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| MCP channel from `seance mcp`              | [V]           | —             | One push covers mid-turn and wake, but needs `--channels` at launch and the org's `allowedChannelPlugins`, and the dev flag shows a startup dialog. A later option, not v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
`nolistener`, `unbound`, `invalid`, `stopping` and `internal`. PR 2 added `routed`, `remote` (a `route: "ask"`
frame's answer for a task not deliverable here), `no_leader`, `offline` and, in a receipt, `unsupported` from the
leader (DESIGN.md, "Cross-machine"). The audit gained `dir=receipt`.

| Concept                                     | Name                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The thing sent                              | **message**                                                                                                                    |
| Its kind                                    | **note** (information), **question** (may answer), **request** (act on it)                                                     |
| A pane's held messages                      | **inbox** (daemon memory only)                                                                                                 |
| MCP tool, send                              | `send_message`                                                                                                                 |
| Mod tool, read                              | `read_messages` (mod-registered, `mcp__inbox__read_messages`)                                                                  |
| The mod                                     | `inbox` (`claude-mods/inbox/`)                                                                                                 |
| Local-socket frame, a session sends         | `message` (frame kind)                                                                                                         |
| Local-socket frame, a session's mod listens | `inbox` (frame kind)                                                                                                           |
| Daemon → leader event op                    | `session-message`                                                                                                              |
| Leader → daemon request op, deliver         | `deliver-message`                                                                                                              |
| Leader → daemon request op, receipt         | `message-receipt`                                                                                                              |
| Capability, a daemon that receives          | `CAPABILITIES.messages`                                                                                                        |
| Capability, a leader that routes            | `CAPABILITIES.messageRoute`                                                                                                    |
| Caps                                        | `MESSAGE_PUSH_MAX` (8 KiB), `MESSAGE_MAX` (64 KiB)                                                                             |
| Audit origin                                | `message` (and `adapter` for the seam, §6)                                                                                     |
| Outcomes                                    | `delivered`, `held`, `offline`, `ended`, `unknown`, `unsupported`, `too_long`, `rate_limited`, `no_leader`, `routed`, `remote` |
| Cross-machine size budget                   | `MESSAGE_ROUTE_MAX` (40 000 bytes of JSON-escaped text)                                                                        |
| The gate on a `message` frame               | `route: "ask"` then `route: "send"`                                                                                            |

## Decided by the owner

**From the brief (before 2026-11-13):**

- **The sender chooses the authority per message**, by its kind: a note, a question or a request
  (§4).
- **Delivery is by Claude mod calls, never tmux keystrokes.**

**Answered on 2026-11-13:**

- **D1. Cross-machine goes through the leader** (§3).
- **D2. A target that is offline or asleep: drop, and answer `offline`.** Nothing is held anywhere
  (§3).
- **D3 (amended 2026-11-14). A session without a task is reached only as a reply, by the id of a message it
  sent.** It was "Sessions without a task are out of v1; the task id is the only address (§2)". The owner's
  2026-11-14 smoke test had a hand-started session ask a task a question, and the task had no way to answer. A
  reply names the message it answers (`inReplyTo`, no `to`); the daemon that minted the id knows which session
  asked, and answers only to the pane, pid, task and **`claude` process** that did, for an hour. A task id stays the
  only address for anything that is not a reply. Built: DESIGN.md, "Session messages", "Replies by handle".
  **Amended again 2026-11-17 (proposed, docs/tags.md §8):** "… or, by an adapter on its own machine, through the
  subscription the session made by messaging that adapter", keyed by its verified conversation id (`agent.session`)
  for the conversation's life. The hour bounds a reply handle because the handle is a bearer; a subscription is the
  session's own act, usable only over that adapter's stdin, so the hour does not apply to it (§6.2).
  **Rejected**, each in §2's list: machine + pane id as a general address; a synthetic task id or queue entry for a
  hand-started session; a leader-held reply table; the Claude session id; replies on one machine only.
- **D4. Wake by kind.** A question or request wakes an idle session; a note does not (§1). Built: a note is a
  `$.session.append` row, added at once and read within a running turn too, which does not wake an idle session.
  **Extended 2026-11-14 (`wake`):** a note that answers a question or request the receiving session itself sent
  does wake it, since an idle asker would never read it otherwise. The daemon decides from its own `sent` table and
  marks the inbox line; the mod then uses `$.prompt.submit`. Nothing else about a note changed.

## Decisions

### 1. Local delivery: a mod listening on the local socket, bound by peer pid

**Built (PR 1, 2026-11-13); the record moved to DESIGN.md**: Local op socket, "Session messages" (the
listener and its refusals, the `inbox` and `message` frames, the daemon's inbox, the grace, the caps,
the outcomes, the wrappers, the standing instruction (the spawn's command line; the compose layer was dropped 2026-11-13), what each kind of session gets, the
rejected alternatives) and Claude Code mods, **inbox** (the mod, its delivery table, `read_messages`).
The spike's three checks are in the Evidence table above.

### 2. Addressing: the task id, following its chain

**The task id is the only address for a message that is not a reply** (D3, amended 2026-11-14: a reply to a session
with no task is addressed by the id of the message it answers, "Replies by handle" in DESIGN.md). It is the only
handle stable across panes: tmux reuses
pane ids, a session can be resumed in another pane, and a window name is display-only (DESIGN.md,
"Claude Code mods": "nothing routes, binds or places on the window").

**Resolution follows the task's chain**, as dependents already do (DESIGN.md, "Passing to a
successor"). Built (PR 2) as `resolveMessageTarget` (`scheduler/src/message-route.ts`):

| Target task state                                                                       | Resolves to                                                                                                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `running` / `needs-input` / `lost`                                                      | forward to the machine its `assignment` names                                                                                          |
| `superseded`                                                                            | its `successor`, followed to the end of the chain (`holder`). A successor still `blocked` or otherwise waiting is `held` (below)       |
| finished, and a later task carries `continues: { task: <id> }` and has landed           | that continuation, which resumes the same Claude conversation in the same worktree                                                     |
| finished, a continuation exists but has not landed                                      | `held`                                                                                                                                 |
| finished, with an `assignment`                                                          | forward, `settled`: that machine delivers to a live pane and answers `ended` for none, since a session can outlive its record's `done` |
| finished, no `assignment`                                                               | `ended`                                                                                                                                |
| `queued`, `ready`, `reserved`, `blocked`, or placed with no `assignment` yet            | `held`: answered at once, not queued (D2's rule applies; nothing is held at rest)                                                      |
| not in the queue, or a chain that breaks (a cycle, a successor the queue does not hold) | `unknown`                                                                                                                              |

"Held" here is an answer, not storage. The sender reads "the target has not started yet" and
decides whether to retry. The adapter seam's `result` uses it in the same meaning (§6.1).

**Who resolves.** The leader, whose queue holds the chain (§3). PR 1's local path, which needs no
leader, is built (DESIGN.md, "Session messages", Resolution): the daemon resolves a task id against its
own panes checked against its launch ledger, and **a live local pane wins over the leader's record**:
the leader is asked only for what the sender's own daemon cannot deliver. Anything else goes to the leader
(PR 2, built: DESIGN.md, "Cross-machine", where the built table is the record).

Rejected:

- **Machine + pane id** (D3), as a general address. A reused pane id delivers to a stranger. A hand-started
  session has no task, nothing to resolve a chain through, and no placement the leader knows. (A pane id is
  still part of a reply's binding, beside the pid, the task and the `claude` process, and is never an address a
  frame supplies.)
- **A synthetic task id, or a queue entry, for a hand-started session** (D3). It would put a session Séance never
  spawned into the leader's record and the Queue screen, with a lifecycle nothing ends, and hand it the chain
  resolution, `continues` and the reaper, none of which apply.
- **A leader-held reply table** (D3). The leader would keep a map of who talked to whom, a mailbox's worth of
  metadata, to answer what the asker's own daemon already can: it minted the id.
- **Replies on one machine only** (D3). The smoke test that raised this was cross-machine, and asking a task on
  another machine is the common case.
- **The Claude session id, as a session-to-session address.** It is stable across `--resume`, but it is the daemon's
  own choice (`--session-id`), recorded only in the launch ledger of the machine that ran it. It is not in the
  queue, so a sender could learn it only by asking that machine, and it is the very id the
  continuation invariant forbids taking from a frame. (Narrowed 2026-11-17: docs/tags.md §4 gives a **verified**
  `agent.session`, one the daemon read itself, exactly one use, an adapter's delivery on that machine to a
  conversation subscribed to it, §6.2. It is still no address between sessions, and replies stay by message id.)
- **Freezing a message at its first target** (no chain). A pass moves the work exactly when one
  session runs out of usage, which is when a peer most needs to reach whoever carries it on.

### 3. Cross-machine: through the leader, no hold

**Built (PR 2, 2026-11-14); the record moved to DESIGN.md**: Local op socket, "Session messages",
"Cross-machine" (the two-frame gate `route: "ask"` then `"send"`, the leader's admit, resolve, forward and
receipt, `settled`, the de-dup by message id for `REPLAY_RETAIN_MS`, the outcomes `routed`, `no_leader`,
`offline` and `unsupported`, the receipt's fixed texts, the size budget `MESSAGE_ROUTE_MAX`, the skew
table, and the rejected alternatives: a direct `from: "app"` send, daemon-to-daemon, and the three holds
for D2), Wire protocol (`session-message`, `deliver-message`, `message-receipt`) and Threat model item 6.
D1 and D2 stand as decided above: through the leader, and a target that is offline or asleep is dropped
and answered `offline`, nothing held anywhere.

### 4. MCP surface and the frames a receiver reads

**Built (PR 1); the record moved to DESIGN.md**: MCP server (`send_message`, no list tool,
`read_messages` on the mod), Local op socket, "Session messages" (the `message` frame, the rejected
broker, direct app-role client and `Plain` op, the wrappers, what a request may not do) and Threat
model item 6 (the prompt-injection path a request opens between accounts). PR 2 reuses the same
`send_message` and wrappers: a target on another machine goes to the leader (`routed`, §3) where PR 1
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

Revised 2026-11-14 from the owner's brief for PR 3 and the 2026-11-13 memo. Three PRs, §7 item 3. **3a (the child
and state out) is built 2026-11-18**, recorded in DESIGN.md, "Adapters": §6.1's handshake, versioning, supervision and
the state-out frames, `config.json` `adapters`, and the lifecycle audit lines. Deliveries in, messages out, the
subscription, `kinds` and the `deliver`, `tag`, `result`, `delivery` and `message` frames (3b), and installing (3c),
are not. 3a sends `Session` without `task.title` and `task.ref`, and `task` without `continues` (the daemon's ledger
notes none of them), and already applies `repos` to state out.

**What the owner decided (the brief, 2026-11-14).**

- **Séance owns a generic, tool-agnostic interface; it never names a tool.** Not in code, specs, plans, names or
  tests. An adapter for a tool lives in its own repository (`seance-<tool>`, private if the owner likes), and that
  tool's code does not know Séance either. The adapter is the only thing that knows both.
- **Two-way.** A tool delivers messages into Séance sessions, and Séance's state and events (sessions, tasks,
  messages) flow out to the tool, so the two can stay in sync.
- **The same pattern will serve work tracking** (memo, 2026-11-13): Séance should not be tied to one tracker
  either. That is a different seam (docs/orchestrator.md §1, and open question 5 below), and this one is shaped so
  as not to foreclose it.

**Built on docs/tags.md (2026-11-17).** That spec (draft PR #533) settles what this section needs and did not have:
what "a session" is (pane, process and conversation, §1 there), the conversation id `agent.session` that the daemon
verifies (§4 there), the `tags` map and its writers (`adapter.<name>.*` is this seam's namespace), and the adapter
subscription that replaces the reply window for a tool's long-lived asks (§8 there). The review points against
§6 as drafted on 2026-11-14 are settled below, in "Review points settled".

**The shape, in one paragraph.** An adapter is a program the machine's owner installs and names in that machine's
`config.json`. The daemon starts it as a supervised child, and the two speak newline-delimited JSON over the
child's stdin and stdout, so there is no rendezvous for another process to claim. The daemon sends a snapshot of
this machine's sessions, then every change to them, the lifecycle of the tasks it launched, and the messages
sessions address to the adapter. The adapter sends deliveries: text for a task's session on this machine, or a
reply to a message a session sent it. Everything else about the tool (its server, its credentials, its ids, how it
maps a task to its own objects) stays in the adapter. One adapter instance runs per machine, and a fleet-wide tool
sees the fleet by running its adapter on every machine, each reporting its own sessions under its own `deviceId`.

#### 6.1 The protocol

The schema of record will be `shared/src/adapter-protocol.ts` (types and parsers, as `shared/src/types.ts` is for
the wire), with a JSON Schema generated from it and committed beside it, so an adapter in any language can vendor a
copy at a protocol version. One frame per line, UTF-8, at most 256 KiB a line (a delivery carries at most
`MESSAGE_MAX` of text, 64 KiB, which JSON escaping can grow).

**Handshake.** The daemon writes `hello` first; the adapter answers with its own; nothing else flows before both.

| Frame           | Fields                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| daemon `hello`  | `{ kind: "hello", protocol: [1], features: string[], machine: { deviceId, name }, daemon: { version } }`                                                     |
| adapter `hello` | `{ kind: "hello", protocol: 1, name, version, wants: ("sessions" \| "tasks" \| "messages")[], features: string[] }`; `name` must equal its `config.json` key |

**Daemon to adapter (state and events out)**, each sent only for what the adapter `wants`:

| Frame          | When                                                                     | Fields                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`     | after the handshake, and on `resync`                                     | `{ sessions: Session[] }`: every live Claude pane this daemon binds, tasked or not                                                                                                                                                          |
| `session`      | a session's state, task or PR changed (the `session-event` ingest's own) | `{ session: Session }`, the whole record, never a patch                                                                                                                                                                                     |
| `session-gone` | the process ended, or stopped being this session                         | `{ key, reason: "exited" \| "closed" \| "replaced" }` (below)                                                                                                                                                                               |
| `task`         | a task this machine launched moved                                       | `{ task, event: "launched" \| "done" \| "handoff" \| "pass" \| "ended", continues?, prUrl? }`, from the launch ledger and the session's own reports                                                                                         |
| `message`      | a session sent this adapter a message (§6.2)                             | `{ id, messageKind, text, from: { key, session?, task?, title? }, inReplyTo?, subscribed }`; `session` is the sender's verified `agent.session`, present exactly when `subscribed`                                                          |
| `result`       | answer to one `deliver`                                                  | `{ ref, id?, outcome, code? }`: `outcome` is the built set's (`delivered`, `sent`, `held`, `ended`, `unknown`, `too_long`, `rate_limited`, `unsupported`, `invalid`) plus `refused` (the adapter's config does not allow that kind or repo) |
| `delivery`     | the fate of a delivery first answered `sent`                             | `{ id, outcome: "delivered" \| "dropped" \| "nolistener" \| "ended" }`                                                                                                                                                                      |

`Session` is `{ key, session?: { id, verified: boolean, conflict?: true }, task?: { id, title?, ref? }, exclave,
repo?, branch?, state: "busy" | "idle" | "needs-input" | "unknown", turnEnded?, reason?, prUrl?, since,
name: { text, source }, tags }` (revised 2026-11-17 on docs/tags.md).

- **Three ids, three lifetimes.** `key` is the process (`<pid>:<start time>`, the binding "Replies by handle" reads):
  a `session` record and its `session-gone` are per process, so a tool can tell a restarted `claude` from the one
  before. `session.id` is the conversation (`agent.session`, docs/tags.md §1): it survives a restart with `--resume`,
  and **it is the id stable across `continue_task`**, which resumes the same conversation under a new task id; join on
  it to keep one ticket across a restart or a continue chain. `task.id` is the work: stable while queued and across
  nothing else (a continuation and a successor are new tasks; a spawn does not name its predecessor today, so carrying
  `succeeds` is a spawn field PR 3a would add). A successor is a new task **and** a new conversation.
- **`session` is absent** when the mod has not reported a conversation yet; **`verified: false`** is a claim the daemon
  could not check (docs/tags.md §4.1), shown but never addressable; **`conflict`** marks an id two live panes claim,
  which `toSession` refuses (`ambiguous`). A refuted claim is never sent.
- `task.ref` is the dispatched `creator.ref`/`creator.ref-url` (docs/tags.md §6.1), which settles open question 11.
- `name` is docs/tags.md §6.1's `displayName` (owner label > task title > `self.name` > window), `source` one of
  `owner`, `task`, `self`, `window`, so an untasked session has a name a tool can show and says where it came from.
- `tags` is the joined map as #526 shapes it (`{ "<full key>": { value, at, scope } }`), every namespace but other
  adapters' `adapter.*` (docs/tags.md §6.2). `remoteSession` is gone from the record: it is `tags["agent.remote"]`.
- **After a daemon restart** every `Session` in the new snapshot reads `state: "unknown"` and carries no process tags
  until that session's next report (or, for its conversation, the daemon's own read of the agent's file). That is
  expected, not a fault: the daemon keeps session state in memory only, and a tool should show "unknown" rather
  than infer that the session ended.
- `repo` is the scan-set name (`SessionEntry.repo`, `shared/src/types.ts`: the repo mapped from the pane's path,
  a linked worktree's through its main clone), the same for a tasked and an untasked session, and absent outside
  every known repo. `branch` is the worktree's branch. `exclave` is the exclave's name, never an account id.

**`session-gone`'s `reason`**, aligned with the `task` events: `exited` (the process ended on its own: the pane's
`ended`, a crash, `/exit`), `closed` (Séance closed it: a despawn, a hand-off's or a pass's close, a custodian `close`,
the drain), `replaced` (the pane was re-tagged for another task under the same process, so the record a tool holds no
longer describes it). A process that moves to another conversation by `/clear` or `/resume` is not gone: it is one
`session` frame, the whole record, with the new `session.id`, and a tool keyed on the conversation sees the old one
lose its process. Nothing in `reason` is a tool's to act on beyond its display; the `task` event is still what says
the work ended.

**Adapter to daemon:**

| Frame     | Fields                                                                                                                                                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliver` | `{ ref, to?, toSession?, inReplyTo?, messageKind: "note" \| "question" \| "request", text, wake?, from? }`; exactly one of `to` (a task id), `toSession` (a subscribed conversation's `agent.session`, §6.2) or `inReplyTo` (the id of a `message` frame it received); `ref` is the adapter's own correlation id, ≤ 64 chars |
| `tag`     | `{ ref, session?, task?, key, value }`: one `adapter.<name>.*` tag (the bare suffix), on a subscribed conversation or a task's session it may deliver to (docs/tags.md §8.4); `""` clears it; answered by `result`                                                                                                           |
| `resync`  | `{}`: send a `snapshot` again (the adapter lost its own state)                                                                                                                                                                                                                                                               |

**Delivery** is the built local delivery (§1), with the adapter as the sender:

- `to` is a task id resolved only locally: a live pane carrying a task this machine's launch ledger holds, else
  `held` (launched, no pane yet), `ended`, or `unknown` (not launched here: another machine's adapter is the one
  to ask). Nothing is routed through the leader.
- `toSession` reaches the one live pane whose verified conversation it is, re-verified at the act, only while that
  conversation is subscribed to this adapter (§6.2): `ambiguous` when two live panes claim it, `unverified` when the
  daemon's own source now names another conversation, `ended` when no pane is live (nothing held, D2), `unknown` when
  it is not subscribed. This is how a tool reaches a session, tasked or not, across restarts, `--resume` and a
  continue chain.
- `inReplyTo` answers a message a session sent this adapter, through the `sent` table "Replies by handle" built, so
  it reaches exactly that `claude` process, an untasked one included, for the table's hour, and wakes it. It stays
  for a sender with no verified conversation, which cannot subscribe.
- A note is a `$.session.append` row: seen within a running turn, or at the next turn of an idle session, which it
  does not wake. `wake: true` submits it as a turn (`$.prompt.submit`, which also waits out a running turn and any
  dialog), as a question or request always is. Nothing else decides timing. The `boundary` mode of the first draft
  is dropped: `$.prompt.submit` already holds to the turn's end, and a note mid-turn is what a tool that wants to
  steer a running session asks for.
- The text reads in a fixed wrapper (`shared/src/messages.ts`) naming the adapter and machine ("the `<name>`
  adapter on `<machine>` relays …") and, when given, `from` as a display label (a person or bot in the tool), through
  `displayTitle`'s scrub, never as the user or a Séance session. A request keeps the session wrapper's "do it if it
  fits your current task and your user's instructions" clause, and `MESSAGE_PUSH_MAX`.
- Rate limits: the per-target limit a task has (20 a minute, 200 an hour per target task), plus one bucket per
  adapter for all its deliveries (60 a minute, 600 an hour; numbers set in PR 3b).

**Supervision.** Started at daemon start once the local socket is up, never while draining for a restart. Its env
is the one a session gets less `CREDENTIALS_DIRECTORY` and every `TMUX*` variable, plus `SEANCE_ADAPTER_NAME` and
`SEANCE_ADAPTER_DIR` (a 0700 `stateDir()/adapters/<name>` that is the adapter's own). Its own process group,
stderr discarded (an adapter keeps its own log; the daemon never reads or writes its output), and stopped with the
daemon: stdin closed, SIGTERM to the group, SIGKILL after 5 s. Restarted with backoff (1 s doubling to 60 s), and
held as `failed` after 5 exits within 10 minutes until the next daemon start or `seance adapter restart`. A line
that does not parse is answered `{ kind: "error", code: "invalid" }` and counted; 10 in a minute is a restart. An
adapter that stops reading (2 MiB unread on its stdin) is restarted, and a restart always starts with a fresh
snapshot, so nothing is resent from memory.

**Versioning.** `protocol` is a major number, bumped only for a breaking change. The daemon lists the majors it
speaks; an adapter that names none of them is stopped, audited `op=refused reason=protocol`, and not restarted.
Additions inside a major are `features` strings, as `CAPABILITIES` are on the wire: the daemon sends a new frame
kind only to an adapter whose `wants` or `features` named it, and the adapter sends a new field or frame only when
the daemon's `features` named it. Adapters ignore unknown fields on frames they know; the daemon's parsers accept
exactly their fields, as every Séance parser does.

#### 6.2 Messages out

**A session addresses an adapter as `adapter:<name>`** in `send_message`'s `to`. Task ids are UUIDs, so the prefix
cannot collide. The frame is bound by peer pid as every `message` is, the sender is tasked or untasked by the same
rule, and the daemon gives the adapter the message's `id`, which is the handle the adapter replies by. Local only:
`adapter:<name>` names the adapter on the sender's own machine.

**Messaging an adapter subscribes the sender's conversation to it** (docs/tags.md §8, amending D3 as above), when the
daemon holds a verified `agent.session` for the sender's bound `claude` process (never one from the frame). From then
on the adapter may deliver to that conversation by `toSession`, for the conversation's life: across a restart with
`--resume`, a daemon restart (the subscription is kept at rest, `conversations.json`), and a `continue_task` chain. It
ends when the conversation is not live for 30 days, when the adapter is removed or added again under its name, or when
the session sends the adapter `leave: true`. A sender with no verified conversation reaches the adapter all the same,
`subscribed: false`, and is answerable by reply for the hour. `send_message`'s result names the conversation id it
subscribed (`session`), so the session knows the id the tool holds it under and can give it to the tool (below).

**`repos` and `kinds` bound this direction too.** With `repos` set, a session whose `repo` is not listed (an untasked
session outside every known repo included, whose `repo` is absent) is not in the snapshot or `session` frames, cannot
be delivered to by any address, and its message to `adapter:<name>` is refused `refused`: not delivered, not
subscribed. Without `repos`, every session on the machine is in scope. `kinds` bounds only deliveries in.

**Structured acts go through the tool's own CLI, keyed by the conversation id** (review point 2). A tool's inbox has a
lifecycle Séance's messages do not (seen, deferred with a note, declined, done, group replies, options), and a message
to `adapter:<name>` has no addressing inside the tool. Séance does not model either. A session that needs them runs the
tool's own command-line client, which the tool's README tells its user to install, naming its conversation id (the one
`send_message` returned, and the one the adapter attached it under), so the tool joins the CLI's act to the session
the adapter reports. Séance's part stays text in, text out and state out. The tool's CLI and its credentials are the
tool's and its user's to install; Séance neither ships nor passes them, and the session's Bash could run any program
of the owner's uid already. **Rejected:** an opaque `data` field on `message` and `deliver`, size-capped, never logged,
passed through unread. Séance would carry bytes it cannot read into and out of a session's context, a channel no
scrub or wrapper can bound, and every tool would grow its own schema inside Séance's protocol, which the brief keeps
out. A `data` field read by the model is also prompt text that Séance's wrappers would no longer frame.

**What never flows out**: a task's prompt, an attachment, a session-to-session message or its metadata, a
transcript, the screen, the PSK or anything derived from it, an account id, an absolute path. Message text flows
only when a session addressed it to that adapter.

#### 6.3 Trust: an adapter is third-party code

**An adapter runs as the owner's uid, so Séance cannot contain it.** Such a process can read `state.json`, the
keychain where it is unlocked and every worktree, and can drive tmux. Installing one trusts its code as much as an
MCP server or a Claude Code plugin the owner installs, and the docs say so where `seance adapter add` is described.
What the seam's rules bound is what **Séance** grants and audits: the paths it owns stay true to its invariants (no
text in a log, no queue write, no relay frame, no key or credential handed over), and a well-behaved adapter's reach
is exactly the protocol. They are not a sandbox, and the threat model must not count them as one.

What follows from that:

- **The tool is a new source of prompt text for every session on the machine.** Anyone who can write into the tool
  (a project member, a bot, a compromised server) can put a note or question in a session, and, if allowed, a
  request. `kinds` in config bounds it, defaulting to `["note", "question"]`; `request` is the owner's explicit opt-in
  per adapter. The optional `repos` list bounds which tasks the adapter sees and reaches.
- **State out is a disclosure to the tool's server**: titles, repos, branches, PR URLs, states, and the text of
  messages sessions address to it. The owner chooses that by installing the adapter; prompts are never part of it.
- **The tool's credentials are the adapter's.** They live in the adapter's own config or keychain entry, are never
  in Séance's `config.json`, and are never passed by the daemon. A daemon with a service-delivered key never hands
  `CREDENTIALS_DIRECTORY` to an adapter, as it never does to a session or a probe.
- **A subscription outlives the hour a reply handle had** (§6.2). It is bounded by the channel, not by time: only
  that adapter, over its own stdin, on that machine, to a conversation that messaged it and that the daemon verified.
  Anyone who can write into the tool can reach a subscribed session for as long as the subscription stands, within
  `kinds` and the rate buckets; a session that no longer wants it sends `leave`.
- **Integrity**: `seance adapter add` records the adapter's git commit, when its directory is a git checkout, and
  `doctor` warns when the checkout moved since, as a reminder that new code is running, not as a refusal.

#### 6.4 What an adapter repository looks like

```
seance-<tool>/
  README.md              setup: the tool's own login, then `seance adapter add`
  seance-adapter.json    { "name": "<tool>", "protocol": 1, "argv": ["bun", "src/main.ts"] }
  src/main.ts            NDJSON on stdin and stdout, its own log under $SEANCE_ADAPTER_DIR
  src/protocol.ts        the vendored schema, at protocol 1
  test/                  against Séance's reference adapter's fixtures
```

Any language works: the contract is a process, stdin, stdout and the schema. Séance ships a minimal reference
adapter (an echo that answers each message by reply) beside its tests. It is the PR 3 tests' stub, the
template a new adapter starts from, and a conformance check an adapter repository can run against.

#### 6.5 Installing one on a machine

```
git clone <adapter repo> ~/src/seance-<tool>        # anywhere the owner keeps code
(cd ~/src/seance-<tool> && bun install)              # and the tool's own login or key setup
seance adapter add ~/src/seance-<tool>               # reads seance-adapter.json, writes config.json
seance restart
seance adapter status                                # running, protocol, counts, last exit
```

`add` writes `adapters.<name>` into this machine's `config.json` and never anything else:

```json
"adapters": {
  "<name>": {
    "argv": ["bun", "/Users/<owner>/src/seance-<tool>/src/main.ts"],
    "kinds": ["note", "question"],
    "repos": ["<repo>"],
    "commit": "<sha at add>"
  }
}
```

`repos` names repos as the scan set does (`Session.repo`, `SessionEntry.repo`: a clone's name, never a forge
path); its meaning for untasked sessions and for messages to the adapter is §6.2's. `argv` is an argv array resolved
to absolute paths at `add`, never a shell string. The `bun` in it is a bare name
resolved through PATH at exec, never a recorded `process.execPath`. `name` follows `^[a-z][a-z0-9-]{0,31}$`, and a
machine may name at most four adapters. Hand-editing the key is equivalent; `remove`, `restart` and `status` are the
other verbs. Self-update never pulls or rebuilds an adapter: an update restarts the daemon, which restarts the
adapters on the code they have. Each machine is set up on its own, and nothing about adapters crosses the relay.

#### 6.6 What an adapter may not do

- spawn, despawn, enqueue, cancel, amend, pass or otherwise touch the queue (open question 5);
- send cross-machine, or reach the relay or the leader at all;
- read an inbox, a prompt, a transcript, a screen, or any message not addressed to it;
- address an untasked session except by reply or by a subscription the session made (§6.2), or a task by anything but
  its id on this machine;
- write a task tag, or any tag outside `adapter.<name>.*`, or one on a session it may not deliver to;
- send a key, answer a dialog, or deliver as the user (the delivery is the `inbox` mod's, never tmux);
- be declared from a frame, the PWA, MCP or another machine.

Audited under its own origin, `adapter`: `op=start|exit|restart|refused|failed|stop` with the name, an exit code and a
reason, and per message `op=deliver dir=in` (adapter to session) and `op=message dir=out` (session to adapter),
with task ids, kind, byte count and outcome. Never text, a `from` label, a message id, an argv word other than
`argv[0]`'s basename, or anything the adapter printed.

#### 6.7 Checked against three kinds of tool

| Need                                                            | A hosted workspace agents attach to  | A team chat bridge | A work tracker             |
| --------------------------------------------------------------- | ------------------------------------ | ------------------ | -------------------------- |
| Turn state of each session (busy, idle, needs input), lifecycle | `session`, `task`                    | `session`          | `task`                     |
| A stable key per session                                        | `session.id` (conversation), task id | `session.id`       | task id                    |
| Its own id and state on the session                             | `adapter.<name>.*` tags (`tag`)      | same               | —                          |
| Text into a session, held while idle or waking it               | `deliver`, note or `wake`            | `deliver`          | —                          |
| Whether and when it landed                                      | `result`, `delivery`                 | `result`           | —                          |
| A session talking to the tool, and the tool answering           | `adapter:<name>`, `toSession`        | same               | —                          |
| Inbox lifecycle (seen, deferred, declined, done, options)       | the tool's own CLI, by `session.id`  | same               | —                          |
| PR URL and done                                                 | `session.prUrl`, `task` `done`       | —                  | `task`                     |
| Start or resume a session for an item nobody holds              | **no** (open question 5)             | —                  | **no**                     |
| Create, amend or settle tasks                                   | —                                    | —                  | **no**: orchestrator.md §1 |
| Tasks queued but not yet placed on any machine                  | —                                    | —                  | **no** (open question 6)   |

The first two fit the seam as it stands. The tracker's core needs (create and amend tasks, see the whole queue)
are the queue's, which this seam is forbidden on purpose; it gets state out from here and writes through an
orchestrator session (docs/orchestrator.md). A fourth, an output-only tool (a desktop notifier, a time log), is
`wants: ["sessions"]` and nothing else, which the handshake allows.

**Rejected:**

- **An adapter dialing the local socket and naming itself.** Any process of the same user could claim the name.
  Peer-pid binding names a pane, not a program.
- **An inherited socketpair on fd 3** (the first draft). It removes the rendezvous, but so do stdin and stdout,
  which every language and runtime has with no extra fd plumbing, as MCP's stdio transport does. The cost is
  that an adapter that prints to stdout breaks its own stream; that is the adapter's bug, answered `invalid` and
  restarted.
- **An adapter loaded into the daemon (`import()`).** Third-party code inside the process that holds the PSK, a
  service-delivered credential and every invariant above.
- **An adapter as an MCP client of `seance mcp`**, or as its own app-role relay client. Both are fleet-wide and
  hold, or need, the PSK: the opposite of a local program trusted with this machine's sessions.
- **The daemon calling the tool itself** (a webhook out, a tool URL in Séance's config). Séance would hold a tool's
  address and credentials, which is the coupling the brief forbids.
- **One adapter for the fleet, on the leader.** Leadership moves, delivery happens on the machine with the pane, and
  the leader keeps nothing a message carries (D2).
- **The adapter installing its own Claude mod.** Two mods would deliver into one session, with no shared rule for
  wake, and Séance would lose its say over what reaches a session.
- **A `boundary` delivery mode** (above). Kept out until a tool needs it.
- **An opaque `data` field passed through unread** (§6.2, review point 2).
- **Keeping the hour for adapter replies, or lengthening it** (review point 3). A longer-lived bearer, still bound to
  one process, still useless across `--resume`; replaced by the subscription.

#### Review points settled (2026-11-17)

From a review of §6 as drafted on 2026-11-14 against a hosted-workspace tool's own wire and inbox contracts:

1. **Identity join.** A session could not learn the key the adapter attached it under. Settled by `agent.session`
   (docs/tags.md §4): the record carries `session.id`, `send_message` returns it, and the session knows it.
2. **Text-only replies lose the tool's inbox lifecycle; messages to an adapter have no addressing inside the tool.**
   Settled: structured acts through the tool's own CLI, keyed by the conversation id; the `data` field rejected (§6.2).
3. **The hour vs a tool's long-lived asks.** Replaced by the subscription (§6.2; D3 amended as above).
4. **`session-gone` had no reason, and nothing said which id is stable across `continue_task`.** `reason` is `exited`,
   `closed` or `replaced`; the conversation (`session.id`) is the stable id (§6.1).
5. **The `repos` example used a forge path; `Session.repo` is the scan-set name.** Fixed (§6.5), and `repos` now
   filters untasked sessions and messages to `adapter:<name>` (§6.2).
6. **`Session` gains the joined `tags` map and a `name`**, an untasked session's name follows docs/tags.md's
   precedence, and after a daemon restart state reads `unknown` until the next event, which is expected (§6.1).

### 7. Build order

Small PRs, each landing on its own:

1. **Local delivery. Built 2026-11-13.** The `inbox` mod (listener child, `read_messages`,
   the delivery table), the `inbox` and `message` local-socket frames, the in-memory inbox, the
   `--append-system-prompt` constant, MCP `send_message` for tasks on this machine,
   `CAPABILITIES.messages`, and audit origin `message`. Alone, this gives cross-account messaging
   between sessions on one machine, since exclaves share a daemon.
   - Spike first (§1's three items).
   - Tested by: `bun:test` on the local socket with a real peer (the session-events tests'
     fixtures), covering binding, refusal on a null pid, one listener per pane, inbox caps and
     clear-on-rebind; the mod via `claude plugin test` (local only, skipped in CI); one live run
     per platform.
2. **Cross-machine. Built 2026-11-14; the record is DESIGN.md, "Cross-machine".** `session-message`, the
   leader's resolve, forward and receipt, `deliver-message`, `message-receipt`,
   `CAPABILITIES.messageRoute` and the chain resolution in the scheduler library.
   - Tested by: `scheduler/` unit tests for resolution over successor and continuation chains;
     leader tests for the admit rule (wrong machine, `from: "app"`); and an e2e test
     (`e2e/messages.test.ts`) with the claude stub across two daemons, covering delivered both ways,
     ended, offline, and a superseded predecessor whose chain breaks and is then completed. The held
     phase (a successor still waiting) is covered in `scheduler/` and the leader's unit tests only: a
     successor placed through `succeeds` dispatches at once and ignores `deps`, so the e2e cannot hold one.
3. **Adapter seam** (§6), in three PRs, each landing on its own:
   - **3a. The child and state out. Built 2026-11-18; the record is DESIGN.md, "Adapters".** Needs docs/tags.md's PR 1 (the vocabulary, `agent.session` and its
     verification). `config.json` `adapters` and its parser, the supervisor (env,
     process group, backoff, `failed`, stop with the daemon, the unread cap), the handshake and versioning,
     `snapshot`, `session` (with `session`, `name` and `tags`), `session-gone` with its `reason`, and `task`, `shared/src/adapter-protocol.ts` and its committed JSON
     Schema, the reference adapter, and audit origin `adapter`'s lifecycle lines. Useful alone: an
     output-only tool works after it.
   - **3b. Delivery in and messages out.** `deliver`, `result` and `delivery`, `kinds` and `repos` (both directions),
     the adapter wrapper in `shared/src/messages.ts`, the rate buckets, `adapter:<name>` in `send_message` and
     the `message` frame out, replies both ways through the `sent` table, the subscription (docs/tags.md §8:
     `conversations.json`, `toSession`, `subscribed`, `leave`, `ambiguous`, `unverified`, `send_message` returning
     `session`, `adapter add` dropping a name's subscriptions), the `tag` frame, and the `op=deliver` and `op=message`
     audit lines.
   - **3c. Installing.** `seance adapter add | remove | restart | status`, `seance-adapter.json`, the
     recorded commit and `doctor`'s checks, and README's setup step with §6.3's trust statement.
   - Tested by: daemon tests with the reference adapter as a committed stub, linked and exec'd once in
     `beforeAll` (CLAUDE.md, Testing), covering the handshake and a protocol refusal, snapshot and
     session events from real `session-event` frames, delivery by kind and `wake`, a reply round trip in
     both directions (the adapter answering a session, and a session answering the adapter's question),
     every refusal (`unknown`, `too_long`, `rate_limited`, `refused`), a malformed line, the unread cap,
     a subscription surviving a `claude` restart with `--resume` and a daemon restart, refused for an unverified
     sender (`subscribed: false`, reply still works), `ambiguous` with two panes on one conversation, `unverified`
     after a `/clear` the file shows, ended by `leave` and by `adapter add` under the same name, and refused for a
     session outside `repos`; `session-gone` with each `reason`, and a `/clear` sent as one `session` with the new `session.id`;
     `state: "unknown"` for every session in the snapshot after a daemon restart; a `tag` on an unsubscribed
     conversation refused and another adapter never seeing it;
     restart with backoff and the `failed` hold, stop with the daemon by process group, and the env
     without `CREDENTIALS_DIRECTORY`; a layering test that nothing in the adapter modules reads message
     text into `log.ts` or `audit.ts`.

**Replies by handle (D3, amended). Built 2026-11-14; the record is DESIGN.md, "Replies by handle".**
`inReplyTo` with no `to`, the `sent` and `received` tables, the `claude`-process binding, `wake`,
`CAPABILITIES.messageReply`, `replyTo` and `origin` on the routed ops.

- Tested by: `daemon/test/messages.test.ts` with real peers, including the restart that matters most (a second
  `claude` stub under the same shell pid must not read the first's replies or answer its questions, also in a pane
  whose start command names `--remote-control`, under a wrapper named `claude` that runs it twice, and with a `claude` nested
  under another; and a shell's child with no `claude` above it holds no handle but still sends by task id); leader tests
  for forwarding by `replyTo` and the `messageReply` gate; the mod's test for `wake`; and an e2e test
  (`e2e/messages.test.ts`) where a session with no task asks a task on the other machine and is answered by id, with
  a wake, and answers back.

## Threat model

PR 1's part is built and recorded in DESIGN.md (Threat model item 6; Local op socket, "Session
messages"; and CLAUDE.md's local-socket bullet): the `inbox` frame is the first on the local socket
that _reads_ something a session did not write itself, so a reader is bound by kernel peer pid, never
by a field, and refused where the host cannot name a peer. PR 2's part is built too (DESIGN.md, Threat
model item 6, and CLAUDE.md's messaging bullet). What PR 2 added and PR 3 will add, each to be kept:

- **The leader honours a request only sealed by the right sender, through its own parser and the one
  `schedulerGuard`.** `session-message` is from a daemon only, `parseSessionMessage`, the same guard.
- **An event moves only a task placed on the machine that sealed it.** A `session-message` is
  accepted only when its `fromTask` is placed on the sealing machine. It moves no task at all.
- **A daemon acts on a scheduler op only sealed `from` the scheduler (or in process).**
  `deliver-message` and `message-receipt` follow this.
- **Every surface audits under its own origin, never reusing one.** `adapter` is the new origin PR 3
  adds, beside PR 1's `message`.
- **An adapter is the owner's code at the owner's uid, not contained** (§6.3). The invariants PR 3 keeps
  are Séance's own: an adapter is declared only in the machine's `config.json` and run only as that argv;
  it is reached only over its own stdin and stdout, never a socket a process could dial; it gets no
  prompt, attachment, session-to-session message, account id or key, and message text only when a session
  addressed it; it delivers only by the `inbox` mod's local delivery, under its own wrapper, kinds and
  rate buckets, to a task this machine's launch ledger holds or by reply; it writes nothing to the queue,
  the store, the leader or the relay; and nothing it sends or prints is logged.
- **A verified conversation id addresses one thing, adapter delivery on its own machine, to a subscribed
  conversation** (docs/tags.md §4, §8), refused when two live panes claim it. Wording it changes, in PR 3b: CLAUDE.md's
  messaging bullet ("A session with no task is reached only as a reply, by the id of a message it sent") gains "or by an
  adapter on its own machine through a subscription the session made by messaging it, keyed by its verified
  conversation id: kept at rest in `conversations.json`, refused when two live panes claim the id, usable only over
  that adapter's stdin"; DESIGN.md, "Replies by handle", Rejected, "the Claude session id", narrowed as §2 here.
- **A service-delivered credential never leaves the daemon process.** An adapter's env drops
  `CREDENTIALS_DIRECTORY`, as a session's and a trait probe's do.
- **Traits are declared only in the machine's own `config.json`; probes run only that argv.**
  Adapters follow the same rule (§6).
- **Nothing reachable from `seance mcp` calls `log.ts`.** PR 2 adds no `seance mcp` code that logs.
- **A reply handle is a bearer, so it is bound.** A message id is `crypto.randomUUID`, unguessable and in no log or
  audit line. The replier's daemon accepts it only from the pane, pid, task and `claude` process the message was placed
  for, and the asker's daemon delivers only to the pane, pid, task and process that sent it while it runs; the leader
  keeps no table. Built (DESIGN.md, Threat model item 6).

## Open questions

1. **May a session send a request while handling one?** Resolved in PR 1 (DESIGN.md, "Session
   messages", Rate limit): yes, bounded by the rate limit, and the wrapper names the message id it
   replies to. Rejected: notes only until the turn ends, which the mod could enforce, since it knows a
   request's turn is running.
2. **Should a question also wake when it is long?** Resolved by spike check 3, on both platforms: a
   pushed stub was heeded with the standing instruction on the spawn's command line only (Linux 2.4 s
   idle and mid-turn; macOS 4 of 4), and with none at all (macOS 3 of 3), so a long question keeps the
   stub path. Whether a pulled question gets an answer through `send_message` is still untested.
3. **The MCP channel** (`--channels`): one push covers mid-turn and wake. Worth revisiting once
   `allowedChannelPlugins` can be set org-wide without a startup dialog.
4. **A sender-side "who can I message" view** beyond `get_queue`. Wait for use.

The adapter seam's (§6), each with a recommendation:

5. **May an adapter start or resume work** (spawn, continue, enqueue, amend)? A workspace tool would like a
   session resumed for an item whose session is gone, and a tracker needs to create and amend tasks.
   _Recommend no, not in this seam._ Route it through an orchestrator session the adapter delivers to
   (docs/orchestrator.md §1), so a person or an agent with a fence decides what runs. If that proves too
   slow, a per-adapter `grants` key is its own threat-model change, later.
6. **A fleet-wide queue view out** (tasks not yet placed on any machine)? _Recommend no for now._ Each
   machine's adapter covers the sessions; unplaced tasks reach a tool through whoever queued them.
7. **Addressing an untasked session beyond a reply** (D3)? **Settled 2026-11-17 by the subscription**
   (docs/tags.md §8; §6.2): a session that messages `adapter:<name>` is reachable by that adapter for its
   conversation's life. Still no general address: only that adapter, only that machine.
8. **Session-to-session message metadata out** (who messaged whom, when)? _Recommend no, not even counts._
   It is the mailbox-shaped record D3 rejected keeping at the leader, handed to a third party instead.
9. **`request` from an adapter by default?** _Recommend off_, opt-in per adapter in `kinds` (§6.3), since
   whoever can write into the tool can write into the session.
10. **Contain the adapter** (the custodian round's masks with a network allowlist for the tool's host)?
    _Recommend not in PR 3._ State the same-uid trust plainly (§6.3); revisit before any adapter the owner did
    not write is installed. Containment would have to be drilled as the custodian's was before it is claimed.
11. **An external ref on a task in state out**, for a tool to map a task to its own object without keeping a
    map? **Settled 2026-11-17**: `Session.task.ref`, the dispatched `creator.ref` (docs/tags.md §5.4, §6.1).
12. **Adapters on the Machines row** (a `MachineStatus` field)? _Recommend later_; `seance adapter status`
    and `doctor` first.
13. **State in beyond messages** (a tool setting a label, a flag or done on a task)? **Partly settled
    2026-11-17**: an adapter may set its own `adapter.<name>.*` tags on a session (§6.1 `tag`), memory only, on its
    machine. Nothing on the task record: a flag or done touches the leader's record, which §6.6 keeps out of the seam.
14. **The spec's `linear` field names a tool**, against the brief's rule. **Settled 2026-11-17**: it becomes the
    task tag `creator.ref` (docs/tags.md §5.4), which is also orchestrator.md's `ref`.
