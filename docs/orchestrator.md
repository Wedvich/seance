# Orchestrators and project queueing — draft

**Status: draft, nothing decided, nothing built.** Written 2026-11-13 from the owner's voice memo
of 2026-11-12. Only §"What the owner said" is the owner's; every proposal below it is a
recommendation waiting for a decision, and the open questions at the end are what an interview has
to settle before this is a spec. Unlike docs/custodian.md and docs/messaging.md, nothing here may
be built from yet.

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

From the memo, in order. These are wants, not decisions on mechanism.

1. Queue an entire Linear project: "implement this project", and Séance queues the tasks and
   starts building.
2. Amend has to grow for this. As work proceeds it creates follow-up issues and more work, which
   must adapt the graph already in the queue, and Séance should support that.
3. Séance is not tied hard to Linear. As with the companion tool (huddle; docs/messaging.md §6),
   neither codebase knows the other: Séance offers an adapter interface, and a separate adapter
   mediates. Work tracking is the same shape, with a Linear adapter as the first one.
4. A new role, after Steve Yegge's split: short-lived agents do the implementation and are gone;
   long-lived orchestrators, on the strongest model, plan and queue.
5. That role is like the custodian (docs/custodian.md) in that it is not a task and takes no queue
   slot, and unlike it in that a machine may run any number.
6. The end goal: an agent that finds work and queues it by itself, doing what the owner does now
   when driving sessions that spawn sessions.

## What exists

| Need                          | Today                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Queue a graph                 | `queue_batch`, and `spawn_session` with `after` naming existing ids. A new task may depend on a waiting one, so a graph can grow at its edges    |
| Change a waiting task         | `amend`: prompt, title, model, effort (DESIGN.md, "Amending a waiting task")                                                                     |
| Change what a task waits on   | Not built. _Amending deps_ is a decided follow-up (docs/scheduler.md, M4, "Amending a waiting task"): whole list against a basis, cycles refused |
| Settle a task from outside    | `report_task_done` (the session), mark-done (a person), a merged PR (the leader's `gh`)                                                          |
| A tracker link                | The spec's `linear` field, carried and shown, read by nothing                                                                                    |
| The tracker inside the leader | Decided, not built (docs/scheduler.md, M4, "Linear", #18): a Linear key in `settings:main`, relations read once at admission, `doneBy: "linear"` |
| A session that is not a task  | The custodian's round (C10), specced: no task id, no slot, its own pane option                                                                   |
| An adapter seam               | docs/messaging.md §6, specced: local to one machine, delivers text into sessions, and may not enqueue, cancel or reach the relay                 |
| A long session that fills up  | The successor pass, for tasks only                                                                                                               |
| Capacity                      | 128 task records (`MAX_TASKS`), finished ones included until pruned; `get_queue` shows 20                                                        |

Two of those rows pull against the memo and are the reason this file exists:

- **The decided Linear item puts the tracker inside the leader** (a key, an API client, a done
  signal). Point 3 says the opposite.
- **The messaging adapter seam is the wrong seam for a tracker.** It is local and forbidden the
  queue on purpose. A tracker adapter has to enqueue and amend, fleet-wide.

## Proposal

### 1. The orchestrator is the adapter

Séance grows no tracker interface in the daemon, the leader or the relay. An orchestrator is a
Claude session holding two tool sets: the tracker's (the Linear connector, or whatever a later
tracker ships) and Séance's MCP. It reads the project there and writes the queue here. Swapping
the tracker changes the orchestrator's instructions and tools, and no Séance code.

What Séance owes that session is a queue surface complete enough to keep a graph true:

- **Amend deps**, the decided follow-up. This is the one missing op.
- **An opaque external ref on a task** (`ref: { source, id, url? }`), display-only like an alias:
  never used to route, bind or settle. It replaces the spec's `linear` as the general form;
  `linear` stays readable on the wire.
- **A way to find its own tasks.** `get_queue` shows 20, unfinished first. An orchestrator needs
  every task of a project, by batch or by ref, including finished ones it must not queue twice.
- **Settling from outside**, which exists: mark-done.

If the tracker should also _push_ ("an issue was added") rather than be polled by the
orchestrator, that is a local adapter delivering a nudge into the orchestrator's session, which is
exactly docs/messaging.md §6 once an orchestrator is an addressable target (open question 5).

### 2. Retire the leader's Linear item

Recommend withdrawing #18 (key in `settings:main`, relations at admission, `doneBy: "linear"`)
before any of it is built. An orchestrator covers each part from outside: it writes `after` edges
from the tracker's relations, keeps them current with amend deps (which #18 could not: it read
relations once), and marks a task done when its issue closes. The leader then holds no tracker
key, and `SettingsRecord.linearKey` stays the unused slot it is.

Cost: a project with no orchestrator running gets no tracker-derived deps or done signal. That is
the trade to weigh.

### 3. The role

Working name **orchestrator**. Proposed shape, each line a decision to take:

- **Not a task**, as the custodian's round is not: no task id, no queue record, no concurrency
  slot, its own pane option so every reader of panes can tell it apart.
- **Any number per machine**, started by the owner (PWA, `seanced`, MCP), one per project or per
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
  reuses one. Its enqueues are otherwise an app-role client's, as `seanced mcp`'s are.
- **A fence on what it may queue unattended**: repos it may name, a cap on tasks in flight and per
  day, the autonomy level its tasks get. Today any session with Séance's MCP can queue without
  limit; a session told to find work by itself is where that stops being acceptable.

### 4. Order of work

1. Amend deps (already decided; needed with or without the rest).
2. The external ref and the project-wide queue read.
3. An orchestrator by hand: an ordinary session with a written brief, no new role. This is
   runnable the day 1 and 2 land, and it is the experiment that says what the role needs.
4. The role proper: not-a-task, the fence, the origin, the restart story.
5. Autonomous intake (point 6 of the memo), last, behind the fence.

## Threat-model notes

- An orchestrator turns tracker text into prompts. Anyone who can write an issue in the project
  can then write a prompt that runs on the fleet. The fence in §3 bounds the blast radius; it does
  not remove the injection. Today that path needs a person to read the issue and queue it.
- No new secret reaches the leader or the relay under §1 and §2. The tracker's credential lives
  where the orchestrator's session lives, as the Linear connector's does now.
- The external ref is sealed in the task record like every other spec field. Display-only is a
  requirement, not an observation: a ref that settles or routes is the tracker inside the leader
  again.

## Alternatives

- **A tracker adapter interface in the leader** (a port in `scheduler/`, one implementation per
  tracker). Works with no session running, and gives relation-derived deps at admission. It puts a
  tracker client and key in the leader, needs a plugin story for a private adapter, and still
  cannot plan: breaking a project into tasks is judgement, which is a session's job either way.
- **Widen the messaging adapter seam to the queue.** One seam instead of two concepts, but that
  seam's rules (local only, never the queue, never the relay) are its security argument.
- **Orchestrator as a task with `until: "reported"`.** No new role at all. It then holds a
  concurrency slot for days, is idle-swept and passed like a worker, and the queue shows it beside
  the work it manages. Good enough for step 3 of the order above; not the end state.
- **A fresh orchestrator per round, like the custodian.** Removes the standing-session costs
  entirely. Worth trying in step 3: if the tracker and the queue hold enough state, a round every
  N minutes may be all "long-lived" has to mean.

## Open questions for the owner

1. Is §1 right: the orchestrator session is the adapter, and Séance gets no tracker interface? Or
   is a code-level adapter interface wanted regardless, for use with no session running?
2. Withdraw the decided Linear item (#18), as §2 recommends?
3. Standing session or a round on a timer (last alternative)?
4. What fences an orchestrator, and who sets it: per orchestrator at start, or the machine's
   `config.json` as traits and the custodian are?
5. Is an orchestrator a message target (docs/messaging.md addresses by task id, and this has
   none), so workers can report to it and a tracker adapter can nudge it?
6. Which account pays, and does placement reserve for it?
7. Does the custodian watch orchestrators, or do they sit outside its scope as `foreign` panes do?
8. Does a project get its own grouping in the queue and the PWA, or is a batch enough? A batch is
   fixed at creation today; a project's membership grows.
9. Capacity: 128 task records hold a project of what size once finished tasks linger? Does the
   orchestrator queue a window of the graph, not all of it?
