# Session presence — spec

**Status: draft 2026-11-17, nothing built. The owner decided O1 and O2 (below) on 2026-11-17; the rest is proposed.** Three features borrowed from huddle
(`pengefix/huddle`, `origin/main`): a one-line `doing` a session declares about itself (§1), status questions
answered from presence without waking anyone (§2), and coalesced wakes (§3). Each stands on its own and lands on its
own; each also feeds the adapter seam (docs/messaging.md §6, as revised in draft PR #486), which none of them depends
on. Like docs/messaging.md, this file is the working record until the code lands; each part folds into DESIGN.md as
it is built, and its text here goes.

**Decided by the owner (2026-11-17):**

- **O1. The custodian's `sessions` verb carries `doing`** (§1, D1.6), as its own PR (PR 4).
- **O2. The standing instruction tells sessions to keep `doing` current** (§1, D1.7), in PR 1.

**Why a file of its own, not a docs/messaging.md section.** `doing` is not messaging: it is a session event that
three readers (the PWA, the custodian, the status answer) consume, and it would sit awkwardly in a file about delivery.
§2 and §3 are messaging, but docs/messaging.md's open edit is #486's §6, and a second branch rewriting the same file
would make one of the two rebase prose. When §2 and §3 land, their record goes to DESIGN.md, "Session messages", as
PR 1's and PR 2's did, so the split costs nothing later.

## What huddle does (read from `origin/main`)

- **`doing`** (`contract/wire-v1.json`: `Heartbeat.doing`, `Session.doing`). The attaching client sends
  `{type: "heartbeat", doing?, turn}` on a timer, `turn` one of `running`, `idle`, `unknown` (`Turn`); the server
  keeps the latest `doing`, `turn` and `turn_since` per session and shows them on its page ("doing: Edit x.rs").
  Free text, no cap in the contract. The client's harness supplies it, so it may be derived (a tool name) or declared.
- **Nudge once** (`crates/huddle-server/src/inbox.rs`, `nudge_check`). When a session's open-item count goes from 0
  to more, one `nudge` frame (`{open, oldest, asks}`: ids, no text) goes to its attach, and none while it stays
  non-empty; the flag resets when the count returns to 0. An idle session is not nudged unless an open item asked to
  `wake`. The session then pulls its inbox.
- **The idle self-answer** (`presence_answer`, `file`). A `status-ask` with no `wake` to a session that is idle or not
  connected is answered by the service at once, from presence, and filed `answered` by `huddle`:
  "`<display>` is idle since `<turn_since>`, last doing: `<doing>`, item `<item>`. Not woken; ask again with wake to
  wake it." (or "is not connected (last seen …)"). Nobody is nudged. A running session gets the ask as usual.

What Séance has today, and the gap each section closes:

| Huddle           | Séance today                                                                                                            | Gap                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `doing`          | the window title (display-only, set once), `Task.inputReason`/`inputTool` while it waits, the state from session-events | nothing says what a session is working on now, so a peer or the person must ask it, or read its screen |
| idle self-answer | a `question` to an idle session is `$.prompt.submit`: it wakes the session and spends a turn                            | "what are you doing?" costs the target a turn, and an idle answer is usually "nothing, waiting"        |
| nudge once       | every `question`, `request` and `wake` note is its own `$.prompt.submit` (§3 shows this)                                | a burst of N messages to a busy session costs N turns after the current one                            |

## 1. `doing`: a line a session declares about itself

### Decisions

**D1.1 Set by an MCP tool, `set_doing`, on `seance mcp`.** `{ text: string }`; an empty string clears. It sends a
`session-event` frame carrying `doing` alone (`{v, kind: "session-event", doing, pane?}`), the shape `handoff` and
`pass` already take, over the local socket. A frame carrying `doing` carries no `state`, `handoff`, `pass`, `prUrl`
or `done`; one that does is refused `invalid`. `seance session-event` (the mod's CLI path) drops a frame carrying
`doing` unsent, as it drops `done`, `handoff` and `pass`: the mod's hooks never set it.

- **Bound by the kernel-reported peer pid, never by a field**, like every session-event frame: the peer is the
  `seance mcp` process, whose ancestor chain names the pane. The frame's `pane` decides only on a host that names no
  peer at all (`peerPidSupported`), as for state reports.
- **Bound to the `claude` process too** (`Bound.session` from "Replies by handle": the innermost `claude` on the
  peer's chain, `<pid>:<start>`). A pane with no `claude` on the chain is refused `unbound`: a `doing` belongs to a
  session, and the shell a hand-started session runs under outlives its `claude`.
- **Tasked and untasked panes alike.** An untasked session's line shows on the Machines screen's session list; only a
  task is reachable by a status question (§2), so nothing else reads it there.

**D1.2 The text is scrubbed, capped and display-only.**

- **Scrub** at ingest, by a new `displayLine(raw, max)` in `shared/src/messages.ts`: whitespace runs fold to one
  space; C0, DEL and C1 controls, format characters (`\p{Cf}`, which covers the bidi overrides and zero-widths),
  line and paragraph separators, lone surrogates, the backtick and the double quote are dropped; the result is
  trimmed. `displayTitle` stays as it is (`displayLine` is the stricter sibling: a window title reaches a wrapper,
  a `doing` reaches the PWA, a round and another session).
- **Cap** `DOING_MAX` = 120 code points after the scrub, cut on a code point. Over it is cut, not refused: a session
  that wrote a long line still meant to say something. Empty after the scrub clears.
- **Display-only.** It binds, routes, moves, settles and alerts nothing: no scheduler decision, no drain timing, no
  custodian act, no notification reads it. It is never logged, never audited as text, never in argv, `progress`,
  `MachineStatus`, a store record, a push or the archive.
- **Rate.** At most 30 sets a minute per session, in memory; past it `rate_limited`. Nothing leaves the machine on a
  set, so this only bounds a looping session's churn of the PWA's next read.

**D1.3 Kept in the daemon's memory only, beside the pane's state.** `PaneActivity` (`daemon/src/pane-activity.ts`)
gains `doing: { text, at, session } | null`. Today that tracker runs only while a custodian seat does; §1 and §2 need
the state half always, so **the state and `doing` retention run unconditionally for every bound pane**, and the
screen sampler stays the custodian's alone. Retention, not an act, as now. Not persisted: a daemon restart forgets
every `doing`, and a session that wants one back sets it again.

**D1.4 How it clears.** Not at a turn's end: an idle session's last `doing` is what a status question most wants
("last said, 40 minutes ago: waiting on CI for #512"), which is huddle's "last doing". It clears on:

- `set_doing` with `""`;
- `ended` for the pane, or the pane gone from tmux;
- a different `claude` process in the pane (the stored `session` no longer matches the bound one: `/exit` then
  `claude --resume`), or a different task on it (`@seance-task` changed);
- a daemon restart.

An in-process `/clear` or `/resume` keeps it (the mod reports neither, and `@seance-task` does not change); every
reader shows its age, so a stale line reads as stale. **Rejected:** clearing at `turnEnded` (loses exactly the line an
idle-status answer wants); a TTL (an age shown beside the line does the same job without deciding for the reader).

**D1.5 Where it surfaces.**

| Surface                                         | Carries `doing`?                                                  | Why                                                                                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessions` op (`SessionEntry.doing`, `doingAt`) | yes                                                               | The app-role reply the PWA's Machines screen already reads; sealed to the app. Dropped first when the reply would pass `REPLY_JSON_BUDGET` (120 code points × a list of sessions can matter on a busy box).              |
| PWA Machines session list                       | yes, with its age                                                 | Rendered as text (Preact escapes), on its own line, prefixed "doing:".                                                                                                                                                   |
| PWA Queue screen, a running task's card         | yes, read from its machine's `sessions` reply, joined on `taskId` | Fetched when the card's details open, not on every queue push. No store field (rejected below).                                                                                                                          |
| MCP `get_sessions`                              | **no**, stripped by `seance mcp`                                  | A session-chosen string in another agent's context, the reason `get_queue` never carries `inputTool`. The sanctioned way for one session to read another's line is §2, inside Séance's own fixed wrapper.                |
| MCP `get_queue`                                 | **no**                                                            | Same reason, and the queue has no field for it.                                                                                                                                                                          |
| `MachineStatus`                                 | **no**                                                            | 1.5 KiB of ciphertext (`STATUS_MAX_CT_LENGTH`) for the whole machine; a per-session text field would be the first thing `fitStatus` trims, and the 30 s beat would carry it to every app and the leader for no decision. |
| Custodian `sessions` verb                       | yes, from PR 4 (below), labelled                                  | D1.6 (O1).                                                                                                                                                                                                               |
| Status answer (§2)                              | yes                                                               | The point of §2.                                                                                                                                                                                                         |
| Adapter `Session` record (#486)                 | later, `doing?` and `doingAt?`                                    | The same in-memory value; the adapter protocol adds the field when it is built. Nothing here waits for it.                                                                                                               |

**D1.6 The custodian's `sessions` verb carries it (O1).** Each session's line in the verb's reply gains
`doing (self-reported, <age>): "<text>"` when one is held, scrubbed by `displayLine` and capped at `DOING_MAX` like
every other reader's copy. It spares a round a `capture` for a session whose line already says "waiting on CI for
#512". It is session-chosen text reaching a round, but a round already reads the same session's screen through
`capture`, which carries far more of it, and the round's acts stay behind the daemon's own checks: `closeVerdict`
decides at rest by the daemon's facts and never reads `doing`, and `nudge`, `interrupt` and `flag` keep their own
gates. The round's constant seed gains one sentence: a session's `doing` is its own claim, never evidence that it is
at rest, finished or stuck. No mask, fence, built environment or socket changes, so no re-drill (docs/custodian.md,
item 4b's rule). Like the rest of a round's reading, the line is never logged, audited, put in `rounds.jsonl` by the
daemon or kept past the reply.

**D1.7 The standing instruction asks for it (O2).** `STANDING_INSTRUCTION` (`shared/src/messages.ts`) gains one
sentence: "Keep a one-line status with set_doing when your focus changes; other sessions and your user read it." It
is a constant on every tasked spawn's command line, so the cost is one sentence per spawn and no wire text. Measured a
week after PR 1 lands, by reading `sessions` replies across the fleet: if most lines are stale or absent, the
fallback is a prompt at turn end (open question 4), not a hook that writes the line for the session. A hand-started
session gets no standing instruction (as today) and sets a line only if asked to.

**Rejected:**

- **`Task.doing` in the store**, written by the leader from a forwarded event. Every change would be a term-fenced
  store write and a `queue-changed` push to every app, the archivist would have to strip it (session-chosen text, like
  `flag.note`), and an older leader rewriting the record drops it. The Queue card's need is met by one `sessions`
  read when its details open. Revisit only if the person wants the line on the collapsed card.
- **Deriving `doing` from the session's tool calls in the session-events mod** (huddle's "Edit x.rs"). A tool's input
  can carry a secret, a tool name alone says little (`inputTool` already covers the waiting case), and it would be a
  report per tool call. A session that wants to be read says what it is doing.
- **Riding `doing` on every state report.** The mod has no source for it, and a state report is two or three per turn
  already.
- **The window title as the line** (the tmux-rename mod sets it). It is set once from the task and must stay stable:
  the PWA and wrappers use it as a name.

### Threat model

`set_doing` adds no act: it is a session-event the ingest binds by peer pid and retains. What is new is a
**session-chosen string that other readers display**: the person (PWA), a custodian round (D1.6) and
another session (§2). Each reader gets it scrubbed (`displayLine`), capped, and labelled as the session's own claim
with its age. It cannot reach a reader that the session could not already reach with more text: a tasked session can
already message any task, and its screen is already what a round's `capture` reads. Residual: a same-uid process on
the machine can set a pane's line (as it can a pane's state today); it lies only to readers who already treat it as a
claim.

Wording this changes, in the same PR as the code:

- CLAUDE.md, local-socket bullet, "The frame's other carried claims are `remoteSession` …, `reason` …, `tool` …":
  add `doing`: sent only by `set_doing` (`seance session-event` drops it unsent), bound to the pane and its `claude`
  process, held to `displayLine` and `DOING_MAX`, display-only, memory only, never logged, audited, persisted or in
  `MachineStatus`, a store record, `get_sessions` or `get_queue`.
- CLAUDE.md, same bullet, "Keeping each `ours` pane's last state and `turnEnded` … only while a custodian seat runs":
  the state half and `doing` are kept for every bound pane always; the screen sampler stays the seat's.
- DESIGN.md, "Session events": the frame shape, the `doing` bullet, "Per-pane retention"; MCP server: `set_doing`; the
  `sessions` op's `SessionEntry`; "Session messages" (the standing instruction's added sentence); Threat model item 6
  (the session-chosen line and its readers).
- With PR 4: CLAUDE.md, custodian frame-kind bullet, where the flag's note is "never … returned by `sessions`": add
  that `sessions` returns a session's `doing`, labelled self-reported with its age, scrubbed and capped, and that no
  verb's verdict reads it; DESIGN.md, "The custodian frame kind" (the `sessions` reply) and "The custodian's seat" (the
  seed's sentence).

## 2. Status questions answered from presence

### What happens today

A `question` is `$.prompt.submit` (DESIGN.md, "Session messages"; `claude-mods/inbox/hooks/register.ts`, `onLine`): to
an idle session it starts a turn at once; to a busy one it starts a turn after the current one. Either way the target
spends a turn, and most status questions to an idle session get "idle, waiting for X", which the daemon already
knows.

### Decisions

**D2.1 A new message kind, `status`, never a flag on `question`.** `send_message { to, kind: "status" }`, no text
(a `status` carrying text is refused `invalid`). It addresses a task only (`to`), never a reply by handle: a session
with no task has no presence anyone asks about.

- A kind is refused by an older parser (`isMessageKind`), so a mixed fleet fails closed: the asker hears `invalid` or
  `unsupported` and nothing is delivered. A flag (`presence: true` on a `question`) would be dropped by an older
  daemon's or leader's parser and the question delivered: the wake the flag exists to avoid.
- **No `wake` on it.** Huddle's `status-ask` carries `wake` because its kinds are fixed per item. Séance's sender
  picks the authority per message (owner's decision, docs/messaging.md): to ask the session itself, send a `question`.
  The answer's fixed text says so. **Rejected:** `wake` on `status` (a second spelling of `question`).

**D2.2 The target's daemon answers, always, and nothing is placed in the target's pane.** It holds the facts: the
pane, its task (`@seance-task`, checked against its launch ledger), the retained state, `stateSince`, `turnEnded`,
`reason` and `doing` (§1, D1.3). The leader never answers from its own record of a session's state: it is a step
behind the daemon, and it would have to keep presence text it must not. The answer, by state:

| Target                                | Answer                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| live pane, state `busy`               | `busy since <t>`                                                                                              |
| live pane, `idle` with `turnEnded`    | `idle since <t>, its turn ended`                                                                              |
| live pane, `idle` without `turnEnded` | `idle since <t>`                                                                                              |
| live pane, `needs-input`              | `waiting for your user since <t>` with `(a question)` or `(a permission)` by `reason`; never the tool name    |
| live pane, no state retained          | `state unknown` (its account may lack the session-events mod, or the daemon restarted since it last reported) |
| no live pane                          | the existing `ended` outcome; no presence                                                                     |
| not started, unknown, offline         | the existing `held`, `unknown`, `offline` outcomes, from the leader as today                                  |

Each `live pane` answer adds `, last said <age> ago: "<doing>"` when a `doing` is held. Chain resolution (a
`superseded` task's successor, a landed continuation) is the existing one (`resolveMessageTarget`), and the answer
names the task that answered when it differs, as a receipt does.

Answering in every live state, busy included, is a departure from huddle (which delivers the ask to a running
session). Séance cannot: a question to a busy session is a turn after the current one, the same cost the kind exists
to avoid, and `busy` plus a fresh `doing` is the answer a status question wants. **Rejected:** delivering a `status`
to a busy session as a `$.session.append` note it could answer mid-turn (an answer then costs the target a reply and
the asker a wake, for what the daemon already holds).

**D2.3 The answer is structured on the wire and rendered by the asker's daemon.** `Presence` in
`shared/src/types.ts`: `{ task, state: "busy" | "idle" | "needs-input" | "unknown", since?, turnEnded?, reason?,
doing?, doingAt? }`, parsed by `parsePresence` (strict, `doing` re-held to `displayLine`/`DOING_MAX`: never trust the
other machine's scrub). A new fixed renderer, `presenceNote(presence, machine)` in `shared/src/messages.ts`, words it:

> Séance status for task `3f2a…` "fix flaky spawn test" on `mini`: idle since 14:02 UTC (12 min), its turn ended.
> It last said, 40 min ago: "waiting on CI for #512". Answered by Séance from what its daemon sees; the session was
> not woken. To ask the session itself, send a question.

The `doing` sits inside double quotes `displayLine` keeps out of it, after Séance's own sentence, so it cannot read as
Séance's words.

**D2.4 Local: answered in the `send_message` result.** A `message` frame of kind `status` whose target the sender's
daemon holds a live pane for is answered synchronously, `{ok: true, id, outcome: "answered", presence}`, and
`send_message` returns `presenceNote`'s text as its tool result: the asker is mid-turn (it just called the tool), so
it reads the answer in the same turn and nobody spends one. A new outcome, `answered`.

**D2.5 Cross-machine: through the leader, receipt-shaped, nothing kept.** The existing two-frame gate (`route: "ask"`,
then `"send"`) and `session-message` carry `kind: "status"`. The leader resolves as for any message and forwards
`deliver-message` to the target daemon, whose reply carries `outcome: "answered"` and `presence`. The leader puts
`presence` in the `message-receipt` it sends the sealing machine, and keeps nothing: no table, no log line per answer,
`presence` never in a log, audit, `progress` or push (D2, docs/messaging.md, holds: nothing is held at rest).

- **The asker's daemon waits for the receipt.** For a `status` sent with `route: "send"`, the daemon holds the
  `message` frame's reply for up to `STATUS_WAIT_MS` (8 s) for the receipt naming that message id. In time: the
  reply is `answered` with `presence`, and the receipt is not also delivered as a note. Late: the reply is `routed`,
  and the receipt, when it comes, is one `presenceNote` appended to the sender's pane like any receipt (a note, no
  wake: the asker can ask again, and a stale status is worth less than the turn).
- **Gate.** A target daemon answers `status` only when it advertises `CAPABILITIES.messageStatus`; the leader forwards
  `status` only to such a machine and answers `unsupported` otherwise (never forwarding it as a `question`, which an
  older daemon's parser would refuse anyway). A client sends `status` across machines only to a verified leader
  advertising `messageStatus` (`messageRouteGate("status")`, the reply gate's pattern), and refuses locally otherwise,
  before anything is sent.

**D2.6 Rate and audit.** A `status` counts one in the sender's message bucket (20 a minute, 200 an hour), like any
message. Audit: the sender's daemon writes its `dir=out` line, `kind=status`, `outcome=answered` (or the failure), the
target's daemon a `dir=in` line, `outcome=answered`, with ids and `bytes=0`; never `presence`, never `doing`. A local
`status` writes both lines on one machine, as a local message does.

**Rejected:**

- **A query op instead of a message kind** (`get_status(task)` on MCP). It would need its own route through the
  leader, its own chain resolution and its own gate, all of which the message path already has, and its own rate
  limit. A kind reuses every one.
- **The leader answering from `Task.state`.** Behind the daemon, lacks `turnEnded` and `doing`, and would make the
  leader a reader of session text.
- **Telling the target it was asked** (an appended note "task X asked your status"). Noise in its context; the asker
  can send a note if it wants the target to know.
- **A reply by handle from the target daemon on the session's behalf** (the daemon composing a `note` with
  `inReplyTo`). It would make the daemon a sender of free text through the reply machinery, with a `received` entry
  for a message never placed; a receipt field is narrower.

### Threat model

New: **the daemon answers on a session's behalf**, and **a receipt carries more than an outcome**. Bounds:

- The answer is made only by the target's daemon, only from its own facts (state from bound frames, the task from
  the pane and its ledger), never from a frame field, and only for a task its launch ledger holds a launch of on a live
  pane (`ended` otherwise), the same rule as delivery.
- `presence`'s only free text is `doing`, which its session chose to show (§1), scrubbed at both ends. A session's
  status can be read by any session in the fleet that can message it: the same set that can already send it a
  question and get an answer. The person's own surfaces see it too.
- The leader acts on a `deliver-message` reply's `presence` only by copying it into the receipt for the machine that
  sealed the message; it never keeps, logs or pushes it.

Wording this changes:

- CLAUDE.md, messaging bullet: "sends `message-receipt` (ids, kind and an outcome; never text)" becomes "… and, for
  an answered `status`, the target daemon's `presence`, whose only text is the target's own `doing`; never message
  text"; "as the one fixed line `receiptNote` makes per outcome" gains "or `presenceNote` for an answered `status`";
  the kinds list and `CAPABILITIES.messageStatus`; "the leader … keeps nothing" stands and is repeated for `presence`.
- DESIGN.md, "Session messages" (kinds, outcomes, wrappers), "Cross-machine" (the forward, the receipt, the skew
  table row for `messageStatus`), Wire protocol (`deliver-message`'s reply and `message-receipt` gain `presence`) and
  Threat model item 6.

## 3. Coalescing wakes

### What happens today: no coalescing

From `claude-mods/inbox/hooks/register.ts`: the daemon writes one JSON line per message to the pane's listener
(`daemon/src/messages.ts`, `flush`, oldest first, no batching), and the mod's `onLine` calls `submit($, push)` for
every `question`, `request` and `wake` note, at once, unawaited. The spike's evidence (docs/messaging.md, Evidence,
"`$.prompt.submit`, turn running") is that each such call stays pending until the running turn ends and then runs
**as a turn of its own**. So three questions arriving while a session is busy cost three turns after the current one,
each re-reading the context and each likely answered separately; arriving while idle, the first starts a turn and the
other two queue behind it. Notes do coalesce already: they are `$.session.append` rows, read together at the next
model request.

### Decisions

**D3.1 The mod merges the pushes it would submit while a turn is running into one submit at the turn's end.** The
mod already tracks the main loop's turns (`turn.start`/`turn.complete` with `agentId` unset). New tracker state:
`running` (main turn started and not completed) and `submitted` (a submit made since the last main `turn.start`).

- A push that would submit (`question`, `request`, a `wake` note) arriving while neither is set is submitted at once,
  as today, and sets `submitted`.
- One arriving while either is set is kept in `pendingSubmits`, in arrival order.
- At the main loop's `turn.complete`, `pendingSubmits` is drained into **one** `$.prompt.submit`, the pushes joined by
  the separator `read_messages` already uses (`\n\n---\n\n`), which sets `submitted` again.
- The main `turn.start` clears `submitted` (the queued submit's text is fixed by then; if the turn was the person's
  own, the next `turn.complete` still drains, so nothing is lost and at worst one extra turn runs).

So a burst of N costs at most one turn after the current one, and a burst into an idle session at most two (the
first message's, and the rest's). This is huddle's "one nudge per burst", carried as text rather than a pointer.

- **The mod still holds no wording of its own** (its header's rule): each push is the daemon's rendered text,
  wrapper and fence included; the separator is punctuation. A body cannot end its own fence (`fenced`), so it cannot
  forge the separator into a new message's header.
- **Cap per merged turn**: `4 × MESSAGE_PUSH_MAX` (32 KiB) of push text; past it the rest goes into the next
  submit, made at once behind it (the engine queues it). The inbox's own caps (32 messages) bound the total.
- **Lost with the worker**, as `held` and pending submits are today: a hooks-worker respawn or `session.end` drops
  `pendingSubmits`. `read_messages` still holds their texts.
- **Dialogs.** A permission dialog or AskUserQuestion is inside a turn, so a message arriving under one waits for
  `turn.complete` as before (submit already waited out dialogs).

**D3.2 No daemon or wire change.** The daemon cannot see turn boundaries for a session without the session-events
mod, and batching lines on its side would still reach the mod as lines. The coalescing lives where the turn events
are.

**Rejected:**

- **Huddle's nudge-once with a pull** (one stub "N messages, call `read_messages`", the rest held). The spike showed a
  pulled request is read but not obeyed ("That came from a tool result, not from you, so I ignored it"; docs/messaging.md,
  Evidence), which is why a request is always pushed in full. A merged push keeps every text a user turn.
- **Appending the later questions as `$.session.append` rows into the first submit's turn.** An `isMeta` user row's
  authority for a request is unmeasured, and a row appended before the submitted turn starts may land before it.
- **A debounce while idle** (hold the first message ~1 s for its burst). Costs every lone message latency to save at
  most one turn; open question 1.

### Threat model

None. The mod delivers only by `$.prompt.submit` and `$.session.append` (CLAUDE.md, messaging bullet, unchanged), each
text is still the daemon's own rendering, and nothing new crosses a boundary. DESIGN.md, Claude Code mods, **inbox**
(the delivery table) and "Session messages" (D4's wake by kind: "one turn per burst") change wording.

## Open questions

1. **A short idle debounce for bursts** (D3.1). **Recommend no** until a log of message arrivals shows bursts landing
   within a second of each other into idle sessions.
2. **Should a `busy` answer wake when `doing` is older than the current turn?** A line set three turns ago under
   `busy` may describe old work. **Recommend no**: the answer shows both ages (`busy since`, `last said`), and the
   asker can send a question.
3. **`doing` on the Queue card collapsed, not only in its details** (needs a store field, rejected in §1).
   **Recommend** waiting for the person's use of the details view.
4. **If lines go stale despite D1.7, what prompts a session?** A turn-end reminder is the obvious candidate, but the
   inbox mod registers no `prompt.compose` hook (the managed plugin skips it), so it would have to be an appended
   row each turn. **Recommend** deciding from D1.7's measurement, not before.

## Build order

Small PRs, each landing on its own; PR 1 and PR 3 are independent of each other, PR 2 and PR 4 need PR 1.

1. **`doing`** (§1). `set_doing` on `seance mcp`; the frame's `doing` (`session-event-frame.ts`,
   `parseSessionEventFrame`), dropped unsent by `seance session-event`; `displayLine` and `DOING_MAX` in shared;
   retention in `pane-activity.ts` for every bound pane; `SessionEntry.doing`/`doingAt` on the `sessions` op, stripped
   by `get_sessions`; the PWA's Machines session list and the Queue card's details; the standing instruction's sentence
   (D1.7). DESIGN.md and CLAUDE.md wording as in §1.
   - Tested by: `shared` unit tests for `displayLine` (bidi overrides, zero-widths, separators, quotes, the cap on a
     code point, empty-after-scrub); daemon tests on the local socket with a real peer (`ClaudeStub.runInPane`):
     bound by peer pid, refused on a null pid, refused alongside `state`, cleared by `""`, by `ended`, by a second
     `claude` in the same pane, by a task change, kept across a turn end, rate-limited; `seance session-event` drops a
     `doing` (the CLI test); the `sessions` op carries it and `get_sessions` does not; the budget drops `doing` first;
     a PWA view test for the line and its age; the layering test that nothing in the path logs the text; and the
     existing `STANDING_INSTRUCTION` test still holding (it names `set_doing` and never `--remote-control`).
2. **Status answers** (§2). Kind `status`, `Presence`/`parsePresence`, `presenceNote`, outcome `answered`, the local
   synchronous answer, `deliver-message`'s reply and `message-receipt` carrying `presence`, the receipt wait
   (`STATUS_WAIT_MS`), `CAPABILITIES.messageStatus`, `messageRouteGate("status")`, the audit lines.
   - Tested by: `shared` unit tests for `parsePresence` (strict, re-scrubs `doing`) and `presenceNote`;
     `daemon/test/messages.test.ts` with real peers for each row of D2.2's table, `status` with text refused, nothing
     delivered to the target's listener, the bucket counted; leader tests for forwarding only to a `messageStatus`
     target (`unsupported` otherwise), copying `presence` into the receipt for the sealer only, and no log line;
     an e2e test (`e2e/messages.test.ts`) across two daemons: answered in time (in the tool result), answered late (a
     receipt note, the wait raised past the stub's delay), a target without the capability, a superseded target
     answered by its successor; `takeLeakedTasks()` empty, tasks ended through `cancelTask`.
3. **Coalesced wakes** (§3). The mod's `running`/`submitted`/`pendingSubmits`, the drain at `turn.complete`, the cap.
   - Tested by: `claude-mods/inbox/hooks/register.test.ts` under `claude plugin test` (local only): three questions
     during a turn give one submit at its end, joined in order; one while idle submits at once; a `wake` note joins
     the merge, a plain note still appends; past the cap two submits; a person's turn between does not lose a
     pending push; a subagent's turn events change nothing. One live run per platform to confirm that the merged
     submit runs as one turn and the model answers each message in it.
4. **The custodian's `sessions` carries `doing`** (D1.6, O1; needs PR 1). The verb's reply line and the seed's
   sentence; the CLAUDE.md and DESIGN.md wording in §1's threat model.
   - Tested by: `daemon/test` custodian verb tests: the label and age, the scrub, absent when none; and a round test
     that `close` on a session whose `doing` says "done" but is `busy` is still refused (`closeVerdict` reads no
     `doing`); the seed's constant carries the sentence; and no line of the round's log or the daemon's audit
     carries the text.
