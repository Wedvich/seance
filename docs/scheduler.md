# Séance scheduler — plan

**Status: plan, M1, M2 and M3 done.** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview; placement revised 2026-10-15 (below). Folds into DESIGN.md
(new section "Scheduler") as each milestone lands; until then this file is the working record and
DESIGN.md describes what exists. M1 (visibility: exclaves, telemetry, the `status` frame, the
`metrics` op, the PWA's Machines screen) folded in on 2026-10-15, M2 (routing, leadership,
`auto`) on 2026-10-16, and M3 (the durable queue) on 2026-10-18; their plan text is gone from
here — DESIGN.md is the record for anything they built. What is left ahead of code is M4.

## Glossary

One word per thing. The wire names in `shared/src/types.ts` are older than this table and
stay as they are; the table says which word each one means.

| Term    | Meaning                                                                                                                                                                                                                                                                                                                                             | On the wire / in code                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| machine | A box running one `seanced`: the unit of presence, pressure and dispatch                                                                                                                                                                                                                                                                            | `deviceId` is its routing key, `MachineInfo` its blob                                       |
| exclave | A tree at `~/<name>` whose Claude Code config dir is `~/.claude-<name>`, signed into one account; `default` is `~` with `~/.claude`. Séance depends on those three attributes and the `~/.exclaves` contract below, nothing else an exclave carries (git identity, browser profile) is its business. Never "workspace", which is a Bun package here | `exclaves[]` in the register blob, `exclave` on a clone                                     |
| account | The billed Claude identity an exclave is signed into; the 5h/7d quota attaches here. Never "subscription", which is the plan that account is on, and never the email                                                                                                                                                                                | `accountId` = `organizationUuid:accountUuid`; `account:<hmac>` its record in the store (M4) |
| repo    | A repository as a logical thing, the same across machines: what a task names. Keyed by normalized `origin`, basename when there is no remote                                                                                                                                                                                                        | `TaskSpec.repo`, `RepoEntry.origin`                                                         |
| clone   | One machine's checkout of a repo, inside one exclave, under a machine-local, collision-disambiguated name. What `spawn` takes                                                                                                                                                                                                                       | `RepoEntry`, `spawn { repo }` (historical name)                                             |
| session | One Claude Code process in one tmux pane, spawned in a clone                                                                                                                                                                                                                                                                                        | pane id, `sessions` op                                                                      |
| task    | A unit of queued work: repo + prompt + spawn opts, with deps and a state. Becomes a session when dispatched                                                                                                                                                                                                                                         | `task:<id>` in the store, `taskId` on spawn                                                 |
| leader  | The daemon currently nominated to run the scheduler loop                                                                                                                                                                                                                                                                                            | `lead`/`follow`, `scheduler:term`                                                           |

## Decisions (from the interview, placement revised 2026-10-15)

| Topic             | Decision                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement         | **Queue lives in the relay's DO as sealed blobs; the loop runs on a relay-nominated daemon.** No standalone process, no new PSK holder. `scheduler/` is a pure library the daemon hosts behind two adapter interfaces, so it can move to a fixed box later without a rewrite                                                                                                                |
| Exclave           | Derived: `default` (`~/.claude`) + one per line of `~/.exclaves` (`~/<name>`, `~/.claude-<name>`). Reported per repo in the register blob, and as the blob's `MachineInfo.exclaves` list (account, auth, skills); a repo's location decides its config dir, so `spawn` is unchanged                                                                                                         |
| Spawn contract    | Unchanged apart from optional `baseBranch` and `taskId`. Scheduler resolves "repo X" → (machine, clone) and calls the existing `spawn`                                                                                                                                                                                                                                                      |
| Account id        | `organizationUuid:accountUuid` from `<configDir>/.claude.json` (`~/.claude.json` for `default`) — never the email                                                                                                                                                                                                                                                                           |
| Quota telemetry   | One source, the config dir's `cachedUsageUtilization` (M1's), which the daemon refreshes through `claude --safe-mode -p /usage` once it is stale (M4) → last value + `resets_at` floor. M4 retires M2's session-reported `rate_limits` and replaces the planned OAuth poll                                                                                                                  |
| Task              | Free-form (repo + prompt + spawn opts), optional Linear link                                                                                                                                                                                                                                                                                                                                |
| Deps              | Per edge `after: opened` (stacked, default) or `after: merged`; Linear relations + hand-declared                                                                                                                                                                                                                                                                                            |
| Done signal       | Layered: PR merged (daemon, local git) / Linear Done → session ended → manual                                                                                                                                                                                                                                                                                                               |
| Quota exhausted   | Spill into credits, loudly (Web Push), with pause: until resume / until next reset                                                                                                                                                                                                                                                                                                          |
| Concurrency       | Global max, per-account max, per-batch strategy (`sequential` / `parallel(n)` / `auto`)                                                                                                                                                                                                                                                                                                     |
| Alerts            | Web Push (VAPID) from the leader to subscribed PWAs (M4; key sealed in the DO, see _Secrets_)                                                                                                                                                                                                                                                                                               |
| Needs input       | `needs-input` state, alert, keeps its slot; idle timeout escalates, never kills                                                                                                                                                                                                                                                                                                             |
| Event ingest      | New ingest-only `session-event` frame kind on the local socket, after the fleet broker's precedent (threat-model widening, recorded)                                                                                                                                                                                                                                                        |
| Proxmox           | Machine pressure = the container's own cgroup and PSI view, read by the LXC daemon and folded into its own `status`; no Proxmox API or token (decided 2026-10-20, M4 #17)                                                                                                                                                                                                                   |
| Telemetry         | Current snapshot (pressure + latest quota) rides the relay as a sealed `status` frame held on the daemon's socket attachment and pushed to apps + the leader; the relay keeps the last one with the registry entry when the socket goes (M2), so quota outlives a sleeping observer. History stays on each daemon behind a `metrics` op; neither the relay nor the scheduler stores history |
| At rest           | The queue is sealed envelopes in DO storage: the relay holds id, version and ciphertext, nothing else. No second at-rest scheme                                                                                                                                                                                                                                                             |
| Skills            | Hard filter on a declared or `/name` skill the fleet's inventory knows (unknown names pass); PWA autocompletes from it                                                                                                                                                                                                                                                                      |
| Clients           | PWA in v1; op set designed so MCP, Raycast and CLI attach later without protocol change                                                                                                                                                                                                                                                                                                     |
| Manual spawn      | Both: `auto` → scheduler; picking a machine → direct to daemon (works with no leader)                                                                                                                                                                                                                                                                                                       |
| Handoff           | Dependent task gets a preamble: predecessor title (else its window or branch slug — its prompt is gone once it finishes, Settled defaults 16), branch, PR URL; the transcript path is proposed dropped from v1 (M4, _Stacking_)                                                                                                                                                             |
| AI dep classifier | Later; dependency sources are pluggable                                                                                                                                                                                                                                                                                                                                                     |
| Slicing           | M1 visibility → M2 routing + leadership → M3 durable queue → M4 refinement (in waves: its items depend on each other, M4 below)                                                                                                                                                                                                                                                             |

### Why the relay holds the queue and a daemon runs it

The first draft placed a standalone scheduler in a Proxmox LXC holding the PSK, a SQLite queue
and three more secrets. It was the fifth kind of PSK holder and the first to act on its own —
by the draft's own risk list, the most valuable box in the system — plus a deployment, an
installer path and an at-rest sealing scheme of its own. Splitting the two things it did
removes all of that:

- **Storing the queue** needs no trust. The relay already keeps one long-lived sealed blob per
  machine (the register `info`) that the PWA opens hours after it was sealed. A task is the same
  shape. The relay learns how many tasks exist and when they change — the metadata class
  DESIGN.md already concedes — and nothing else.
- **Running the queue** needs the PSK (every input is sealed: `status`, exclaves, task bodies,
  `branch-state`), so a PSK holder must do it. Daemons already hold it, already dial out, and
  one of them is up whenever any work could run. So the scheduler is a _role_ a daemon takes:
  the relay nominates one, and the queue's liveness equals the fleet's. If the leading machine
  sleeps, the role moves; as long as there is a daemon, there is a scheduler.

The relay stays blind, and the one judgement it makes to nominate — connectedness — is the one
DESIGN.md already allows it ("the one check a blind relay can make").

Rejected: plaintext task metadata (state, deps) so the relay could drive alarms itself — the
work graph is an activity timeline, and the leader's own timers cost nothing. Rejected: every
daemon running the loop with the DO serialising writes — duplicate alerts and polls, and N
readers of the whole queue every tick, for no availability gain over re-nomination.

## Topology

```
PWA ──/app──┐                ┌──/daemon── seanced (mac)   ◄─ leader: scheduler/ loop + app-role leg
            ├── Relay (DO) ──┼──/daemon── seanced (wsl)
            │   task:<id>    └──/daemon── seanced (lxc-*)       each: tmux ── claude (+ mod hooks → local socket)
            │   {version, env}
            └── scheduler:term
```

No new kind of PSK holder. The leader is an ordinary daemon with two extra legs: a store
client on its daemon socket and an app-role client (the fleet broker's precedent) to receive
registry and `status` pushes and to address other daemons. That client is the leader's own
and long-lived, not the broker's idle-closing `LazyRelay` (DESIGN.md _Scheduler_, "The leader").

## Wire changes

M1–M3's wire is built, and DESIGN.md is its record: _Wire protocol_ (the frames, Layer 2's
scheduler ops, the frame→module table) and _Scheduler_ ("The store", "Task records and the app's
store leg", "The queue store", "The leader"). All shapes land in `shared/src/types.ts` first, the
schema of record; where a sketch here disagrees with it, `types.ts` wins. What M4 adds:

- **Store ops** (M3; DESIGN.md _Scheduler_, "The store"). Who may write is a rule per key
  prefix, applied by the relay. M4 adds prefixes:

  | Prefix           | Create          | Overwrite / delete               | Term-fenced | Lands |
  | ---------------- | --------------- | -------------------------------- | ----------- | ----- |
  | `task:<id>`      | any app, leader | leader only                      | yes         | M3    |
  | `queue:pause`    | leader only     | leader overwrites; never deleted | yes         | M3    |
  | `account:<hmac>` | any app         | any app, by `expect` (CAS)       | no          | M4    |

  App-writable records exist for state a person edits from any client with no leader up — an
  account's alias first. M4's `settings`, push subscriptions and the fleet quota record need
  prefixes of their own in `STORE_PREFIXES`, decided with each item, under one policy that
  lands before any of them ("Store rules v2", M4 below).

- **Version binding** — the reader's rules (`bindTaskRecord`) are DESIGN.md _Scheduler_, "Task
  records and the app's store leg". They close rollback against a token holder, not the relay
  (DESIGN.md Threat model, item 4).
- **Stored blobs are an at-rest format, not live frames.** M4's `account` record is sealed to
  `"app"` under op `account` and, like `task` and `pause-state`, opened only through
  `openAtRest`, never on a live routing path. A distinct op per kind is what stops a stored record
  being replayed as a request, or as a record of another kind.
- **Daemon → scheduler** (M2, M3): `session-event` and `branch-state`, and the `sessions`
  reply's `ended` and `progress` that back them up, are DESIGN.md Local op socket ("Session
  events") and _Scheduler_ ("Branch state", "Done detection"). M4 adds an exit status (`failed`
  from exit status, M4 below).
- **`SpawnRequest.baseBranch?`** (M4, stacking) — start the worktree from this branch instead of
  the default. Resolved against the repo's refs, never interpolated; unresolvable is a new code,
  `base_not_found`. Fetched before launch as the default branch is (`base-fetch.ts`), so a
  stacked task never starts from a stale `origin/<b>`. An old daemon drops an unknown field
  silently, and B would start from main, so the leader sends it only to a daemon advertising the
  `"baseBranch"` capability — required, not optional. How the worktree gets made is the open part
  (Stacking, below).
- **App → scheduler ops**: M2 and M3's (`queue`, `route-preview`, `cancel`, `mark-done`,
  `pause`/`resume`) are DESIGN.md _Wire protocol_, Layer 2. M4 adds `push-subscribe` (Web Push),
  not in `SCHEDULER_OPS` yet. `enqueue` stays a `store-put`, never a leader op.
- **`MachineInfo.capabilities`** gains `"baseBranch"`; `status` gains each exclave's auth state
  (Auth health, below).

## Daemon changes

What M1–M3 built is DESIGN.md's: _Daemon_ (exclaves, telemetry), Local op socket ("Session
events"), and _Scheduler_ ("The leader", "The queue store", "Branch state"). M4 adds:

- `daemon/src/usage-refresh.ts` (not `shared/src/quota.ts`, the fleet fold readers share): runs
  `claude --safe-mode --output-format json -p /usage` for an exclave whose cached utilization is
  stale, so Claude Code refreshes its own cache and the existing `cache` collector reads the
  result. The daemon holds no token and calls no endpoint (M4 item "`/usage` refresh"). **Done**
  (DESIGN.md, _Daemon_, "Usage refresh").
- Collectors not yet built — LXC PSI and cgroup views, macOS I/O rates
  (DESIGN.md _Daemon_, "Telemetry").

## Scheduler (`scheduler/`)

**A pure library, no I/O of its own**, behind two interfaces the host supplies — `QueueStore`
and `Fleet` — so the placement decision stays reversible: moving the scheduler to a fixed box
later is two new adapters (SQLite store, own app-role client) and no change here. DESIGN.md
_Scheduler_ is the record of what exists: "The library" for the interfaces, routing, states,
takeover and `lost`, "The leader" for the daemon hosting it, "The queue store" for the adapter on
the relay's store. This section keeps only what M4 changes. Labels code comments cite, and where
they now live:

- **Routing** (filter, score, stickiness, reserve, record) — DESIGN.md "The library", "One
  routing function" through "Reserve, then dispatch"; what is ahead is below.
- **Missing quota is unknown, never 0%** — the DESIGN.md bullet of that name.
- **Quota freshness** (the observation's, not the status's) — DESIGN.md "One routing
  function": pressure only from a live, unstale status, quota from every status by its own
  `at`. Why there is no age cap: _Settled defaults_ 7.
- **Task states**, **Takeover** and **Done detection** — DESIGN.md "States", "Admission and
  dependencies", "Batches", "Done detection", "Pruning", "`lost`" and "What takeover settles",
  with `scheduler/src/task.ts` the table that runs; the store's half of takeover is "The queue
  store".
- **The store adapter** and **Records** — DESIGN.md "The queue store"; what a leader change loses
  is the library's in-memory view, listed in "What takeover settles".

**Routing, ahead.** M4 adds:

- Filters (the per-account cap and the per-batch bound are DESIGN.md "Routing caps" and
  "Batches"): `skill absent` (M4, _Skills_: a hard filter when declared or the prompt starts with
  `/name`, and only for a name the fleet's inventory knows); stacked base unpushed and not on
  this exclave (M4, _Stacking_); auth expired (M4, _Auth health_).
- Score: `dependencyDistance` gets an input once M4's stacking fills `TaskSpec.base`. The LXC
  pressure view (M4) reaches `machinePressure` folded into the LXC daemon's own `status`, so the
  library reads it as any other pressure.
- Projected usage: the fixed per-task estimate (_Settled defaults_ 8), to be tuned from observed
  deltas per task.

**Credits spill:** detected, logged and shown in the PWA (DESIGN.md "Credits spill"). An account
whose credits are spent to the monthly cap is never spilled into (DESIGN.md, Routing). From M4 the
same `onAlert` fires a Web Push ("Spending credits on <account> for <task>"), once per account
per window, not per task; the de-dupe outliving a leader change is M4's (Settings and Web Push,
below).

**Done detection, ahead.** Linear Done (M4, if linked, polled), and `failed` for a session that
ends with no PR and a nonzero exit (M4, _`failed` from exit status_) — until then a PR-less end
is `done` by `session`, which releases every dependent.

**Secrets (M4).** The first draft gave a fixed box a Linear key, a VAPID key and a Proxmox
token. Under a moving leader there is no Proxmox token at all (M4 #17: the LXC daemons read
only their own container); the VAPID keypair and Linear key live in the store (`settings`),
opened by whichever daemon leads — the PSK is already the only trust boundary, so sealing them
under it adds no second one. The leader alone writes `settings`, and every PSK holder can read
it (Settings and Web Push, below, #9). Linear polling is optional from day one, since daemon-local merge detection is the
primary done signal.

## Milestones

Each milestone ships something usable on its own and is cut into PR-sized tasks in the order
listed — the order is the dependency graph. _Exit_ is what proves it done, phrased as tests
where a test can say it. _Gaps_ are what the milestone deliberately leaves manual or broken, so
nobody files them as bugs. _Record_ names the DESIGN.md sections it folds into; the plan text it
replaces is deleted here in the same PR.

| M   | Ships                                               | One line                                            |
| --- | --------------------------------------------------- | --------------------------------------------------- |
| M1  | Visibility across machines, exclaves and accounts   | See pressure and quota everywhere; no scheduler yet |
| M2  | Routing + leadership                                | "spawn this in repo X" without picking a machine    |
| M3  | Durable queue                                       | Queue a block of work with deps and walk away       |
| M4  | Stacking, `/usage`, skills, Proxmox, alerts, Linear | Refinement, in waves                                |

### M1 — visibility (done 2026-10-15)

From the PWA, every machine with its exclaves and accounts, current pressure, the newest quota
observation per account, and history charts — without a scheduler. Landed as #71 (schema), #72
(exclaves), #73 (telemetry), #74 (`status`), #75 (`metrics`) and #77 (PWA), with fixes after.
Recorded in DESIGN.md _Presence & identity_, _Wire protocol_, _Daemon_ and _PWA_. Every exit
criterion has a test — pressure from the first registry push, a `status` gone with its socket,
the size and rate floors, a stray `~/.exclaves` line costing one exclave, an old daemon with no
`exclaves` still rendering, and `status` through the real DO — with two real daemons, each
status indexing its own blob and one account folded across both machines.

**Gaps, until later milestones close them.** No scheduler: you pick the exclave by hand and read
the pressure yourself. Quota comes only from Claude Code's own cached utilization per config dir
(session reports are M2, the `/usage` refresh M4), so an exclave shows whatever its last Claude
session left, with its observed-at — and nothing at all until one has run there. Proxmox node
view absent (M4); an LXC reports what `/proc` shows inside the container, with no cgroup or PSI
read yet.

### M2 — routing and leadership (done 2026-10-16)

A PWA spawn on `auto` lands on the machine and exclave the scheduler chose, with the decision
explained, and the role survives the leading machine going away. Landed by item ("M2 item N"
in commits and code comments):

| Item | What                                                                                                                                       | PR        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1    | The `scheduler/` library                                                                                                                   | #115      |
| 2    | Relay leadership: signed `roles`, nomination, `scheduler:term`, the term fence                                                             | #114      |
| 3    | `leader.ts`, the scheduler role                                                                                                            | #117      |
| 4    | `taskId` on `spawn`, `task_running`, `taskId` in `sessions`                                                                                | #112      |
| 5    | Session events and the `session-events` mod                                                                                                | #118      |
| 6    | The leader answering `queue` and `route-preview`, closing gap A (part 1); M2's `submit`, closing gap B (part 2); the PWA's `auto` (part 3) | #120–#122 |
| 7    | The kept `status`                                                                                                                          | #113      |

After it: gaps 1 and 4 (#127), M3's gate (#124), and MCP's `auto` on M2's `submit` (#131).
Recorded in DESIGN.md _Scheduler_ (leadership, the leader, requests, the library, `lost`),
_Wire protocol_ (Layer 2's scheduler ops, the frame table), _Local op socket_ ("Session
events"), _Presence & identity_ (the kept `status`), _Daemon_ ("Task ids"), _PWA_ (`auto`) and
_Threat model_ (signed `roles`, leader capture and the reader check).

Every exit criterion has a test: two real daemons and an `auto` spawn landing where its record
says, with the other machine's rejection in it, and a bearer-token holder's squatting socket read
as "leader unverified" with nothing sent to it (e2e — since M3's gate a squatter is never
nominated, so the case is a listed machine's seed without the PSK); a stopped leader replaced within one sweep
under a higher term, with `auto` greying and returning (relay + e2e); `not_leader` for a demoted
leader's dispatch and an unsigned `roles` never nominated (relay); `task_running` for a duplicate
task id (daemon + e2e); a session event reaching the leader's state, bound to the sender's own
pane (daemon + e2e); the leader's leg outliving `LazyRelay`'s idle window and nothing of it
surviving `follow` (daemon); and every filter reason, score component, stickiness case and
`quota unknown` rule over fixtures, with the layering test (scheduler).

**Gaps, until later milestones close them.** (The queue was in memory on the leader — a
leader change forgot `auto` tasks not yet dispatched. M3 item 3 closed that: the queue is the
relay's and the next leader takes it over; item 6 moved the PWA and MCP onto `store-put`.)
Deps, batches, caps, `pause` and the escalation and spill alerts have landed (items 4a and 5);
the PWA hears `queue-changed` and keeps a bounded poll as its fallback (item 6). An account nothing has observed yet is `quota unknown` and
gets no `auto` work until a direct spawn gives it a reading (M4's `/usage` refresh gives every
signed-in exclave one).
Leader capture was visible, not prevented: a squatter's term held `auto` unavailable until its
socket went. M3's gate (Risks, _Leader capture_) has since closed it with the relay's
`SCHEDULER_LEADERS` allowlist.

The gaps cited by label elsewhere (A and B were item 3's):

- **Gap A** (closed, item 6 part 1): a term the daemon ended on its own — its leg's token
  rejected — stayed named at the relay, so `auto` looked available while nothing answered. The
  daemon now hands the role back (DESIGN.md _Scheduler_, "The leader").
- **Gap B** (closed, item 6 part 2): a placed task on a machine that stopped answering read
  `running` forever. It is now `lost` (DESIGN.md _Scheduler_, "The library", "`lost`").
- **Gap 1** (closed, #127): a reserved task whose machine disconnected before answering went
  back to `ready`, a possible twin. It is now `lost`, and back to `ready` only on that
  machine's launch-ledger proof (same bullet, and _Local op socket_, "Session events").
- **Gap 2** (looked at, open as a watch): terms climbing fast — deploy churn, not a nomination
  bug (Risks, _Leader churn_).
- **Gap 3** (closed, M3 item 6): a `submit` whose reply was lost could not be reconciled — the
  verdict said it may have queued and offered no retry. Enqueue is now a `store-put` of an
  app-minted id, so the retry re-sends the same task and a `version_conflict` reads as queued.
- **Gap 4** (closed, #127): a `lost` task waited for its own machine indefinitely, with no
  way to give up on it; it can now be cancelled (DESIGN.md "`lost`"), and since 2026-10-18 it
  fails `lost_expired` after 7 days lost (Settled defaults 14).

### M3 — durable queue (done 2026-10-18)

Queue a block of work with dependencies and leave: it runs, survives leader changes, and
finishes without anyone watching. Landed by item ("M3 item N" in commits and code comments):

| Item  | What                                                                                                      | PR         |
| ----- | --------------------------------------------------------------------------------------------------------- | ---------- |
| Gate  | `SCHEDULER_LEADERS`: the relay nominates only listed daemons                                              | #124       |
| 0, 0b | The schema: store frames, task records, the M3 ops, dependency semantics, record bounds                   | #130, #135 |
| Port  | The store port: unreadable records as values, write failures named, the pause slot, `refresh`             | #149       |
| 1     | The relay store: term-fenced writes, tombstones, caps, `store-changed`                                    | #165       |
| 2     | Task records sealed at rest, version binding, the app's store leg                                         | #161       |
| 4a    | The library's M3 states: admission, deps, batches, done detection, pruning                                | #164, #166 |
| 4b    | The daemon's `branch-state` emitter and `sessions` progress                                               | #168, #172 |
| Split | `leader.ts` split into adapters, requests and the term lifecycle                                          | #174       |
| 5     | Caps, `pause`/`resume`, `needs-input` escalation, credits-spill alerts                                    | #177       |
| 3     | The `QueueStore` adapter on the relay store, takeover over sealed records; expiry and the leader-kill e2e | #179, #180 |
| 6     | The PWA's Queue screen, enqueue by `store-put` from the PWA and MCP, M2's `submit` removed                | #183       |

After it: MCP's `cancel_task` wording (#181), the leader and builds in `list_machines` and the
PWA (#184), the relay logging only failures for scheduler traffic (#186), and the leader in the PWA's
Machines header (#188). Recorded in
DESIGN.md _Scheduler_ ("Leadership", "The store", "Task records and the app's store leg", "The
queue store", "The leader", "The library": states, deps, batches, caps, pause, done detection,
expiry, "Branch state"), _Wire protocol_ (the store frames, Layer 2's scheduler ops), _PWA_ ("The Queue screen"), _MCP server_, _Security model_ and _Threat model_ (the
leader allowlist, the bearer token's store acts, prompts at rest, the term fence that is not a
PSK check, rollback closed by version binding and tombstones against token holders, not the
relay).

Every exit criterion below has a test, with the tier named in each; the takeover's merged half
and the verified leader running an unverified-era task were added at close-out.

**Exit.**

- Enqueue with no leader, then start a daemon: it leads, reconciles, and runs the task (e2e).
- Kill the leader between `spawn` and its verdict: the next leader finds the session by
  `taskId` and does not spawn again (e2e, 2026-10-18).
- Put an old sealed blob back at the current version: the reader rejects it on the inner
  version (scheduler + relay).
- A put with a stale term is refused `not_leader`; a bearer-token-only client can list and
  create but not overwrite or delete (relay).
- `after: opened` releases on the first `branch-state pushed` with a PR, `after: merged` only
  on `merged`; `pause` stops dispatch and keeps running sessions; `resume` continues (scheduler).
- A task that does not decrypt, or whose version mismatches, is skipped and reported, never
  fatal, and is still in the store after the takeover (scheduler).
- A leader that takes over after a gap settles a task whose session ended with an open PR as
  `awaiting-merge`, and one whose branch merged meanwhile as `done` (scheduler + daemon).
- A `failed` or `cancelled` predecessor fails its dependents; a cycle fails every member
  (scheduler).
- A create past the create cap is `too_large`; a leader write that would not fit cuts the
  decision and lands (relay + scheduler).
- `relay/test/layering.test.ts` still passes with the store in place (relay).
- An app enqueues by `store-put` with the leader unverified or absent, and the task shows
  `queued` and is run by the next verified leader; the leader's `queue-changed` reaches an app
  and one an app seals does not (e2e, pwa + relay).
- `mark-done` finishes a running task as `manual` and ends its session first; `pause` and `resume`
  show as `holds` in `queue` (e2e). A leader's nudge, an app's `queue`
  fetch it prompts, the leader's answer and its dispatch log no `wire` line (relay).

**Gaps.** No stacking: every task starts from the default branch, and `TaskSpec.base` stays
unset. Alerts are PWA-only until M4's Web Push. Linear is not consulted; done comes from local
merge detection, the session ending, or manual marking. Quota is still session-reported (until
M4's `/usage` refresh; closed 2026-10-20).
Batches and hand-declared deps have no authoring surface: the library, the record and the leader
support them, but neither the PWA nor MCP writes them. A full `task:` listing in one frame is
unchecked on the iOS WKWebView app leg (DESIGN.md, "The store", _Send size_); paging through the
reserved `after`/`next` is the fallback.

**Record.** DESIGN.md _Scheduler_ (store, states, takeover), _Security model_ and _Threat
model_ (the bearer token's app-leg store access, prompts at rest, rollback closed by version
binding against token holders), _Wire protocol_ rows, _Presence & identity_ (each machine's build and last update
report now reach apps, #184; the registry push's shape is otherwise unchanged).

### M4 — refinement

M4's items are **not independent**. The M3 review (2026-10-18) found four real dependencies in
the code, so M4 runs in waves:

- Auth health needs the `/usage` refresh, since a refresh that fails on auth is the signal.
- Web Push and Linear need `settings`.
- Stacking and Linear need an authoring surface. No client writes `deps`, `batch` or `linear`
  today.
- The disk and auth alerts need Web Push.

Each item still lands as its own PR with its own DESIGN.md subsection. Budget one follow-up PR per
item: every M3 item needed one within hours.

**Every _Decided_ entry below was settled by the owner on 2026-10-20** (the M3 review's R8). Each
started as the review's recommendation; where the owner chose otherwise, the entry says so. The
numbers (#) are the review's owner-decision list; #7 and #13 lapsed with the OAuth poll, #1, #2
and #20 were settled earlier, and #21 was added in the same session.

**Order.** Wave 0 settles the seams the items share. Wave 1 is the items nothing else in M4 has to
precede. Wave 2 waits on the wave-1 item named.

| Wave | Item                                                               | Depends on                                                             | Size                     |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------ |
| 0    | Store rules v2 (relay)                                             | the review's S4 store bounds; #29                                      | —                        |
| 0    | One schema PR for every M4 shape                                   | the owner's calls below                                                | —                        |
| 0    | Daemon seams and test infrastructure — **Done**                    | the review's splits of `scheduler.ts`, the PWA store and MCP's enqueue | —                        |
| 0    | #28 (the seed prompt on stdin) and #29 (relay security) — **Done** | —                                                                      | —                        |
| 1    | Authoring surface (new)                                            | —                                                                      | M                        |
| 1    | Settings and Web Push, in three PRs                                | store rules v2; the fetch seam                                         | L                        |
| 1    | `/usage` refresh (was: OAuth quota poll) — **Done** (PR #249)      | — (spiked 2026-10-20)                                                  | S–M                      |
| 1    | Skills filter                                                      | —                                                                      | S; M with project skills |
| 1    | LXC pressure view (was: Proxmox node view)                         | —                                                                      | S                        |
| 1    | Account records                                                    | store rules v2                                                         | M                        |
| 1    | Fleet quota record                                                 | store rules v2                                                         | M                        |
| 1    | CLI and keyless MCP `auto`                                         | MCP's enqueue split out                                                | S–M                      |
| 1    | `failed` from exit status (new)                                    | —                                                                      | S–M                      |
| 2    | Stacking                                                           | authoring surface; #28                                                 | L                        |
| 2    | Auth health                                                        | `/usage` refresh; Web Push for its alert                               | M                        |
| 2    | Linear                                                             | settings; authoring surface                                            | L                        |

**Wave 0.** Owned by the review's relay and daemon sessions, not planned here in full:

- **Store rules v2**, one relay PR before any new prefix:
  - a per-prefix tombstone flag, off for deterministic keys;
  - per-prefix caps sized so caps plus singletons fit `MAX_RECORDS`;
  - a delete policy per prefix;
  - the create floor on the daemon leg for any prefix that is not term-fenced, with store frames
    handled only after register;
  - `store-changed` fanned out to apps for app-writable prefixes (today it reaches only the
    leader);
  - the new prefixes.

  M4's first app-side `store-list` (`account:` on open) means any `store-list` rate bucket must be
  per prefix, or it throttles that list against takeover.

- **One schema PR**, every M4 shape in `types.ts` and `parse.ts` at once: the spawn's base fields,
  `base_not_found` and its capability, the new reason codes, a declared skill on `TaskRequest`,
  `RepoEntry.skills`, auth in `MachineStatus`, a `linear` done signal, the exit status, the new
  at-rest ops and record types, and `push-subscribe` — plus #21's `done` session-event state,
  `until` on the task and `after: "done"`. The prefixes stay unaccepted until store
  rules v2.
- **Daemon seams.**
  - An injectable `httpFetch` and clock through `startDaemon`, the leader and telemetry. Without them
    auth health, push, Linear and Proxmox can be tested only at the unit tier.
    **Done** — `now`, `httpFetch` and `probe` in `RunOpts` (DESIGN.md, Daemon, "Seams").
  - `probe` passed through `startDaemon` to telemetry. **Done**, with the clock.
  - `run.ts`'s wiring split into a capabilities list and a collector registry. **Done**
    (DESIGN.md, Daemon, "Wiring"). The registry reaches into `telemetry.ts` too: each source is one
    `TELEMETRY_COLLECTORS` entry, so the Proxmox readers are each one more. (The `/usage` refresh
    adds none: it refreshes the file the `cache` collector already reads.)
  - `e2e/e2e.test.ts` split by area. **Done** — one file per area behind `startSuite` (docs/development.md).
  - A credentials fixture, a helper that pushes a feature branch to the fixture's origin, and a
    push-endpoint stub. **Done** (docs/development.md).

**Items.**

- **Authoring surface (new, M3 review R3).** MCP and PWA fields for `deps`, `batch` and a Linear
  link. The library, the record and the leader support all three, and the app client already
  bounds a batch index at `createTask`, but no client writes them. Without this item, stacking
  and Linear ship unusable. Exit: a task enqueued from MCP and from the PWA with an
  `after: opened` dep and a batch is admitted with both (e2e).
  - _Decided (#21), done by self-report:_ a task can stay open past its merge until its own
    session says it is done — "after X is in prod" is X's session merging, watching the deploy
    and then reporting. Three shapes, all in the schema PR:
    - a `done` session-event state, bound to the sender's pane by peer pid like every session
      event, so a session can finish only its own task;
    - a per-task `until: "merged" | "reported"` (default `merged`). Under `reported` a merge is
      recorded but does not settle the task; only the report, `mark-done` or Linear Done does;
    - `after: "done"` beside `opened` and `merged`, released by the predecessor's `done`
      whatever settled it.

    The authoring surface writes all three. It is the first act session events gain beyond
    ingest, so it is a threat-model change: DESIGN.md records it (_Local op socket_, "Session
    events", and _Threat model_). A session that lies about being done can do no more than one
    that exits. `mark-done` stays the manual override.
- **`failed` from exit status (new, M3 review R3).** Today a session that crashes with no PR
  settles `done` by `session`, and `done` releases every edge (`released` in
  `scheduler/src/deps.ts`). Under stacking its dependents would start on a branch with nothing
  pushed. The daemon already sets `remain-on-exit` on a spawned window, so `pane_dead_status` is a
  cheap source. Carry it in the launch ledger or in `ended`, so the event path and the sweep
  agree. Exit: a session that exits nonzero with no PR is `failed` and fails its dependents; one
  that exits zero is `done` (scheduler + daemon).
- **Stacking** — `baseBranch` and `base_not_found`, lineage, the handoff preamble. Exit: a
  dependent task's worktree starts from its predecessor's branch; an unresolvable base fails
  with the code, not a shell error. Gap: a rebase after the predecessor changes is manual.
  Corrected by the review (R2):
  - _The daemon has to make the worktree._ `claude --worktree` creates the worktree itself from
    `origin/<default>`, and no CLI flag overrides that (DESIGN.md "Worktree mode does no git
    preparation"). So "start the worktree from this branch" means the daemon creates it.
    _Decided (#3):_ spike whether `claude --worktree <name>` reuses an existing worktree. Either
    way the daemon runs `git worktree add --no-track -B worktree-<name> … origin/<base>` and keeps
    the `.claude/worktrees` layout reap and branch-state rely on; if claude does not reuse it, the
    daemon runs plain `claude` inside the worktree it made (the owner added this fallback, so the
    spike's result does not stall stacking on a second decision).
  - _Fetches are keyed by repo, not branch._ `base-fetch.ts` keys its in-flight fetch by common
    dir alone, so two bases in one repo would share one fetch.
  - _Decided (#4), which dependency stacks:_ only `after: opened`, the first in `deps` order, and
    only on a pushed predecessor. `released` already frees an `opened` edge only with a PR and a
    pushed branch; the one way past it is a predecessor `done` without either (`mark-done`, a
    no-PR session end, a `here` task), and that dependent starts from `origin/<default>` with the
    preamble saying there was nothing to stack on. No placement restriction (the review's, dropped:
    it served only that case).
  - _Decided (#15), validating `baseBranch`:_ `check-ref-format` rules at every hop (today a
    branch name is only length-checked in `shared/src/parse.ts`), and pass
    `refs/remotes/origin/<b>` after `--end-of-options`. Through `shq()` if it ever reaches the
    shell string.
  - _Decided (#5), the handoff preamble:_ drop the transcript path from v1. Nothing on the leader
    knows it, so the PR is the handoff.
- **`/usage` refresh** (decided 2026-10-20; replaces the OAuth quota poll, whose proposals #7 and
  #13 lapse with it; **Done** 2026-10-20 (PR #249), recorded in DESIGN.md, _Daemon_, "Usage refresh") — `daemon/src/usage-refresh.ts` runs
  `claude --safe-mode --output-format json -p /usage` with the exclave's config dir, and Claude
  Code refreshes `cachedUsageUtilization` in place. The daemon reads no token, calls no endpoint
  and never refreshes a login: Claude Code does all three under its own rules, so the
  rotating-refresh-token hazard that made the poll read-only is gone. Measured on 2.1.304:
  - _Free._ `total_cost_usd: 0`, zero tokens, `num_turns: 0`, no transcript written.
  - _Debounced by Claude Code._ `/usage` answers from the cache while `fetchedAtMs` is under 60s
    old and asks the endpoint only past that, so concurrent refreshes of one config dir reach the
    endpoint at most once a minute.
  - _But a process is not cheap._ About 330–390 MiB peak and 5–8s wall with `--safe-mode`,
    about 490 MiB and 7.5–8.5s without (hooks and MCP servers start). Even a run the debounce
    answers from the cache costs the whole process. Hence the rules below.

  Rules:
  - **Never spawn inside the debounce.** The daemon reads `fetchedAtMs` itself (the `cache`
    collector already does, memoized on mtime) and spawns only when it is older than
    `quota.staleAfter`, never under 60s. `fetchedAtMs` is the debounce marker; there is no second
    one of ours.
  - **`--safe-mode` always**: smaller, faster, and no user hook, plugin or mod runs — including
    session-events, which would otherwise report from a process that is not a session.
  - **One spawn at a time per daemon**, with a timeout and a kill: an LXC cannot carry ten
    400 MiB processes.
  - **Triggers**: a session event from the exclave (a session there has spent quota) and a
    `quota.staleAfter` timer for an exclave with none, both subject to the staleness check.
  - **A built env, never the daemon's**: `HOME`, `PATH`, `USER`, `LOGNAME` and
    `CLAUDE_CONFIG_DIR` for a non-default exclave. Without `USER`/`LOGNAME` the macOS keychain
    lookup fails silently and `/usage` prints the `/cost` view with `is_error: false`. The
    service-delivered credential stays out as in `exec.ts`; `claude` is argv-array exec,
    resolved by bare name.
  - **The cache file is the result, not stdout.** A run past the debounce that leaves
    `fetchedAtMs` unchanged failed, whatever it printed; the daemon logs it once and backs off to
    the timer. Failure is quiet and non-fatal.
  - **Retire the `session` source in the same work.** The cache becomes the one source: drop the
    mod's `session.measure` tap, `SessionQuota` and `session-quota.json`, and stop emitting
    `s: "session"` (and drop the never-emitted `oauth`). Parsers keep accepting `session` until
    every daemon has updated: a status from an older daemon still carries it, and refusing it
    would cost that machine its quota. DESIGN.md "Session events" and _Daemon_ "Telemetry" are
    rewritten with it.

  Exit: an idle signed-in exclave's quota is never older than `staleAfter` while the daemon
  runs; no exclave is spawned for twice inside 60s; a failing refresh is quiet (daemon, with a
  `claude` stub that writes or leaves the cache).

  As built: `quota.staleAfter` is the config key `quota.staleAfterMinutes` (default 10; under 1
  refused, the repo's unit-in-the-name convention, like `reap.intervalHours`); the timer checks
  every minute, so a healthy exclave is at most `staleAfter` plus a minute plus a run old — plus the runs queued ahead of it on the process-wide lane (each up to the
  timeout, 60 s, then SIGKILL after 5 s) — and unbounded while its runs fail (backed off for
  `staleAfter` per attempt, state process-wide so a config reload does not reset it, nor shorten
  a backoff already running: its `retryAt` was set from the old `staleAfter`).
  `session-quota.json` is left on disk unread rather than deleted.

- **Skills** — hard filter on declared or `/name` prompts, PWA autocomplete. Settled 2026-10-17:
  - _Inventory_: M1's `MachineInfo.exclaves[].skills` is the source, read with the repo scan
    and served from the blob, never per request. Tightened to directories (or symlinks
    resolving to one) holding a `SKILL.md`, so a stray dir or a dangling dotfiles link stops
    advertising a skill — landed with the autocomplete (PR #167).
  - _Filter_: only a name somewhere in the fleet's inventory restricts — to the exclaves
    that have it (`skill_absent` on the rest). An unknown name passes, which covers built-ins and
    anything the inventory skips; cost: a typo routes anywhere rather than failing. _Decided
    (#19):_ keep "unknown names pass"; detect `/name` only until a client declares a skill.
  - _Autocomplete_ — **DONE (PR #167)**: union of names across machines and exclaves, from data
    the PWA already holds — needs no leader, which is why it landed before the filter. Names
    only, no descriptions (blob size; revisit if wanted).
  - _Out of scope for now_: plugin skills (`plugin:name`, under `plugins/`) and legacy
    `commands/*.md` — both pass the filter as unknown names.
  - _Required, not yet built_: project skills (`<repo>/.claude/skills/`) belong to a clone,
    not an exclave, so they go on `RepoEntry` and the filter checks clone × skill. Until
    then a project-only skill is unknown and passes.
  - _Decided (#20):_ #128 (penalise the default exclave's account) is parked, to be redone as a
    flag on the account record once those land.
- **LXC pressure view** (was: Proxmox node view; S, was M–L) — read by the LXC daemons, folded
  into their own `status`. An injectable `HostProbe` reaches telemetry through `startDaemon`;
  missing are the cgroup and PSI readers, each one more `TELEMETRY_COLLECTORS` entry.
  _Decided (#17):_ no Proxmox API and no token — only what the container itself sees (its cgroup
  limits and PSI). The review proposed a read-only PVEAuditor token with a pinned certificate;
  the owner chose to hold no Proxmox credential at all, at the cost of a node-wide view:
  pressure from neighbouring containers is invisible except as this one's PSI.
- **Settings and Web Push**, in three PRs — the VAPID keypair in the store under the PSK, the
  credits-spill and needs-input alerts, `push-subscribe`; also a machine health alert (disk
  nearly full, from the `disk_pct`/`disk_free_mib` series M1 already stores — the Machines
  screen shows the fill level, but only a push reaches someone not looking at it). The `onAlert` seam exists,
  hard-wired to a log line (`startTerm` in `daemon/src/leader.ts`); a workbox service worker
  exists. Missing: the prefixes, `push-subscribe`, VAPID and RFC 8291 encryption, a push
  handler, the new alert kinds and a persisted de-dupe. Push endpoints can take seconds, so never
  await a send in the pass (as `#launch` does for spawns), and read subscriptions once per term,
  not per alert.
  - _Decided (#9), who writes `settings`:_ a leader op, not an app-writable prefix — an app sends
    the value sealed `from: "app"`, and only the leader writes the record.
    - Every PSK holder, the PWA included, can open the Linear token and VAPID key; DESIGN.md's
      threat model records it rather than adding a second key, since the PSK is already the one
      trust boundary. The Linear key is scoped as narrowly as Linear allows.
    - Apply the review's version floor (S1) to it.
    - Never put it in logs, `queue`, MCP or `status`.
  - _Decided (#10), Web Push egress from a dev machine:_
    - An allowlist of push-service hosts: `fcm.googleapis.com`,
      `updates.push.services.mozilla.com`, `web.push.apple.com` and `*.notify.windows.com` —
      stricter than the review's "any https public host", so a forged subscription cannot aim
      the leader at an arbitrary URL. A new browser vendor is a one-line change.
    - https only, no redirects, short timeouts.
    - Ids and state only in payloads.
    - Prune a subscription on 404 or 410.
  - _Decided (#11), notification actions:_ clicking opens the Queue screen at the alert's task,
    by the task id the payload carries (the owner added the deep link). No actions: iOS ignores
    them, and the service worker holds no PSK.
  - _Decided (#12), spill de-dupe across leader changes:_ stamp the alerted window on the task
    record and seed it at takeover. The 31 terms seen in 6 hours would otherwise repeat a push per
    term.
- **Linear** — key in `settings`; relation-derived deps and Done as a done signal. Needs settings
  and the authoring surface. _Decided (#18):_
  - Only `blocks` / `blocked by` count; `related` and `duplicate` carry no order.
  - A blocks B maps to B `after: "done"` on A (#21), so a block behind a deploy works when A is
    `until: "reported"`, and is a merge otherwise. Not `opened` (every block would stack) nor
    `merged` (a deploy could not be waited on).
  - Linear Done against an open PR settles the task as a manual mark-done would, with a new
    `doneBy: "linear"`: a person closed the issue, so its dependents release. A later merge
    changes nothing.
  - The leader reads relations once, at admission, and writes them into `deps`. A relation added
    or removed in Linear afterwards does not move a queued task, which keeps one write path for
    deps.
- **Account records** — `account:<hmac>` in the store, app-writable (Wire changes, _Store
  ops_), holding `{ accountId, alias }` sealed to `"app"` under op `account`. The key is
  HMAC-SHA-256 over the account's id under a key HKDF derives from the PSK with its own label —
  never the PSK's AES-GCM bytes reused, and never a plain hash, which anyone who knows the
  UUIDs (Anthropic, another relay the account appears on) could match. Every PSK holder lands
  on the same key, so two apps naming one account race on its version, not into two records;
  the relay sees how many accounts are named and when one is renamed, nothing else. Readers
  check the sealed `accountId` hashes to the key. The HMAC input carries the account's kind
  (`oauth|<org>:<acct>`), so a later kind — an API key, a Foundry deployment — gets ids
  disjoint from these; what identifies such an account (the provider's org or workspace, or a
  fingerprint of the key, which changes on rotation) is decided with that kind. PWA: rename on
  the account card, which shows the alias, else the email (DESIGN.md _PWA_), else the short
  account id — clearing an alias falls back to the email. Exit: an alias set in one client shows
  in another; a record whose `accountId` does not hash to its key is ignored (shared + e2e).
  Record: DESIGN.md _Threat model_ (the HKDF label, what the key reveals).
  - _Correction (R2), deleting an alias:_ the relay tombstones every prefix apps can create into,
    and a standing tombstone refuses every put for 30 days. Account keys are a deterministic HMAC,
    so under today's rules a token holder's delete blocks that alias for 30 days; it is not
    "retyped in a second". Today `parse.test.ts` asserts `account:` is refused.
  - _Decided (#8):_ refuse deletes on `account:`, `quota:` and `settings:` as on `queue:`, with no
    tombstone; clear by overwrite.
  - _Decided (#14):_ DESIGN.md records the HKDF salt, label and input. `termFenced: false` gives
    every `/daemon` socket an app's rights on `account:` — create and overwrite, never delete
    (#8) — and that is accepted: a daemon socket needs a signed register on top of the bearer
    token, so it is harder to open than the app leg that already has those rights, and a writer
    without the PSK writes only records whose `accountId` does not hash to their key.
- **Fleet quota record** (decided 2026-10-17, no longer conditional) — one record of
  `{ accountId → newest observation }`, written by daemons on a fixed cadence (~5 min) by
  read-open-compare-`expect`: a daemon writes only an observation newer than the one stored, so
  the record keeps the newest observation, not the last write. One record, not one per account —
  per-account writes would tell the relay when each account is in use. Why it is needed, not just
  nice: the kept-status fold (M2) holds an account's quota only as long as some machine's own
  snapshot does. Each daemon writes over its own, so the fleet's newest reading lives only on the
  machine that saw it, and a `forget`, a reinstall or a machine retired takes that reading with
  it. Persisting `SessionQuota` (DESIGN.md, "Session events") stops a restart regressing it, and
  does nothing for those. Its other payoff is `status` shrinking to pressure, which frees most of
  the 16 KiB socket attachment; its cost is a daemon write path into the store and a 5-min floor
  on freshness, where `status` is faster — so readers fold both, newest wins.
  - _Corrections (R2)._
    - "A single `quota` key" does not fit `STORE_KEY_PATTERN`, which needs a prefix plus a
      routing id.
    - Daemons are a writer class the prefix table does not have, and the first writer on a prefix
      that is not term-fenced. So the create floor must cover the daemon leg, and `#nudgeLeader`'s
      premise — a daemon-leg write is the leader's — stops holding.
    - The plan said both "whether or not anything changed" and "only an observation newer than the
      one stored". The second is the rule.
    - It depends on store rules v2, not on account records.
  - _Estimate:_ about 288 get-and-put pairs per daemon a day, roughly 2,900 rows written at 10
    daemons (3% of the free limit).
- **Auth health** (after the `/usage` refresh) — `authOk` says only that `.claude.json` names an
  `oauthAccount`: a revoked or lapsed login still reads as signed in, and the `auth missing`
  filter routes to an exclave that cannot start a session. Per exclave `auth: ok | expired |
  unknown` with its observed-at, carried in `status`, not the register blob (a change there
  re-registers and drops the status, #102). Filter widens to "missing **or expired**"; `unknown`
  routes, since it is every exclave before its first refresh. _Decided (#6):_ a compact,
  never-trimmed list of expired exclaves in `status`, since auth shares about 680 bytes with
  quota. Signals:
  - _A `/usage` refresh that fails on auth._ Claude Code has already tried its own token
    refresh by then, so — unlike the OAuth poll's 401, which needed reading against
    `expiresAt` — the failure means the login is revoked or lapsed. **Unverified:** what such a
    run prints and exits with (`is_error`, the result text); spike it on a signed-out exclave
    before relying on it, and tell it apart from the silent `/cost` fallback a missing `USER`
    causes (the `/usage` refresh, above).
  - _A session that died on auth_ — only if a hook surfaces it, which is unverified; check
    before relying on it.
  - _A `claude setup-token` token_ (`CLAUDE_CODE_OAUTH_TOKEN`) has the one predictable expiry;
    handled only if an exclave runs on one.

  `expired` clears to `unknown` when a rescan sees the exclave's `.claude.json` or credentials
  change (a `/login`); the next refresh decides. PWA: "needs `/login`" on the exclave row; a Web
  Push beside the disk health alert. Exit: a revoked exclave is filtered `auth expired` and
  clears after `/login`; a failed refresh for any other reason never reads as `expired` (daemon).

- **CLI `auto`, and keyless MCP `auto`** — MCP's `auto` on a box that reads the key itself
  exists already (DESIGN.md "MCP server"). Its `enqueueAuto` is module-private in
  `daemon/src/mcp.ts`, so it is split out before a second caller. What remains:
  - `seanced spawn --auto` (spelling open), enqueueing through the store as the PWA does:
    seal the task, `store-put` it at `expect: 0`, so it queues with no leader up; the
    verdict is "queued" plus the task id, and `get_sessions` finds the session by
    `taskId` once it runs. `seanced spawn` is relay-free today: it drives local tmux and
    audits `origin=cli`. `--auto` is the one form that needs the relay and the PSK (an
    app-role leg, as `seanced mcp` has), and a direct spawn stays relay-free.
  - Keyless `seanced mcp`. It reaches the relay only through the fleet broker, whose
    actions are fixed; today its `auto` is refused ("needs this machine's own key"). An
    enqueue there is a new broker action, which is a threat-model change (DESIGN.md
    "Fleet broker"); without it, keyless MCP gets no `auto`.
  - _Decided (#16):_ ship CLI `--auto` on boxes with the key; defer the broker action.

  Raycast attaches the same way. Exit: a CLI `auto` spawn lands as a task with no leader
  up and runs once one leads (e2e); `seanced spawn` without `--auto` still works with the
  relay unreachable (daemon).

## Settled defaults (interview, 2026-10-15)

Nothing below is open. An implementer who wants a different value changes this section in the
same PR, with the reason.

1. **Leader** = earliest-connected capable daemon on the relay's `SCHEDULER_LEADERS`
   allowlist, ties by `deviceId`, except that a current leader still eligible keeps the role —
   even across its own reconnect; nomination only, no voting. Capable is signed `roles`; the
   allowlist is a Worker secret, and unset or empty nominates nobody. Readers still ignore a
   leader whose entry does not open (Risks, _Leader capture_).
2. **Enqueue needs no leader.** Apps create tasks in the store at `expect: 0`; everything else
   waits for one. Matters only for old daemons and the re-nomination gap — immediate on a clean
   close, up to ~150s for a leader that vanishes silently (90s of silence, then up to a 60s
   sweep, `relay/src/hub.ts`) — and costs nothing (a token holder could already fill the
   registry with junk).
3. **Audit** as `origin=relay client=scheduler`, not a new origin — the daemon-side surface is
   still the relay, and `client` is what already tells the PWA, MCP and Raycast apart. The
   exception is the leader's own machine, which it reaches in process, not through the relay:
   `origin=leader client=scheduler`, since a new surface adds an origin (DESIGN.md _Scheduler_,
   "The leader").
4. **Quota line: 90% hard, 10% reserved**, either window. Matches the router note's
   `reserve_pct: 10` and the knee of its convex cost, `(u/(1-u))²`: 16 at 80%, 81 at 90%,
   361 at 95% — the score already pushes work away before the line, the filter only adds the
   guarantee. Two sub-rules, so nobody reads them as bugs: the line applies to _projected_
   usage (current + this task's estimate + reservations), so with the v1 estimates (5% of a 5h
   window, 1% of a week) a new task is refused from ~85% current in 5h and ~89% in 7d; and a window that resets within 15 min counts as empty for the
   filter, since a task started then runs almost entirely after the reset.
5. **`needs-input` escalation** after 30 min (`needsInputEscalateMs`, built with M3 item 5):
   re-alert once, keep the slot, never kill. Until M4's Web Push the re-alert is the record's
   `escalated` and a leader log line.
6. **Disk is a floor, not a load.** Under 1 GiB free (`status.free`) filters the machine out;
   above it disk adds nothing to the score. A fill level says how much upkeep a machine needs,
   not how busy it is — scored, an 85%-full idle disk would read as 85% busy and push work off
   it. The same series feeds M4's health alert and the Machines screen's Disk gauge.
7. **No age cap on a quota reading** beyond the reset rule. The 5h window bounds itself — a
   reading older than 5h is past its reset and reads 0% — so only the 7d window can drift, and
   only through use the fleet does not see. Fleet accounts are used almost only inside the
   fleet (the owner, 2026-10-16); the rare cloud session is a blip the next
   `/usage` refresh (M4) overwrites. A cap would fail every time a machine sleeps past it, and on the
   account with the most headroom; no cap fails only on unseen use, for one dispatch, until the
   next reading corrects it — the `/usage` refresh a session's events or the minute timer
   trigger (M4; before it, the session's own `rate_limits` report). Revisit with a 7d-only cap (~24h) if
   out-of-fleet use becomes routine.
8. **Score weights and the rest of `SchedulerConfig`** (set with the library, 2026-10-16;
   `scheduler/src/config.ts` is the copy that runs): weights account 1, machine 4,
   dependency 4, queue 1; sticky bonus 2; per-task estimate 5% of a 5h window and 1% of a
   weekly (all-models or per-model); global max 8 in-flight tasks; a reservation's TTL 120 s
   (`reservationTtlMs`, twice the replay window, so a spawn that ever runs has begun by half of it). The estimate is per span
   (owner, 2026-10-18): one number for both added a task's 5h share to every week, so a
   standard seat (then ×6.25, item 17) at 41% weekly with one task in flight projected 104% and
   scored ~8000× worse than any other account. 1% is a guess at a week's share; tune both
   from observed deltas. Account pressure is the convex cost (1 at 50%, 16 at 80%) while the other three
   are fractions or counts, so the weights put one busy machine, or the farthest base, on
   the scale of an account near 70%. First guesses, to tune from decision records; nothing
   observed yet argues for them. **Per-account max 4** in-flight tasks (`accountMax`, added
   with M3 item 5, 2026-10-17): half the global max, so one account cannot take every slot,
   and an account's parallel sessions draw on its 5h window together — at the 5% estimate, four
   already project +20%. A fleet on one account therefore runs at most four `auto` tasks at
   once; raise it here if that bites.
9. **An unreported `free` is not under the disk floor.** The floor guards a disk known to
   be full; read as unknown-therefore-filtered, a host with no statfs answer would never
   get work. Unlike quota, nothing about a missing disk reading makes it the risky choice.
10. **A running task is `lost` after 15 min absent** (`lostAfterMs`, set with item 6,
    2026-10-16). Long enough that a laptop lid closed for a coffee does not flip its task, short
    enough that a forgotten machine's task stops reading `running` the same session. Recoverable
    either way: the machine's own `sessions` settles it when it returns, so a short bound costs a
    label, never a twin.
11. **Task records stay small** (owner, 2026-10-17): a task prompt is at most 8,192 characters
    (`TASK_REQUEST_LIMITS.prompt`), a record's ciphertext 40 KiB (`STORE_MAX_CT_LENGTH`) and a
    create's 28 KiB (`STORE_CREATE_MAX_CT_LENGTH`), and `task:` holds 128 (`MAX_TASKS`), so the
    whole queue lists in one frame with no paging (checked in production 2026-10-18, and in headless Chromium and Firefox 2026-10-18 with a 5.13 MB
    frame intact; WKWebView open; DESIGN.md "The store", Send size). A task names its work ("implement this
    Linear issue, and here are the details") and the session gathers the rest with tools; 8K
    characters is far more than that takes. A direct spawn is not bound by it. Raised from 32 KiB
    on 2026-10-17 (the M2 review), so a full create leaves the leader room for its own fields;
    the measurements are DESIGN.md's (_Scheduler_, "The store", "Versions").
12. **Running tasks are checked against their machines every 2 min** (`sweepIntervalMs`, set
    with the M2 review, 2026-10-17): the backstop for an `ended` event that never arrived,
    whose task would otherwise hold its slot for good; `awaiting-merge` tasks ride the same
    sweep, for a merge event that never arrived. One `sessions` per connected machine
    holding running or `awaiting-merge` tasks, shared with the pass's other checks; a lost event costs at most
    two minutes of a slot, where a sweep every pass would cost a call per busy machine per
    status beat.
13. **Fifty finished tasks are kept** (`keepFinished`, set with M3 item 4a, 2026-10-17; M2's
    leader kept the same number as `KEEP_FINISHED`): enough for `queue` to show recent
    history, and with M2's 64 unfinished at most still under `MAX_TASKS` (128). Pruned oldest
    first (ties by id), never one an unfinished task names. A pass or takeover prunes only at
    `pruneAt` (96) records, which narrows the window in which a finished task an app is about to
    name in `deps` is gone before the leader hears of the create; it does not close it. M2's leader
    also pruned on every submit, bypassing `pruneAt`, until 2026-10-18.
14. **A task `lost` over 7 days fails `lost_expired`** (`lostExpiryMs`, set 2026-10-18, owner).
    Why: never pruned, it counted toward `MAX_TASKS` and persisted across terms. It ages
    from `absentSince`, else `createdAt`. A task whose machine is connected is left to its own
    `sessions` check. Cost: a machine asleep past it may still run the session, untracked
    (DESIGN.md "Expiry").
15. **A task `awaiting-merge` over 7 days fails `merge_expired`** (`mergeExpiryMs`, set
    2026-10-18, owner). It ages from `endedAt`, or `createdAt` on older records. Its
    `after: "merged"` dependents fail with it. Seven days is the launch ledger's own age bound:
    past it no machine can report the merge, and a `here` task's merge is never read back, so
    it needs mark-done before then.
16. **A finished task keeps no prompt** (owner, 2026-10-18). The leader drops it on the write
    that finishes the task (`forgetPrompt` in `#update`), and strips finished records that still
    hold one in its next passes (`#forgetPrompts`, 8 a pass). Nothing keeps a finished
    prompt: the transcript on the machine is the copy from when the task ran, and a task that
    never ran (cancelled or marked done while waiting, expired, a failed dependency, a spawn
    refused before launch) has none. Slugs derived from it (window, branch) stay as labels
    (DESIGN.md, Scheduler, "The library").
17. **Seats differ, so a percentage does not compare across them** (owner, 2026-10-18). A Team
    premium seat (`seatTier` `team_tier_1`) has 5× a standard seat's (`team_standard`)
    limits (Anthropic's Team plan page; 6.25× is premium against an individual Pro seat, until
    2026-10-19 misread as against standard, which is itself 1.25× Pro), and only premium covers Fable from quota; on standard Fable is billed to credits.
    So a Fable task never goes to a seat that doesn't include it — `model_not_included`, a hard
    filter that extra usage does not spill past — and the per-task estimate (8) is scaled by
    the seat's `capacity`: 5% / 1% (5h / 7d) on premium, 25% / 5% on standard, which keeps heavy work off the
    small seat through the existing line and score, with no task-size field. Premium's own
    Fable allowance is not modelled separately; its `7d Fable` window is what routing reads,
    and only for Fable tasks — a full Fable week leaves other models' work free.
    The table is `seats` in `scheduler/src/config.ts`, keyed by the tier string the daemon
    reads from `.claude.json` — mapped, not set per account, so it needs no account records
    (M4). A tier the table doesn't name, or none (an older daemon, a non-Team account), keeps
    today's estimate but includes no gated model: an unknown seat may bill Fable to credits.

## Risks / unknowns

- **Bearer-token blast radius grows, by one act.** Today a token holder can register junk and
  delete registry entries, which DESIGN.md calls harmless because the daemon rebuilds them.
  Queued tasks are not rebuilt: a token holder can list the queue (ciphertext) and create junk
  (the leader skips what doesn't decrypt, as the PWA does for the registry). It still cannot
  read a prompt, forge a task, roll one back (version binding), or replay a deleted one
  (tombstones and the 30-day admit rule, M3 item 0). Accepted: what is lost is a
  pointer to work, never the work or the repo it lives in; the remedy is the one that already
  exists (rotate) — which stops new junk but clears none: junk stays until removed by hand, and
  a full `task:` refuses every enqueue until a person clears the unreadable records from the Queue screen (`discard`; DESIGN.md Threat model, item 3, M3 review S2). DESIGN.md's "destroys nothing that exists" paragraph has this caveat since
  M3 item 1 landed (2026-10-17): the token cannot delete a task, only add junk within the caps.
  M4's account records add a smaller one: being app-writable, a token holder can delete an
  alias or overwrite it with junk that readers skip — but not read, forge or roll one back. Under
  today's tombstones a delete blocks that alias for 30 days rather than being retyped in a second
  (M4, _Account records_). Holding the leader's term would be a larger act — next item.
- **Leader capture** (decided 2026-10-16, M2 and M3's gate; built). A bearer-token holder could
  mint a capable id and outlast a real leader's socket. The relay now nominates only
  `SCHEDULER_LEADERS`, a Worker secret, and apps believe a nominee only with its `lead-proof`. The
  record, rejected options and what remains (the allowlist's own trust, a listed machine's
  stolen seed) are DESIGN.md _Scheduler_, "Leadership", and _Threat model_, item 3.

- **Prompts at rest on Cloudflare.** Sealed under the PSK like `info`, and ciphertext length is
  unpadded, so the relay bounds prompt length — the same concession as live frames. At rest
  only while the task is unfinished (Settled defaults 16).
- **`/usage` is Claude Code's behaviour, not a contract.** The 60s debounce, the cache shape,
  the zero cost and the `--safe-mode` flag were read off 2.1.304 (2026-10-20); an update can move
  any of them. The cache file staying the result is what keeps a change visible: a refresh that
  stops moving `fetchedAtMs` logs, and the reading ages into the reset floor rather than lying.
  Its memory (~350 MiB a run) is the other cost, bounded by one spawn at a time and the
  staleness check. Each refresh is also a full Claude Code process that writes the exclave's
  `.claude.json` alongside live sessions, so it inherits Claude Code's own concurrent-writer
  behaviour for that file.
- **Session `rate_limits` cadence** — retired with the source (2026-10-20): the `/usage`
  refresh's timer covers an exclave no session is active in.
- **Stacked rebases**: when A changes in review, B's branch drifts. v1 does nothing
  automatic; the dependent's preamble names the base so the session can rebase.
- **Leader churn is mostly deploys** (looked at 2026-10-16, M2's gap 2). Term 31 within ~6h of
  leadership landing (13:57Z). The term bumps on every leader change, every new socket of the
  leader, and every move to or from no leader, so a relay deploy — which drops every socket —
  costs about two terms, and each merge's self-update restarts every daemon, the leader among
  them. That day had seven relay deploys after 13:57Z (CI deploys the relay on any `shared/`
  change, which most M2 PRs touched), and the MacBook's socket also dropped on sleep and network
  changes (`pong deadline missed`, close 1006), handing the role to Thad or WSL by design
  (stickiness holds only across a reconnect the relay sees before the old close). No nomination
  or socket bug found. It matters from M3: every change is a takeover — a full store list, plus
  one `sessions` read per machine with an in-flight task — so churn costs reads, never tasks.
  Revisit if terms keep climbing on a quiet day: the relay logs every change as
  `scheduler term=<n> leader=<id|none>`, kept by Workers observability, so a day's history is in
  the dashboard without `wrangler tail`.
- **Daemons on old versions** report no `exclaves`/`origin`/`taskId`. The scheduler treats
  such a machine as ineligible for `auto` (it can't know which account a spawn would bill,
  and can't dedupe a re-dispatch), while direct spawns to it keep working. Self-update makes
  this a short window.
- **Reversibility is only as real as the adapter boundary.** If daemon code starts reaching into
  `scheduler/` internals, or the library grows an import from `daemon/`, the move to a fixed
  box becomes the rewrite this design exists to avoid. Enforced the way `raycast/` enforces
  its layering: `scheduler/test/layering.test.ts` fails on either import direction, and proves
  its detector catches each.
