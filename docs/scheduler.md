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
| Done signal       | Layered: PR merged (leader, forge: GitHub via `gh`) / PR merged (daemon, local git) / Linear Done → session ended → manual                                                                                                                                                                                                                                                                  |
| Quota exhausted   | Spill into credits, loudly (Web Push), with pause: until resume / until next reset                                                                                                                                                                                                                                                                                                          |
| Concurrency       | Global max, per-account max; a batch is a group with no bound or order (2026-10-26); asleep or idle-at-prompt tasks hold no slot past a grace (18, 20); `run-now` lifts both for one task (2026-10-27)                                                                                                                                                                                      |
| Alerts            | Web Push (VAPID) from the leader to subscribed PWAs (M4; key sealed in the DO, see _Secrets_)                                                                                                                                                                                                                                                                                               |
| Needs input       | `needs-input` state, alert, keeps its slot; idle timeout escalates, never kills                                                                                                                                                                                                                                                                                                             |
| Event ingest      | New ingest-only `session-event` frame kind on the local socket, after the fleet broker's precedent (threat-model widening, recorded)                                                                                                                                                                                                                                                        |
| Proxmox           | Machine pressure = the container's own cgroup and PSI view, read by the LXC daemon and folded into its own `status`; no Proxmox API or token (decided 2026-10-20, M4 #17)                                                                                                                                                                                                                   |
| Telemetry         | Current snapshot (pressure + latest quota) rides the relay as a sealed `status` frame held on the daemon's socket attachment and pushed to apps + the leader; the relay keeps the last one with the registry entry when the socket goes (M2), so quota outlives a sleeping observer. History stays on each daemon behind a `metrics` op; neither the relay nor the scheduler stores history |
| At rest           | The queue is sealed envelopes in DO storage: the relay holds id, version and ciphertext, nothing else. No second at-rest scheme                                                                                                                                                                                                                                                             |
| Skills            | Hard filter on a declared skill or any `/name` token in the prompt that the fleet's inventory knows (unknown names pass); project skills count only from the task's own repo; PWA autocompletes from it                                                                                                                                                                                     |
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
  prefix, applied by the relay; store rules v2 (M4 wave 0, below) put every policy on the
  prefix's `STORE_PREFIXES` entry and added M4's prefixes:

  | Prefix            | Create                         | Overwrite                            | Delete      | Term-fenced | Cap | Lands |
  | ----------------- | ------------------------------ | ------------------------------------ | ----------- | ----------- | --- | ----- |
  | `task:<id>`       | any app                        | leader only                          | leader only | yes         | 128 | M3    |
  | `queue:pause`     | leader only                    | leader only                          | never       | yes         | 1   | M3    |
  | `settings:<name>` | leader only                    | leader only                          | never       | yes         | 8   | M4    |
  | `account:<hmac>`  | any app, any registered daemon | any app, any registered daemon (CAS) | never       | no          | 64  | M4    |
  | `quota:fleet`     | any registered daemon          | any registered daemon (CAS)          | never       | no          | 1   | M4    |

  Only `task:` tombstones. App-writable records exist for state a person edits from any client
  with no leader up — an account's alias first. Push subscriptions still need a prefix of their
  own, decided with Settings and Web Push, within the 54 records the caps leave of
  `MAX_RECORDS`.

- **Version binding** — the reader's rules (`bindTaskRecord`) are DESIGN.md _Scheduler_, "Task
  records and the app's store leg". They close rollback against a token holder, not the relay
  (DESIGN.md Threat model, item 4).
- **Stored blobs are an at-rest format, not live frames.** M4's `account`, `quota` and
  `settings` ops and record types are in `AT_REST_OPS` (DESIGN.md _Security model_). The
  `account` record is sealed to `"app"` and, like `task` and `pause-state`, opened only through
  `openAtRest` (`openAccountRecord`, `shared/src/account-record.ts`), never on a live routing path.
- **Daemon → scheduler** (M2, M3): `session-event` and `branch-state`, and the `sessions`
  reply's `ended` and `progress` that back them up, are DESIGN.md Local op socket ("Session
  events") and _Scheduler_ ("Branch state", "Done detection"). M4's exit status is
  `TaskProgress.exit`, acted on by `failed` from exit status (M4 below, **Done**; DESIGN.md
  _Daemon_, "Exit status").
- **`SpawnRequest.baseBranch?`**, `base_not_found` and the `"baseBranch"` capability are in the
  schema (DESIGN.md _Wire protocol_, Layer 2, `spawn`). Still to build (Stacking, below): the
  base fetched before launch as the default branch is (`base-fetch.ts`), so a stacked task never
  starts from a stale `origin/<b>`, and how the worktree gets made.
- **App → scheduler ops**: DESIGN.md _Wire protocol_, Layer 2, `push-subscribe` included (typed,
  not in `SCHEDULER_OPS` yet). `enqueue` stays a `store-put`, never a leader op.

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

- Filters (the per-account cap and `skill_absent` are DESIGN.md "Routing caps" and "Skills
  filter"; the per-batch bound M3 built went 2026-10-26, "Batches"): stacked base unpushed and not on this exclave (M4,
  _Stacking_); auth expired (M4, _Auth health_).
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

**Done detection, ahead.** The forge is built: the leader reads each GitHub PR with its own `gh` and settles a merge (DESIGN.md, "PR status"). Linear Done (M4, if linked, polled). A session that ends with no PR
and a nonzero exit is `failed` since M4's _`failed` from exit status_, which fails its
dependents; a PR-less end with a clean or unknown exit is still `done` by `session`.

**Secrets (M4).** The first draft gave a fixed box a Linear key, a VAPID key and a Proxmox
token. Under a moving leader there is no Proxmox token at all (M4 #17: the LXC daemons read
only their own container); the VAPID keypair and Linear key live in the store (`settings`),
opened by whichever daemon leads — the PSK is already the only trust boundary, so sealing them
under it adds no second one. The leader alone writes `settings`, and every PSK holder can read
it (Settings and Web Push, below, #9). Linear polling is optional from day one, since the leader's forge read and daemon-local merge detection are the
primary done signals.

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
gets no `auto` work until a reading lands: M4's `/usage` refresh timer (`daemon/src/usage-refresh.ts`)
gives every signed-in exclave one once its cache is stale, with no session needed.
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
- Stacking and Linear need an authoring surface. Built (wave 1, 2026-10-23): MCP and the PWA
  write `deps`, `batch` and `linear` (below).
- The disk and auth alerts need Web Push.

Each item still lands as its own PR with its own DESIGN.md subsection. Budget one follow-up PR per
item: every M3 item needed one within hours.

**Every _Decided_ entry below was settled by the owner on 2026-10-20** (the M3 review's R8). Each
started as the review's recommendation; where the owner chose otherwise, the entry says so. The
numbers (#) are the review's owner-decision list; #7 and #13 lapsed with the OAuth poll, #1, #2
and #20 were settled earlier, and #21 was added in the same session. #22 (junk under `account:`,
found after store rules v2 landed) is still open.

**Order.** Wave 0 settles the seams the items share. Wave 1 is the items nothing else in M4 has to
precede. Wave 2 waits on the wave-1 item named. _Later_ is deferred by the owner (2026-10-25),
not blocked: nothing in M4 waits on it, and whether it is built at all is decided once the rest
of M4 has landed.

| Wave  | Item                                                               | Depends on                                                             | Size                     |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------ |
| 0     | Store rules v2 (relay) — **Done**                                  | the review's S4 store bounds; #29                                      | —                        |
| 0     | One schema PR for every M4 shape — **Done**                        | the owner's calls below                                                | —                        |
| 0     | Daemon seams and test infrastructure — **Done**                    | the review's splits of `scheduler.ts`, the PWA store and MCP's enqueue | —                        |
| 0     | #28 (the seed prompt on stdin) and #29 (relay security) — **Done** | —                                                                      | —                        |
| 1     | Authoring surface (new) — **Done**                                 | —                                                                      | M                        |
| 1     | Settings and Web Push, in three PRs                                | store rules v2; the fetch seam                                         | L                        |
| 1     | `/usage` refresh (was: OAuth quota poll) — **Done** (PR #249)      | — (spiked 2026-10-20)                                                  | S–M                      |
| 1     | Skills filter — **Done**                                           | —                                                                      | S; M with project skills |
| 1     | Account records — **Done**                                         | store rules v2                                                         | M                        |
| 1     | Fleet quota record — **Done**                                      | store rules v2                                                         | M                        |
| 1     | CLI `auto` — **Done**                                              | MCP's enqueue split out                                                | S–M                      |
| 1     | `failed` from exit status (new) — **Done**                         | —                                                                      | S–M                      |
| 1     | Asleep machines on the Queue screen (new) — **Done**               | —                                                                      | S                        |
| 2     | Spawn defaults to the scheduler (**Done**)                         | account pins (PR #303); keyless `auto` for MCP (**Done**)              | M–L                      |
| 2     | Stacking                                                           | authoring surface; #28                                                 | L                        |
| 2     | Auth health                                                        | `/usage` refresh; Web Push for its alert                               | M                        |
| 2     | Linear                                                             | settings; authoring surface                                            | L                        |
| Later | LXC pressure view (was: Proxmox node view)                         | —                                                                      | S                        |
| Later | Proxmox node view (follow-up)                                      | LXC pressure view; reopens #17                                         | M                        |

**Wave 0.** Owned by the review's relay and daemon sessions, not planned here in full:

- **Store rules v2** — **Done**, one relay PR before any new prefix:
  - a per-prefix tombstone flag, off for deterministic keys;
  - per-prefix caps sized so caps plus singletons fit `MAX_RECORDS`;
  - a delete policy per prefix;
  - the write floor (creates, and overwrites where the term fence does not cover them) on the
    daemon leg for any prefix that is not term-fenced, with store frames handled only after
    register;
  - singleton prefixes (`queue:`, `quota:`) accept one key (`queue:pause`, `quota:fleet`), so a
    cap of one cannot be squatted;
  - `store-changed` fanned out to apps for app-writable prefixes (today it reaches only the
    leader);
  - the new prefixes.

  M4's first app-side `store-list` (`account:` on open) means any `store-list` rate bucket must be
  per prefix, or it throttles that list against takeover.

  _As built (2026-10-20):_ each `STORE_PREFIXES` rule carries `appCreate`, `appWrite`,
  `termFenced`, `daemonCreate`, `deletes` (`leader` | `never`), `tombstone` and `cap`, and
  `relay/src/store.ts` names no prefix. New prefixes `settings:` (leader only, #9), `account:`
  (apps and registered daemons, #14) and `quota:` (registered daemons); deletes refused on all but
  `task:` (#8). Caps: 128 / 1 / 8 / 64 / 1 (`task:`, `queue:`, `settings:`, `account:`,
  `quota:`), 202 of 256. Store frames on `/daemon` before an accepted register are
  `forbidden`, reads included. `store-changed` goes to the leader for any write its term socket
  did not make, and to other apps for `account:` writes, which the PWA's account store re-reads
  on. Both list floors are per prefix, and the bucket's refill moved 4 s → 8 s so
  every prefix listed full stays about half the free daily reads. The ciphertext caps were
  already measured in bytes on the relay since #29; nothing else enforces them on untrusted
  input. Residual: with deletes refused, a token holder's junk under `account:` or `quota:` holds
  its slots until an operator edits the DO's storage (DESIGN.md Threat model, item 3).
  DESIGN.md _Scheduler_, "The store", is the record.

- **One schema PR**, every M4 shape in `types.ts` and `parse.ts` at once. **Done** 2026-10-20;
  DESIGN.md _Wire protocol_ ("M4's shapes landed ahead of their items") records each shape and
  what an older peer does with it. Where it differs from the sketch here:
  - the stacked base's branch is not a `TaskSpec` field: decided #4 makes it the predecessor's
    own `Task.branch`, so `TaskSpec.base` stays a placement and the leader holds that branch to
    `isBranchName` before it sends `baseBranch`;
  - the exit status rides `TaskProgress.exit` (the `sessions` reply's `progress` and the launch
    ledger), not `ended` or the session event, whose hook runs before the pane dies;
  - auth in `MachineStatus` is `ax`, the expired exclaves' indices, never trimmed;
  - `push-subscribe` is typed and parsed but not in `SCHEDULER_OPS`; a leader answers it
    `invalid_request` until the Web Push PR adds its handler and `OP_TIMEOUT_MS` entry;
  - push subscriptions, the VAPID key pair and the Linear key are one `settings` record.

  Store rules v2, above, accepts the prefixes.

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

- **Authoring surface (new, M3 review R3) — Done (2026-10-23).** MCP and PWA fields for `deps`,
  `batch` and a Linear link. The library, the record and the leader supported all three, and the
  app client bounds a batch index at `createTask`; this item is the clients that write them. MCP:
  `spawn_session`'s `after`, `until`, `linear`, `pin` (a machine, an account or both — the M2
  placement restriction; added 2026-10-23, the account form replacing the exclave one 2026-10-25)
  and `avoid` (machines to keep it off), and `queue_batch`; `seanced spawn` takes the
  same placement as `--machine`, `--account` and `--not` (DESIGN.md "`pin` and `avoid` on a spawn"). PWA: the
  auto form's AFTER and BATCH tiles, the settle-on-report switch and the Linear field, and Follow
  up on queue rows. DESIGN.md records both ("MCP server", "PWA"). Exit, met in `e2e/authoring.test.ts`: a task enqueued from MCP
  and from the PWA with an `after: opened` dep and a batch is stored with both and held `blocked`
  until its predecessor is done.
  Linear's own relations are not read yet: that is the Linear item below.
  - _Decided (#21), done by self-report:_ a task can stay open past its merge until its own
    session says it is done — "after X is in prod" is X's session merging, watching the deploy
    and then reporting. Three shapes, all in the schema PR:
    - a `done` session-event state, bound to the sender's pane by peer pid like every session
      event, so a session can finish only its own task;
    - a per-task `until: "merged" | "reported"` (default `merged`). Under `reported` a merge is
      recorded but does not settle the task; its session's `done` report, `mark-done`, Linear Done, or a session ending clean with no PR does;
    - `after: "done"` beside `opened` and `merged`, released by the predecessor's `done`
      whatever settled it.

    The authoring surface writes all three, and a client writes `until` or a `done` edge only
    to a leader advertising `CAPABILITIES.reportedDone`. It is the first act session events
    gain beyond ingest, so it is a threat-model change: DESIGN.md records it (_Local op socket_,
    "Session events", and _Threat model_). The daemon notes the report in its launch ledger and
    forwards it whatever the task's `until`; the leader settles only a `reported` task, from the
    machine it was placed on, and ignores it otherwise. The slot is freed at the report while the
    session may still run, and a session that cannot call the tool (a permission prompt, plan
    mode) is settled by `mark-done`. A session that lies about being done can do no more than one
    that exits. `mark-done` stays the manual override.
- **`failed` from exit status (new, M3 review R3).** Today a session that crashes with no PR
  settles `done` by `session`, and `done` releases every edge (`released` in
  `scheduler/src/deps.ts`). Under stacking its dependents would start on a branch with nothing
  pushed. The daemon already sets `remain-on-exit` on a spawned window, so `pane_dead_status` is a
  cheap source. Carry it in the launch ledger or in `ended`, so the event path and the sweep
  agree. Exit: a session that exits nonzero with no PR is `failed` and fails its dependents; one
  that exits zero is `done` (scheduler + daemon).

  _As built (2026-10-21):_ **Done.** The premise was half right: `remain-on-exit` was on only
  while a spawn waited for registration, then off, so a registered session's pane closed with its
  status. A task window now keeps `remain-on-exit failed`; the status rides the ledger and
  `progress` (`TaskProgress.exit`), noted before the dead pane is closed by every `sessions`
  reply. The leader settles a PR-less `ended` from a machine advertising `exitStatus` by that
  machine's next answer, asked at once and then every pass until the session is gone (at most
  `endingTimeoutMs`, 5 min, then it settles as if no exit were known — once a check out has
  answered and a read begun after it still lists the session; a machine that is not connected
  settles on the deadline alone, never `lost` at the defaults), so the event path and the sweep are one path; a nonzero exit (a signal death as `128 + signal`) fails the task `session_failed`. DESIGN.md, _Daemon_, "Exit
  status", records the rest and what was rejected. _Follow-up (2026-10-26):_ the failure carries
  the status as `failure.exit`, so the PWA and `get_queue` say how the session ended — "killed
  (SIGKILL), possibly out of memory" for 137, a signal's name for the others macOS and Linux number
  alike ("ended on SIGTERM (status 143)": only SIGKILL claims a kill), "exited with status N" otherwise —
  instead of "exited with an error". Under `until: "reported"` it says "did not report done" for "reported no pull request".
  _Follow-up (2026-10-26):_ on Linux with cgroup v2 the daemon checks a 137 against the
  kernel's `oom_kill` count for the session's own cgroup, sampled while it lived, and the failure
  carries the verdict as `failure.oomKill`: "out of memory (the kernel's OOM killer fired as it
  died)" (only when sampled and judged within ten minutes of the death) or "not by the kernel's
  OOM killer" in place of "possibly out of memory", which stays for macOS, an unreadable or
  vanished cgroup (a per-pane tmux scope), a rise with a stale sample or a late check, another pane's
  sample, and older daemons.
  DESIGN.md, _Daemon_, "Exit status", records what the count proves on a shared cgroup.

  _Open gaps (follow-up, not yet planned):_
  - The deadline and disconnect settles call `ended(task, undefined)`, so a PR the daemon noted
    in the ledger (`progress.prUrl`) but the leader never recorded settles `done` by `session`,
    not `awaiting-merge`, and releases `after: "merged"` dependents early. Same blindness the
    event path had before; narrower now. Fix direction: settle from the machine's last
    `progress` entry where one was read.
  - A spawn that times out before claude registers and then dies untitled gets no status
    (harvest takes only titled panes; reap closes it), so its task settles `done` as before.

- **Continue a failed task (new, 2026-10-26; widened 2026-10-27).** A task that failed `session_failed` (an OOM
  kill) leaves its worktree and its conversation on disk, and the only remedy was a new task from
  scratch. A **Continue** action queues a new task that resumes the conversation (`claude --continue`)
  in the same worktree.
  - _Decided:_ a new task linked by `TaskSpec.continues { task, at }` (the old task stays `failed`,
    and its dependents stay failed); a new mode value `"continue"` as the forward-compat gate (an
    older leader's parser refuses it, so the record is held unreadable instead of spawned as a fresh
    worktree); exact-target routing (only the `(deviceId, exclave, clone)` of the old assignment, only on
    a daemon advertising `continueTask`); the cwd resolved from the daemon's own launch ledger, never from
    the wire; a spawn sealed by the scheduler only (the local socket and every other `from` refused
    `not_continuable`); a brokered enqueue allowed, so keyless `seanced mcp` works; a CLI,
    `seanced continue <task-id> [--prompt …]`, that enqueues through the scheduler (a hand-run
    `claude --continue` is untracked by design); a stale worktree lock in Claude's own
    `claude session … (pid N start …)` form with a dead pid unlocked, any other lock refused; manual only, for
    `session_failed` alone (not `here` runs, not an automatic continue after an OOM kill). Surfaces: the
    PWA's failed card, MCP's `continue_task`, the CLI.
  - _Follow-up (2026-10-27), landed:_ a `ready` continuation expires `continue_expired` after 4 days, a task
    cancelled after placement is continuable (`continueCancelled`), the offer moves to the newest landed
    continuation and the daemon refuses an older task whose worktree a later launch noted, and the seed is
    worded from the old note's exit.
  - _As built:_ DESIGN.md, _Daemon_, "Continuing a session", records it and what was rejected.

- **Asleep machines on the Queue screen (new, 2026-10-26) — Done.** A task placed on a MacBook whose
  lid closes keeps reading "It's waiting for input on MacBook M4 Pro · default" until
  `lostAfterMs`, then "Lost on … — its machine went away 16m ago" under _Needs you_, though
  nothing is lost and nothing can be answered: the machine is asleep. Decided with the design
  session of 2026-10-26; lands as one PWA PR, and DESIGN.md _PWA_, "The Queue screen", takes it
  over.
  - _Decided, a derived view, not a state:_ the leader's states stay as they are (`lost` after
    15 min, Settled defaults 10). The PWA derives "asleep" per row from the task's machine: a
    `reserved`, `running`, `needs-input` or `lost` task whose assigned (or reserved) machine is
    listed and not `connected` says so in its headline — "It's waiting for input on MacBook M4
    Pro · default — its machine went to sleep 14m ago" (`running`: "It's running …",
    `reserved`: "Starting …", each with the same clause; `formatSeen` words the age, as the
    `lost` line does today). A `lost` task on such a machine is headlined "Asleep on MacBook M4
    Pro · default — its machine went to sleep 22m ago", with the body "Settles when its machine
    wakes; cancel or mark done to give up on it" — the leader's `lost` is that very judgement,
    and its one remedy from the phone is giving up. "Lost" stays for a `lost` task whose machine
    is listed and `connected` — "Lost on … — its machine is back but hasn't answered for it
    yet", true both of a machine genuinely back (its next `sessions` pass settles the task) and
    of a dark wake's zombie socket (a failed delivery re-marks it within seconds) — and for one
    whose machine is no longer in the registry, which keeps today's wording from `absentSince`.
    `awaiting-merge` carries no clause: the leader reads the merge with its own `gh`. Rejected: a
    new task state, or a per-pass `absentSince` on running tasks — a store write per absent task
    per pass, for a label, where the leader's absence clock is in memory by design (DESIGN.md
    "`lost`"); a PWA-side hysteresis on `connected` — per device and per reload, it delays the
    truth for the person who just opened the lid while the Machines screen beside it has already
    flipped.
  - _Decided, the signal:_ `Machine.connected` as the PWA's own `RelayClient` derives it (the
    relay's live-socket flag, overridden by this client's proven-offline marks) — the signal the
    Machines card's "asleep" already reads, never the relay flag alone. Why: `connected` is held
    per app-role client, and a client's marks come only from its own failed deliveries, so the
    leader, the daemon's broker (`list_machines`) and the PWA can disagree for minutes (DESIGN.md
    _Presence & identity_, "Every app-role client holds its own marks"). The leader's
    `#connectedIds` is not on the wire, exporting it is a per-pass write, and the PWA's own view
    is the one that agrees with the rest of its screen. Accepted: a dark wake — the Mac
    registering, or sending one `status` beat, and sleeping again; measured 2026-10-26 at
    14:04:48 and 14:21:45 UTC — clears every reader's mark, so the clause disappears for the
    moments until a delivery fails (the leader: ≤ 10 s) or the sweep closes the zombie socket
    (≤ ~2.5 min); the Machines card flickers identically, and the fix for that is not in the
    PWA.
  - _Decided, "since":_ when the machine was last heard from — `lastHeardAt(machine)`, the later
    of `lastSeen` and the kept `status.at` (`shared/src/status-reader.ts`, beside `liveStatus`),
    shared by the Queue card, the Machines card's "asleep · last seen" and the machine picker's
    "offline · last seen". The sweep stamps `lastSeen` with the last heartbeat, so once the
    socket is closed it is within one beat of the sleep; but while the relay still lists a slept
    socket — the window a proven-offline mark exists for — `lastSeen` is the register's time,
    hours or days old on a machine that was simply up, and today's card says "last seen 3d ago"
    of a machine that slept three minutes ago. The daemon's `status` beat, kept with the entry
    when the socket goes, is at most a beat older than the sleep in both windows. Not
    `absentSince`: the leader's clock starts a pass after its own view flipped (minutes after
    the sleep), exists only on `lost`, and reading it for one state and `lastSeen` for another
    makes the same card change its mind at the 15-minute mark.
  - _Decided, Needs you:_ an asleep task stays in _Needs you_ — opening the lid is the action,
    and "Running" would read as progress — ranked after what can be answered from the phone now:
    escalated and live, `needs-input` and live, `needs-input` on an asleep machine, then `lost`.
    Rejected: an "Asleep" section — sleep is the machine's property, shown on the Machines
    screen, and a section that empties the moment the lid opens moves every row mid-glance. The
    header's attention dot and the row's dot are unchanged, and so is `get_queue`: it lists raw
    `state` and placement, and a model reads `connected` from `list_machines`.
    _Reversed after use (2026-10-26):_ ranked low in Needs you, an asleep row still read as
    something to answer now. Asleep tasks now get their own collapsed "Asleep" section below
    Waiting, and leave the running count and the attention dot.

  _As built (2026-10-26):_ **Done**, in two PWA changes: #316 built `lastHeardAt` beside
  `liveStatus`, `machineAsleep` and the headlines in `pwa/src/decision-view.ts`, the body and
  ranks in `pwa/src/queue-view.ts`; the follow-up replaced the ranks with the collapsed Asleep
  section (`queue-view.ts`, `components/queue.tsx`) and `needsAttention`. DESIGN.md _PWA_,
  "Asleep machines on the Queue screen", is the record.

- **"Last seen" off the PWA (new, 2026-10-26) — Done.** Raycast's cached-list age and every
  `seanced mcp` "last seen" (`list_machines`' `lastSeen`, the despawn not-connected refusal,
  `auto`'s offline-pin note) still read the register's `lastSeen`, so they said "3d ago" of a
  machine that slept minutes ago. Exit: they read `lastHeardAt` like the PWA.

  _As built (2026-10-26):_ **Done.** `daemon/src/mcp.ts` and `auto.ts` format `lastHeardAt`;
  `list_machines` keeps the `lastSeen` key, its value now the heard time (the tool description
  says so). The brokered path carries `status` (`parseMachines`), so it agrees. Raycast's
  `PickerMachine` takes the live `status`, and the registry cache folds `lastHeardAt` into its
  existing `lastSeen` key rather than storing `status`, so an older cached entry still parses.

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

- **Skills — Done (2026-10-25).** Hard filter on a declared skill or any `/name` token the
  inventory knows, project skills (`<repo>/.claude/skills/`) on `RepoEntry` checked clone ×
  skill, unknown names passing (#19, revised 2026-10-25: any `/name` token counts, and prompt
  detection stays beside a declared skill; every known token is required); recorded in DESIGN.md, _Scheduler_ "Skills filter" and
  _Daemon_ "Exclaves". The autocomplete landed first (PR #167; DESIGN.md, PWA). Still out:
  plugin skills (`plugin:name`) and legacy `commands/*.md`, which pass as unknown names.
  _Decided (#20):_ #128 (penalise the default exclave's account) is parked, to be redone as a
  flag on the account record once those land.
- **LXC pressure view** (was: Proxmox node view; S, was M–L) — read by the LXC daemons, folded
  into their own `status`. An injectable `HostProbe` reaches telemetry through `startDaemon`;
  missing are the cgroup and PSI readers, each one more `TELEMETRY_COLLECTORS` entry.
  _Decided (#17):_ no Proxmox API and no token — only what the container itself sees (its cgroup
  limits and PSI). The review proposed a read-only PVEAuditor token with a pinned certificate;
  the owner chose to hold no Proxmox credential at all, at the cost of a node-wide view:
  pressure from neighbouring containers is invisible except as this one's PSI.
  - _Deferred (2026-10-25)_ to the end of M4, with the node view below. The owner has not
    decided whether to build it at all; that is decided then.
  - Keep its `status` fields container-scoped (this container's limit, usage, PSI), never named
    as the host's, so a node view lands beside them instead of repurposing them under older
    daemons.
  - _Follow-up, not decided: a Proxmox node view._ What only the API adds is which neighbour
    and the node's headroom, for routing across nodes. It reopens #17: a read-only PVEAuditor
    token with a pinned certificate held somewhere, which is a threat-model change (where the
    token lives, what a leak reveals: the node's whole inventory). Open with it: who polls — one
    daemon per node or the leader, not every LXC — and where a node-level reading lives, since
    `MachineStatus` is one machine reporting itself.
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
  - A blocks B maps to B `after: "done"` on A (#21; the authoring surface now writes the edge and
    `until`), so a block behind a deploy works when A is `until: "reported"`, and is a merge otherwise. Not `opened` (every block would stack) nor
    `merged` (a deploy could not be waited on).
  - Linear Done against an open PR settles the task as a manual mark-done would, with a new
    `doneBy: "linear"`: a person closed the issue, so its dependents release. A later merge
    changes nothing.
  - The leader reads relations once, at admission, and writes them into `deps`. A relation added
    or removed in Linear afterwards does not move a queued task, which keeps one write path for
    deps.
- **Account records — Done (2026-10-25).** `account:<hmac>` in the store, app-writable, holding
  `{ accountId, alias }` sealed to `"app"` under op `account`; the PWA's account card renames, and
  every client shows alias, else email, else short id. The key derivation, the reader's rules
  (version bound to the relay's, `accountId` hashed to the key), the rename's compare-and-set and
  what the key reveals are DESIGN.md _Scheduler_, "Account records". Exit, met in
  `e2e/accounts.test.ts`: an alias set in one client shows in another through `store-changed`, a
  record whose `accountId` does not hash to its key is ignored, and an old blob put back reads
  unreadable rather than as the old name. `seanced mcp` and Raycast show them too: DESIGN.md "Account listings" and the Raycast "Scope is spawn" note.
  - _Correction (R2), deleting an alias:_ the relay tombstoned every prefix apps could create
    into, and a standing tombstone refuses every put for 30 days. Account keys are a deterministic
    HMAC, so under those rules a token holder's delete would have blocked that alias for 30 days.
    Store rules v2 resolved it by #8 below: no delete, no tombstone; `account:` is accepted.
  - _Decided (#8):_ refuse deletes on `account:`, `quota:` and `settings:` as on `queue:`, with no
    tombstone; clear by overwrite.
  - _Decided (#14):_ DESIGN.md records the HKDF salt, label and input. `termFenced: false` gives
    every `/daemon` socket an app's rights on `account:` — create and overwrite, never delete
    (#8) — and that is accepted: a daemon socket needs a signed register on top of the bearer
    token, so it is harder to open than the app leg that already has those rights, and a writer
    without the PSK writes only records whose `accountId` does not hash to their key.
  - _Open (#22), junk under `account:`:_ a bearer-token holder can create junk keys under
    `account:` up to its cap of 64, and with deletes refused (#8) nothing in the product removes
    them, so while they stand the fleet can alias no account it has not named already (DESIGN.md
    _Threat model_, item 3, records it as a residual). `task:` has `discard` for the same junk (M3
    review S2); `queue:` and `quota:` take one key each, so they cannot be squatted. Records
    sealed under an old PSK are unreadable the same way, and stay for the same reason: a PSK
    rotation orphans every `account:` record (it no longer opens), each holding a cap slot that
    deletes cannot free, and the account key derived from the new PSK maps to new keys. Options:
    - **(a) a leader-only purge op** for unreadable `account:` records, shaped like `discard`:
      sealed `from: "app"`, parsed by its own parser, checked against `schedulerGuard`, at the
      version an app listed it under, audited. It refuses every readable record (`conflict` if
      the record changed since) and writes no tombstone. The relay's `account:` rule then allows
      a delete on the leader's term socket only, so this reopens the deterministic-key delete #8
      avoided. It also reopens rollback: a deleted key restarts at version 1, so an old genuine
      version-1 blob a token holder kept (each ciphertext is listable while it is current, so a
      holder can keep every one) then reads as the
      current record, where today's put-back lands at a higher version and reads
      `version_mismatch`. The rollback protection holds only while no key's version history is
      reset. A tombstone would only block the key's real account for 30 days. Cost: one relay
      rule change, one leader op, a PWA action, and that rollback exposure, which for a
      display-only alias may be acceptable but is a decision, not a given.
    - **(b) a larger cap.** Raises the cost of the squat without removing it, and every app pays
      for the larger list it reads on open.
    - **(c) accept it and rotate the token.** Rotation stops new junk and clears none, so the
      taken slots stay taken.
    - _Recommended:_ (a). It is the only option that clears the squat, and it reuses `discard`'s
      shape and its guard instead of adding a new kind of write.
- **Fleet quota record — Done (2026-10-25).** One record of each account's newest reading,
  written by every daemon by read-open-compare-`expect` on a 5-min cadence, folded with the
  statuses by every reader. Needed, not just nice: the kept status holds an account's quota only
  while some machine's own snapshot does, so a `forget`, a reinstall or a retired machine took the
  fleet's newest reading with it. One record, not one per account: per-account writes would tell
  the relay when each account is in use. DESIGN.md _Scheduler_, "Fleet quota record" records the
  writer as built (its register gate, bounds and the unreadable-record rule) and its readers.
  `status` shrinking to pressure, the other payoff, is not done.
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

- **Spawn defaults to the scheduler** — **Done** (owner, 2026-10-25; PRs #309, #310 and #311): every
  spawn is a task, a machine or an account is a pin on it, and a task's pin and `avoid` show on
  its queue card. DESIGN.md is the record ("CLI spawn", "MCP server", "PWA", "Fleet broker").
  - _Follow-up:_ `route-preview` takes a pin. It drops one today (`parseTaskRequest`), so the
    PWA's placement preview is shown with both pickers on `auto` only.
  - _Follow-up:_ drop `spawn` from `LOCAL_OPS` and `BROKER_OPS` once no pre-PR-1 `seanced mcp` can
    still be running — a threat-model change, recorded in DESIGN.md with it.

- **Keyless `auto`** — **Done**: MCP's `auto` and `seanced spawn` on a box that cannot
  read the key go through the daemon's fleet broker (DESIGN.md "Fleet broker", "The scheduler
  actions").

  Raycast `auto` attaches the same way as the CLI's.

- **Batches are a group** — **Done** (owner, 2026-10-26). A batch is where a set of tasks came
  from, shown and acted on together, never a scheduling primitive: `sequential` and `parallel`
  went from the scheduler, `queue_batch` and the PWA, so order is `after` edges and concurrency
  the global and per-account caps. #318's carve-out (a batch bound counting members on an asleep
  machine) went with them. DESIGN.md "Batches" is the record, with both strategies as rejected
  alternatives.
  - _Follow-up:_ stop emitting `strategy: { mode: "auto" }` (`BATCH_STRATEGY`) and drop the field
    from `BatchMembership` once no pre-change leader, app or daemon can still read a record — an
    older `parseBatch` nulls a batch without one. The parser already ignores it, so this is a
    type and writer change only. The `batch_order` and `cap_reached` `scope: "batch"` reasons an
    older leader sends need no step: readers already drop them as unknown.

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
18. **A machine asleep 2 min holds no concurrency slot** (`slotReleaseAfterMs`, owner,
    2026-10-26). Its in-flight tasks stop counting toward `globalMax`, `accountMax` and projected
    usage, with no change of state; on return they count again and the fleet may sit over a cap
    until work drains. A blip or relay reconnect frees nothing, and a dark wake restarts the clock, so after each one
    the slots come back only after the connected-read window (~2.5 min, DESIGN.md) plus the grace; `lostAfterMs` (10)
    stays 15 min, because `lost` writes records and settles reservations. Nothing else counts them:
    the batch-bound carve-out went with batch strategies (2026-10-26). DESIGN.md "Routing caps" has the rule and the rejected alternative.

19. **A continuation `ready` over 4 days fails `continue_expired`** (`continueExpiryMs`, owner,
    2026-10-27). Without it an unplaceable continuation (target re-keyed, clone gone, daemon rolled back)
    waits until cancelled by hand. Fixed in `DEFAULT_CONFIG`, not per machine: expiry runs in the leader and
    leadership moves. Not tied to reap's `minAgeDays`, which is about worktrees, not queue entries. The
    ceiling is the launch ledger's age (7 days): past it the target daemon refuses the continuation anyway,
    so failing earlier is never premature; a test pins the relation. A continuation expires at this bound
    pinned or not; a pin without `continues` has its own (21).

20. **A session idle at its prompt 10 min holds no concurrency slot** (`idleReleaseAfterMs`, owner,
    2026-10-27). A `running` task whose own machine reported `idle` (main turn ended, no dialog open)
    and nothing since stops counting toward `globalMax`, `accountMax` and projected usage, its state
    unchanged — the "done, want a follow-up?" session that was never settled. Its next state counts it
    again, over a cap or not, as item 18's do on return. `needs-input` keeps its slot: a dialog is
    mid-task, so work resumes for certain when it is answered. Detected from the mod's `idle`, never
    from what the session wrote. DESIGN.md "Routing caps" has the rule and the residuals.

21. **A pinned task `ready` over 30 days fails `pin_expired`** (`pinExpiryMs`, owner, 2026-10-27).
    A pin (`pin.deviceId` or `pin.account`) to a machine retired or re-keyed, or an account signed out for
    good, otherwise waits forever: never pruned, counted toward `MAX_TASKS`, holding a place in the
    20-task `queue` reply, and liable to start a stale prompt if its machine ever returns. 30 days is
    the tombstone's life (`STORE_TOMBSTONE_MS`), the month `queue_expired` names, by choice (admission
    stops a day short of it for clock skew); from `createdAt`, as 19 is. A pin released from `blocked`
    already past it fails before dispatch rather than launching. One bound and one code for
    machine and account pins, the message saying which. Pins only: an unpinned `ready` task no machine can
    take (a fleet-wide `repo_absent`, `avoid` of every machine) is out of scope on purpose, since a bound
    there also fails tasks held only by quota or caps; decided separately. Rejected: hand cancel only,
    ranking long-waiting pins below finished tasks, a shorter account-pin bound, a leader-written `readyAt`.
    DESIGN.md "Expiry" has the record.

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
  M4's account records add a smaller one: being app-writable, a token holder can overwrite an
  alias with junk that readers skip — but not read or forge one, and not delete it, since
  `account:` refuses deletes (#8); the next real edit overwrites the junk. Nor can it roll one
  back (an old blob put back lands at a higher version and reads `version_mismatch`), which
  holds only while `account:` refuses deletes and no key's version history is reset: an operator
  reset of `account:` storage with the PSK unchanged (a DO migration, `deleted_classes`, a redeploy
  to a fresh worker) reopens it, so rotate the PSK or bump `ACCOUNT_KEY_HKDF_INFO` then. It can also create
  junk account keys up to the prefix's cap, which nothing in the product removes (DESIGN.md
  Threat model, item 3). Holding the leader's term would be a larger act — next item.
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
  and can't dedupe a re-dispatch), while `seanced spawn --now`, the only direct path left, keeps working. Self-update makes
  this a short window.
- **Reversibility is only as real as the adapter boundary.** If daemon code starts reaching into
  `scheduler/` internals, or the library grows an import from `daemon/`, the move to a fixed
  box becomes the rewrite this design exists to avoid. Enforced the way `raycast/` enforces
  its layering: `scheduler/test/layering.test.ts` fails on either import direction, and proves
  its detector catches each.
