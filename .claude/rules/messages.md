---
paths:
  - "daemon/src/{messages,send-message*,message-frame*,inbox-cli,leader-messages*,local-socket,mcp}.ts"
  - "daemon/test/{messages,message-layering,message-route-handler}*.ts"
  - "shared/src/messages*.ts"
  - "scheduler/src/message-route.ts"
  - "claude-mods/**"
---

# Session messages

Requirements, not observations. DESIGN.md's "Session messages" and its "Cross-machine" and "Replies by
handle" subsections are the record; docs/messaging.md keeps the spikes and D1–D4. CLAUDE.md's recurring
rules (peer-pid binding, data-channel stdouts, no text in logs, a new act is a threat-model change) hold
throughout.

## Local delivery: the `message` and `inbox` frames

- The local socket's fourth and fifth frame kinds are `message` (`send_message`,
  `daemon/src/send-message.ts`) and `inbox` (the `inbox` mod's `seance inbox` child,
  `daemon/src/messages.ts`). Both are bound only by peer pid: refused `unbound` where the host names no
  peer (`peerPidSupported`; an `inbox` listener there is told `unsupported`, not `unbound`, since no retry
  can bind) or the pid came back null, never falling back to a claimed pane. Giving either frame any
  other act, or binding by a field, is a threat-model change.
- `inbox` is the first frame that hands text out, and binds once at accept. There is one listener per
  pane, closed (lazily, at the next send or listen) when the pane's task changes. Every bound pane is
  acked, an untasked one included: no task id reaches it, but a reply by handle (below) can.
- The daemon's inbox is memory only (32 messages, `4 × MESSAGE_MAX`), cleared on `ended`, rebind and
  restart.
- A message addressed by task id is delivered only to a live pane carrying a task this machine's launch
  ledger holds, and a sender counts as tasked only when the ledger holds its pane's task.
- Text is never in argv: `--append-system-prompt` carries only the constant `STANDING_INSTRUCTION`, on
  tasked spawns.
- The mod delivers only by `$.prompt.submit` or `$.session.append`, never `asUser`, `$.prompt.fill` or
  tmux keys.
- A sending task may send 20 messages a minute and 200 an hour.
- The daemon's second way into a pane's inbox is `Messages.deliverAsCustodian` (a custodian `nudge`): it
  binds no peer (the `custodian` frame was bound to the round's pane) and has no rate bucket (the verb's
  counts bound it), but it addresses only a live pane carrying a task the ledger holds, and only the pid
  and task the verb counted under.
- `send-message.ts` and `message-frame.ts` are in `seance mcp`'s closure, and `inbox-cli.ts` is silent
  because its stdout is the mod's data channel.

## A session with no task

**It is reached only as a reply, by the id of a message it sent, or by an adapter on its own machine
through a subscription the session made by messaging it, keyed by its verified conversation id**
(DESIGN.md "Replies by handle" and "Adapters"; docs/messaging.md D3, amended; "Tags and session
identity").

- The subscription is kept at rest in `conversations.json`, refused when two live processes claim the
  id, usable only over that adapter's stdin.
- A reply's `message` frame carries `inReplyTo` and no `to` (or the same id as `to`, which is the same
  reply).
- Two memory-only tables, 1 h and 256 entries each (past the cap the oldest entry of the busiest pane
  goes, a note's before a question's), hold a handle: `sent` (ids this daemon minted, for the asker) and
  `received` (ids placed in a pane, for the replier).
- A message id is `crypto.randomUUID`, so the id is a bearer handle and no audit line, log line or warn
  carries one (the audit names the recipient as the constant `reply`).
- **Every entry binds the `claude` process, not the pane and its pid alone** (`Bound.session`:
  `<pid>:<start time>` of the innermost process on the peer's chain, peer first, that is called `claude`
  (`sessionOf`, read by `processNames`; a name is a hint any process can take, and only the innermost
  counts, so a wrapper script named `claude` is never the session), never from the pane's start command,
  `BoundPane.ours`, nor the executable's path). None on the chain is no session: that peer still sends by
  task id and listens where its task was launched here, but holds no handle, `sent` entry, `received`
  entry or `wake`. Why: a hand-started session's pane process is the shell, which outlives a restarted
  `claude`, and no `ended` fires for an untasked pane.
- A reply is accepted only from the pane, pid, task (null staying null) and session the message was
  placed for (`unknown` otherwise, in the sender's own rate bucket), and reaches the asker only at the
  pane, pid, task and session the `sent` entry names, while that `claude` still runs, the same process
  by start time as well as pid (`ended` otherwise): held for no other session, never given to the next
  `claude` in the same pane, and a held reply meets a listener of its own session only (`only`).
- A listener's bind drops every handle of its pane made for another pane process or task, or for a
  session that no longer runs.
- A reply to an asker on another machine goes through the leader as a `session-message` carrying
  `replyTo` (`{id, deviceId}`) and no `to`. The leader resolves nothing for it, forwards it to
  `replyTo.deviceId` only while that machine advertises `CAPABILITIES.messageReply` (`unsupported`
  otherwise), with `origin` the sealer's id (what a later reply routes back to), and the target daemon's
  own `sent` table decides. A client sends a reply to another machine only after the verified-leader
  gate for `messageReply` (`messageRouteGate("reply")`).
- `wake` is on an inbox line only when the daemon's own `sent` table says the message answers a question
  or request that this pane's session sent (never from a frame), and only on that session's listener, or
  when an adapter's `deliver` carried `wake: true` (the adapter's own frame, on stdin, never a
  session's); the mod then submits even a note.

## Cross-machine: the leader routes and keeps nothing

DESIGN.md, "Session messages", "Cross-machine".

- A `message` frame carries `route` only as `"ask"` or `"send"`. `ask` is answered `remote` (in a rate
  bucket of its own, same limits, so a loop of asks is bounded and a routed message is one count in each
  bucket), and `seance mcp` sends `send` only after it found the **verified** leader advertising
  `CAPABILITIES.messageRoute` (`messageRouteGate`), never on the daemon's own word. That gate is the
  client's: the daemon routes any `send` a bound pane makes, and what binds the message is the leader's
  admit rule below, never an assumption that the sender was gated. A frame with no `route` is answered
  as before (`unknown`/`ended`), never `remote`.
- A routed text is held to `MESSAGE_ROUTE_MAX` of JSON-escaped bytes. The daemon sends `session-message`
  only sealed `from` its own device id (or in process), with `fromTask` only for a task its own ledger
  holds.
- The leader honours it only when it is not sealed `from: "app"`, parsed by `parseSessionMessage` into a
  fresh value, past the one `schedulerGuard`, and sealed by a registered machine; a `fromTask` only when
  the leader's own list places or reserves that task on the sealer (`elsewhere` is dropped with no
  receipt; `absent`, a pruned task, is forwarded without naming `fromTask`, its receipt still going to
  the sealer, whose own ledger bound it).
- The sender's machine name reaches the receiver's wrapper only through `displayTitle`'s scrub, cut to
  `ROUTING_ID_MAX_LENGTH`.
- The leader resolves the target only through its own list (`resolveMessageTarget`), forwards
  `deliver-message` only to a connected machine advertising both `messages` and `messageRoute` (this
  leader's own machine, when the registry lacks it, is delivered to in process: the leader is that
  daemon), for the task its own resolution chose (`settled` only for a finished record), sends
  `message-receipt` (ids, kind and an outcome; never text) only to the machine that sealed the message,
  keeps nothing and logs no line per message, title or id, only a drop or a failed forward or receipt
  that names a task or machine id.
- A daemon acts on `deliver-message` and `message-receipt` only sealed `from` the scheduler (or in
  process), through their own parsers; delivers only to a live pane carrying a task its own launch ledger
  holds (a `deliver-message` for another is `unknown`), or, for a `replyTo`, to the pane and session its
  own `sent` table names; de-duplicates a forward by message id, and a receipt by id and outcome, for
  `REPLAY_RETAIN_MS`; and hands a receipt only to the pane its own `sent` table says sent that message
  (an untasked sender's only way, to its session alone) or else the pane carrying the sending task, as
  the one fixed line `receiptNote` makes per outcome, never message text.
- A third audit line, `dir=receipt`, carries ids, kind and outcome with `bytes=-`.
