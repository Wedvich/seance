# Tags, session identity and the adapter subscription — spec

**Status: draft 2026-11-17; build steps 1 and 3 built** (step 1, 2026-11-17: the vocabulary, the frame's `agent`, the
conversation table and its verification, `SessionEntry.tags`: DESIGN.md, "Session events", "Session identity", is its
record. Step 3, 2026-11-18: task tags, DESIGN.md, "Task tags"). Steps 2 and 4 are not built. The owner decided T1–T4 (below) on 2026-11-17; everything else is
proposed, with a recommendation where there is a choice. Two drafts build on this file: docs/presence.md (draft PR
#526: `self.doing`, `set_self_tag`, the `tags` map on `SessionEntry`), which already fixes the first key and must stay
valid under this model, and docs/messaging.md §6 (draft PR #486: the adapter seam), whose `Session` record, addressing
and reply window this file reshapes. Like docs/messaging.md, this file is the working record until the code lands; each
part folds into DESIGN.md as it is built, and its text here goes.

Read with: CLAUDE.md (the local-socket, messaging, custodian and task-sealer bullets), DESIGN.md "Session events",
"Session messages" and its "Replies by handle", "Continuing a session", docs/agents.md (agent-neutral launch, Codex's
session ids) and docs/orchestrator.md (the display-only external `ref`).

## Decided by the owner (2026-11-17)

- **T1. Tags are key/value, namespaced by writer, and the namespace is the access rule.** `agent.*` is written only
  by the agent's own mod and hooks (`agent.kind`, `agent.session`, `agent.remote`), `seance.*` only by the daemon,
  `self.*` only by the session through MCP (display-only, never keyed on), `adapter.<name>.*` only by that adapter
  over its stdin, `owner.*` only by the owner, sealed `from: "app"`. **No tag binds, routes or authorizes anything,
  with one exception:** a verified `agent.session` may address adapter delivery (§8), and is refused when two live
  panes claim it.
- **T2. The owner's label may rename a task's session, display-only, separate from the task's title.** A session's
  name is chosen by precedence **owner label > task title > `self.name` > window**, the source marked whenever it is
  not the owner's or the task's. Push notifications never show a tag.
- **T3. Tags are specified together with session identity and the adapter subscription**, in this file.
- **T4. Retention covers hand-started sessions** (§3.3), decided 2026-11-17: the gate is a bound `claude` process,
  not `ours`. The direction is that Séance picks up every session in its tmux server, not only task-backed ones.
  docs/presence.md's PR 1 builds it for `self.doing` (its O4).

**Decided by the owner 2026-11-17, beyond T1** (open question 7): two task-scope namespaces T1 did not name, `creator.*` (whoever
enqueues, at create only) and `scheduler.*` (the leader; no keys in v1). `creator.*` has no single writer: any app-role
client that enqueues writes it, so it is trusted as a task's title is, no more (§6.3).

## Problem

Three things want to hang facts on a session, and today each has grown its own field:

- **The person** wants to name and mark sessions (a hand-started session is "zsh" or a slug on the Machines screen,
  and a task's session can only be renamed by amending the task's title, which is the task's, not the session's).
- **The session** wants to say what it is doing (#526's `self.doing`) and, untasked, what it is (`self.name`).
- **A tool** (the adapter seam, #486) wants to attach its own ids and states to a session, and to keep reaching a
  session across restarts and `--resume`. #486's review found it cannot: the adapter attaches a session under a
  `<pid>:<start time>` key that dies with the process, the session cannot learn that key, and a reply handle lives an
  hour.

Meanwhile the fields that exist are each one-offs: `remoteSession` on the session-event frame, `SessionEvent` and
`Task`; `linear` on `TaskSpec`, which names a tool (against #486's rule) and is read by nothing; orchestrator.md's
proposed `ref`. And the one stable identity every agent already has, the conversation id (`--session-id`, `$.session.id`,
Codex's thread id), is held by the daemon only in the launch ledger and refused as an address (DESIGN.md, "Replies by
handle", Rejected: "the Claude session id").

## 1. What "a session" is: three levels and the task

"Session" has meant three different things in Séance's record. They have different lifetimes, and a fact belongs at
the level whose lifetime it shares.

| Level            | Identity                                                                                                                        | Born                                                                                 | Ends, or is reused                                                                                                                                                                                                                           | Facts that live here                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **pane**         | tmux pane id (`%12`)                                                                                                            | `new-window`                                                                         | outlives processes; tmux reuses the id; a pane can be re-tagged for another task                                                                                                                                                             | none of its own: a pane is where a process is, never what it is (DESIGN.md, "nothing routes, binds or places on the window") |
| **process**      | the `claude` process, `<pid>:<start time>` (`Bound.session`, "Replies by handle")                                               | `claude` starts                                                                      | the process exits; a restart in the same pane is a new process                                                                                                                                                                               | turn state, `self.doing`, `agent.remote` (one Remote Control bridge per process), today's reply handles                      |
| **conversation** | the agent's session id: Claude's `--session-id`/`$.session.id`, Codex's thread id (docs/agents.md), held as **`agent.session`** | a launch with `--session-id`, a fresh `claude`, or `/clear` inside a running process | never ends: it survives a restart with `--resume`, is resumed by `continue_task` under a new task id, and can be left by `/clear` or `/resume` in the same process. **One conversation can span a continue chain; a successor is a new one** | `agent.session`, `agent.kind`, an adapter's id for it and its subscription (§8), an owner label on an untasked session       |
| **task**         | the task id                                                                                                                     | enqueue, before any process exists                                                   | finished, pruned; followed by continuations (same conversation) and successors (new conversation)                                                                                                                                            | `creator.*` (a tracker ref, labels), `owner.*` (a label for its session), `scheduler.*`                                      |

**Why it matters.** `self.doing` dies with the process (a restarted `claude` has not said what it is doing); an
adapter's ticket id for a conversation must not (the tool's ask is still open after `--resume`); a tracker ref must
exist while the task is still queued, before any process. Putting all three in one per-pane bag either loses the
second at every restart or keeps the first past its truth.

**Process versus conversation inside one process.** `/clear` starts a new conversation in the same process, and
`/resume` switches to an older one. So a process carries a current conversation, which can change under it; the
daemon learns of the change from the mod's next report (§4.3) and moves the process's conversation link. Process tags
stay; conversation tags follow the conversation.

## 2. One vocabulary, two stores

**Two scopes, one model.** A tag is the same thing wherever it is stored: a key in a writer's namespace and a short
printable value. What differs is the store:

- **Session scope** (process and conversation tags): **daemon memory**, per machine, written over the local socket and
  the adapter's stdin, re-sent by their writers. Never in a task record, `MachineStatus`, the store or the archive.
- **Task scope**: **the task record**, sealed through the one task sealer like every spec field, written only at
  enqueue, by the leader, or by an owner's `amend`. Kept few on purpose: every task-scope writer is a path into the
  sealer. One structured copy leaves it: the ref (`creator.ref`, `creator.ref-url`) the leader dispatches with a
  spawn, noted in the launch ledger for adapters (§6.1).
- **At rest on the daemon**, one small file for what no writer re-sends: an untasked conversation's owner label and
  its adapter subscriptions (`conversations.json`, §3.2).

### 2.1 The vocabulary (`shared/src/tags.ts`)

One module, imported by every writer and reader; nothing restates it. Built (step 1); the module is the record of the
grammar, caps and parsers, and this section stays as their rationale.

- **Key grammar.** A full key is `<namespace>.<suffix>`. `suffix` is #526's pattern, `[a-z][a-z0-9-]{0,31}`.
  `namespace` is one of the fixed words below, or `adapter.<name>` with `<name>` held to #486's adapter-name pattern
  `^[a-z][a-z0-9-]{0,31}$`. The parser splits at the last dot, so `adapter.x.y` is namespace `adapter.x`, suffix `y`.
- **Namespace is writer, and writer is path.** No frame names its own namespace: the path a tag arrives on decides it
  (#526 already does this for `self.*`: the frame carries the bare suffix). So every write carries bare suffixes: the
  session-event frame's `agent`, `set_self_tag`, the adapter's `tag` frame, the `session-tag` op, an enqueue's
  `creatorTags` and `amend`'s `ownerTags`. Only what the writer itself builds holds full keys: the task record
  (`TaskSpec.tags`, written by the sealer from those bare inputs, and parsed back only into the namespaces task scope
  allows) and every read-side view. A full key on a write is refused `invalid`, never re-homed.

| Namespace          | Scope                  | Written by, and only over                                            | Accepts                                                                                    |
| ------------------ | ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `agent.*`          | process / conversation | the agent's own mod and hooks, through `seance session-event` (§3.1) | known keys only: `kind`, `session`, `remote`                                               |
| `seance.*`         | process                | the daemon itself                                                    | known keys only; none in v1 (reserved)                                                     |
| `self.*`           | process                | the session, through MCP `set_self_tag` (#526), bound by peer pid    | `doing` (#526), `name` (this spec); any other suffix refused `unknown_key` in v1           |
| `adapter.<name>.*` | conversation           | that adapter, over its own stdin (§8.4)                              | any suffix, opaque value                                                                   |
| `owner.*`          | conversation, or task  | the owner, through the PWA only, sealed `from: "app"` (§3.1, §5.2)   | `label` known; any other suffix opaque                                                     |
| `creator.*`        | task                   | whoever enqueues the task, at create only (§5.2)                     | `ref`, `ref-url` known; any other suffix opaque                                            |
| `scheduler.*`      | task                   | the leader, through the one task sealer; proposed                    | known keys only; none in v1 (reserved, so that a leader-made fact never needs a new field) |

- **Values.** Every value passes the printable-text rule, `displayLine` (#526 builds it in `shared/src/messages.ts`;
  this spec moves it to `shared/src/tags.ts` and re-exports it, one implementation), then `TAG_VALUE_MAX` (256 UTF-8
  bytes, cut on a code point boundary; #526's). Empty after the scrub clears the key. **Known keys have strict parsers**
  (below); an opaque value is display text and nothing else, which every reader is held to.
- **Known keys.**

| Key               | Value                                                                                  | Notes                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `agent.kind`      | `claude` (later `codex`), an `AGENT_KINDS` member                                      | corroborated by the process name the daemon already reads (`processNames`)      |
| `agent.session`   | the agent's conversation id, held to `isAgentSessionId` (Claude: a lowercase UUID)     | verified or claimed (§4)                                                        |
| `agent.remote`    | Remote Control's id, `isRemoteSessionId`                                               | today's `remoteSession` (§7)                                                    |
| `self.doing`      | a line                                                                                 | #526, unchanged                                                                 |
| `self.name`       | a name, at most `TASK_REQUEST_LIMITS.title` characters after the scrub                 | third in the name precedence (T2); the standing instruction does not ask for it |
| `owner.label`     | a name, at most the title's cap                                                        | first in the name precedence (T2)                                               |
| `creator.ref`     | `<source>:<id>`, `source` held to the suffix pattern, `id` to `[A-Za-z0-9._#/-]{1,64}` | an external tracker's item, display-only; replaces `TaskSpec.linear` (§5.4)     |
| `creator.ref-url` | an `https:` URL, `httpsUrl`, at most `TAG_VALUE_MAX`                                   | the item's link; the PWA links it, nothing fetches it                           |

- **Caps.** At session scope, `TAGS_PER_WRITER_MAX` (4) per namespace, and `TAGS_PER_PANE_MAX` (16, #526's) over a
  session's process and conversation tags **outside** `adapter.*` (task tags are not counted: they live in the record).
  Each adapter has its own 4 per conversation on top, so with #486's four adapters a session's worst case is 32 keys,
  about 8 KiB; #526's `sessions` fitter (D1.5a) drops adapter tags first and then the rest, all or nothing per tier,
  saying which with `tagsOmitted: "adapter" | "all"`. This amends #526's "16 across all namespaces". At task scope,
  `TASK_TAGS_MAX` (6) per record, budgeted per writer so one cannot starve another: `creator.*` 3, `owner.*` 2,
  `scheduler.*` 1, sized against `STORE_MAX_CT_LENGTH` in `parse.test.ts` as `avoid` and `requires` were. Past a cap a
  write is refused `full`, never a silent drop of another key.
- **Parsers.** `parseTags(raw, { scope, known })` is strict in shape and lenient in membership: it drops (never
  refuses the record for) a key it does not know or whose value fails its parser, so a newer writer never breaks an
  older reader, and keeps every key it does. #526's "every parser keeps only the keys it knows" is this rule.

### 2.2 What every tag is not

Held as an invariant, not an observation (wording in "Threat model"): no tag binds, routes, places, settles, alerts,
authorizes or moves anything, with T1's one exception (§8). No tag is logged, audited as text (an audit line may carry
a key's count, never a key's value), put in argv, `progress`, `MachineStatus`, a push payload or a push's text, or
read by `closeVerdict`, routing, the drain or any custodian verdict. A tag is never the source of a pane, task,
session or path that something acts on.

## 3. Session tags: daemon memory, per level

### 3.1 Writers and paths

- **`agent.*`: the mod's report.** The session-event frame gains `agent: { kind?, session?, remote? }`, sent by the
  `session-events` mod, which already sees each: `$.session.id` (as `tmux-rename` reads it), the bridge id it reads
  for `remoteSession` today, and its own kind. It rides **every** report (one UUID, a kind word and the bridge id: a few dozen bytes on a
  frame sent two or three times a turn), so a daemon that restarted relearns a session's conversation at its next
  report, and a change at `session.start` (`clear` and `resume` included, §4.3) is never missed. An older daemon's
  frame parser ignores the field. Bound to the pane as a state report is (peer pid, falling back to the frame's `pane`
  only on a host that names no peer), because `agent.*` claims are corroborated before they count (§4) and a wrong one
  is corrected by the next report. **A claim that arrived through the `pane` fallback is never verified and never
  counts toward a conflict** (§4.2): no peer was bound, so no process could be checked. `seance session-event` carries `agent` (the mod's CLI path is its only path); `set_self_tag` cannot.
- **`self.*`: `set_self_tag`** (#526, D1.1), unchanged in shape. This spec widens the accepted keys to `doing` and
  `name`. Stricter binding than `agent.*`, as #526 decided: peer pid only, `unbound` otherwise.
- **`seance.*`: the daemon**, in memory. None in v1; reserved so a daemon-made fact (a verification time, a health
  mark) never needs a new field.
- **`adapter.<name>.*`: the adapter**, by a `tag` frame on its stdin, addressed by `agent.session` (§8.4).
- **`owner.*` on a session: a new app op, `session-tag`**, sealed `from: "app"` on the relay leg, parsed by
  `parseSessionTagRequest`, audited without a payload (`op=session-tag key-count=1 outcome=…`), addressed by
  `{ pane, session: <agent.session>, key: "label", value }`: the daemon checks that the pane's bound process's current
  conversation is that id, verified and unconflicted (`moved`, `unverified` or `ambiguous` otherwise), and only then
  stores the label against the id. This is a second thing a verified `agent.session` names, beside §8's delivery: the
  owner's own display write, which binds and routes nothing, and is named in the threat model as such. On no local op, broker action or MCP tool, so a session cannot
  rename itself as the owner: the same rule, and the same honest residual, as `set-limits` and `availability` (a
  process holding the PSK can seal `from: "app"`). Used for **untasked** conversations only; a tasked session's
  `owner.label` lives on the task (§5.2), so it survives the queue and its chain. A `session-tag` naming a
  conversation whose live pane carries a task is answered `tasked` and points the client at the task.

### 3.2 Where each level's tags live

`PaneActivity` (#526 D1.3) keeps the process level: per bound process, its state, `reason`, `self.*`, `agent.remote`,
and a link to its current conversation. **Keyed on `Bound.session` (`<pid>:<start time>`), not the pane pid**, and
pruned when that process is gone: in a hand-started pane the pane process is the shell, which outlives a restarted
`claude`, so #526's pane-pid check would carry one `claude`'s `self.doing` onto the next. This changes #526 D1.1's "no
`Bound.session` walk is needed" (an `ours` pane's `claude` is its pane process, so there the two keys agree). A new table, `Conversations` (`daemon/src/conversations.ts`), keeps the
conversation level: per `agent.session`, its `agent.kind`, whether it is verified (§4), each adapter's tags, its
subscriptions (§8) and an untasked conversation's `owner.label`, plus the processes currently claiming it. **What is
kept against an id (the owner's label, adapter tags, subscriptions) attaches to a process only while that process's
claim of the id is verified and unconflicted**: an unverified claimer of a labelled id shows its own name by the
precedence, never the owner's label, and receives nothing addressed to the id.

- **Memory, except two things nobody re-sends.** `agent.*` is re-sent by the mod on every report, `self.*` by
  the session, and adapter tags by the adapter after each `snapshot` (it keeps its own state; #486's restart already
  starts from a fresh snapshot). The owner's label on an untasked conversation and the adapter subscriptions are not
  re-sent by anyone, so they are kept at rest in `stateDir()/conversations.json` (0600, written atomically), keyed by
  conversation id: `{ ownerLabel?, subscriptions: [{ adapter, since }], lastLive }`. The owner's label is the one text it holds, the
  owner's own, under `displayLine` and the title's cap. At most
  `CONVERSATIONS_KEPT_MAX` (256) entries, the least recently live dropped first, and an entry not live for
  `CONVERSATION_IDLE_MS` (30 days) dropped at load. A file the daemon cannot read loads empty (labels and
  subscriptions are lost, never invented), and nothing in it is logged.
- **Clearing.** Process tags clear as #526's D1.4 says (`ended`, the pane gone, a different task on the pane, a
  restart, or the writer's own `""`), with "a new pane pid" read as "the bound `claude` process gone". Conversation tags clear when the conversation has no live process
  and the daemon restarts (memory), or at the `CONVERSATION_IDLE_MS` prune (what is at rest), or for one adapter's
  tags when that adapter is removed.
- **After a daemon restart** every session reads state `unknown` and carries no process tags until its next report.
  That is expected and shown as such ("state unknown since the daemon restarted"), as #526 already accepts for
  `doing`. A conversation's at-rest label and subscriptions are back at once, and the next `agent.session` report
  reattaches them to its process (every report carries it, §3.1). A session that sends no report (idle, untouched since
  the restart) is found by the daemon's own read instead: at start and at each pane listing, for a pane with no report
  since start, the daemon looks for the `sessions/<pid>.json` of the innermost `claude` under the pane's process, as
  §4.1 reads it, and links a verified conversation without waiting for the mod.

### 3.3 Hand-started sessions (#526's item 1): lift `ours`, and what it costs

#526 holds `self.*` to `ours` panes, because retaining state for a pane séance did not start widens CLAUDE.md's
retention line ("Keeping each `ours` pane's last state and `turnEnded` … only while a custodian seat runs"). A
hand-started session in the daemon's own tmux server is exactly what an adapter most needs: it is how a person joins a
tool by hand.

**Lift it, with the gate moved from `ours` to "a bound `claude` session"** (T4, decided). Retention (state, `reason`,
process and conversation tags) is kept for any pane whose peer resolves to a `claude` process on its chain
(`Bound.session` non-null, "Replies by handle"), tasked or not, `ours` or not. A peer with no `claude` on its chain
(a shell's child) still sends what it sends today, and gets no retention.

- **Cost.** The daemon keeps per-pane memory for panes it did not start, bounded by the caps above and the number of
  panes in its server, pruned at its listings (#526 D1.3). It holds no new act on them: no close, nudge, interrupt or
  key, since every custodian verb and the drain still require `ours` and a launch-ledger task. What changes is that a
  same-uid process typing `claude` in the daemon's tmux server can put lines on the Machines screen; it could already
  put a pane and a window title there.
- **Not lifted:** sessions outside the daemon's tmux server (an IDE terminal, a bare terminal). The mod skips them
  (`TMUX_PANE` unset), and no pane binds them. An adapter sees only sessions in the server; a tool that wants the rest
  is open question 3.
- **Wording.** CLAUDE.md's retention line and #526's `untracked` refusal both change (Threat model).

## 4. Session identity: `agent.session`, claimed and verified

**Built (step 1)**, as DESIGN.md, "Session events", "Session identity" records it. This section stays as the
rationale steps 2 and 4 build on (the acts `atAct` guards).

### 4.1 Verified means the daemon corroborated it from its own facts

An `agent.session` value arrives as a **claim** from the mod (§3.1). It is **verified** when the daemon reads the same
id for the same process from a source of its own:

- **A tasked spawn:** the launch ledger's session id, the one the daemon chose (`--session-id`) or resumed for that
  task, matched against the pane's task. This is the continue invariant's id, so nothing new is trusted. **The ledger
  corroborates only the launch's own conversation**: once the process has reported a `session.start` from `clear` or
  `resume`, or whenever a `sessions/<pid>.json` exists for the process, the file must agree (the ledger a second
  witness for the launch id), since `/clear` in a tasked pane leaves the ledger naming a conversation the process has
  left.
- **An untasked Claude session:** the file Claude Code writes for each running process,
  `<configDir>/sessions/<pid>.json`, which the daemon already reads for the custodian round's Remote Control link
  (`daemon/src/custodian-remote.ts`). Observed on Claude Code 2.1.326 (2026-11-17), it holds `pid`, `sessionId`,
  `procStart`, `startedAt`, `cwd` and, only while Remote Control is on, `bridgeSessionId` (and `name`, `nameSource`,
  `status`, among others; on Linux also `pidDomain`, `linux:<machine-id>:pid:[<pid-namespace inode>]`, which nothing
  here relies on). It is written for every `claude` past the trust dialog, `-p` and `--resume` launches included, under
  whichever config dir the process runs with (S2), and removed on a clean exit but left behind by a `SIGKILL`. The daemon opens it
  exactly as `custodian-remote.ts` does (no symlink, no FIFO, a regular file of at most 64 KiB, the open descriptor
  checked), only for the pid of the `Bound.session` process, searching every config dir its exclave scan knows (the
  default one included) and requiring **exactly one** match, and verifies when the file's `pid` is that pid, its
  `procStart` denotes the same start as `processStart`, and its `sessionId` equals the claim. **`procStart`'s format
  differs by platform** (S3, evidence below), so the daemon reads it by the platform it runs on, never by guessing
  from its shape:
  - **Linux:** `procStart` is `/proc/<pid>/stat`'s start time itself, the decimal clock-tick count since boot that
    `processStart` returns, so the match is plain string equality, exact to the tick. Neither side is wall time, so
    no zone and no clock change can move it.
  - **macOS:** `procStart` is the kernel's start second as a zone-less UTC `ctime` string, so the match is exact to
    the second: parse it as UTC and compare with the seconds part of `processStart`'s `sec.usec`, which is two
    integers (the microseconds unpadded), never a decimal.

  `startedAt` is no substitute on either: it trails the kernel's start by a third of a second or more. Undocumented
  behaviour, like the round's link: re-verified on Claude Code upgrades, and a missing or changed file only means
  "claimed", never a failure.

- **Codex** (docs/agents.md): from the session files under its own `CODEX_HOME`, read the same way; part of that
  spike, not this spec's build.

**A verified id also corroborates `agent.remote`** where the same file's `bridgeSessionId` matches, which today's
`remoteSession` never was. It stays display-only either way.

**Checked at the act, not only at ingest.** Every act a verified id names (a `deliver` or `tag` by
`toSession`/`session`, a `session-tag`) re-reads the source for the process it is about to act on, and a file that now
names another conversation demotes the claim before the act, answered `unverified`. A file that changed with no mod
report is caught there.

**What verification proves, and what it does not.** It defeats a confused or lying peer in the wrong place: a Bash
child of session B claiming session A's id from B's pane is not verified, because the file for B's `claude` names B's
conversation. It does not defeat a same-uid process that writes the file (any process of the owner's uid can), as
nothing on this machine defeats the owner's uid; the threat model says so, as #486 §6.3 does for adapters.

### 4.2 Claims, conflicts and what an id may do

- **Only a verified id addresses** (T1's exception, §8). A claimed one is displayed, marked unverified, and joins
  nothing.
- **A refuted claim is dropped at ingest.** When the daemon's own source for the claiming process names another id
  (its file, or the ledger for an unchanged launch), the claim is not kept, shown or counted: the source says which
  conversation the process is in. **A claim is not refuted by the first read of the file**: Claude Code can rewrite
  the file after the `session.start` event that carries the claim (tens of milliseconds after a `resume` on both
  platforms, and a few after a `clear` or a `-p` start on Linux; S1, evidence below), so the daemon re-reads it for a
  bounded settle window (§4.3) and refutes only a file that still names another id at its end. The ledger, which
  never moves, refutes at once. Until then the claim is held as unverifiable, which can refuse a delivery as `ambiguous`, never misdeliver.
- **Two live panes claiming one id refuse it** (T1): a delivery by that id is `ambiguous`, and the adapter is told so
  in its `session` records (`conflict: true`). The claims counted are the verified ones and the **unverifiable** ones
  (no file, no ledger entry), never a refuted one, and never one bound through the `pane` fallback (§3.1). Counting the
  unverifiable keeps a misdelivery impossible; dropping the refuted keeps a Bash child in another pane from denying
  delivery. A conversation can genuinely be open twice (`claude --resume <id>` in two
  panes); then neither is addressed until one ends.
- **An id never binds a frame to a pane.** Peer pid still decides which process a frame is from; the id only names the
  process's current conversation after that binding.

### 4.3 When the id changes inside one process

`/clear` starts a new conversation and `/resume` switches to another, in the same `claude` process. The mod sees
both (`session.start` with source `clear` or `resume`; `CONTINUES` in both mods) and reports the new id; the daemon
moves the process's link and re-verifies. **The file follows both** (S1, evidence below). On macOS, after `/clear`
it already names the new conversation when the `SessionStart` event fires (written 13–19 ms before it), and after
`/resume` it names the resumed one 37–46 ms after the event. On Linux the `/clear` write lands with the event (19 ms
before to 3 ms after), the `/resume` one 13–30 ms after, and a `-p` process's first write 6 ms after its start event.
So **every report whose id the file does not name yet**, whatever its source, re-reads the file until it agrees or a
settle window of **500 ms** (ten times the slowest observed lag) has passed, only then demoting or refuting (§4.2); a
report the file already agrees with verifies on its first read, which is the usual case for `clear` and `startup`. The mod's own `session.start` rides the same event; the lag the
daemon sees also includes the report's trip over the socket, which only shortens the wait.

### 4.4 This amends a rejected alternative

DESIGN.md, "Replies by handle", Rejected, "the Claude session id": "a `$.session` value only the mod sees: the daemon
would trust a claim from a frame". That reason stands for a claim and falls for a verified id, which the daemon reads
itself. The amended line keeps the rejection for **replies** (a reply is still by message id) and points to §8 for
the one use a verified id gets.

## 5. Task tags: in the task record, through the one sealer

**Built 2026-11-18 (step 3); DESIGN.md, "Task tags" is the record** and this section's text went into it. The
subsections stay as pointers, since code cites them by number.

### 5.1 Shape and skew

`TaskSpec.tags`, its caps, `TAGS_DEP_SENTINEL`, the `CAPABILITIES.taskTags` gate, the cost the sentinel carries (and
why it is an exception to the skew list's rule) and the archivist's strip: DESIGN.md, "Task tags", and its skew-list
entry.

### 5.2 Writers, kept few

`creator.*` at create, `owner.*` only through `amend` from the PWA in any state, `scheduler.*` none in v1, adapters
none: DESIGN.md, "Task tags" and "Amending a waiting task" (tags-only). A separate `set-task-tags` op and a changeable
`creator.*` stay rejected.

### 5.3 Chains

`creator.*` copied by the client (continuation) or the creating leg (successor); `owner.*` copied by the leader at the
first move out of `queued`; `scheduler.*` never; conversation tags carry on a continuation, process tags never:
DESIGN.md, "Task tags", "Continuing a session" and "Passing to a successor".

### 5.4 `linear` becomes the first task tag

Mapped at the join only (`taskTagEntries`), never in the record; writers send `ref` (`source:id`, optional URL) once
the leader advertises `taskTags` (none writes `linear` any more); `doneBy: "linear"` and
`SettingsRecord.linearKey` are unchanged: DESIGN.md, "Task tags". orchestrator.md's `ref: { source, id, url? }` is
`creator.ref` plus `creator.ref-url`; its "find its own tasks" can filter `get_queue` by `creator.ref` (open question
5). This resolves #486's open question 14.

## 6. The joined view and the name

### 6.1 One join, decided once

`joinTags(task?, conversation?, process?)` in `shared/src/tags.ts` is the only place precedence lives. It returns
`tags: Record<key, { value, at, scope: "task" | "conversation" | "process", verified?: true }>` (#526's `{ value, at }`
plus scope, so #526's map stays a valid subset). A key exists at one scope by construction (each namespace has its
scopes, §2.1) bar `owner.label`, where the task's wins over the conversation's (a tasked conversation has no session
label, §3.1; the rule covers a task started from a labelled conversation).

**The name** (T2): `displayName(joined, task?, window)` →
`{ text, source: "owner" | "task" | "self" | "window" }`, by `owner.label` > the task's title > `self.name` > the
window name. Every surface that uses it shows `source` when it is `self` or `window` ("fix flaky test (self-named)",
"zsh (window)"), never for `owner` or `task`. **It is used only on the owner's own surfaces** (the PWA) and in an
adapter's `Session`. Anything that puts a name in another agent's context (a message wrapper, a receipt,
`presenceNote`, the custodian's `sessions`, MCP) keeps the task's title or the window as today: `self.name` is
session-chosen text.

**Who joins.** The reader, since no single process holds both scopes: the daemon holds session tags and, for its own
launches, the task's ref (below); the PWA and `seance mcp` hold the queue.

- **The spawn carries the task's ref, for adapters only.** Built (`SpawnRequest.ref`, `TaskNote.ref`, the adapter's
  `task.ref`): DESIGN.md, "Task tags". Not in a `sessions` reply, and no `owner.*` or opaque tag goes to the daemon, so
  there is no stale second copy of the owner's label. Open question 4.

### 6.2 Surfaces

| Surface                                  | Gets                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| PWA (Machines, Queue, task details)      | the joined view, every namespace, each with its scope, writer and age; `verified` shown on `agent.session` |
| `sessions` op to an app                  | session tags (`SessionEntry.tags`, #526's map with `scope`)                                                |
| `sessions` op sealed from the scheduler  | **none** (#526 D1.5a, kept)                                                                                |
| MCP `get_sessions`, `get_queue`          | an allowlist (§6.3)                                                                                        |
| adapter `Session` (#486)                 | session tags but **other adapters'** `adapter.*`, plus the dispatched ref (§6.1)                           |
| custodian `sessions` verb                | `self.doing` only (#526 D1.6); nothing else                                                                |
| `MachineStatus`, push, logs, audit, argv | **never**                                                                                                  |
| archive                                  | `creator.ref`, `creator.ref-url` only (§5.1)                                                               |

An adapter never sees another adapter's tags: each adapter is a separate third party, and one tool's ids are not
another's business.

### 6.3 Another agent's context (#526's item 2)

#526 keeps tags out of other agents' context: `get_sessions` prints a field allowlist, and a scheduler-sealed
`sessions` gets none. The question is whether an orchestrator session (docs/orchestrator.md) may see others' tags.

**Decided and built (step 3): by writer, not by reader, and narrow.** `AGENT_VISIBLE_TAG_KEYS` is `agent.kind`,
`creator.ref` and `owner.label`: MCP's `get_sessions` and `get_queue` print only those (DESIGN.md, "Task tags",
"Session identity"). Not `creator.ref-url` or opaque `creator.*` suffixes (when a session enqueued, those are
session-chosen text), not `agent.session` (no reader needs another session's conversation id, and handing it out only
helps one claim another's), and tags a session or a tool chose (`self.*`, `adapter.*`) stay out of every MCP surface for
every caller, orchestrator included: they reach another session only inside Séance's fixed wrappers (#526 §2's
`presenceNote`).
**Rejected:** an orchestrator role that sees more. MCP cannot tell an orchestrator from any other session (both are
`seance mcp` sealing `from: "app"`), so a role would be a claim; and orchestrator.md decides nothing yet.

## 7. `remoteSession` becomes `agent.remote`

Today `remoteSession` is a carried claim on the local session-event frame, a field of the `SessionEvent` op to the
leader, and `Task.remoteSession` in the store (DESIGN.md, "Session events"; CLAUDE.md's local-socket bullet). The
migration renames the concept, not the wire fields the skew table depends on:

1. **Local frame** (built, step 1). The mod sends `agent: { remote }` and, until its floor moves, `remoteSession` too; the daemon
   reads `agent.remote` first and `remoteSession` as its fallback, through the one `isRemoteSessionId`.
2. **Daemon to leader.** `SessionEvent.remoteSession` keeps its name: it is the daemon's own field on a sealed op,
   and an older leader parses it. No rename on the wire.
3. **The store.** `Task.remoteSession` keeps its name and its rule (the newest its machine reported, dropped when the
   task goes back to `ready`). It is a task field, not a tag: the joined view carries `agent.remote` at process scope
   from a live session only, and the PWA falls back to `Task.remoteSession` outside the tag map, as today.
4. **Readers** (built, step 1). The PWA's claude.ai link reads `agent.remote` from the joined view; the custodian round's link
   (`custodian-remote.ts`) is unchanged, since the round has no session events.
5. **Codex** later supplies its own `agent.remote` (docs/agents.md: a link into its app), through the same key.

## 8. The adapter subscription (amends D3)

### 8.1 Why

#486's review: a tool's asks live for days, and a session that joined the tool by messaging `adapter:<name>` is
answerable only by reply, for the `sent` table's hour, and only while the same `claude` process runs. A restart, a
`--resume`, a `continue_task` or an hour's silence each cut it off, and the session cannot even tell the tool who it
is, since the adapter's key (`<pid>:<start time>`) is not something the session knows.

### 8.2 The decision

**A session that sends a message to `adapter:<name>` subscribes its conversation to that adapter, for the
conversation's life**, and the adapter may then deliver to it by `agent.session`.

- **Only a verified conversation subscribes.** The daemon takes the conversation from the sender's bound process
  (peer pid, then `Bound.session`, then that process's verified `agent.session`), never from the frame. A sender with
  no verified id still reaches the adapter and is answerable by reply for the hour, as #486 has it; its `message`
  frame to the adapter says `subscribed: false` so the tool knows.
- **Kept at rest** in `conversations.json` (§3.2), so a daemon restart or self-update does not end it; dropped when the
  conversation is not live for `CONVERSATION_IDLE_MS` (30 days), when the adapter is removed from `config.json` or
  added again under the same name (`seanced adapter add` drops that name's subscriptions, so a replaced program
  inherits none), or
  when the session sends `adapter:<name>` a `leave` (a `send_message` flag, `leave: true`, no text needed).
- **Delivery by subscription.** `deliver { toSession: <agent.session>, … }` reaches the one live pane whose verified
  `agent.session` it is, under every rule of #486's delivery (the adapter wrapper, `kinds`, the rate buckets, the
  mod's local delivery, never a key); `ambiguous` when two live panes claim the id (§4.2), `ended` when none is live
  (nothing held: D2), `unknown` when the conversation is not subscribed to this adapter. #486's `kinds` and `repos` bound it as they
  bound any delivery (`refused`), and a session outside `repos` cannot subscribe (docs/messaging.md §6.2, as revised).
- **Across a continue chain** the subscription carries automatically (same id, same machine). Not to a successor (a
  new conversation): the adapter learns of the successor from #486's `task` event and reaches it by task id, or the
  successor subscribes itself.

### 8.3 Why D3's one-hour bearer reason does not apply

D3 bounds a reply handle to an hour because the handle is a **bearer**: a message id that crossed the wire, held by
whoever received it, valid from any machine through the leader. A subscription is not a bearer. Its authority is the
session's own act (messaging the adapter), recorded by the daemon against a conversation it verified; it is usable
only over that one adapter's stdin, on that one machine; and the id it is keyed by, `agent.session`, grants nothing to
anyone else who learns it. What an hour bounded for a bearer is bounded here by the channel.

### 8.4 Adapter tags

An adapter writes `adapter.<name>.*` tags (its ticket id, its own state word) by a `tag` frame,
`{ kind: "tag", session: <agent.session> | task: <task id>, key, value }` (a bare suffix), on a conversation
subscribed to it, or on the session of a task it may deliver to by id (a launch this machine's ledger holds, within
`repos`), under the caps.
Replayed by the adapter after each `snapshot`, kept in memory only. They show in the PWA and in that adapter's own
`Session` records, never in another adapter's, never on MCP (§6.3).

### 8.5 What this amends

- **docs/messaging.md D3** (amended 2026-11-14): "A session without a task is reached only as a reply, by the id of a
  message it sent" gains: "**or, by its adapter, through the subscription it made by messaging that adapter**
  (docs/tags.md §8)." The "Rejected: the Claude session id" bullet in §2 is narrowed as in §4.4.
- **DESIGN.md, "Replies by handle"**, Rejected list, "the Claude session id": as §4.4.
- **CLAUDE.md, messaging bullet**, "**A session with no task is reached only as a reply, by the id of a message it
  sent**": add "or by an adapter on its own machine through a subscription the session made by messaging it, keyed
  by its verified conversation id (docs/tags.md §8): kept at rest in `conversations.json`, refused when two live
  panes claim the id, usable only over that adapter's stdin."

## Rejected

- **One per-pane bag of tags** (no levels). Loses conversation facts at every restart or keeps process facts past
  their truth (§1).
- **Tags in `MachineStatus`.** 1.5 KiB of ciphertext for the whole machine (#526 D1.5, kept).
- **Session tags in the store** (a leader-held map keyed by conversation). Every change a term-fenced write and a push
  to every app; a leader holding session text (#526 rejected `Task.doing` for this).
- **A free-for-all namespace** (any writer, any key). Without namespace-as-writer, a session could set `owner.label`
  and a tool could set `agent.session`; access rules would have to be per key and would drift.
- **Trusting the mod's `agent.session` without verification.** A Bash child of one session could claim another's
  conversation from its own pane; verification makes that a non-event (§4.1).
- **The pane id or `<pid>:<start time>` as the adapter's key** (#486 as drafted). Neither survives a restart, and the
  session cannot learn either.
- **Persisting every session tag.** Process tags are false after a restart; conversation tags other than the owner's
  label and subscriptions are re-sent by their writers.
- **A separate `set-task-tags` op**, and **adapter task tags** (§5.2).
- **Extending the reply handle's TTL for adapters** instead of a subscription. A longer-lived bearer, still bound to
  one process, still useless across `--resume`.

## Threat model

New, and what bounds it:

- **A session-chosen or tool-chosen string other readers display** (`self.*`, `adapter.*`). Scrubbed by
  `displayLine`, capped, labelled with its writer, scope and age, kept out of MCP and pushes; only Séance's fixed
  wrappers carry `self.doing` to another session (#526).
- **Retention for hand-started panes** (§3.3): memory per bound `claude` process, bounded and pruned, no new act.
- **A verified conversation id addresses one thing**: adapter delivery, on one machine, to a subscribed conversation,
  refused when ambiguous. It is read by the daemon from its ledger or the agent's own per-process file, never taken
  from a frame to bind anything.
- **A long-lived subscription** (§8.3): the session's own act, at rest in one 0600 file of conversation ids, adapter
  names and the owner's labels (its one text, the owner's own).
- **The owner's `session-tag`** names a conversation by a verified id to label it: a display write the owner seals,
  binding and routing nothing (§3.1).
- **Task tags in the record**: display text sealed like a title, held to the sentinel, the gate and the archivist's
  strip.

Wording this changes, each in the PR that builds it:

- CLAUDE.md, local-socket bullet, "The frame's other carried claims are `remoteSession` …" (done, step 1, but for #526's
  `self` wording, which has not landed): becomes `agent`
  (`kind`, `session`, `remote`; `remoteSession` read as `remote`'s fallback), each kept only as its parser passes it;
  `agent.session` verified only against the launch ledger or the `claude` process's own `sessions/<pid>.json`,
  opened as `custodian-remote.ts` opens it, re-read at each act, a refuted claim dropped, and used only to address
  adapter delivery and the owner's `session-tag`; and #526's `self` wording
  widened from `self.doing` to the `self.*` keys this spec accepts.
- CLAUDE.md, same bullet, "Keeping each `ours` pane's last state and `turnEnded`, tasked or not …": "each pane whose
  peer resolves to a `claude` process", and the conversation table beside it (done, step 1, as a sentence of its own:
  the custodian's tracker stays `ours`-only, and the table is a separate module, `conversations.ts`).
- Done, step 3: CLAUDE.md, the task-sealer list: "every task record carrying `tags` is sealed through that same sealer, which
  appends `TAGS_DEP_SENTINEL` …; a client writes `tags` only to a verified leader advertising `CAPABILITIES.taskTags`;
  `owner.*` only through `amend` from the PWA, in any state; adapters write none".
- Done, step 3: CLAUDE.md, the amend sentence ("a task's prompt, title, model and effort change after its create only by the
  leader's own write on an `amend` … only while …"): add that a tags-only amend, `owner.*` only, is the leader's own
  write in any state.
- Done, step 3: CLAUDE.md, the archivist's `archive.sqlite` sentence: `tags` dropped but `creator.ref` and `creator.ref-url`.
- Done, step 3: CLAUDE.md, the push sentence: "its payload carries ids and state only" gains "and never a tag".
- CLAUDE.md, a new bullet beside "Closing a machine is the owner's sealed act": `session-tag` is the owner's sealed
  act (relay leg, `from: "app"`, its parser, audited without payload, on no local op, broker action or MCP tool).
- CLAUDE.md, messaging bullet: §8.5.
- Done, step 3: CLAUDE.md, the task-sealer list's phrase for `amend`, and the broker bullet's `amend` action: neither carries
  `ownerTags`; the leader drops `owner.*` and `scheduler.*` from a version-1 record.
- DESIGN.md: "Session events" (the `agent` field, retention; done, step 1), "Session messages" and "Replies by
  handle" (§8.5), and, done in step 3 as the "Task tags" section with pointers in "Continuing a session", "Passing to a
  successor", "Amending a waiting task", the MCP server, the PWA, the archivist, the skew list and Threat model items 2
  and 6.

## What changes in #526 (docs/presence.md)

#526 stays valid as a first slice; these are the edits it takes when this spec is decided, in whichever PR lands
second:

- **D1.0**: "never in a task record" holds for session tags; task tags are this spec's §5. The namespace table gains
  `creator.*` and `scheduler.*` (decided 2026-11-17) and points here.
- **D1.1**: the `untracked` refusal for a hand-started pane goes (§3.3), and so does its test; "no `Bound.session`
  walk is needed" becomes the `Bound.session` key (§3.2).
- **D1.2**: `TAGS_PER_PANE_MAX` counts non-adapter session tags (§2.1); `displayLine` moves to `shared/src/tags.ts`.
- **D1.3/D1.4**: entries keyed on the bound `claude` process, cleared when it is gone (§3.2).
- **D1.5**: the map's entries gain `scope`; `get_sessions`' allowlist gains the keys of §6.3; the fitter drops
  adapter tags before the rest (§2.1).

## Open questions

1. **`self.name` at all?** It is third in T2's precedence and fills the hand-started case. _Recommend yes_, accepted
   by `set_self_tag`, not asked for by the standing instruction, shown only on the owner's surfaces (§6.1).
2. **Should an owner label on an untasked conversation follow it into a task?** Nothing adopts a hand-started session
   into a task today. _Recommend nothing until something does._
3. **Sessions outside the daemon's tmux server** (an IDE terminal), which a tool would also like to see. _Recommend
   not in this spec_: no pane, no peer-pid binding to a pane, no mod report; it would need its own binding model.
4. **The owner's label reaching adapters while a task runs.** Only the ref is dispatched (§6.1), so an adapter names
   a task's session by its title. _Recommend leaving it_ unless the owner wants tools to show the label; then a
   scheduler-sealed push of `owner.label` to the task's machine, memory only.
5. **Filtering `get_queue` by `creator.ref`** for an orchestrator (orchestrator.md's "find its own tasks").
   _Recommend yes, with orchestrator.md's project-wide read_, not in this spec's PRs.
6. **`agent.kind` for Codex**: whether the daemon can corroborate it as it does for `claude` (`processNames`).
   Part of docs/agents.md's spike.
7. **`creator.*` and `scheduler.*`** (beyond T1's five namespaces). **Decided 2026-11-17: both.** `creator.*` is where `linear`
   and orchestrator.md's `ref` go, and `scheduler.*` reserves a slot so a leader-made display fact needs no new field.

8. **An older keyless broker daemon drops `tags`** from a brokered enqueue (its `parseTaskSpec`), so a task a session
   queues through `seance mcp` or the CLI behind it lands untagged. Display data only, so no stale-broker check guards
   it (a `staleDaemonOf` test was weighed and left out). _Recommend leaving it_ unless refs become load-bearing.
9. **A task's tags carry the task's `createdAt` as their `at`**: a task has no per-key time, so an amended label shows
   the task's age. _Recommend keeping it_ until a surface wants "labelled 2 h ago"; then `owner.*` gets a stamp, which is
   a record-format change.

## Spikes before building

- **S1.** Does `<configDir>/sessions/<pid>.json`'s `sessionId` follow `/clear` and `/resume`, and how soon after the
  mod's `session.start`? On macOS and Linux, the current Claude Code.
- **S2.** Is the file written for every interactive `claude` (not only `--remote-control` ones, which is all the
  custodian has relied on), and for `kind`s other than `interactive`?
- **S3.** What precision `procStart` carries (observed as a date string to the second) and how it compares with
  `processStart` on each platform, including across a clock change; whether `startedAt` (ms) is the better match.

Both platforms are below. They agree on S1 and S2; S3 differs in `procStart`'s format, and §4.1 reads it per
platform.

### Evidence, macOS (Claude Code 2.1.326, 2026-11-17)

Throwaway `claude` processes in panes of a private tmux server, in a trusted checkout, with no prompt typed but one
`-p` call. A watcher polled `sessions/*.json` every 5 ms and logged each change of `sessionId`; a `SessionStart`
command hook (from a `--settings` file, not the user's settings) logged its own time, `source` and `session_id`. That
hook fires on the event the mod's `session.start` rides. Timings are the watcher's first sight of the file minus the
hook's log line, so each is good to about ±5 ms. Ids were compared, never recorded.

**S1: the file follows `/clear` and `/resume`, in the same process.** Yes to both.

| Act                                | Tries | File names the new id                                                      |
| ---------------------------------- | ----- | -------------------------------------------------------------------------- |
| `/clear`                           | 11    | 13–19 ms **before** the hook (11/11)                                       |
| `/resume <id>`                     | 6     | 37–46 ms **after** the hook (6/6)                                          |
| fresh start                        | 4     | first write 3–390 ms before the hook, already carrying the hook's id (4/4) |
| `claude --resume <id>` (at launch) | 1     | first write 261 ms before the hook, already the resumed id                 |

`procStart`, `startedAt` and `pid` stay put across `/clear` and `/resume`; only `sessionId` (and `updatedAt`) moves.
`/resume` is the case that changes the design: a report read against the file at once would find the old id and be
refuted, so §4.2 and §4.3 now re-read for a settle window, and the build order's step 1 tests it.

**S2: which `claude`s get a file.**

| Process                                                             | File?                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| interactive, Remote Control at startup (the config's own setting)   | yes, `bridgeSessionId` added about a second after the first write                        |
| interactive, `remoteControlAtStartup: false` (through `--settings`) | yes, with no `bridgeSessionId` key; follows `/clear` the same                            |
| `-p`                                                                | yes, for its life; `kind` is still `interactive`, `entrypoint` is `sdk-cli` (else `cli`) |
| `claude --resume <id>`                                              | yes, the resumed id from the first write                                                 |
| under a named exclave's `CLAUDE_CONFIG_DIR`                         | yes, in that dir's `sessions/`, none in the default one                                  |
| waiting at the trust dialog of an untrusted folder                  | no (and no `SessionStart` either)                                                        |

On exit: `/exit`, `SIGTERM` and the end of a `-p` run remove the file; `SIGKILL` leaves it, with its
`<pid>.<hash>.key` beside it, so a stale file for a later process with a reused pid is real and `procStart` is what
rejects it. `kind` does not tell a `-p` process from an interactive one on this version, so nothing should key on it.
The design holds: every config dir is searched, and a file only ever corroborates.

**S3: `procStart` against `processStart`.** `procStart` is a `ctime`-style string (`Ddd Mmm d HH:MM:SS YYYY`) in
**UTC, with no zone**: read as local time it is off by the zone offset (an hour here), read as UTC it equals the
seconds part of `processStart`'s `sec.usec` exactly, in 9 of 9 files (the spike's and the machine's other sessions'
files, read for these two fields only). `ps -o lstart` shows the same second in local time. `processStart`'s
microseconds are unpadded (`.1477` is 1477 µs), so it is compared as two integers, never parsed as a decimal.
`startedAt` (ms) is the process's own clock read early in its boot, 0.30–0.61 s after the kernel's start in the same
9 files: it cannot match `processStart` exactly, and a window wide enough to hold it would be wider than `procStart`'s
one second. `procStart` is the match; `startedAt` is at most a sanity bound (never earlier than the kernel's start).

A clock change was not tested: stepping the clock needs root and would disturb every other process on the owner's
machine (TLS, timers, other sessions). By reasoning only: macOS keeps a process's start as wall time stamped at fork
and never adjusts it, and `procStart` agrees with it to the second (so it is most likely read from the kernel, not
from Claude's own clock), so a step moves neither side and the match survives. Linux, where
`processStart` is ticks since boot and a date string has to add a boot time, is where a clock change could matter and
is part of the Linux run.

### Evidence, Linux (Claude Code 2.1.326, 2026-11-17)

The macOS method, on a Linux host (Proxmox VE kernel 7.0, `CLK_TCK` 100, system zone UTC): throwaway `claude`
processes in panes of a private tmux server, in a trusted checkout, no prompt typed but one `-p` call; a watcher
polling every config dir's `sessions/*.json` every 5 ms and logging each change of `sessionId`; a `SessionStart`
command hook from a `--settings` file logging its own time, `source` and `session_id`. Ids were compared as hashes,
never recorded. Timings are the watcher's first sight minus the hook's log line, good to about ±5 ms; the hook stamps
its line after its shell and `jq` start, so the event itself is a few ms earlier than the hook's time.

**S1: the file follows `/clear` and `/resume`, in the same process.** Yes to both, as on macOS; the timings differ.

| Act                                | Tries | File names the new id                                                  |
| ---------------------------------- | ----- | ---------------------------------------------------------------------- |
| `/clear`                           | 17    | 19 ms before to 3 ms after the hook (17/17); macOS was always before   |
| `/resume <id>`                     | 6     | 13–30 ms **after** the hook (6/6)                                      |
| fresh start                        | 5     | first write 225–826 ms before the hook, already carrying the hook's id |
| `claude --resume <id>` (at launch) | 1     | first write 92 ms before the hook, already the resumed id              |
| `-p`                               | 1     | first write 6 ms **after** the hook, carrying its id                   |

`procStart`, `startedAt` and `pid` stay put across `/clear` and `/resume`, as on macOS. What changes the design: on
Linux a `clear` (and a `-p` start) can be written just after the event, not only a `resume`, so §4.2 and §4.3 now
hold any report the file does not name yet over the settle window, whatever its source, instead of `resume` alone.
The slowest lag seen on either platform is 46 ms, so the 500 ms window stands.

**S2: which `claude`s get a file.** The same answers as macOS.

| Process                                                             | File?                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| interactive, Remote Control at startup (the config's own setting)   | yes, `bridgeSessionId` added 1.16 s after the first write                    |
| interactive, `remoteControlAtStartup: false` (through `--settings`) | yes, with no `bridgeSessionId` key; follows `/clear` and `/resume` the same  |
| `-p`                                                                | yes, for its life (1.2 s here); `kind` `interactive`, `entrypoint` `sdk-cli` |
| `claude --resume <id>`                                              | yes, the resumed id from the first write                                     |
| under a named exclave's `CLAUDE_CONFIG_DIR`                         | yes, in that dir's `sessions/`                                               |
| with no `CLAUDE_CONFIG_DIR` (the default dir)                       | yes, in `~/.claude/sessions/`, none in the named exclave's                   |
| waiting at the trust dialog of an untrusted folder                  | no (and no `SessionStart` either)                                            |

On exit: `SIGTERM` and the end of a `-p` run remove the file; `SIGKILL` leaves it with its `<pid>.<hash>.key`. `/exit`
removes it, but in 2 of 5 tries (one with Remote Control on, one with it off after `/resume`) the file reappeared
about 10 ms after its removal and was gone for good 0.5–0.8 s later. Its `pid` and `procStart` still name the exiting
process, so a reader matching both is not misled; a reader treating the file's presence alone as "running" would be.
The first write carries fewer keys than later ones (`status`, `statusUpdatedAt` and `updatedAt` arrive with the
first status update), so a reader requires only the keys it uses. Linux files also carry `pidDomain`,
`linux:<machine-id>:pid:[<pid-namespace inode>]` (the `/etc/machine-id` and `/proc/<pid>/ns/pid` of the writer),
besides `version`, `peerProtocol`, `peerFeatures`, `messagingSocketPath`, `tmux` and `asksForConvertedSkills`; the
design uses none of them.

**S3: `procStart` against `processStart`.** **`procStart` on Linux is not a date string**: it is the decimal string
of `/proc/<pid>/stat`'s field 22, the start time in clock ticks since boot, exactly what `processStart`
(`daemon/src/peer.ts`) returns. It equals `processStart(pid)` byte for byte in 10 of 10 files (the spike's processes
and the machine's other sessions' files, read for these two fields only), under the default and two named config
dirs, and with `TZ=Europe/Oslo` set on the `claude` process. So the Linux match is string equality, exact to the
tick (10 ms here), with no parse and no zone. `startedAt` (ms) trails the kernel's start by 0.30–0.42 s in 7 files
(the kernel's start taken as `CLOCK_REALTIME − CLOCK_BOOTTIME` plus the ticks, so good to a tick): as on macOS it
cannot match, and `procStart` is the match.

A clock change needs no test on Linux: both sides are ticks since boot, so a wall-clock step moves neither, and no
date conversion (where a step would matter) happens on either side. The platforms disagree only in format, which is
why §4.1 now reads `procStart` per platform.

## Build order

Small PRs, each landing on its own. #526's PR 1 (`self.doing`) can land before or after PR 1 here: its shapes are
this spec's (the `tags` map, the caps, the `self` frame), and the edits above follow whichever lands second.

1. **The vocabulary and `agent.*`.** **Built 2026-11-17** (DESIGN.md, "Session events", "Session identity").
   `shared/src/tags.ts` (grammar, namespaces, caps, `displayLine` moved,
   `parseTags`, known-key parsers, `joinTags`, `displayName`); the session-event frame's `agent`, on every report;
   `Conversations` in memory; verification from the launch ledger and `sessions/<pid>.json` (`procStart` read per platform: on
   Linux equal to `processStart`'s tick string, on macOS read as UTC against its seconds; a report the file does not
   name yet re-read over the settle window, whatever its source, §4.3), re-read at each act; the
   daemon's own read for panes with no report since start; `remoteSession` as `agent.remote`'s fallback (§7 steps 1
   and 4); retention keyed on the bound `claude` process, for any such pane (§3.2, §3.3); `SessionEntry.tags` with
   `scope`.
   - Tested by: `shared` unit tests for the grammar (dots, the adapter split, a full key on a write refused), every
     known key's parser, the caps and per-writer budgets (`full`), `joinTags`' precedence and `displayName`'s sources;
     daemon tests with real peers (`ClaudeStub.runInPane`): a claim verified from the ledger; one verified from a
     `sessions/<pid>.json` the stub writes; one left unverifiable with no file; a refuted claim (the file names
     another id) neither kept nor counted toward a conflict; a `resume` report, and a `clear` one, whose file still names
     the old id at first read and the new one within the settle window verified, and one whose file never changes
     refuted only at the window's end; on macOS a `procStart` in UTC matched across a non-UTC `TZ`, and one a second
     off not; on Linux a `procStart` equal to `processStart` matched, and one a tick off, or in macOS's `ctime` form,
     not; a file for
     another pid, an older start, a symlink or a FIFO ignored; two config dirs both matching is no verification; two verified or unverifiable claims marked
     `conflict`; a claim through the `pane` fallback never verified or counted; a `/clear` in a tasked pane demoting
     the ledger's id until the file agrees, and an act after it re-reading the file and answering `unverified`; a
     daemon restart relearning the conversation from the next report and, for an idle pane, from its own read;
     retention for a hand-started pane with a `claude` stub, none for a shell's child, and a `claude` restarted under
     the same shell starting with no `self.*`; the mod's test that `agent` rides every report; the layering test that
     no tag text reaches `log.ts` or `audit.ts`.
2. **Owner labels on sessions, and the name.** The `session-tag` app op, `conversations.json`, the PWA's rename on
   the Machines screen, `displayName` on the PWA with its source mark.
   - Tested by: the op refused unless sealed `from: "app"` on the relay leg, absent from `LOCAL_OPS`, `BROKER_OPS`
     and MCP (a test over each list); `tasked`, `moved`, `unverified` and `ambiguous`; the label not shown for an
     unverified claimer of a labelled id; the file's mode, atomic write, cap, idle prune and unreadable-loads-empty;
     a restart keeping the label; a PWA view test for each name source; and a test that message wrappers, receipts
     and the custodian's `sessions` never carry `self.name` or the owner's label.
3. **Task tags.** **Built 2026-11-18** (DESIGN.md, "Task tags"). `TaskSpec.tags`, `creatorTags`, `ownerTags`, `TAGS_DEP_SENTINEL`, `CAPABILITIES.taskTags`,
   `creator.*` on every enqueue path, `owner.*` through `amend` in any state, the chain copies (§5.3),
   `SpawnRequest.ref` into the ledger, `linear` shown as `creator.ref` at the join, the archivist's strip, MCP's
   allowlist (§6.3).
   - Tested by: `shared` tests that the sealer appends the sentinel and the parser refuses it without `tags`; a size
     test at every cap under `STORE_MAX_CT_LENGTH`; leader tests for a tags-only amend on a running and a finished
     task, `owner.*` only, `amend_task` and the broker's `amend` refusing `ownerTags`, and `owner.*`/`scheduler.*`
     dropped from a version-1 record; scheduler tests for the continuation copy (the leader's, from the `continues`
     record) and the successor copy, `scheduler.*` never copied; a legacy record with `linear` re-sealed by a leader
     write still read by an older parser, and shown as `creator.ref` by `joinTags`; an archivist test that only the
     two ref tags reach a row; `get_queue` showing `creator.ref` and never `creator.ref-url`, an opaque `creator.*`,
     `agent.session` or `self.*`; an e2e test queueing a task with a ref to a two-daemon fleet and reading it back
     in the queue, ending it through `cancelTask`.
4. **The adapter subscription** lands with #486's PR 3b (docs/messaging.md §6, as revised): `subscribed`,
   `toSession`, `leave`, `ambiguous`, adapter `tag` frames, the at-rest subscriptions, `adapter add` dropping a
   name's subscriptions. Its tests are listed there.
