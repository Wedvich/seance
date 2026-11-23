# Session presence — spec

**Status: draft 2026-11-17, nothing built. The owner decided O1–O4 (below) on 2026-11-17; the rest is proposed.** Three features borrowed from huddle
(`pengefix/huddle`, `origin/main`): a one-line `self.doing` tag a session declares about itself (§1), status questions
answered from presence without waking anyone (§2), and coalesced wakes (§3). Each stands on its own and lands on its
own; each also feeds the adapter seam (DESIGN.md, "Adapters", #486), which none of them depends on. It builds on
the tags model (docs/tags.md, #533, built and folded into DESIGN.md, "Tags and session identity"), whose edits for this file are applied here. Like docs/messaging.md, this file is the working record until the code lands; each part folds into DESIGN.md as
it is built, and its text here goes.

**Decided by the owner (2026-11-17):**

- **O1. The custodian's `sessions` verb carries `doing`** (§1, D1.6), as its own PR (PR 4).
- **O2. The standing instruction tells sessions to keep `doing` current** (§1, D1.7), in PR 1.
- **O3. `doing` is the first tag of the session-tags model, `self.doing`, not a standalone field** (§1, D1.0),
  recorded as T1 in DESIGN.md, "Tags and session identity". The tags model is that section's, not this file's.
- **O4. Hand-started sessions get `self.doing` and retention too** (§1, D1.1, D1.3): the gate is a bound `claude`
  process, not `ours` (T4; DESIGN.md, "Tags and session identity", "Retention for hand-started sessions"), which #543 already builds for state and `agent.*`. The owner's
  direction is that Séance picks up every session in its tmux server, not only task-backed ones.

**Builds on the tags model's build step 1 (#543; DESIGN.md, "Session identity").** That step builds the vocabulary (`shared/src/tags.ts`: the key
grammar, namespaces, `TAG_VALUE_MAX`, `TAGS_PER_WRITER_MAX`, `TAGS_PER_PANE_MAX`, `displayLine`, `parseTags`), the
per-process retention (`daemon/src/conversations.ts`: keyed `<pid>:<start>` on the bound `claude` process, for every
pane whose peer resolves to one, `ours` or not, with each process's state and `reason`), `SessionEntry.tags` on an
app's `sessions` reply (none on a scheduler-sealed one) and MCP's `get_sessions` filter (`AGENT_VISIBLE_TAG_KEYS`).
This file's PR 1 is what is left for `self.doing` on top of it, and lands after #543. Nothing in `shared/src/tags.ts`
writes `self.*` yet.

**Why a file of its own, not a docs/messaging.md section.** `doing` is not messaging: it is a session event that
three readers (the PWA, the custodian, the status answer) consume, and it would sit awkwardly in a file about delivery.
§2 and §3 are messaging, but they were drafted beside #486's rewrite of the adapter seam (now DESIGN.md, "Adapters"), and one file per draft
kept the two from rebasing each other's prose. When §2 and §3 land, their record goes to DESIGN.md, "Session messages", as
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

## 1. `self.doing`: a line a session declares about itself

### Decisions

**D1.0 `doing` is the tag `self.doing` (O3).** The session-tags model is DESIGN.md's "Tags and session identity" (`shared/src/tags.ts` is the record of the vocabulary); in
brief, tags are key/value pairs namespaced by writer, and **the namespace is the access rule**:

| Namespace          | Written by                         | Scope                 | Notes                                                                   |
| ------------------ | ---------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `agent.*`          | the agent's own mod and hooks only | process, conversation | `agent.kind`, `agent.session`, `agent.remote` (today's `remoteSession`) |
| `seance.*`         | the daemon only                    | session               |                                                                         |
| `self.*`           | the session itself, through MCP    | process               | display-only, never keyed on, bound by peer pid                         |
| `adapter.<name>.*` | that adapter only, over its stdin  | conversation          | DESIGN.md, "Adapters"                                                   |
| `owner.*`          | the PWA, sealed `from: "app"`      | task, or conversation | on the task record for a tasked session (DESIGN.md, "Task tags")        |
| `creator.*`        | whoever enqueued the task          | task                  | beyond T1, decided: `linear` became `creator.ref`                       |
| `scheduler.*`      | the leader                         | task                  | beyond T1, decided; no keys in v1                                       |

No tag ever binds, routes or authorizes anything. Display precedence for a session's name is owner label > task
title > `self.name` > window, the source marked, on the owner's surfaces only (DESIGN.md, "Tags and session identity", "The join and the name"). Session tags live
in daemon memory, short keys, values at most 256 bytes under the printable-text rule, never logged or audited as text,
never in `MachineStatus`; task tags live in the task record (DESIGN.md, "Task tags"), and no session tag ever does.

This spec builds one key of it, `self.doing`, and shapes everything so the rest is additive:

- **The setter is general in shape, narrow in what it accepts.** `set_self_tag { key, value }` (D1.1). PR 1 accepts
  only `key: "doing"` and refuses any other key `unknown_key`; docs/tags.md widens the accepted set to `doing` and
  `name` (its open question 1), not the tool.
- **The caps are the tags model's**, as #543 built them in `shared/src/tags.ts`: values at most `TAG_VALUE_MAX` (256
  UTF-8 bytes) after `displayLine`; keys `[a-z][a-z0-9-]{0,31}`; `TAGS_PER_WRITER_MAX` (4) per namespace and
  `TAGS_PER_PANE_MAX` (16) over a session's non-adapter tags (D1.2).
- **Every wire shape carries the `tags` map keyed by the full namespaced key**, `{ "self.doing": { value, at, scope:
  "process" } }` (`joinTags`' entry shape, `SessionEntry.tags` as #543 built it), never a `doing` field:
  `SessionEntry.tags`, the custodian's `CustodianPaneView.tags`, `Presence.tags`, and the adapter `Session` record
  (DESIGN.md, "Adapters"). Every parser keeps only the keys it knows (`parseTags`) and drops the rest.
- **`self.doing` is a line, not a name.** It never enters the name precedence above; the PWA shows it under the
  session's name, never in its place.

**D1.1 Set by an MCP tool, `set_self_tag`, on `seance mcp`.** `{ key: string, value: string }`; an empty `value`
clears the key. The tool's description names `doing` as the key to use ("a one-line status other sessions and your
user read"). It sends a `session-event` frame carrying `self` alone (`{v, kind: "session-event", self: { key, value },
pane?}`), the shape `handoff` and `pass` already take, over the local socket. A frame carrying `self` carries no
`state`, `handoff`, `pass`, `prUrl` or `done`; one that does is refused `invalid`. The key is the bare `self.*` suffix:
the namespace is never on the frame, since the frame's path (an MCP call from the session, bound by peer pid) is what
makes it `self`. `seance session-event` (the mod's CLI path) drops a frame carrying `self` unsent, as it drops `done`,
`handoff` and `pass`: the mod's hooks never write `self.*` (they write `agent.*`: DESIGN.md, "Session identity", "The claims").

- **Bound by the kernel-reported peer pid only, never by a field**: the peer is the `seance mcp` process, whose
  ancestor chain names the pane. Unlike a state report, the frame's `pane` never decides: on a host that names no peer
  (`peerPidSupported`) or for a null pid, `set_self_tag` is refused `unbound`, as `message` and `inbox` are. A state
  report falls back to a claimed pane because a wrong state is corrected by the next report; a line other readers
  display is not, so it gets the stricter rule.
- **Any pane whose peer resolves to a `claude` process, `ours` or hand-started, tasked or not (O4).** The gate is
  the one #543's retention already uses (`claudeProcessOf`, `daemon/src/claude-process.ts`: the innermost process on
  the peer's chain called `claude`), as T4 decided. A peer with no `claude` on its chain (a shell's
  child running `seance mcp` by hand) is refused `unbound`, since there is no process to hold the line against.
  Sessions outside the daemon's tmux server stay out: no pane binds them (DESIGN.md, "Tags and session identity", "Retention for hand-started sessions").
- **Kept against that `claude` process** (`<pid>:<start>`; DESIGN.md, "Session identity", "Retention"), never the pane pid: in a hand-started
  pane the pane process is the shell, which outlives a restarted `claude`, and the pane pid would carry one `claude`'s
  line onto the next.

**D1.2 The value is scrubbed, capped and display-only.**

- **Scrub** at ingest, by the printable-text rule, `displayLine` (`shared/src/tags.ts`, #543), through `parseTagValue`
  for `self.doing` like every known key: whitespace runs fold to one
  space; C0, DEL and C1 controls, format characters (`\p{Cf}`, which covers the bidi overrides and zero-widths),
  line and paragraph separators, lone surrogates, the backtick and the double quote are dropped; the result is
  trimmed. `displayTitle` stays as it is (`displayLine` is the stricter sibling: a window title reaches a wrapper,
  a `doing` reaches the PWA, a round and another session).
- **Cap** `TAG_VALUE_MAX` = 256 UTF-8 bytes after the scrub, cut on a code point boundary. Over it is cut, not
  refused: a session that wrote a long line still meant to say something. Empty after the scrub clears. Keys are held
  to `[a-z][a-z0-9-]{0,31}` and, in PR 1, to `doing` alone, under #543's per-writer and per-pane caps.
- **Display-only.** It binds, routes, moves, settles and alerts nothing: no scheduler decision, no drain timing, no
  custodian act, no notification reads it. It is never logged, never audited as text, never in argv, `progress`,
  `MachineStatus`, a store record, a push or the archive.
- **Rate.** At most 30 sets a minute per session, in memory; past it `rate_limited`. Nothing leaves the machine on a
  set, so this only bounds a looping session's churn of the PWA's next read.

**D1.3 Kept in the daemon's memory only, in the process entry #543 built.** `daemon/src/conversations.ts`'s per-process
entry, which already keeps that process's last state, `reason` and `agent` claims, gains `self: Map<suffix, { value, at
}>` (`doing` alone in PR 1), cleared when the entry's `taskId` changes (D1.4). It already runs for every pane bound to a
`claude` process (O4), with or without a custodian seat, and prunes at its `sweep` (each `sessions` op, and the
listings it already hooks); `pane-activity.ts` and its screen sampler stay the custodian's, `ours` only, and untouched.
Retention, not an act: every custodian verb, the drain ask and the handoff still require `ours` and a launch-ledger
task, so a hand-started pane's line is read only by the `sessions` op and the PWA. `SessionEntry.tags` gains the entry
through #543's `withTags`, at scope `process`.

- **Not persisted.** A daemon restart forgets every `doing` and every state. A session at rest sends no frame until
  its next turn, so after a restart an idle session reads `state unknown` with no line (§2) until it is next busy.
  This also undercounts lines in D1.7's measurement; the measurement reads only sessions that ran a turn since the
  daemon's last start.

**D1.4 How it clears.** Not at a turn's end: an idle session's last `doing` is what a status question most wants
("last said, 40 minutes ago: waiting on CI for #512"), which is huddle's "last doing". It clears on:

- `set_self_tag` for `doing` with `""`;
- `ended` for the pane, or the pane gone from tmux;
- the bound `claude` process gone (in an `ours` pane, a respawned pane; in a hand-started one, `claude` exiting to
  its shell, since no `ended` fires for an untasked pane), or a different task on it
  (`@seance-task` changed), found at the next `sweep` (D1.3);
- a daemon restart.

An in-process `/clear` or `/resume` keeps it (the mod reports neither, and `@seance-task` does not change); every
reader shows its age, so a stale line reads as stale. **Rejected:** clearing at `turnEnded` (loses exactly the line an
idle-status answer wants); a TTL (an age shown beside the line does the same job without deciding for the reader).

**D1.5 Where it surfaces.**

| Surface                                 | Carries `doing`?                                                  | Why                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions` op (`SessionEntry.tags`)     | yes, to an app only                                               | D1.5a.                                                                                                                                                                                                                                                                                                                                                            |
| PWA Machines session list               | yes, with its age                                                 | Rendered as text (Preact escapes), on its own line, prefixed "doing:".                                                                                                                                                                                                                                                                                            |
| PWA Queue screen, a running task's card | yes, read from its machine's `sessions` reply, joined on `taskId` | Fetched when the card's details open, not on every queue push. No store field (rejected below).                                                                                                                                                                                                                                                                   |
| MCP `get_sessions`                      | **no**, projected out by `seance mcp`                             | A session-chosen string in another agent's context, the reason `get_queue` never carries `inputTool`. The sanctioned way for one session to read another's line is §2, inside Séance's own fixed wrapper. D1.5a. DESIGN.md, "Tags and session identity", "Another agent's context", widens the allowlist by writer and keeps `self.*` out of it for every caller. |
| MCP `get_queue`                         | **no**                                                            | Same reason, and the queue has no field for it.                                                                                                                                                                                                                                                                                                                   |
| `MachineStatus`                         | **no**                                                            | 1.5 KiB of ciphertext (`STATUS_MAX_CT_LENGTH`) for the whole machine; a per-session text field would be the first thing `fitStatus` trims, and the 30 s beat would carry it to every app and the leader for no decision.                                                                                                                                          |
| Custodian `sessions` verb               | yes, from PR 4 (below), labelled                                  | D1.6 (O1).                                                                                                                                                                                                                                                                                                                                                        |
| Status answer (§2)                      | yes                                                               | The point of §2.                                                                                                                                                                                                                                                                                                                                                  |
| Adapter `Session` record                | later, as its `tags` map                                          | DESIGN.md, "Adapters" specifies `Session.tags` as this map, joined; built with the adapter seam (its PR 3a). Nothing here waits for it.                                                                                                                                                                                                                           |

**D1.5a The `sessions` op has three readers, and only the PWA gets `doing`.**

- **The scheduler.** The leader's sweep reads `sessions` (`REPLY_JSON_BUDGET`'s comment, `shared/src/types.ts`). A
  `sessions` request sealed `from` the scheduler (or the leader's in-process call) gets no `tags`: #543's
  `listSessions` returns before attaching them. The leader never holds session text (§2 rejects it for the same
  reason).
- **`seance mcp`'s `get_sessions`.** The daemon cannot tell it from the PWA (both seal `from: "app"`), so the strip is
  the client's: #543 filters tags to `AGENT_VISIBLE_TAG_KEYS`, which never holds a `self.*` key (DESIGN.md, "Tags and session identity", "Another agent's context").
  PR 1 adds a test that `self.doing` stays out.
- **The PWA**, which renders it.
- **Budget.** No fitter exists for `sessions` today (only `progress` is trimmed, in `handlers.ts`; #543 added none, since
  `agent.*` values are short ids). `self.doing` is the first tag of up to 256 bytes per session, so PR 1 adds one: when
  the reply's JSON would pass `REPLY_JSON_BUDGET`, every entry's `tags` are dropped (all, not some, so
  the PWA reads "lines omitted" once rather than guessing which ones are missing), and the reply says so with
  `tagsOmitted: "all"`. The value is the tags model's tiered one (`"adapter" | "all"`): once adapter tags exist
  the fitter drops those first, all or nothing per tier; PR 1 has only the second tier.

**D1.6 The custodian's `sessions` verb carries it (O1).** The verb's reply is JSON (`CustodianPaneView`,
`daemon/src/custodian-frame.ts`); each pane gains `tags: { "self.doing"?: { value, minutes } }` (`minutes` whole
minutes since it was set, like `stateMinutes`), held by `displayLine` and `TAG_VALUE_MAX` like every other reader's copy,
and the verb's help text calls the field the session's own claim. It spares a round a `capture` for a session whose line already says "waiting on CI for
#512". It is session-chosen text reaching a round, but a round already reads the same session's screen through
`capture`, which carries far more of it, and the round's acts stay behind the daemon's own checks: `closeVerdict`
decides at rest by the daemon's facts and never reads `doing`, and `nudge`, `interrupt` and `flag` keep their own
gates. The round's constant seed gains one sentence: a session's `doing` is its own claim, never evidence that it is
at rest, finished or stuck. No mask, fence, built environment or socket changes, so no re-drill (docs/custodian.md,
item 4b's rule).

This is a deliberate departure from one precedent. The verb withholds a flag's note because the note "is not fed back
to later rounds" (`custodian-verbs.ts`): the note is model-written from untrusted pane text, and a round would read
an earlier round's (possibly injected) words as its own. `doing` differs in source, not in trust: a session writes it,
not a round, so it carries no earlier round's reasoning; but it does persist across rounds and arrives unasked in
every listing, unlike `capture`, which a round reads only when it chooses. An injected session can therefore put the
same text in front of every round until it changes the line. Accepted because the round's acts are all gated by the
daemon's own facts, the counts bound `nudge` and `interrupt`, and a session can already keep its screen saying the same
thing; the seed's sentence is there so the round does not weigh it as evidence. Like the rest of a round's reading, the line is never logged, audited, put in `rounds.jsonl` by the
daemon or kept past the reply.

**D1.7 The standing instruction asks for it (O2).** `STANDING_INSTRUCTION` (`shared/src/messages.ts`) gains one
sentence: "Keep a one-line status with set_self_tag (key doing) when your focus changes; other sessions and your user read it." It
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

`set_self_tag` adds no act: it is a session-event the ingest binds by peer pid and retains. What is new is a
**session-chosen string that other readers display**: the person (PWA), a custodian round (D1.6) and
another session (§2). Each reader gets it scrubbed (`displayLine`), capped, and labelled as the session's own claim
with its age. It cannot reach a reader that the session could not already reach with more text: a tasked session can
already message any task, and its screen is already what a round's `capture` reads. Residual: a same-uid process on
the machine can set a pane's line (as it can a pane's state today); it lies only to readers who already treat it as a
claim.

**Hand-started panes (O4).** #543 already keeps state, `reason` and `agent.*` for panes the daemon did not start;
PR 1 adds `self.doing` to the same entry, bounded by the caps and pruned at its `sweep`. It gains no act on them
(D1.3), and a hand-started session is untasked, so §2 never answers for it and the custodian never lists it. What
changes is that a same-uid process typing `claude` in the daemon's tmux server can put a line on the Machines screen; it
could already put a pane and a window title there.

Wording this changes, in the same PR as the code:

- `.claude/rules/local-socket.md`, "The frame's other claims" (`agent`, `reason`, `tool`; as #543
  words it): add `self` (the `self.*` tags, today `self.doing` alone): sent only by `set_self_tag` (`seance session-event`
  drops it unsent), never binds, routes or authorizes anything, bound only by the kernel-reported
  peer pid (never the frame's `pane`, refused `unbound` where the host names no peer or no `claude` is on the peer's
  chain), kept in that `claude` process's `conversations.ts` entry, held
  to `displayLine`, `TAG_VALUE_MAX` and the key pattern, display-only, memory only, never logged, audited, persisted or in `MachineStatus`,
  a store record, a `sessions` reply to the scheduler, `get_sessions` or `get_queue`.
- The same file, "Retention, not acts", the bullet "For each pane whose peer resolves to a `claude` process …, that
  process's last state, `reason` and `agent` claims": add `self.*`, and that it too reaches only an app's `sessions`
  (never a scheduler-sealed one, never MCP's `get_sessions`).
- DESIGN.md, "Tags and session identity", Threat model, widens `self` to the keys it accepts later; until then the wording names `self.doing`
  alone.
- DESIGN.md, "Session events": the frame shape, the `self` bullet, "Session identity" (the process entry, as #543 records it); MCP server: `set_self_tag`; the
  `sessions` op's `SessionEntry`; "Session messages" (the standing instruction's added sentence); Threat model item 6
  (the session-chosen line and its readers).
- With PR 4: `.claude/rules/custodian.md`, the `flag` verb, where the flag's note is "never … returned by `sessions`": add
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

**D2.1 A new message kind, `status`, never a flag on `question`.** `send_message { to, kind: "status" }`, no text.
It addresses a task only (`to`), never a reply by handle: a session with no task has no presence anyone asks about.
`to: "adapter:<name>"` (DESIGN.md, "Adapters") is refused `invalid`: an adapter has no presence, and it already
reads every session's from its own snapshot.

- **Wire shape.** `text` is absent on every frame that carries a `status` (`message`, `session-message`,
  `deliver-message`); `parseMessageFrame` and the two op parsers take `kind: "status"` only without `text`,
  `inReplyTo` or `replyTo`, and any other `kind` still requires non-empty `text` (`message-frame.ts`). A `status`
  mints no reply handle: no `sent` or `received` entry, since nothing is placed in a pane that could answer it.
- **Skew.** An older daemon's `parseMessageFrame` refuses the kind (`isMessageKind`), so a local asker hears
  `invalid` and nothing is delivered. An older **leader** is different: it drops an unparseable `session-message` with
  no receipt, so an ungated asker would wait and hear nothing. That is why the client gate (D2.5) is required, not
  belt-and-braces: across machines a `status` is sent only to a verified leader advertising `messageStatus`. A flag (`presence: true` on a `question`) would be dropped by an older
  daemon's or leader's parser and the question delivered: the wake the flag exists to avoid.
- **No `wake` on it.** Huddle's `status-ask` carries `wake` because its kinds are fixed per item. Séance's sender
  picks the authority per message (owner's decision, docs/messaging.md): to ask the session itself, send a `question`.
  The answer's fixed text says so. **Rejected:** `wake` on `status` (a second spelling of `question`).

**D2.2 The target's daemon answers, always, and nothing is placed in the target's pane.** It holds the facts: the
pane, its task (`@seance-task`, checked against its launch ledger), the retained state, `stateSince`, `turnEnded`,
`reason` and `doing`, all in the bound `claude` process's `conversations.ts` entry (§1, D1.3; #543 keeps `stateAt`,
`turnEnded` and `reason` there, and PR 2 adds them to its `ProcessView`). The leader never answers from its own record of a session's state: it is a step
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
tags? }`, `tags` holding only `self.doing` (`{ value, at }`), parsed by `parsePresence` (strict, unknown tag keys dropped, the value re-held to `displayLine`/`TAG_VALUE_MAX`: never trust the
other machine's scrub). A new fixed renderer, `presenceNote(presence, machine)` in `shared/src/messages.ts`, words it:

> Séance status for task `3f2a…` "fix flaky spawn test" on `mini`: idle since 14:02 UTC (12 min), its turn ended.
> It last said, 40 min ago: "waiting on CI for #512". Answered by Séance from what its daemon sees; the session was
> not woken. To ask the session itself, send a question.

The `doing` sits inside double quotes `displayLine` keeps out of it, after Séance's own sentence, so it cannot read as
Séance's words. The note names the session by its task's title, never by `self.name` or an owner label: DESIGN.md, "Tags and session identity",
"The join and the name", keeps the joined name to the owner's own surfaces and an adapter's `Session`.

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
  `message` frame's reply for up to `STATUS_WAIT_MS` (3 s) for the receipt naming that message id. 3 s, because
  `send_message`'s own socket exchange gives up at 5 s (`SEND_TIMEOUT_MS`, `daemon/src/send-message.ts`) and the
  reply must reach it first; a leader round trip is well under a second when both legs are up. The waiter is
  registered **before** the route call, since an in-process leader's receipt can arrive before `route` returns.
  In time: the reply is `answered` with `presence`, and the receipt is not also delivered as a note. Late, or the
  caller's connection closed during the wait (the waiter is dropped on close): the reply, if anyone still reads it, is
  `routed`, and the receipt, when it comes, is one `presenceNote` appended to the sender's pane like any receipt (a
  note, no wake: the asker can ask again, and a stale status is worth less than the turn).
- **The leader parses, never copies.** The target's reply is read by `parsePresence` into a fresh value, and its
  `presence.task` must equal the task the leader's own resolution chose; a malformed or mismatched `presence` makes
  the receipt carry outcome `unknown` with no `presence`, never a pass-through. The asker's daemon parses the receipt's
  `presence` again before rendering.
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
- The leader acts on a `deliver-message` reply's `presence` only by parsing it into a fresh value bound to the task
  it resolved and putting that in the receipt for the machine that sealed the message; it never keeps, logs or pushes
  it.

Wording this changes:

- `.claude/rules/messages.md`: "sends `message-receipt` (ids, kind and an outcome; never text)" becomes "… and, for
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
- **A refused submit clears `submitted` and drains.** `submit()` swallows a rejection today (a plugin above refused,
  or the session is going). Under coalescing that would leave `submitted` set and every later push waiting for a
  `turn.complete` that, in an unattended session, never comes. So the rejection handler clears `submitted` and, when
  no turn is `running`, submits `pendingSubmits` at once; a second refusal in a row leaves them for the next
  `turn.complete` and `read_messages`, rather than looping.

So a burst of N costs at most one turn after the current one, and a burst into an idle session at most two (the
first message's, and the rest's). This is huddle's "one nudge per burst", carried as text rather than a pointer.

- **The mod still holds no wording of its own** (its header's rule): each push is the daemon's rendered text,
  wrapper and fence included; the separator is punctuation. A body cannot end its own fence (`fenced`), so it cannot
  forge the separator into a new message's header.
- **Cap per merged turn**: `4 × MESSAGE_PUSH_MAX` (32 KiB) of push text; past it the rest goes into the next
  submit, made at once behind it (the engine queues it). `pendingSubmits` has its own cap, `INBOX_MAX_MESSAGES` (32)
  and `INBOX_MAX_BYTES`, oldest dropped first (still readable through `read_messages` while its own hold keeps it; the
  mod adds no wording to say so) (the daemon's inbox caps bound only its hold while no listener is connected; a connected listener gets every line
  at once).
- **Lost with the worker**, as `held` and pending submits are today: a hooks-worker respawn or `session.end` drops
  `pendingSubmits`. `read_messages` still holds their texts.
- **Dialogs.** A permission dialog or AskUserQuestion is inside a turn, so a message arriving under one waits for
  `turn.complete` as before (submit already waited out dialogs).

**D3.1a Two engine facts gate the merge, checked in the spike before PR 3.** (a) Does every main turn end in
`turn.complete`, including one ended by Escape or an API error, and what does a hooks-worker respawn mid-turn leave
`running` as? If a turn can end without it, `running` sticks and pushes stall: the fallback is clearing `running` on
the next main `turn.start` and on `session.start`. (b) Does the model act on the second and third request of a merged
submit as it does on one request per submit? The spike measured one per submit only. If (b) fails, the merge is
limited to questions and `wake` notes, and each request keeps its own submit.

**D3.2 No daemon or wire change.** The daemon cannot see turn boundaries for a session without the session-events
mod, and batching lines on its side would still reach the mod as lines. The coalescing lives where the turn events
are. It covers adapter deliveries for free (DESIGN.md, "Adapters"): an adapter's question, request or `wake: true`
note reaches the mod as the same inbox line and is merged like any other, which matters more there, since an
adapter's own bucket (60 a minute) allows denser bursts than a session's.

**Rejected:**

- **Huddle's nudge-once with a pull** (one stub "N messages, call `read_messages`", the rest held). The spike showed a
  pulled request is read but not obeyed ("That came from a tool result, not from you, so I ignored it"; docs/messaging.md,
  Evidence), which is why a request is always pushed in full. A merged push keeps every text a user turn.
- **Appending the later questions as `$.session.append` rows into the first submit's turn.** An `isMeta` user row's
  authority for a request is unmeasured, and a row appended before the submitted turn starts may land before it.
- **A debounce while idle** (hold the first message ~1 s for its burst). Costs every lone message latency to save at
  most one turn; open question 1.

### Threat model

None. The mod delivers only by `$.prompt.submit` and `$.session.append` (`.claude/rules/messages.md`, unchanged), each
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

Small PRs, each landing on its own; PR 1 and PR 3 are independent of each other, PR 2 and PR 4 need PR 1, and PR 1
needs the tags model's step 1 (#543, built).

1. **`self.doing`** (§1), on top of #543. `set_self_tag` on `seance mcp` (key `doing` only); the frame's `self`
   (`session-event-frame.ts`, `parseSessionEventFrame`), dropped unsent by `seance session-event`; `self.doing`'s
   parser in `shared/src/tags.ts`; its retention in `conversations.ts`'s process entry and on `SessionEntry.tags`
   through `withTags`; the `sessions` fitter and `tagsOmitted`; the PWA's Machines session list and the Queue card's
   details; the standing instruction's sentence (D1.7). DESIGN.md and `.claude/rules` wording as in §1.
   - Tested by: `shared` unit tests for `self.doing` through `parseTagValue` (bidi overrides, zero-widths,
     separators, quotes, the cap on a code point, empty-after-scrub); daemon tests on the local socket with a real
     peer (`ClaudeStub.runInPane`):
     bound by peer pid, refused `unbound` on a null pid and on a host that names no peer (even with a `pane`),
     kept for a hand-started pane running a `claude` stub and refused `unbound` for a shell's child with no `claude` on its
     chain, a `claude` restarted under the same shell starting with no line, the custodian's `sessions` still listing
     no hand-started pane, refused alongside `state`, cleared by `""`, by `ended`,
     by a respawned pane and by a task change found at the next `sweep` with no custodian seat running, kept across a
     turn end, rate-limited, any key but `doing` refused `unknown_key`, a value cut at 256 bytes on a code point
     boundary; `seance session-event` drops a `self` (the CLI test); the `sessions` op carries it to an app and not to
     a scheduler-sealed request; `get_sessions` never shows `self.doing`; the new
     fitter drops every entry's `tags` and sets `tagsOmitted: "all"` past `REPLY_JSON_BUDGET`; every entry carrying
     `scope: "process"`;
     a PWA view test for the line and its age; the layering test that nothing in the path logs the text; and the
     existing `STANDING_INSTRUCTION` test still holding (it names `set_self_tag` and never `--remote-control`).
2. **Status answers** (§2). Kind `status`, `Presence`/`parsePresence`, `presenceNote`, outcome `answered`, the local
   synchronous answer, `deliver-message`'s reply and `message-receipt` carrying `presence`, the receipt wait
   (`STATUS_WAIT_MS`), `CAPABILITIES.messageStatus`, `messageRouteGate("status")`, the audit lines.
   - Tested by: `shared` unit tests for `parsePresence` (strict, re-scrubs `doing`) and `presenceNote`;
     `daemon/test/messages.test.ts` with real peers for each row of D2.2's table, `status` with text refused, nothing
     delivered to the target's listener, the bucket counted; leader tests for forwarding only to a `messageStatus`
     target (`unsupported` otherwise), parsing `presence` into the receipt for the sealer only, `unknown` for a
     malformed or mismatched `presence.task`, and no log line; a daemon test that a cross-machine `status` reply reaches
     `send_message` inside `SEND_TIMEOUT_MS` (the real client, not a stub timeout), that a receipt arriving before
     `route` returns is still taken, and that a closed caller's late receipt becomes a note; a wire test that `status`
     with `text`, `inReplyTo` or `replyTo` is refused on all three frames;
     an e2e test (`e2e/messages.test.ts`) across two daemons: answered in time (in the tool result), answered late (a
     receipt note, the wait raised past the stub's delay), a target without the capability, a superseded target
     answered by its successor; `takeLeakedTasks()` empty, tasks ended through `cancelTask`.
3. **Coalesced wakes** (§3). The mod's `running`/`submitted`/`pendingSubmits`, the drain at `turn.complete`, the cap.
   - Tested by: `claude-mods/inbox/hooks/register.test.ts` under `claude plugin test` (local only): three questions
     during a turn give one submit at its end, joined in order; one while idle submits at once; a `wake` note joins
     the merge, a plain note still appends; past the cap two submits; a person's turn between does not lose a
     pending push; a subagent's turn events change nothing; a refused submit clears `submitted` and the next push is
     submitted rather than stranded; `pendingSubmits` past its cap drops the oldest. Before PR 3, the spike in D3.1a
     (Escape and an API error ending a turn, a worker respawn mid-turn, three requests in one merged submit). One live run per platform to confirm that the merged
     submit runs as one turn and the model answers each message in it.
4. **The custodian's `sessions` carries `doing`** (D1.6, O1; needs PR 1). The verb's reply fields and the seed's
   sentence; the `.claude/rules` and DESIGN.md wording in §1's threat model.
   - Tested by: `daemon/test` custodian verb tests: the scrub and the cap; and a round test
     that `tags["self.doing"]` appears in `CustodianPaneView` JSON and are null when none is held, and
     that `close` on a session whose `doing` says "done" but is `busy` is still refused (`closeVerdict` reads no
     `doing`); the seed's constant carries the sentence; and no line of the round's log or the daemon's audit
     carries the text.
