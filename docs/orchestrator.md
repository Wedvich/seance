# Orchestrators and project queueing — plan

**Status: milestones 1–3 are a spec, decided by the owner 2026-11-26 (Q1–Q9 and Q11; Q10, the dry run's project, is
picked before the run). Milestones 4 and 5 are a draft, their questions (Q12–Q18) open for milestone 3's evidence.
Nothing is built.** Drafted 2026-11-13 from the owner's voice memo of 2026-11-12; milestones 1–3 specced 2026-11-26
from the owner's brief of that day and settled in an interview the same day. What the owner said and the decided
questions are the owner's; the rest is the plan built on them. Milestones 1–3 may be built from; milestones 4 and 5
may not. As a milestone lands, its decisions move into DESIGN.md as "Decided by the owner (date)" and its section here
shrinks to an index, as docs/drain.md's did.

Milestones are named in full ("milestone 2"), never M2: docs/scheduler.md's M1–M4 are the scheduler's.

## Problem

Séance queues tasks one at a time or in a hand-written batch. The owner wants to say "implement
this project" and have the whole thing queued, run and kept on course:

- **A project is a graph, and somebody has to write it.** Today a session reads the issues and
  calls `queue_batch` by hand (16 members a call, `BATCH_TASKS_MAX`).
- **The graph changes while it runs.** Finished work turns up follow-up issues and new
  dependencies. `amend` (built 2026-11-12) changes a waiting task's prompt, title, model and
  effort; it does not change what the task waits on.
- **The work lives in a tracker Séance should not know.** Linear today, something else tomorrow.
- **Nobody tends the graph.** The owner does: watching what lands, queueing the next thing,
  rewriting what is waiting. That is the job to hand to an agent.

## What the owner said

### The memo (2026-11-12)

In order. These are wants, not decisions on mechanism.

1. Queue an entire Linear project: "implement this project", and Séance queues the tasks and
   starts building.
2. Amend has to grow for this. As work proceeds it creates follow-up issues and more work, which
   must adapt the graph already in the queue, and Séance should support that.
3. Séance is not tied hard to Linear. As with the adapter seam for other tools (DESIGN.md, "Adapters"),
   neither codebase knows the other: Séance offers an adapter interface, and a separate adapter
   mediates. Work tracking is the same shape, with a Linear adapter as the first one.
4. A new role, after Steve Yegge's split: short-lived agents do the implementation and are gone;
   long-lived orchestrators, on the strongest model, plan and queue.
5. That role is like the custodian (docs/custodian.md) in that it is not a task and takes no queue
   slot, and unlike it in that a machine may run any number.
6. The end goal: an agent that finds work and queues it by itself, doing what the owner does now
   when driving sessions that spawn sessions.

### The brief (2026-11-26)

- Before deciding on a new role, run §1's orchestrator by hand. For that, the queue surface must be complete enough for
  a session to keep a graph true: milestones 1–3.
- Out until then, not even partly: the role proper (not-a-task, its own pane option, audit origin, fence), autonomous
  intake, any tracker client or key in the leader, daemon or relay, widening the adapter seam to the queue, a PWA
  surface for any of this, and #18 (§2).
- Each milestone's code is one PR: mixed-version safe, record first, MCP and `seance` only (through the broker when
  keyless), never logged, its tests admitted, no deploys.
- The dry run: CI is a worker's definition of done; every correction becomes a proposed check; an optional reviewer
  task; a project in a repo whose CI is already strict.

### The interview (2026-11-26)

The owner's answers to Q1–Q9 and Q11, each with what it rejected, are under "Questions for the owner".

## What exists

| Need                          | Today                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue a graph                 | `queue_batch`, and `spawn_session` with `after` naming existing ids. A new task may depend on a waiting one, so a graph can grow at its edges    |
| Change a waiting task         | `amend`: prompt, title, model, effort, not-before time (DESIGN.md, "Amending a waiting task")                                                    |
| Change what a task waits on   | Not built: milestone 1. Decided in outline (docs/scheduler.md, M4, "Amending a waiting task"): whole list against a basis, cycles refused        |
| Find a project's tasks        | Not built: milestone 2. `get_queue` shows the 20 most relevant, unfinished first                                                                 |
| Settle a task from outside    | `report_task_done` (the session), mark-done (a person), a merged PR (the leader's `gh`)                                                          |
| A tracker link                | `creator.ref` and `creator.ref-url` (DESIGN.md, "Task tags"): `spawn_session`'s `ref` and `ref_url`. Display-only; the old `linear` still reads  |
| The tracker inside the leader | Decided, not built (docs/scheduler.md, M4, "Linear", #18): a Linear key in `settings:main`, relations read once at admission, `doneBy: "linear"` |
| A session that is not a task  | The custodian's round (C10): no task id, no slot, its own pane option                                                                            |
| An adapter seam               | DESIGN.md, "Adapters", built: local to one machine, delivers text into sessions, and may not enqueue, cancel or reach the relay                  |
| A long session that fills up  | The successor pass, for tasks only                                                                                                               |
| Capacity                      | 128 task records (`MAX_TASKS`), finished ones included until pruned; `get_queue` shows 20                                                        |

Two of those rows pull against the memo and are the reason this file exists:

- **The decided Linear item puts the tracker inside the leader** (a key, an API client, a done
  signal). Point 3 says the opposite.
- **The messaging adapter seam is the wrong seam for a tracker.** It is local and forbidden the
  queue on purpose. A tracker adapter has to enqueue and amend, fleet-wide.

### What milestones 1–3 build on

Read from the code at ce55b1ed. Each is a fact a milestone depends on.

- **Amend.** `parseAmendRequest` refuses any key it does not take, so an older leader answers a new field
  `invalid_request` and applies nothing. `Scheduler.amend` takes `queued`, `blocked` and `ready` with no spawn out
  (`AMENDABLE`), writes through `#update` and the one sealer, then forgets the held decision and ticks. `sendAmend`
  reads the record for a `basis` when the draft names none, and re-sends only on `prompt_changed`, at most three
  times, never on a lost answer.
- **Deps.** `spec.deps` holds `{ task, after }` edges, at most `TASK_SPEC_LIMITS.deps` (16), and their order is
  meaning: stacking starts a worktree task from its _first_ `opened` dep's branch. The dep sentinels live only in the
  stored array: `parseDeps` drops them, the sealer re-adds them, and no client can write one (`isTaskId` refuses the
  empty `task`). `admission` judges only `queued` and `blocked` tasks; a `ready` task is never judged again. `cycles`
  finds a loop, and a create's loop fails the task `dependency_cycle`. A missing dep waits `DEP_MISSING_GRACE_MS`
  (5 min) from the dependent's `createdAt`, then fails it `dependency_missing`; a `failed` or `cancelled` one fails it
  `dependency_failed`. `named` keeps every task an unfinished task names from pruning.
- **Successors and continuations.** Neither carries `deps` or `batch` (`successorSpec`, `continuationSpec`), and
  admission judges a successor against its predecessor alone. Both copy the predecessor's `creator.*` tags
  (`chainTags`), so `creator.ref` follows the work through a pass or a continue. A batch does not.
- **The queue read.** `queue` answers at most `QUEUE_MAX_TASKS` (20), unfinished first, each with a decision, filled
  against `REPLY_JSON_BUDGET` (44 000 bytes). `parseQueueRequest` drops keys it does not know, and the broker's `queue`
  carries no payload at all.
- **The store.** `MAX_TASKS` (128) records under `task:`. Once it holds `pruneAt` (96), the leader deletes the oldest
  finished tasks down to `keepFinished` (50), never one an unfinished task names or a live continuation chain holds.
  A project's finished tasks are pruned on the fleet's schedule, not the project's.
- **The archivist** keeps a row per finished task with `creator.ref` and `creator.ref-url`. `archive-tasks` filters by
  repo, outcome, machine, account, dates and title, not ref. It is optional, and `seance mcp` has no path to it.
  `parseArchiveTasksRequest` drops filter keys it does not know, an archivist advertises no capabilities, and it drops
  an op it does not know with no answer (`archivist/src/run.ts`).
- **The relay** reads `SCHEDULER_OPS` only to size its reply window (the largest `OP_TIMEOUT_MS`). A new op at 10 s
  needs no relay deploy.

## Proposal

### 1. The orchestrator is the adapter

Séance grows no tracker interface in the daemon, the leader or the relay. An orchestrator is a
Claude session holding two tool sets: the tracker's (the Linear connector, or whatever a later
tracker ships) and Séance's MCP. It reads the project there and writes the queue here. Swapping
the tracker changes the orchestrator's instructions and tools, and no Séance code.

What Séance owes that session is a queue surface complete enough to keep a graph true:

- **Amend deps**, the decided follow-up, and the one missing op: milestone 1.
- **An opaque external ref on a task** (`ref: { source, id, url? }`), display-only like an alias:
  never used to route, bind or settle. It replaces the spec's `linear` as the general form;
  `linear` stays readable on the wire. Built as `creator.ref` and `creator.ref-url` (DESIGN.md,
  "Task tags"): `spawn_session`'s `ref` and `ref_url`.
- **A way to find its own tasks**: every task of a project, by its refs or by batch, including finished ones it must
  not queue twice. Milestone 2.
- **Settling from outside**, which exists: mark-done.

If the tracker should also _push_ ("an issue was added") rather than be polled by the
orchestrator, that is a local adapter delivering a nudge into the orchestrator's session, which is
exactly DESIGN.md, "Adapters" once an orchestrator is an addressable target (Q14).

### 2. Retire the leader's Linear item

Withdrawn by the owner on 2026-11-26 (Q9), before any of it was built: #18 (key in `settings:main`, relations at
admission, `doneBy: "linear"`). An orchestrator covers each part from outside: it writes `after` edges
from the tracker's relations, keeps them current with amend deps (which #18 could not: it read
relations once), and marks a task done when its issue closes. The leader then holds no tracker
key, and `SettingsRecord.linearKey` stays the unused slot it is.

Cost, accepted: a project with no orchestrator running gets no tracker-derived deps or done signal.

### 3. The role

Working name **orchestrator**; milestone 4. Proposed shape, each line a decision to take once milestone 3 has
evidence:

- **Not a task**, as the custodian's round is not: no task id, no queue record, no concurrency
  slot, its own pane option so every reader of panes can tell it apart.
- **Any number per machine**, started by the owner (PWA, `seance`, MCP), one per project or per
  standing brief. Not a daemon seat, not a registry role: the relay learns nothing.
- **Long-lived**, unlike a round. The custodian rejected a standing session for itself (recycle
  rules, a liveness check, context cost between rounds). Those costs are real here too and have to
  be paid, because an orchestrator's value is its accumulated view of the project:
  - _Context fills._ It needs a pass of its own (the successor mechanism is task-bound today), or
    it keeps its state in the tracker and the queue and restarts fresh from a brief, as a round
    does from its notes. The second is cheaper and survives a crash; recommend it.
  - _Liveness._ Something must notice a dead orchestrator. The custodian is the natural watcher,
    which widens its scope (C7, C10).
- **It counts against its account.** "No queue slot" must not mean invisible to routing: a
  long-lived session on the strongest model burns the same weekly allowance the tasks need. Usage
  already shows up in the account's reading; the question is whether placement should also reserve
  for it.
- **Its own audit origin** (`orchestrator`), per the threat model's rule that a new surface never
  reuses one. Its enqueues are otherwise an app-role client's, as `seance mcp`'s are.
- **A fence on what it may queue unattended**: repos it may name, a cap on tasks in flight and per
  day, the autonomy level its tasks get. Today any session with Séance's MCP can queue without
  limit; a session told to find work by itself is where that stops being acceptable.

## Milestones

| Milestone | What                         | Status                                                  |
| --------- | ---------------------------- | ------------------------------------------------------- |
| 1         | Amend deps                   | Spec, decided; one PR                                   |
| 2         | Find a project's tasks       | Spec, decided; two PRs: `find`, then the archive read   |
| 3         | The orchestrator by hand     | Spec, docs only, beside milestone 1; project open (Q10) |
| 4         | The role proper (§3)         | Draft; decided from milestone 3's evidence (Q12–Q18)    |
| 5         | Autonomous intake (memo, 6.) | Draft; last, behind milestone 4's fence                 |

Milestone 1 is one PR; milestone 2 is two, `find` and then the archive read; milestone 3 runs beside milestone 1 (Q8).
Each PR ships alone to a mixed-version fleet and leaves `main` releasable: no record changes shape, every new act is
gated on what the peer advertises or refused by an older one, and no older peer half-applies or answers wrongly.
(Milestone 2 once also held the external ref, built 2026-11-18 with the tags work.)

### Milestone 1: amend deps

**What a session can do after it.** Change what a waiting task waits on, under its own id: add an edge when step 3
turns up a prerequisite for step 6, drop one that no longer holds, swap one, or move one edge from `opened` to
`merged`. Today the only way is cancel and requeue, which mints a new id and fails every dependent `dependency_failed`.

**Wire** (`shared/`). `AmendRequest.deps?: { list: readonly TaskDep[]; basis: string }`: the complete new list, in
order, and `depsBasis` of the list it was made against (SHA-256 of the canonical JSON `[{task, after}]` in order, `[]`
for none, lowercase hex like `promptBasis`). `list` is held to a create's rules (`parseDep`, at most
`TASK_SPEC_LIMITS.deps`), and `[]` clears every edge. It may ride with any other amend field but `ownerTags` (Q3).
Every field and both bases are checked before anything is written. New `SCHEDULER_ERROR_CODES`, each answered with
nothing written:

| Code             | When                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `deps_changed`   | the held list hashes otherwise than `basis`                                                             |
| `deps_successor` | the task carries `succeeds`: admission reads only its predecessor, so an edge on it would never be read |
| `dep_self`       | an edge names the task itself                                                                           |
| `dep_unknown`    | an edge names a task the leader does not hold, after one store read of that key                         |
| `dep_unreadable` | an edge names a record the leader holds as unreadable, so it cannot check a loop through it             |
| `dep_ended`      | an edge names a task that ended `failed` or `cancelled` (through `superseded` too), as a create does    |
| `dep_cycle`      | the amended graph loops through held tasks (`cycles` over the held set, with this task's list replaced) |

**Leader** (`scheduler/`, `daemon/`).

- `Scheduler.amend` runs those checks before the write and again inside it, against the copy held when its turn comes,
  as it already does for state. The write replaces `spec.deps` (`amendSpec` gains the field), and the sealer re-adds
  every sentinel the other fields need.
- In the same write the task's state follows the new list: a `ready` task with an unmet edge goes back to `blocked`, a
  `blocked` one whose every edge is met goes to `ready`, and a `queued` one stays `queued`, since admission makes its
  first move (the expiry check and the chain-tag copy with it). The decision is forgotten and the leader ticks, as now.
- An edge to a `done` task is met at once; one to a `superseded` task follows its chain (`holder`), as admission does.
- The miss path's one store read covers a task an orchestrator created seconds earlier, whose `store-changed` has not
  reached the leader yet.
- A prune must not delete a task that an in-flight deps amend names. `unprunable` reads the held copy, which is the
  old one until the write lands, so the names a deps amend adds are held unprunable from its check until its write
  settles.

**Clients** (`shared/`, `daemon/`), through `sendAmend`, which already reads the record for a prompt basis:

- A draft carries a deps _change_, not a list: `add` (edges; one naming a task already in the list replaces that edge,
  which is how an edge's `when` changes) with or without `drop` (task ids), or `replace` (a whole list) alone. A task
  in both `add` and `drop` is refused. `sendAmend` reads the record, applies the change to the list it read, sends
  that list with its basis, and on `deps_changed` reads again and re-applies, at most three times, as it re-sends an
  append. A lost answer is never re-sent. With a prompt change beside it, one read serves both bases, and a refusal of
  either re-applies both.
- **MCP** `amend_task` gains `add_after` (`[{task, when}]`), `drop_after` (`[taskId]`) and `replace_after`
  (`[{task, when}]`; `[]` clears). `add_after` and `drop_after` combine, which is a swap; `replace_after` stands alone.
  Offered only to a verified leader advertising `CAPABILITIES.amendDeps`, and refused otherwise with a message naming
  the flag. The description says what each refusal means and what to do; for `dep_unknown`: "a task that finished and
  was pruned already released its dependents; leave its edge out".
- **CLI** `seance amend <task-id> --after <id>[:opened|merged|done]` (repeatable, adds), `--drop-after <id>`
  (repeatable), and `--replace-after`, which makes the `--after` list replace the whole list (with no `--after`, it
  clears it). The success line names the edge count and the state, never an id.
- **Broker.** `parseAmendDraft` carries the deps change through `parseAmendRequest`'s strict parse, and the broker's
  daemon runs `sendAmend` as it does now. No new broker action.

**Capability.** `CAPABILITIES.amendDeps`, advertised by a leader on this build. `OP_TIMEOUT_MS.amend` stays 10 s.

**Never logged.** The leader's `audit queue op=amend` line gains `deps` in `fields` and `edges=<n>` (the new list's
length): no task id but the amended task's, no basis. A refusal is audited with its code. The broker logs the op and
the task id only, as now.

**Threat-model note** (recorded in DESIGN.md, "Amending a waiting task", with the build). Amend's acts widen from what
a waiting task does to what it waits on. A PSK holder, or a keyless broker peer, can now hold a waiting task back
behind any task, or release it early by dropping an edge. Acceptable on V1's ground: it is what that holder can already
do by cancelling and requeuing with other deps, the write is the leader's own under the term fence, and the leader's
checks mean no amend can fail a task (a loop, an unknown edge or an ended one is refused instead). No record changes
shape: an amended record is an ordinary one, so an older leader that takes the term reads it as written.

**Records updated.**

- DESIGN.md: "Amending a waiting task" (_Planned: amending `deps`_ becomes the built text, with the owner's answers to
  Q1–Q4 as "Decided by the owner (date)"), "MCP server" (`amend_task`), "Fleet broker" (the draft).
- docs/scheduler.md, M4, "Amending a waiting task" (_Next: amending deps_ marked done). Its Linear row was marked
  withdrawn with this plan (2026-11-26).
- `.claude/rules/scheduler.md`, "Amend": what amend may change grows by deps, with the refuse-don't-fail rule.
- README's `seance amend` usage, if it lists the flags.
- This file: the "What exists" row, §1's first bullet, §2, and this section shrunk to an index.

**Tests**, each admitted per docs/development.md, "Admitting a test":

- `scheduler/test/amend.test.ts`: each refusal code, both before the write and inside it (a predecessor that fails, or
  a loop another amend closes, between the check and the turn); `ready → blocked` on an unmet edge, `blocked → ready`
  on dropping the last, `queued` untouched; order kept; every sentinel back on the sealed record (attachments,
  requires, tags, agent); a successor refused; the prune race (a finished predecessor a deps amend names survives a
  prune while the write is out, driven by a held store write, never a sleep).
- `shared/src/amend.test.ts`, `amend-client.test.ts` and `parse.test.ts`: `depsBasis`; the strict parse (a
  sentinel-shaped edge refused, a 17th edge refused); `add`, `drop` and `replace` applied to a read list; re-applied on
  `deps_changed`; never re-sent on a lost answer.
- `daemon/test/leader.test.ts`: the op through the leader; the audit line's fields and count, with no other id.
- `daemon/src/mcp.test.ts`, `cli.test.ts` and `broker.test.ts`: the gate (a verified leader without `amendDeps` is
  refused unsent, naming the flag) and **the old-peer paths**: a leader advertising `amend` but not `amendDeps`,
  reached anyway (a takeover between the gate and the send), answers `invalid_request` from V1's strict parser, and
  the surface says nothing changed; an older broker daemon refuses the draft `invalid_request`, and the surface says to
  update this machine's daemon.
- `e2e/amend.test.ts`: a stack of three where the third, while `blocked`, gains an edge to the first, runs only after
  it, and keeps its id. Every queued task ends through `cancelTask`.

**Rollout.** No relay change and no deploy. Daemons update in any order. A leader advertises `amendDeps` once it runs
this build, and clients send deps only to a verified leader advertising it. A takeover by an older leader mid-update
refuses the field (strict parser) and reads every amended record as written. The PWA is untouched and shows an amended
list through its usual re-read.

**Measure.** `audit queue op=amend` lines with `deps` in `fields`, by outcome, against cancels of `blocked` tasks
followed by an enqueue from the same client: whether amending deps replaced cancel and requeue.

### Milestone 2: find a project's tasks

**What a session can do after it.** List every task of a project in one call not capped at the 20 most relevant: by
the set of refs its issues carry, or by one batch. Finished ones are included while the store holds them, and after
the second PR, by ref, from the archivist once pruned. An orchestrator can then check, before it queues an issue,
whether a task for it exists, and read the state of every task it wrote.

#### First PR: `find`

**Wire** (`shared/`). A new scheduler op, `find` (Q5 says why not a filter on `queue`):

- `FindRequest { refs?: readonly string[]; batch?: string; cursor?: string }`: exactly one of `refs` (1 to `MAX_TASKS`
  values, each held to `parseRef`; 128 at the tag value bound fit the request envelope) and `batch`
  (`TASK_ID_PATTERN`). Parsed strictly: an unknown key refuses, as amend's does.
- `FindResponse { tasks: readonly Task[]; unreadable: number; next?: string; at: number }`. Each task is the queue
  reply's shape with no prompt and no decision, ordered by `createdAt`, then id, and filled against
  `REPLY_JSON_BUDGET`. `next` names the last task returned when the fill stopped short; a request carrying it as
  `cursor` resumes after it. A task created between pages with an earlier `createdAt` (a skewed client clock) can be
  missed; the clients follow every page within one call, which keeps that window to seconds.
- `unreadable` counts the `task:` records the leader cannot read. Any of them may be a match it cannot see, so "none
  found" beside `unreadable > 0` is not proof of none, and the clients say so.
- **Matching.** A task matches `refs` when its `creator.ref`, read through `taskTagEntries` (so a legacy `linear` reads
  as `linear:<issue>`), equals one of them exactly. It matches `batch` when `spec.batch.id` equals it. Successors and
  continuations carry their predecessor's ref and so match it; they carry no batch, so a batch lists only the tasks
  created in it.
- `OP_TIMEOUT_MS.find` is 10 s. Capability: `CAPABILITIES.findTasks`.

**Leader** (`daemon/`). Answered from the tasks the term holds, with no store read (the same source `queue` reads),
and `not_ready` during a takeover as `queue` is. A read, so no audit line, as for `queue`.

**Clients** (`daemon/`).

- **MCP** `find_tasks { refs?: string[], batch?: string }` follows `next` to the end (at most `MAX_TASKS` tasks or 8
  pages) and answers every match in `get_queue`'s per-task format without decisions, with a closing line when
  `unreadable` is above 0. Its description says it is for checking a project before queueing; that the store prunes
  finished tasks, so one done long ago may be gone until the archive read lands; and that a ref only groups and finds,
  with nothing routing, settling or binding on it. `get_queue`'s description gains one sentence pointing to it, and
  `spawn_session`'s and `queue_batch`'s `ref` descriptions say a task queued from a tracker item should carry the item's
  ref so it can be found. Offered only to a verified leader advertising `findTasks`.
- **CLI** `seance tasks (--ref <source:id>)… | --batch <id>`, one line per task (id, state, title, ref), and `--json`.
  It is for the owner, checking what an orchestrator queued. Droppable if not wanted.
- **Broker.** `BROKER_SCHEDULER_OPS` gains `find`, resendable like `queue`, its payload parsed by `parseFindRequest`
  into a fresh value. Audited `audit broker origin=local-broker op=find by=<refs|batch> refs=<n> matched=<n>
  outcome=<o>`: never a ref, an id or a cursor.

**Threat-model note** (DESIGN.md, "Fleet broker" and the new section). A read. It adds an op to the leader's
app-sealed requests and one to the broker's scheduler allowlist. A PSK holder already reads every record through
`store-list`, so `find` tells it nothing new. A keyless broker peer reads the 20 most relevant tasks today (`queue`,
no payload); with `find` it reads any task whose ref or batch it names, in the fields `get_queue` already shows, never
a prompt. Accepted because the 20 was a size bound, not an access bound. Matching on `creator.ref` is a read and stays
one: nothing routes, binds, places, settles, alerts or prunes on a ref (Q6). That goes into
`.claude/rules/scheduler.md` as an invariant beside amend's.

**Records updated.**

- DESIGN.md: a new Scheduler subsection, "Finding a project's tasks" (the op, the match, the cursor, the pruned-task
  answer, with the owner's answers to Q5–Q7); "Task tags" (_Readers_ gains `find`); "MCP server" (`find_tasks`, and
  `get_queue`'s pointer); "Fleet broker" (the allowlist); the wire protocol's op list.
- `.claude/rules/scheduler.md` (the read-only invariant) and `.claude/rules/local-socket.md` (the broker's scheduler op
  list).
- docs/tags.md, open question 5 (pointed here 2026-11-26; marked built).
- This file: the "What exists" rows (find, capacity), §1's third bullet, Q17 and Q18, and this section shrunk to an
  index.

**Tests**, admitted the same way:

- `shared/src/parse.test.ts`: `parseFindRequest` (both or neither of `refs` and `batch`, an unknown key, a bad ref,
  more than `MAX_TASKS`) and the reply's bounds.
- The leader's request module, as `boundedQueue`'s test does: matching by ref (a legacy `linear`, a successor and a
  continuation included) and by batch; finished tasks included; at the worst case (128 tasks, 200-unit titles that
  JSON-escape to six bytes a unit, 16 edges each) the reply pages, and following `next` returns every match exactly
  once; `unreadable` counted.
- `daemon/src/mcp.test.ts`, `cli.test.ts` and `broker.test.ts`: the gate and **the old-peer paths**: a verified leader
  without `findTasks` is refused unsent; one reached anyway answers the unknown op `invalid_request`, which the surface
  words as an older leader, never as "none found"; an older broker refuses the unknown op and the surface says to
  update this machine's daemon; the broker's audit line carries no ref.
- `e2e/`: one project's refs spread across a batch, a later `spawn_session` and a pass, listed whole by refs with one
  task finished. Every queued task ends through `cancelTask`, and `takeLeakedTasks()` is empty.

**Rollout.** No relay change and no deploy: the relay's reply window is already the largest op timeout. Daemons
update in any order, and clients gate on the verified leader's `findTasks`. An older leader taking the term answers
`invalid_request`, and the client says so.

**Measure.** Milestone 3's log: whether the orchestrator ever queued an item twice, and how often it needed a task
`find` no longer held, then how often the archive half was missing.

#### Second PR: the archive read

**What it adds.** `find_tasks` by ref answers for tasks the store has pruned too, from the archivist, which keeps a
row per finished task with its `creator.ref` (Q6). A batch is matched in the store alone.

**Wire** (`shared/`, `archivist/`). A new archivist op, `archive-find`: `ArchiveFindRequest { refs: readonly string[];
before?: cursor }`, `refs` 1 to `MAX_TASKS` values each held to `parseRef`, parsed strictly. Its reply is
`archive-tasks`' page without `machines`: `ArchivedTask` rows re-stripped through `archivedTask`, newest first by end
time, a keyset `next`, `total`, filled to `REPLY_JSON_BUDGET`. A row matches when its stored `creator.ref`, read as
`find` reads it, is one of `refs`, bound as one JSON array parameter. That is a scan of the archive, left unindexed
until a fleet's size makes it matter, as A33 left the metrics index. `OP_TIMEOUT_MS["archive-find"]` is 10 s.

- **A new op, not a `refs` filter on `archive-tasks`.** That parser drops keys it does not know, and an archivist
  advertises no capabilities, so an older archivist would answer the newest 20 unfiltered as the match. An older
  archivist drops an unknown op with no answer, which costs the client one timeout and never a wrong answer.
  Rejected: capabilities in `ArchivistInfo`, a registry blob change for one read.
- No capability gate, as the other archive ops have none: the client sends to the archivist card it believes
  (identity.md), and reads a timeout or a refusal as "the archive half is missing".

**Clients** (`daemon/`).

- **MCP** `find_tasks` with `refs` asks the leader (`find`), then the archivist (`archive-find`) for the same refs, and
  merges by task id, the store's copy winning. Its answer says which halves answered: a missing archive half (no
  archivist card, a timeout, a refusal) is a closing line, never silence, and the description says "none found" is
  then not proof. `seance mcp` reaches the archivist as the PWA does, with an app-role read to the registry's
  archivist card.
- **CLI** `seance tasks --ref` does the same.
- **Broker.** A new action, `archive`, carrying `archive-find` only, to the archivist the broker's own registry names,
  never an id from the peer, its payload rebuilt through `parseArchiveFindRequest`. Audited `audit broker
  origin=local-broker op=archive-find refs=<n> matched=<n> outcome=<o>`, never a ref. An older broker daemon refuses
  the unknown action, and the surface says to update this machine's daemon.

**Threat-model note** (DESIGN.md, "Archivist" and "Fleet broker"). The archivist answers a fourth read, sealed
`from: "app"`, through the same gate, never a prompt. The broker reaches a device it never addressed before, for this
one read, resolved from its own registry. A keyless session gains, for the refs it names, what an app holding the key
already reads.

**Records updated.** DESIGN.md: "Archivist" (a new A-numbered entry beside A31–A34's query ops), "Fleet broker" (the
action), "MCP server" (`find_tasks`' archive half), the wire op list. `.claude/rules/archivist.md` (four ops and the
new parser) and `.claude/rules/local-socket.md` (the broker action). This section.

**Tests**, admitted the same way:

- `archivist/src/query.test.ts`: matching (a legacy `linear`, a continuation's copied ref), the cursor, refs bound as
  one parameter; `archivist/test/layering.test.ts` green unchanged.
- `shared/src/parse.test.ts`: the strict parse.
- `daemon/src/mcp.test.ts`: the merge (the store's copy wins), no archivist card, an archivist that never answers
  (driven by an injected clock, never a sleep), a refusal.
- `daemon/src/broker.test.ts`: the archivist id from the broker's own registry only, the audit line without a ref, an
  older broker's refusal.

**Rollout.** No relay change and no deploy: the op travels sealed to the archivist's id as `archive-tasks` does. The
archivist updates with the fleet; until it does, `find_tasks` reports the archive half missing.

### Milestone 3: the orchestrator by hand

No code and nothing committed: no packages, no capability, no tests. The runbook is the owner's local one-off, not
checked in (owner, 2026-11-26): a log to learn from, whose findings come back here. It holds what a run needs and
nothing this file decides:

- the project and repo, picked when the brief is ready (Q10);
- a paste-ready brief for an orchestrator session: one Linear project; `queue_batch` and `spawn_session` with `after`
  and `ref: "linear:<ID>"`; amend (and amend deps once milestone 1 lands) as issues change; never implements; keeps
  its state in Linear and the queue, so it can be cleared and restarted from the brief. A task settles on its PR's
  merge; one that must settle otherwise (an issue closed with no PR) is the owner's mark-done in the PWA, since no MCP
  tool settles another task, and the log counts each such ask;
- its fence in words, since milestone 4's is not built: the repos it may name, caps on tasks in flight and per day,
  its tasks' autonomy, and asking the owner before queueing anything that is not an issue in the project;
- CI as the definition of done, with worker prompts pointing at the repo's checks rather than restating rules;
- corrections filed as `guardrail` issues proposing the check that would have caught them, never queued unasked;
- the optional reviewer: a review task with an `opened` edge on the implementation task, on another model;
- what to observe, mapped to Q12–Q18: each cancel and requeue that changed deps (evidence for milestone 1), the peak
  count of unfinished tasks against the cap (Q6, Q18), and signs of overload (re-asking what is decided, carrying one
  task's rule to another, losing the graph after a compaction), each evidence for a round on a timer over a standing
  session;
- the log template: one line per intervention, and whether a check could have caught it.

Before queueing an issue, the orchestrator reads its state in the tracker and its tasks in the queue: `get_queue`
until milestone 2's first PR lands (the project is small enough for its 20), `find_tasks` after. Where nothing accounts
for an earlier task (the archive half missing, or a task gone from the queue before the archive read lands), it asks
the owner rather than queue on "none found" (Q6). The run's fleet should have an archivist, so the archive read can be
tried in the run once it lands.

The run's findings come back here as evidence under milestone 4, and that evidence decides whether milestone 4 is
built.

### What milestones 1–3 do not change

For a reviewer checking their PRs:

- **No task-record field, no new sentinel, no change to a record's shape.** Milestone 1 writes `spec.deps` in its
  existing shape; milestone 2 only reads.
- **No relay change:** no prefix, store rule, frame, cap or deploy.
- **No PWA change.** It shows an amended list through its existing reads, and gets no `find` surface.
- **No tracker in Séance:** no client, key, poll or adapter in the leader, daemon or relay. `SettingsRecord.linearKey`
  is untouched, and #18 is not built.
- **The adapter seam is unchanged:** adapters still never enqueue, amend, cancel or reach the relay.
- **`LOCAL_OPS` is unchanged.** The broker gains two reads (`find` in its scheduler allowlist, and an `archive` action
  carrying only `archive-find`), and `amend` carries one more field through the parser it already uses.
- **Nothing acts on a ref:** no route, bind, place, settle, alert or prune. `AGENT_VISIBLE_TAG_KEYS` is unchanged.
- **What amend may change is otherwise unchanged,** and so are the states that take it: `repo`, `pin`, `avoid`,
  `requires`, attachments, `until` and `batch` stay a cancel and requeue's job.
- **No new audit origin, session role or pane option.**
- **The archive is unchanged:** no schema change, no new column, nothing more kept. The archivist answers one more
  read (`archive-find`).
- **`queue` and `QUEUE_MAX_TASKS` are unchanged.**

## Threat-model notes

- An orchestrator turns tracker text into prompts. Anyone who can write an issue in the project
  can then write a prompt that runs on the fleet. The fence in §3 bounds the blast radius; it does
  not remove the injection. Today that path needs a person to read the issue and queue it. Milestone 3's fence in
  words, and its rule to ask before queueing anything not from the project, keep a person on that path for the run.
- No new secret reaches the leader or the relay under §1 and §2. The tracker's credential lives
  where the orchestrator's session lives, as the Linear connector's does now.
- The external ref is sealed in the task record like every other spec field. Display-only is a
  requirement, not an observation: a ref that settles or routes is the tracker inside the leader
  again.
- Milestones 1 and 2 each carry their own note above.

## Alternatives

- **A tracker adapter interface in the leader** (a port in `scheduler/`, one implementation per
  tracker). Works with no session running, and gives relation-derived deps at admission. It puts a
  tracker client and key in the leader, needs a plugin story for a private adapter, and still
  cannot plan: breaking a project into tasks is judgement, which is a session's job either way.
- **Widen the messaging adapter seam to the queue.** One seam instead of two concepts, but that
  seam's rules (local only, never the queue, never the relay) are its security argument.
- **Orchestrator as a task with `until: "reported"`.** No new role at all. It then holds a
  concurrency slot for days, is idle-swept and passed like a worker, and the queue shows it beside
  the work it manages. Good enough for milestone 3; not the end state.
- **A fresh orchestrator per round, like the custodian.** Removes the standing-session costs
  entirely. Worth trying in milestone 3: if the tracker and the queue hold enough state, a round every
  N minutes may be all "long-lived" has to mean.

## Questions for the owner

Q1–Q9 and Q11 were settled in an interview on 2026-11-26. Each keeps its reason and what it rejected, so a later reader
sees what was weighed. An answer moves into DESIGN.md with the milestone that builds it, and its entry here becomes a
pointer.

### Milestones 1–3: decided by the owner (2026-11-26)

**Q1. Amend deps: the decided shape.** Confirmed as recorded (DESIGN.md, "Amending a waiting task", _Planned_): whole
list against a basis; unknown ids, self-edges and cycles refused before writing; `ready`/`blocked` re-evaluated in the
same write; sentinels left to the sealer; its own capability. All four refinements taken:

- (a) The basis hashes the list _in order_, because order is meaning (the first `opened` edge picks the stack base).
  Rejected: an order-free hash, which lets a reorder through.
- (b) A miss reads the key from the store once before refusing `dep_unknown`, so an orchestrator can add an edge to a
  task it created seconds ago. Rejected: refusing at once, which every orchestrator would have to know to retry.
- (c) An edge to a pruned task is refused `dep_unknown`, worded "already released; leave it out". Rejected: an unknown
  id read as met, which also accepts a typo.
- (d) The surfaces send changes (`add`, `drop`, `replace`), re-applied on a fresh read after `deps_changed` as an
  append is; only the wire carries the whole list. Rejected: whole lists from the session, which rewrite up to 16
  edges to add one and leave the race to the model.

**Q2. Which states take a deps amend.** V1's three: `queued`, `blocked`, and `ready` with no spawn out. `blocked` is the
main case. `ready` stays in because a late finding is most urgent just before the task is placed, and an unmet edge
puts it back to `blocked` in the same write. Rejected: `blocked` only, which refuses that case.

**Q3. With a prompt amend.** One op, one write, all or nothing: "task 7 now also waits on X, and here is why" lands
whole or not at all. Title, model, effort and not-before may ride along, as now. Rejected: deps alone, which can land
the edge while the append is refused `prompt_changed`, leaving the task waiting on X without being told why.

**Q4. `until` and each edge's `when`.** An edge's `when` (`opened`, `merged`, `done`: when it releases) changes as part
of the list, by adding the edge again (`add` replaces an edge to the same task). The task's `until` (`merged`,
`reported`: when it settles) stays out of milestone 1: `reported` works because the client appends the report
instruction at create (`withReportedPrompt`), and amending `until` alone would leave a session never told to report.
Rejected for now: amending `until` with the client rewriting the instruction in the same write, reopened only if
milestone 3 shows the need.

**Q5. Finding tasks.** A new leader op, `find`, surfaced as MCP `find_tasks` and `seance tasks`, with a cursor the
clients follow within one call. A filter on `queue` fails open on two older peers: `parseQueueRequest` drops keys it
does not know, and the broker's `queue` carries no payload, so an older leader or broker answers the 20 most relevant
as if they were the match; both refuse an unknown op. Rejected: a `queue` filter behind the capability, still open
through an older broker on a keyless machine; a `truncated` flag with no cursor, which leaves narrowing to the model;
listing the store client-side, up to 5 MB a call against the list floors, and whole records, prompts included,
through the broker.

**Q6. A task the store has pruned.** The archivist answers it: `find_tasks` asks the archivist for the same refs and
merges its rows with the leader's, in one tool (milestone 2, second PR). The orchestrator does not comment task ids on
issues. Where the archive half is missing (no archivist on the fleet, one that did not answer, or a task pruned before
the archivist read it), "none found" is not proof, and the orchestrator asks the owner before queueing on it. Rejected:
the tracker alone (the task id commented on the issue and read before queueing); a separate archive tool, which the
orchestrator would have to remember to call; keeping ref'd tasks longer, which against the 128 cap comes close to
turning pruning off and makes a ref change what the leader does.

- Matching on `creator.ref` stays a read: never a route, bind, settle or prune. Written into
  `.claude/rules/scheduler.md` with milestone 2's first PR.
- The broker carries both reads, so a keyless machine can orchestrate. A keyless session already queues, amends and
  cancels through it, and without the read it could queue but not check. It gains `get_queue`'s fields for the refs or
  batch it names, never a prompt. Rejected: keyed machines only.
- No cap change in milestones 1–3 (asked beside Q6). `MAX_TASKS` bounds a bearer-token holder's junk, keeps a full
  listing to one ~5 MiB frame with no paging, and bounds the rows each listing reads. With the newest 50 finished always
  kept, about 78 unfinished tasks fit. Milestone 3 logs the peak unfinished count for Q18. If the cap binds, the cheap
  first move is the leader pruning finished tasks below 50 under pressure (leader-only, no relay deploy). Raising the
  cap needs store paging, a relay deploy and frames past what was checked. Rejected for now: both.

**Q7. Batch identity.** A set of refs is enough; a project key waits for evidence. One ref is one issue, not one
project, so "by ref" means the set of refs the orchestrator reads from the tracker's project, which is why `find` takes
`refs`. A ref follows the work through a pass or a continue (both copy `creator.*`); a batch does not, and cannot grow.
If milestone 3 asks for a key, a third `creator.*` key fits `TASK_TAG_BUDGET.creator` with no new record field.
Rejected for now: a `creator.project` tag. Whether people see a project as one thing in the queue and the PWA is Q17.

**Q8. Order.** Milestone 3 runs beside milestone 1, before milestone 2 is built: the runbook is written now and run
on a project of 5 to 8 issues, few enough for `get_queue`'s 20. Milestone 1's shape needed no evidence; milestone 2's
does, and a run is the best way to get it. Until milestone 1 lands, changing deps means cancel and requeue, which fails
every dependent `dependency_failed`, so the graph stays shallow and the log records each requeue as evidence for
milestone 1. Rejected: milestones 1 and 2 first, which builds milestone 2 blind.

**Q9. The leader's Linear item (#18).** Withdrawn (§2; recorded in docs/scheduler.md, M4). An orchestrator writes the
edges, keeps them current (which #18's read-once relations could not), and marks tasks done; the leader holds no
tracker key. The cost, accepted: a project with no orchestrator running gets no tracker-derived deps or done signal.
Rejected: keeping it decided and unbuilt, which leaves two designs for one job on the record.

**Q11. §1: the orchestrator session is the adapter.** Confirmed with Q9: Séance gets no tracker interface. Rejected: a
code-level adapter in the leader for use with no session running, which reopens the brief's out-of-scope list.

### Milestone 3: picked before the run

**Q10. The dry-run project.** Which Linear project, in which repo: picked when the brief is ready. Criteria: 5 to 8
issues with at least two dependencies between them, in a repo whose CI is strict enough to be the definition of done.
Séance qualifies on CI, but only for work away from the scheduler and MCP: an orchestrator amending the code it runs on
muddies the signal.

### Milestones 4 and 5: open, for milestone 3's evidence

**Q12.** Standing session or a round on a timer (the last alternative)?

**Q13.** What fences an orchestrator, and who sets it: per orchestrator at start, or the machine's `config.json` as
traits and the custodian are?

**Q14.** Is an orchestrator a message target (docs/messaging.md addresses by task id, and this has none), so workers
can report to it and a tracker adapter can nudge it?

**Q15.** Which account pays, and does placement reserve for it?

**Q16.** Does the custodian watch orchestrators, or do they sit outside its scope as `foreign` panes do?

**Q17.** Does a project get its own grouping in the queue and the PWA? Q7 settles how an orchestrator finds a
project's tasks; this is whether people see a project as one thing.

**Q18.** Capacity: 128 task records hold a project of what size once finished tasks linger? Does the orchestrator
queue a window of the graph, not all of it? Milestone 3 logs the peak unfinished count for it, and Q6 records the cap's
reasons and the two ways to move it.
