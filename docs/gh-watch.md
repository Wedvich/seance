# Fleet GitHub watches — spec

**Status: spec; build steps 1 to 3 built (2026-11-18: `askGithub`'s `limited`, the in-query `rateLimit`, the
reset-time backoff, then the leader's side: the run query, the watch registry, the reserve for tasks, `watch-set` and
`watch-event` — DESIGN.md, Scheduler, "PR status"; then the daemon's side: the `watch` frame, the table, `watches.json`,
the notes and the custodian hold — DESIGN.md, "Watches"); step 4's MCP tools are built (DESIGN.md, "MCP server"), its
spike S4 is not.
Drafted 2026-11-17; every decision below is proposed for the owner's review unless marked decided.** A
session asks the fleet to watch a pull request or an Actions run and is told through its inbox when something
happens, instead of polling GitHub itself. The leader already reads every task's PR in batches (DESIGN.md, "PR
status") and the daemon already delivers text into a session (DESIGN.md, "Session messages"); a watch joins the two.
Like docs/messaging.md, this file is the working record until the code lands; each part folds into DESIGN.md as it is
built, and its text here goes.

**Decided by the owner (2026-11-18):**

- **G1. A watch may name any github.com repo** (W2), not only the task's own PR or a repo some machine clones. Séance
  supports one GitHub user per fleet; a fleet whose machines are logged in as different users is unsupported, so a
  watch reveals nothing a session's own `gh` could not.

## Problem

Every session on every machine runs `gh` as the same GitHub user, so all of them share one 5000-requests-an-hour
REST budget and one 5000-points-an-hour GraphQL budget. On 2026-11-17 the REST budget ran out between 10:23:47 and
10:42:07 UTC. Many sessions were each running their own background watchers:

| Watcher                                                 | Cost a tick                           | Default pace  |
| ------------------------------------------------------- | ------------------------------------- | ------------- |
| `gh run watch`                                          | about 3 REST (run, jobs, annotations) | 3 s           |
| `gh pr checks --watch`                                  | about 1 GraphQL point                 | 10 s          |
| /ship's merge loop, `gh pr view --json state,mergeable` | 1 GraphQL point                       | 15 s (now 30) |

The owner's instructions now say to poll every 30 s or slower, and `gh-run-wait` polls a run with conditional
requests (a 304 Not Modified is not counted, verified on `repos/<o>/<r>/actions/runs/<id>`). That cuts what each
watcher costs. It does nothing about N sessions watching the same things in parallel, and nothing about the next
skill or session that forgets the rule. A fleet that has one reader of GitHub (the leader) and one way into a
session (the inbox) can make waiting cost one read however many sessions wait.

## What a watch is

A session calls an MCP tool with a PR URL or an Actions run URL and ends its turn. The leader folds the target into
the batched GraphQL poll it already runs. When the target changes in a way the watch cares about, the leader tells the
session's daemon, and the daemon delivers one fixed-format note that wakes the session (a `$.prompt.submit`, as a
question is delivered). Ten sessions watching one PR cost one alias in one query.

```
session ──watch_github──▶ seance mcp ──watch frame (peer pid)──▶ daemon  ──watch-set (sealed from device)──▶ leader
                                                                   ▲                                          │
                                                                   │ note (inbox, submit)                     │ batched GraphQL poll,
session ◀──────────────────── inbox mod ◀────────────────────────── daemon ◀──watch-event (sealed scheduler)──┘ every 60 s
```

## Decisions

### W1. Who may watch: any bound `claude` session, tasked or hand-started

The tool is served to a session whose peer pid resolves to a `claude` process (`Bound.session`, `<pid>:<start
time>`, DESIGN.md "Replies by handle"), whether or not its pane carries a task. A peer with no `claude` process on its
chain is refused `nosession`: a watch is delivered to a session, and a shell has none.

- **Why not tasked sessions only.** The sessions that ran the budget out were not all tasks: the owner's hand-started
  sessions run /ship and deploy waits too, and the owner's direction (docs/presence.md, O4) is that Séance serves every
  session in its tmux server. A hand-started session is already reachable by the daemon's own table (a reply by
  handle); a watch is the same shape, a table the daemon keeps naming the session it delivers to.
- **The pane must have a listener.** The daemon refuses `nolistener` when the pane has no `inbox` listener and none
  is expected (`canDeliver` answers no past the listener grace): a watch whose note can never land would leave the
  session waiting for good. The tool's refusal tells the session to poll itself, at 30 s or slower.

### W2. What may be watched: any github.com PR or Actions run, by URL

Two target kinds, both given as URLs and parsed into a fresh value by a strict pattern:

- **A PR**: `https://github.com/<owner>/<repo>/pull/<n>`, the exact pattern `parseGithubPr` holds today, with an
  optional `head` (40 or 64 hex): the commit the session just pushed (W4).
- **An Actions run**: `https://github.com/<owner>/<repo>/actions/runs/<id>` (an optional `/attempts/<n>` dropped:
  the run's newest attempt is what is read), owner and repo held to the PR pattern's character sets, the id to a
  positive integer of at most 20 digits.

Any repo, not only the session's own task's PR.

- **Rejected: only the tasked session's own PR** (`taskPrs`). /ship stacks PRs, a hub opens PRs in sub-repos, a
  session waits on main's deploy run after its merge (no task holds a run), and a hand-started session holds no task.
  Each of those would keep polling, which is the problem.
- **Rejected: only repos some machine clones.** The leader does not know any machine's scan set (it is each daemon's,
  never on the wire), and the restriction would buy nothing: the session runs `gh` as the same user, so a watch tells
  it nothing its own `gh` could not. What a hostile session can do with a watch is spend budget, and the caps (W7)
  bound that.
- **One GitHub user per fleet** (G1). Machines logged in as different users are unsupported: on such a fleet a
  session would learn states, check names and job ids of a repo only the leader's token reads. Supporting several
  users later revisits this rule.
- A run is named by URL rather than `<owner>/<repo>` and id so one parser serves both kinds and the session copies
  what `gh run list --json url` or a check's link already prints.

### W3. Binding and lifetime

A watch is the daemon's, not the leader's, and is bound to the session that made it:

- **Bound by peer pid, never by a field.** The local frame carries the target and nothing that names a pane, task or
  session. The daemon binds it to the pane, its pane process's pid and the `claude` process (`<pid>:<start time>`)
  that sent it, as a reply-by-handle `sent` entry is bound. Its id is minted by the daemon (`crypto.randomUUID`) and
  returned to the session, which may name it to `unwatch_github`; an `unwatch` is honoured only from the same bound
  session (else `unknown`, the same answer as a wrong id, so an id is no oracle).
- **It ends when** (each audited, W10):
  - a terminal event is delivered: a PR `merged` or `closed`, a run `completed`;
  - the session ends: its `claude` process is gone or another runs in its place (start time differs), its pane is
    gone, or the pane's `ended` fires;
  - the pane's task changes (a rebind to another task, as the inbox clears);
  - the session calls `unwatch_github`;
  - it expires: **24 h** after it was made (W8 says what the session is told). A session that still wants it calls
    the tool again, which replaces the old watch with the same target.
- **Caps** (refused at add, never an eviction, so no watch a session relies on vanishes behind its back): 8 watches a
  session, 64 a machine, and at the leader 100 distinct PRs and 100 distinct runs across the fleet (`fleet_full`).
  Several sessions watching one target count it once at the leader.
- **Rejected: binding to the task id.** A hand-started session has none, and a task's session can be replaced
  (continue, successor) by one that never asked.
- **The custodian leaves a watching session alone.** Built 2026-11-18 (DESIGN.md, "Watches", "The custodian"): a live
  watch on a pane makes `close` answer `busy` and the seat count no round due for it (`awaitsWake`); a hand-off, a pass
  and a drain are not held by it.
- **Built** (DESIGN.md, "Watches"): the binding, the caps, every end above, `unwatch` as the frame's `remove`.

### W4. Events and what each watch fires on

Events are computed by the leader from a reading, per target, and fanned out to each watch whose `seen` set (below)
lacks the event's key:

| Target | Event       | Key                          | When                                                                       | Ends the watch |
| ------ | ----------- | ---------------------------- | -------------------------------------------------------------------------- | -------------- |
| PR     | `checks`    | `checks:<head>:<pass\|fail>` | every context of the head's last commit passes, or any one fails (S2)      | no             |
| PR     | `conflict`  | `conflict:<head>`            | `mergeStateStatus` reads `DIRTY` or `mergeable` `CONFLICTING` on that head | no             |
| PR     | `merged`    | `merged`                     | `state` is `MERGED` (stacked or not; the note says which, `stacked`)       | yes            |
| PR     | `closed`    | `closed`                     | `state` is `CLOSED`                                                        | yes            |
| Run    | `completed` | `completed:<attempt>`        | `checkSuite.status` is `COMPLETED`                                         | yes            |

- **Fail-fast.** `checks` fires on the first `FAILURE` reading, while other checks may still run, as `gh pr checks
  --watch --fail-fast` does; a later pass of the same head after a re-run fires `checks:<head>:pass` once more. Built
  2026-11-18 on the contexts, not the rollup's `state` (S2: DESIGN.md, "PR status", "What a watch's events are"). The
  head is `headRefOid`.
- **All checks, not only required ones.** A session fixing CI cares about an optional check too. The note marks which
  failing names are required (W5), so a session can tell a merge blocker from noise.
- **A PR watch spans the PR's life** until it is merged or closed: a push, a failure, a fix, a conflict, a rebase and
  the merge are one watch, which is /ship's whole step 8. No per-event subscription, and no `quiet: passing` option
  (decided, open question 1).
- **`head` closes the stale-run race.** Right after a push the rollup can still be the previous head's (why /ship
  sleeps 20 s before `gh pr checks --watch`). A watch made with `head` fires `checks` and `conflict` only for readings
  whose head is that commit. If the PR's head moves to another commit, the watch follows it and the next note says the
  head moved (someone else pushed). Without `head`, the head of the first reading is the watch's.
- **Level-triggered from the first reading.** A watch on a PR already merged, or a run already completed, fires at
  the first poll after it is made. A session that registers late still gets its answer, and a watch carried across a
  leader change (W9) is judged afresh against `seen`.
- **`seen` is the daemon's record of what it delivered**: the event keys of the watch's last 8 deliveries, kept beside
  the watch (W9) and sent with every `watch-set`. The leader also keeps them in memory for its term, adding a key only
  once the daemon answered the `watch-event` (W6), so a lost frame is retried next poll and a retry is deduplicated by
  key on the daemon side.
- **Not events:** `behind` (blocks only under an up-to-date ruleset, and a session cannot tell from one bit),
  `unarmed`, review requests, comments, a draft toggling. The `prBlocked` alert already reaches the owner for an
  `awaiting-merge` task's stuck PR; a watch is for a session waiting on a fact.

### W5. What a note carries

A note is rendered by the session's own daemon from the event's fields through one fixed formatter
(`watchNote`, `shared/src/watch.ts`, beside the message wrappers), opening "Automated note from séance, not written
by the user" as `blockedBrief` does, and naming the watch id. Its fields, each validated when the daemon parses the
`watch-event`:

- the target URL (rebuilt from the parsed owner, repo and number or id, never the leader's string verbatim);
- the event kind and outcome, enums: `checks` `pass`/`fail`, `conflict`, `merged` (with `stacked: true` when the
  base is not the default branch), `closed`, `completed` with the run's `conclusion` as one of GitHub's
  `CheckConclusionState` values lowercased;
- the head commit (hex, 40 or 64) for PR events, and `headMoved: true` when W4's follow happened;
- for a failure (`checks` `fail`, a run `completed` other than `success`, `neutral` or `skipped`): at most **10**
  failing checks, the newest run of each name (`latestRuns`), each a name through `cleanName` (control characters
  dropped, 100 characters), `required: true` where it is, and a job link only when the check's `detailsUrl` matches
  `https://github.com/<same owner>/<same repo>/actions/runs/<digits>/job/<digits>` exactly, rebuilt from those ids.
  A check whose link is anything else (an external status's `targetUrl`) gets no link: a third party's URL is not put
  in front of a session as séance's word. The names go in a fenced block, as a message body does (`fenced`).

**Never**: a PR or run title, body, branch name, author, comment, review, annotation, log line or a check's summary.
Those are free text a third party (any contributor, any action) writes, and the session can read them with its own
`gh` when it decides to, as the evidence it is (/ship's rule for logs). Check names are repo-owned text already put in
a continuation prompt (`blockedBrief`), bounded the same way; accepted.

The note tells the session what to do next only in fixed words per kind (for a failure: "read the failed job's log
with `gh api repos/<o>/<r>/actions/jobs/<id>/logs` to a file"), never by echoing anything read.

### W6. How it reaches the session

- **The leader sends `watch-event`** to the daemon that holds the watch, sealed `from` the scheduler, one frame per
  device per poll carrying every event for that device's watches (watch id, key, fields). It is a request: the daemon
  answers `{ ok, delivered: [ids] }`, and only then does the leader add the key to its `seen`. The leader's own
  machine is answered in process, as `deliver-message` is.
- **The daemon delivers** (built 2026-11-18: DESIGN.md, "Watches", "Events and `delivered`", "A held note") only through
  messaging's local delivery: it looks the watch id up in its own table (never
  the frame's word on the pane or session) and delivers to the pane, pane pid, task and `claude` process that table
  names, as a reply by handle reaches its asker. A watch whose session no longer runs ends there (`ended`). The note is
  an inbox line marked `wake` (the mod submits it, `$.prompt.submit`): every event is something the session asked to
  be woken for. The mod needs no change: it pushes the daemon's text verbatim and already submits a `wake` line, and
  docs/presence.md §3's coalescing merges a burst of them into one turn once built.
- **Same machine and across machines are one path.** The session's daemon always holds the watch and always
  delivers; only the leader reads GitHub. No message crosses from one session's machine to another's.
- **Held like a reply**: a note for a session whose listener is reconnecting is held under the listener grace like any
  message, and one dropped `nolistener` ends the watch (audited), since nothing else will reach that session.
- **Rejected: an `append` note** (`$.session.append`, no wake). A session waiting on CI has ended its turn; a note it
  reads only at its next turn is never read.
- **Rejected: delivering through `send_message`'s `session-message` path.** That routes by task id through the
  leader's resolver and has no untasked recipient; a watch event already knows its daemon and its table entry.

### W7. What is read, and the budget

**The leader reads, with its own `gh`, inside the poller it already runs** (`daemon/src/pr-status.ts`), and nothing
else reads GitHub for a watch. Watched targets join the poll's target list; nothing changes for a task's PR.

- **PRs.** A watched PR is a target like a task's PR: one alias in the merge query (`p<i>`, 50 a chunk, the query
  byte-identical as DESIGN.md requires), and, while open, one alias in the blocked-state read (`b<i>`, 10 a run),
  which already reads the head, `mergeStateStatus` and every context with `isRequired`; it gains `detailsUrl` on
  `CheckRun`. A PR that is both a task's and watched shares its aliases. A watched PR's reading writes no record and
  no task: it only feeds W4.
- **Runs, by GraphQL, not REST.** Built 2026-11-18 (DESIGN.md, "PR status", "The run query"): a third query, aliased
  `w<i>`, 50 a query, the URL a `URI` variable built from the parsed owner, repo and id (never the session's string),
  reading `checkRuns(first:20, filterBy:{checkType: LATEST})` in the same query, so no fourth query exists (S1).
- **Why GraphQL for runs.** It is the budget that did not run out, it batches 50 runs into a point where REST costs a
  request each, and it keeps no per-run state. **Rejected: REST with `If-None-Match`**, which `gh-run-wait` proves
  free on a 304: a run's ETag changes whenever the run is updated, which during a run may be every poll (unmeasured),
  each a counted request, on the REST budget that ran out; and it needs an ETag per run held by the leader and lost at
  every leader change. It stays the fallback if S1 finds `resource(url:)` unreliable.
- **Rejected: the session's own daemon reading its runs** ("a run is not a task field"). The machine may hold no `gh`
  login (DESIGN.md's reason for one PR poller), two machines watching one run would read it twice, and a rate limit
  would be met by each daemon on its own clock instead of one reader backing off for the fleet.
- **Pace**: the poller's 60 s. A watch's note lands within about one interval of the change (plus the blocked-state
  read's few seconds), against the 30 s the owner's rule allows a session. Accepted: a minute's latency on a CI wait of
  ten, for one read where there were N. No faster pace for watched targets (decided, open question 2).
- **Budget at the caps**, before S1's measurement: 100 watched PRs are 2 merge chunks and up to 10 blocked-state runs
  a poll, 100 runs 2 queries: about 14 points a minute, 840 an hour, of the 5000 GraphQL points, and **no REST at
  all**. Today a single `gh run watch` at its default costs more REST than that in GraphQL. Each query also selects
  `rateLimit{ cost remaining resetAt }` (built: DESIGN.md, "PR status"), so the cost is measured, not assumed.

### W8. Rate limits, a lapsed login, a leaderless fleet

- **A rate-limit answer is its own class, and the poller waits for the reset.** Built 2026-11-18: DESIGN.md,
  Scheduler, "PR status", "A spent budget is waited out" (the class, S3's shapes, the reset's sources and the
  backoff).
- **A reserve for tasks.** Built 2026-11-18: DESIGN.md, "PR status", "Reserve for tasks". A watch is a convenience; a
  merge settling is not.
- **Watchers are told, once per reason.** The leader's side is built (2026-11-18: DESIGN.md, "PR status",
  "Suspended and unreadable"): a watch whose reads stop for longer than two intervals gets a `suspended` event with a
  reason enum and, for a limit, the reset time. The daemon delivers a fixed note (built 2026-11-18, "Watches"): for a limit "GitHub's budget for this fleet's account is
  spent until HH:MM UTC; this watch resumes then; do not poll GitHub yourself meanwhile", **without wake** (an
  `append`: the session is waiting either way, and waking it to say "keep waiting" costs a turn); for a login or a
  missing `gh`, "the fleet cannot read GitHub; this watch is suspended" **with wake**, since that may never heal by
  itself and the session should fall back to its own polling at 30 s or ask its user. The watch stays and resumes
  when reads do; the fallback is the session's call. One note per watch per reason (the key is `suspended:<reason>`, so a new leader does not repeat it), and a
  resumption says nothing.
- **A target the forge will not describe** (the alias answers `null`: no repo, no access, no such run) for two
  consecutive polls ends the watch with an `unreadable` note, with wake. Built 2026-11-18 on both sides.
- **No leader, or one that does not advertise `watches`**: the add is refused (`no_leader`, `unsupported`) and the
  session polls itself. A leader lost after the add: the daemon, having had no `watch-set` answered for 10 minutes,
  sends the watch a `no_leader` note, with wake, once. Built 2026-11-18, with the answer counted and never the send
  (DESIGN.md, "Watches", "A set nobody answered is resent"). A `fleet_full` that arrives after the add is one wake
  note per watch and the watch stays, in the daemon's own local flag, never in `seen`.
- **Expiry** (W3's 24 h) is a note with wake ("watch expired; call `watch_github` again if you still wait on it"):
  a session may be waiting on it. Built 2026-11-18.

### W9. Leader change and daemon restart: the daemon is the owner of record

- **The leader's registry is built** (2026-11-18): DESIGN.md, "PR status", "The registry" (soft state per term, keyed by
  device id, the whole set replacing, the generation, the 15 minute expiry, the caps and the refusals, the answers).
  Nothing is in the relay's store. The daemon's side is built (2026-11-18, DESIGN.md, "Watches"): it sends every live
  watch it holds (id, kind, target, `head`, `seen`) on every change, every 5 minutes as a heartbeat, at each tick while
  an answer is owed, and at once when it sees a new verified leader nominee, so a new leader, a relay hiccup or a lost
  frame each heal within one heartbeat.
- **The daemon persists its table** (built 2026-11-18, "Watches", "Persistence") in `stateDir()/watches.json` (0600, written by atomic rename): per watch the id,
  kind, target, `head`, `seen`, the pane id, the pane process's pid and start time, the `claude` process's pid and
  start time, task id or none, made and expiry times. No note text, check name or reading. A restart (a self-update is
  one) reloads an entry only while its `claude` process still runs with that start time and its pane carries the same
  task, as `pane-activity-store.ts` reloads activity; any other is dropped. The first `watch-set` after the start
  carries the survivors.
- **Rejected: a store record per watch** (a `watch:` prefix). Durable across a leader change, but a new prefix needs
  its own write policy, the write floor and the version floor, and a store write per add and per event, to keep state
  the daemons already hold and can restate in one frame.
- **Rejected: daemon memory only.** Self-updates restart daemons often; every one would silently drop every watch on
  the machine while its sessions wait.

### W10. Surfaces, capability and audit

- **MCP** (`seance mcp`; built 2026-11-18, DESIGN.md, "MCP server"): `watch_github { url, head? }` answers `{ ok, id, kind }` or a code (`invalid`,
  `nosession`, `nolistener`, `too_many`, `fleet_full`, `no_leader`, `unsupported`, `unbound`, plus the transport
  codes); `unwatch_github { id }` answers `ok` or `unknown`. Its description says to end the turn after a successful
  call, that a note will wake the session, and that the session must not poll the same target meanwhile. Rejected:
  separate `watch_pr` and `watch_run`: the URL already says which, and one tool is one more line in every session's
  context instead of two. No list tool: the ids are in the session's own context, and an `unwatch` of an unknown id
  is harmless.
- **The local socket's `watch` frame kind** (built 2026-11-18) (`{ v: 1, kind: "watch", op: "add" | "remove", url?, head?, id? }`,
  parsed by `parseWatchFrame`, exactly those fields), bound by the kernel-reported peer pid only, refused `unbound`
  where the host names no peer or the pid came back null, never a claimed pane. Not a `Plain`, not on `LOCAL_OPS`,
  not on the broker.
- **Two scheduler frames**: `watch-set` (daemon to leader), honoured only sealed `from` a registered machine's own
  device id, never `from: "app"`, parsed by `parseWatchSet`, past `schedulerGuard`; `watch-event` (leader to daemon),
  acted on only sealed `from` the scheduler (or in process), parsed by `parseWatchEvent`, its ids looked up in the
  daemon's own table.
- **`CAPABILITIES.watches`**, advertised by a daemon that serves the frame and, as leader, polls watches.
  `seance mcp`'s tool answers `unsupported` unless its own daemon advertises it and the **verified** leader does
  (`messageRouteGate`'s pattern, never the daemon's word alone); the daemon, which sends the `watch-set`, refuses the
  add `unsupported` when the leader it sends to does not advertise it. An older leader would drop the unknown op; the
  gate means none is sent.
- **Audit**, a new origin `watch` (built 2026-11-18), counts, kinds and outcomes only:
  `audit watch origin=watch op=<add|remove|event|end> kind=<pr|run|-> event=<…> reason=<…> outcome=<…>`. Never the
  URL, owner, repo, number, head, check names or the watch id (it joins nothing the line needs). The leader logs no
  line per watch, reading or event, only a refused set, a failed send and the poller's class changes.
- **Not in the PWA, `get_queue`, `status` or the archivist.** No count of live watches on the Machines row (decided,
  open question 3).

## Threat-model invariants this adds

Recorded 2026-11-18 (invariants 1, 3 and 5-8 with step 3, 2 and 4 with step 2): CLAUDE.md's conventions list and
DESIGN.md's threat model, "A watch's target reaches GitHub only through the leader's poller" and "A daemon's watch
table binds a watch to its session's `claude` process". The list stays as the spec they were taken from:

1. A watch is made only through the local socket's `watch` frame, bound by the kernel-reported peer pid to a pane and
   a `claude` process (`<pid>:<start time>`), never by a field; refused where the host names no peer.
2. Its target reaches the leader only as a URL matching the PR or run pattern, parsed into owner, repo and number or
   id, and reaches `gh` only as GraphQL variables (`-f`, `-F` for the regex-held PR number) in an argv array, the
   query text built from alias indices alone, through `askGithub` with `--hostname github.com`. Read-only.
3. A note is rendered by the session's own daemon through the one formatter from enums, hex, rebuilt URLs and
   `cleanName`-bounded check names, fenced; never a title, body, branch, comment, annotation, log, summary or a third
   party's URL. Delivered only by messaging's local delivery, to the pane, pid, task and `claude` process the
   daemon's own table names, as a `wake` line or a plain note, never `asUser`, `$.prompt.fill` or tmux keys.
4. `watch-set` is honoured only sealed `from` a registered machine (never `from: "app"`), parsed fresh, past the one
   `schedulerGuard`; `watch-event` only sealed `from` the scheduler. Neither frame names a pane, task or session.
5. The caps (8 a session, 64 a machine, 100 PRs and 100 runs a fleet) and the reserve for tasks' reads are the
   leader's and the daemon's, never a frame's; nothing a session sends can raise them.
6. `watches.json` holds ids, targets, keys and process identity only, 0600, and an entry is reloaded only for the
   same `claude` process.
7. A live watch holds its pane from the custodian's `close` and nothing else: no hand-off, pass, drain or reap waits
   on it.
8. Nothing reachable from `seance mcp` calls `log.ts` (the tool and frame client live with `send-message.ts`'s rule).

## What it replaces in practice

- **/ship step 8, "Watch".** The hand-off branch stays as it is (W11). The watch branch becomes: after the push,
  `watch_github` on each PR with `head` set to the pushed commit, end the turn. A `checks fail` note carries the
  failing jobs' ids, which step 8's log step needs (it reads them from `gh pr checks --json link` today); a `conflict`
  note replaces the 20×30 s `mergeable` loop; `merged` ends it. A re-run or a fix push is a new `head`: call the tool
  again, which replaces the watch. A refusal (`unsupported`, `no_leader`, `nolistener`, `fleet_full`) falls back to
  today's background script. Step 9's "wait for main's dev deploy job to finish" becomes `watch_github` on that run.
- **The owner's waiting instructions** (`~/.claude/CLAUDE.md`, "Waiting") would gain one rule ahead of the others:
  in a Séance session, wait for a PR or an Actions run with `watch_github` and end the turn; fall back to
  `gh pr checks --watch -i 30` and `gh-run-wait` only when it refuses. The 30-second floor stays for everything else.
- **What it does not replace**: a session watching a non-GitHub forge, a run on GitHub Enterprise, or anything not a
  PR or a run (a deploy's health URL, a release). Those keep their own waits under the owner's rules.

## W11. The plain alternative: extend `hand_off_task` and `prBlocked`

The question is whether a session that hands its PR off and is continued on an event (the leader already reads the PR,
`prBlocked` already names `checks` and `conflict`, Continue on a blocked PR already resumes the conversation with a
fixed brief) makes a watch unnecessary. It would need one change: the leader continuing an `awaiting-merge` task by
itself when `taskPrBlock` names `checks` or `conflict`, where today a person taps Continue.

It covers less than the problem:

- **Only tasked sessions, one PR, targeting main, with a merge gate armed.** /ship hands off only then, by its own
  rule. Hand-started sessions, stacked PRs, several PRs, gate-less repos (where the session merges once green) and
  every Actions run (a deploy, a dev check, a release) keep polling, and those are a large share of what ran the budget
  out.
- **A CI cycle becomes a close and a relaunch.** Each failure would end the session and queue a continuation, which
  waits for a slot under the account's cap (4) behind whatever is queued, starts a new process, and resumes a
  conversation whose prompt cache has gone cold. A watch leaves the session idle in its pane for the minutes CI takes
  and wakes it into the same context.
- **It reverses a decision.** Automatic continue was kept manual on purpose (DESIGN.md, "Continuing a session": an
  automatic continue after a kill is "manual by decision"), and a self-continuing loop on a red check is an
  unattended retry of the kind that decision kept for a person: the watch leaves the next step to the session, which /ship bounds at
  three fix attempts.

**Decision: build the watch; keep the hand-off for what it is good at.** A session whose PR waits on a review or a
merge queue for hours should still hand off: an idle session holds a pane, a slot and an account's session limit for
nothing. A session waiting minutes for CI, a conflict or a run should watch. The two compose: a session can watch
until checks pass and then hand off. The leader's automatic continue on `checks` is not proposed here; if the owner
wants it, it is its own decision against the "manual" one above.

## Rejected alternatives (all in one place)

- **Webhooks.** DESIGN.md's PR-status record already rejects them: the relay is blind and holds no secret worth a
  GitHub-facing endpoint, and a webhook needs per-repo installation the fleet does not own.
- **GitHub's notifications API** (`/notifications`, `Last-Modified` and `X-Poll-Interval`). One feed per user, but CI
  outcomes reach it only as the user's notification settings allow, a thread names no check or job, and a
  session would still need a read per run to learn which job failed.
- **A caching `gh` shim on each machine** (sessions' `gh` calls deduplicated per machine). It dedups within one machine
  only, cannot change a session's polling pace, and puts séance between every session and its `gh`, which reads and
  writes far more than watches. Not proposed.
- **A watch per tasked session only, by task id** (W1), **only the task's own PR** (W2), **runs read by each daemon or
  over REST with ETags** (W7), **a store record per watch** and **memory-only daemon state** (W9), **`append` notes**
  (W6), **separate PR and run tools** (W10).

## Spikes before build

- **S1 (done 2026-11-18).** Recorded in DESIGN.md, "PR status", "The run query": 50 run aliases cost 1 point with and
  without `checkRuns(first:20)`, a blocked read of 10 PRs costs 1 point with `detailsUrl`, and a run the token cannot
  see answers a `null` alias with no error. `resource(url:)` is reliable, so the REST fallback is not needed.
- **S2 (done 2026-11-18).** Not observed in 32 open PRs: a rollup reading `FAILURE` with pending contexts, so
  fail-fast reads the contexts. Recorded in DESIGN.md, "PR status", "What a watch's events are".
- **S3 (done 2026-11-18, from `gh`'s source and GitHub's docs, not a live spent budget).** Recorded beside the
  `limited` class in DESIGN.md, "PR status".
- **S4.** An idle Claude session woken by a `wake` note after 30-plus minutes, with the session waiting by ended turn
  and no background shell: that the note starts a turn the model acts on (the messaging spikes measured minutes, not
  a CI's length).

## Open questions (all decided by the owner, 2026-11-18, as recommended; recorded in DESIGN.md, "PR status" and Daemon, "GitHub rate limits")

1. **`quiet: ["passing"]`**: no. One note per head is cheap, and a pass is often when /ship merges.
2. **A faster pace for watched targets**: no. The poller keeps one 60 s clock.
3. **A budget gauge**: built as #547 (`MachineStatus.gh`, the leader's `github` alert). **A live-watch count on the
   Machines row**: not built.

## Build order

1. **Leader side, no new surface** (built 2026-11-18): `askGithub`'s `limited` class and the in-query `rateLimit`,
   the reset-time backoff (W8). The reserve moved to step 2.
2. **Spikes S1 and S2**, then the run query, the watch registry and the reserve for tasks in the poller (W4, W7, W8), behind
   `CAPABILITIES.watches`, with `watch-set` and `watch-event` (W6, W9) and their parsers, tests against a `gh` stub
   (built 2026-11-18).
3. **The daemon's table, `watches.json`, the `watch` frame, delivery and the custodian hold** (W3, W5, W6, W9), the
   audit origin, and the threat-model invariants into CLAUDE.md and DESIGN.md (built 2026-11-18: DESIGN.md,
   "Watches", which also holds the `watch-set` contract the leader built: `gen.n` rising on every send, the resend
   until answered, what `delivered` lists, `fleet_full` as "not polled for now").
4. **MCP's `watch_github` and `unwatch_github`** with the verified-leader gate (W10), S4 live, then the /ship and
   owner-instruction changes (outside this repo).
