# Séance scheduler — plan

**Status: plan, M1 and M2 done.** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview; placement revised 2026-10-15 (below). Folds into DESIGN.md
(new section "Scheduler") as each milestone lands; until then this file is the working record and
DESIGN.md describes what exists. M1 (visibility: exclaves, telemetry, the `status` frame, the
`metrics` op, the PWA's Machines screen) folded in on 2026-10-15, and M2 (routing, leadership,
`auto`) on 2026-10-16; their plan text is gone from here — DESIGN.md is the record for anything
either built.

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
| Quota telemetry   | Layered: session-reported `rate_limits` (the mod's `session.measure` tap, landed M2) → OAuth usage endpoint when stale → the config dir's `cachedUsageUtilization` (M1's only source) → last value + `resets_at` floor                                                                                                                                                                      |
| Task              | Free-form (repo + prompt + spawn opts), optional Linear link                                                                                                                                                                                                                                                                                                                                |
| Deps              | Per edge `after: opened` (stacked, default) or `after: merged`; Linear relations + hand-declared                                                                                                                                                                                                                                                                                            |
| Done signal       | Layered: PR merged (daemon, local git) / Linear Done → session ended → manual                                                                                                                                                                                                                                                                                                               |
| Quota exhausted   | Spill into credits, loudly (Web Push), with pause: until resume / until next reset                                                                                                                                                                                                                                                                                                          |
| Concurrency       | Global max, per-account max, per-batch strategy (`sequential` / `parallel(n)` / `auto`)                                                                                                                                                                                                                                                                                                     |
| Alerts            | Web Push (VAPID) from the leader to subscribed PWAs (M4; key sealed in the DO, see _Secrets_)                                                                                                                                                                                                                                                                                               |
| Needs input       | `needs-input` state, alert, keeps its slot; idle timeout escalates, never kills                                                                                                                                                                                                                                                                                                             |
| Event ingest      | New ingest-only `session-event` frame kind on the local socket, after the fleet broker's precedent (threat-model widening, recorded)                                                                                                                                                                                                                                                        |
| Proxmox           | Machine pressure = max(container cgroup view, Proxmox node via API); the LXC daemon reads the node view itself and folds it into its own `status`, so no reader needs Proxmox reach                                                                                                                                                                                                         |
| Telemetry         | Current snapshot (pressure + latest quota) rides the relay as a sealed `status` frame held on the daemon's socket attachment and pushed to apps + the leader; the relay keeps the last one with the registry entry when the socket goes (M2), so quota outlives a sleeping observer. History stays on each daemon behind a `metrics` op; neither the relay nor the scheduler stores history |
| At rest           | The queue is sealed envelopes in DO storage: the relay holds id, version and ciphertext, nothing else. No second at-rest scheme                                                                                                                                                                                                                                                             |
| Skills            | Hard filter when declared or prompt starts with `/name`; otherwise informational (+ PWA autocomplete)                                                                                                                                                                                                                                                                                       |
| Clients           | PWA in v1; op set designed so MCP, Raycast and CLI attach later without protocol change                                                                                                                                                                                                                                                                                                     |
| Manual spawn      | Both: `auto` → scheduler; picking a machine → direct to daemon (works with no leader)                                                                                                                                                                                                                                                                                                       |
| Handoff           | Dependent task gets a preamble: predecessor title, branch, PR URL, transcript path (same machine only)                                                                                                                                                                                                                                                                                      |
| AI dep classifier | Later; dependency sources are pluggable                                                                                                                                                                                                                                                                                                                                                     |
| Slicing           | M1 visibility → M2 routing + leadership → M3 durable queue → M4 refinement (independent items)                                                                                                                                                                                                                                                                                              |

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
and long-lived, not the broker's idle-closing `LazyRelay` (Daemon changes, `leader.ts`).

## Wire changes

All shapes land in `shared/src/types.ts` first (schema of record); DESIGN.md's frame→module
table gains rows. **M3's are there now** (M3 PR 0): the store frames and their limits, the
`task` and `pause-state` records, the widened task model, the new scheduler ops,
`queue-changed` and `branch-state`. Read the types for any M3 shape — the sketches below are the
reasoning, `types.ts` is the record, and where they differ `types.ts` wins.

**Relay (`hub.ts`, `wire.ts`, `index.ts`)**

- **Leadership** (M2; DESIGN.md _Scheduler_, "Leadership", is the record): signed `roles`,
  nomination in `relay/src/leadership.ts`, `scheduler:term`, `lead`/`follow`, the term fence and
  (M2 review) the `lead-proof` apps believe a nominee by. Every leader write in M3 carries its
  term through the same fence — which checks the term, not the proof the relay cannot read (M3
  item 1).
- **Store ops** on the daemon leg (leader) and app leg: `store-list { prefix }` → `[{ key,
version, env }]`, `store-get { key }` → `{ key, version, env }` or `null` (what a
  `version_conflict` refreshes from, so a lost race costs one read, not the whole queue
  unsealed), `store-put { key, expect, env, term? }` → `{ version }` or
  `version_conflict`, `store-delete { key, expect, term? }`. Values live at their key as
  `{ version, env }`; `version` starts at 1 on create and increments per put. Named for the
  store, not the queue, because tasks are not its only records — who may write is a rule per
  key prefix, applied by the relay:

  | Prefix           | Create          | Overwrite / delete         | Term-fenced | Lands |
  | ---------------- | --------------- | -------------------------- | ----------- | ----- |
  | `task:<id>`      | any app, leader | leader only                | yes         | M3    |
  | `queue:pause`    | leader only     | leader only                | yes         | M3    |
  | `account:<hmac>` | any app         | any app, by `expect` (CAS) | no          | M4    |

  Tasks: apps may list and create (`expect: 0`) so enqueue works with no leader; every
  overwrite and delete is the leader's. `queue:pause` holds the pause (`PauseRecord`, op
  `pause-state`), so it outlives the leader that took it. App-writable records exist for state a
  person edits from any client with no leader up — an account's alias first; whether M4's
  `settings` is one is M4's call. Bounds in `wire.ts`: keys a known prefix plus a routing id
  (`ROUTING_ID_PATTERN`, the one bound task ids and `deviceId`s share), `env.ct` under
  `STORE_MAX_CT_LENGTH` (40 KiB) and a create's under `STORE_CREATE_MAX_CT_LENGTH` (28 KiB), so
  a record has room for what the leader adds to it; `MAX_TASKS` and `MAX_RECORDS` like
  `MAX_DEVICES`, and a create rate floor per socket. The DO is SQLite-backed, so a value may
  reach 2 MB; what keeps records small is the one-frame listing, not storage.

- **Version binding closes rollback.** Anything with the bearer token can list the queue, keep a
  task's old sealed blob and put it back — authentic bytes, stale state (a cancelled task back to
  `ready`). So the sealed body carries the `version` its put will produce, and every reader
  rejects a blob whose inner version disagrees with the relay's. A replayed blob then fails like
  a forged one. The reader's rules are one function, `bindTaskRecord` in `shared/src/parse.ts`:
  version and key binding, a version-1 record must be `queued`, and a `createdAt` more than the
  replay window ahead is refused, so a far-future stamp cannot outlive the 30-day admit rule. A
  refused record is skipped and reported with its reason, never deleted unasked — after a PSK
  rotation every record is unreadable. A put fails as `version_conflict` (a lost race),
  `not_leader`, `forbidden`, `too_large`, `rate_limited`, `store_full` or `invalid_request`
  (`STORE_ERROR_CODES`), or its reply is lost after it committed — which a create's retry reads
  as `version_conflict` and a leader's next read settles.
- **Stored blobs are an at-rest format, not live frames.** Their `op` is the record's kind —
  `task` and `pause-state` sealed to `"scheduler"`, `account` to `"app"` — opened _without_ the
  `ReplayGuard` through `openAtRest` — exactly as the register blob and `status` already are —
  and never accepted on a live routing path. Keeping the op distinct per kind is what stops a stored
  record being replayed as a request, or as a record of another kind.
- **Last `status` kept**, `to: "scheduler"` envelopes and the registry push's `scheduler` (M2;
  DESIGN.md _Presence & identity_ and _Scheduler_).
- **`status { env }`** (daemon→relay, landed in M1; DESIGN.md _Presence & identity_): the
  leader's app-role leg receives it like any app, from the registry push and as it arrives, so
  the routing loop reads the same snapshot the PWA renders.
- Cost: one storage write per task _transition_ — never per tick. Well inside free-tier limits for a handful of machines and tens of tasks.

The `status` payload, its encoding and the `metrics` history op landed in M1 (DESIGN.md
_Presence & identity_, _Wire protocol_ Layer 2, _Daemon_ "Telemetry"). What the scheduler adds
to the payload is new quota sources (session reports in M2, the OAuth poll in M4): readers
already take the newest observation per account, whichever daemon reported it.

**Daemon → scheduler (fire-and-forget, sealed to `"scheduler"`)** — events only, the things
that must arrive when they happen rather than when someone asks:

| Op              | Cadence                      | Payload (sketch)                                                                               |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `session-event` | on event, coalesced ≤1/5s    | `SessionEvent`: session (pane), task id, exclave, state, `https:` PR URL, `at` — landed (M2 5) |
| `branch-state`  | on change, for task branches | task id, repo, branch, `pushed`, `merged` (reap-git's rules), `at`                             |

Both are lost while no leader listens, so neither is the record. What they carry is also in the
daemon's `sessions` reply — a running session as itself, an ended task in `ended`, and each
task's PR URL, branch, `pushed` and `merged` in `progress` (`TaskProgress`, M3; decided
2026-10-17 over re-emitting `branch-state` on a cadence: one read the takeover already makes,
and no standing traffic). A new leader reads it on takeover, and again when a machine holding
a task it waits on comes back, so a gap can neither settle a task that ended with an open PR
as `done` nor hold an `after: merged` dependent past a merge. In a reply the daemon trimmed to
fit (`progressTrimmed`) a task with no entry is unknown and waits for a later read. The
session and task ids in a `session-event` are the daemon's own, from its pane map, never copied
from what the mod sent (DESIGN.md, Local op socket, "Session events"). The plan's `skill` field
was left out: nothing reads it before M4's skill filter.

**Scheduler → daemon**: existing `spawn`/`sessions`/`despawn`, addressed from `"scheduler"` by
the leader's app-role leg (landed with item 3). The target daemon needed no change — it replies
to `env.from` already — but the relay routes that `to: "scheduler"` reply to the leader's
_daemon_ socket, so the leader's daemon leg hands it to its app-role leg to correlate (DESIGN.md
_Scheduler_, "The leader").

**`SpawnRequest` gains two optional fields**, both ignored harmlessly by old daemons except
where noted — a direct spawn (PWA machine pick, MCP, Raycast, CLI) and a scheduler spawn remain
the same op:

- `taskId?: string` — **dispatch idempotency.** A daemon refuses a second spawn for a task id
  it already runs (`task_running`, with the pane id), and `sessions` reports `taskId` per
  session. This is what makes leader failover safe: a leader that dies between sending `spawn`
  and reading the verdict leaves a reservation with no assignment, and the next leader must not
  double-spawn. On takeover it reads `sessions` from every machine with a reservation before
  dispatching anything, and the daemon-side refusal is the backstop if that read is stale.
  Old daemons ignore the field, so the leader only reserves against daemons advertising it.
- `baseBranch?: string` (M4, stacked deps) — start the worktree from this branch instead of
  the default. Resolved against the repo's refs (`origin/<b>` or local), never interpolated;
  unresolvable → new code `base_not_found`. Through `shq()` if it ever reaches the shell
  string. Useful from the PWA directly too. Old daemons ignoring it is wrong rather than
  harmless (B would start from main), so the scheduler only sends it to daemons that advertise
  support.

Audit: scheduler spawns reach the target through the relay, so they audit as `origin=relay
client=scheduler` — except on the leader's own machine, which it reaches in process as
`origin=leader client=scheduler`; task ↔ session correlation is `taskId`.

**App → scheduler ops** (request/response, PWA via `RelayClient`, routed to the leader):
`queue` (list + decisions), `cancel`, `mark-done`, `pause`/`resume` (`until: "resume" |
"reset"`), `route-preview` (dry-run explanation), `push-subscribe`. `queue` and
`route-preview` landed with M2 item 6 — DESIGN.md _Scheduler_, "The leader", is the record:
answered from the daemon socket rather than the term's leg, `not_leader` from a daemon running no
term, `not_ready` during takeover. M2 adds a temporary `submit` (a `TaskRequest` →
`Scheduler.submit`), because its queue is in memory on the leader and there is no store to
`store-put` into; M3 item 6 removes it, with the PWA's move to `store-put`. `enqueue` is _not_ a
leader op: the app seals the task and `store-put`s it at `expect: 0`, so queuing works with
no leader and the next one picks it up. Scheduler → app: `queue-changed` push to `"app"`
(broadcast, apps re-fetch) — no polling. It names the tasks that changed (`tasks`, absent when
more did or the holds changed), and `queue` takes the same ids as a filter
(`QueueRequest.tasks`), so an app re-fetches what moved rather than the whole queue; an M2
leader ignores the filter and answers the newest, which the reader filters again.

**`MachineInfo`.** `exclaves`, `RepoEntry.exclave`/`origin` and `capabilities` landed in M1
(DESIGN.md _Daemon_, "Exclaves" and "Repo discovery"). `origin` is the scheduler's repo key.
What remains is new `capabilities` values — `"taskId"` (M2), `"baseBranch"` (M4) — so the
scheduler never relies on a field an old daemon would drop. (`roles` is the plaintext sibling:
what the _relay_ must read; `capabilities` is sealed, read by apps today — they gate `metrics` on it — and by the leader to gate `taskId`.)

## Daemon changes

- `exclaves.ts` and `telemetry.ts` landed in M1 (DESIGN.md _Daemon_). Session events (M2) and
  the OAuth poll (M4) add quota observations to the same store under the same metric names.
  Collectors not yet built — LXC PSI/cgroup views, the Proxmox node view, macOS I/O rates — are
  listed there too.
- `daemon/src/oauth-quota.ts` (M4; not `shared/src/quota.ts`, the fleet fold readers
  share): OAuth usage poll per exclave when the newest session report is older than
  `quota.staleAfter` (default 10m). **Token never leaves the daemon process** — same invariant
  class as the service-delivered PSK. Failure is quiet and non-fatal (unofficial endpoint).
- Local socket `session-event` and `claude-mods/session-events` (M2; DESIGN.md Local op socket,
  "Session events"). The mod is also the phase-2 bus.
- **`leader.ts`, the scheduler role** (M2; DESIGN.md _Scheduler_, "The leader"). `QueueStore` is
  still the library's in-memory one, fenced by the term; M3 swaps in the relay's `store-*` ops
  behind the port as the store port left it (2026-10-17: unreadable records as values, every
  write failure but a revoked term as a value, the pause slot, `refresh`) — so the adapter maps
  the relay's answers onto it rather than widening it.

## Scheduler (`scheduler/`)

**A pure library, no I/O of its own**, behind two interfaces the host supplies — `QueueStore`
and `Fleet` — so the placement decision stays reversible: moving the scheduler to a fixed box
later is two new adapters (SQLite store, own app-role client) and no change here. M2 built it,
and DESIGN.md _Scheduler_ is the record of what exists: "The library" for the interfaces,
routing, states, takeover and `lost`, "The leader" for the daemon hosting it. This section keeps
only what M3 and M4 change. Labels code comments cite, and where M2's half now lives:

- **Routing** (filter, score, stickiness, reserve, record) — DESIGN.md "The library", "One
  routing function" through "Reserve, then dispatch"; what is ahead is below.
- **Missing quota is unknown, never 0%** — the DESIGN.md bullet of that name.
- **Quota freshness** (the observation's, not the status's) — DESIGN.md "One routing
  function": pressure only from a live, unstale status, quota from every status by its own
  `at`. Why there is no age cap: _Settled defaults_ 7.
- **Task states** and **Takeover** — M2's half is DESIGN.md "States are M2's slice",
  "`lost`" and "Takeover", with `scheduler/src/task.ts` the table that runs; M3's is below.

**The store adapter (M3 item 3).** M2's leader runs on the library's `MemoryQueueStore`. M3's
`QueueStore` is `daemon/src/queue-store.ts` over the relay's `store-*` ops, behind the port as
the store port left it (DESIGN.md _Scheduler_, "The library"). The library sees plain task
bodies, plus each record that did not read as `{ id, version, reason }`: the adapter seals and
opens each under the daemon's imported key, binds it through `bindTaskRecord` (Wire changes,
_Version binding_), and carries the term on every write. It maps the relay's answers onto the
port's: `not_leader` to a `StoreRevoked` throw, a reply lost to the timeout to `indeterminate`,
`forbidden` and `invalid_request` to `refused`, and the rest by name. Tests stay layered: the library against in-memory fakes of both interfaces, the adapter
against `daemon/test/harness.ts`, the store against the real DO in e2e.

**Records (M3).** One sealed `TaskRecord` per task at `task:<id>`, the pause at `queue:pause`;
machines, exclaves, pressure and quota come from the fleet feed and are persisted nowhere. A
leader change then loses only the in-memory view (the absence clock, an unplaced task's latest
decision). M4's `settings` (_Secrets_) and push subscriptions need prefixes of their own in
`STORE_PREFIXES`, decided with that item.

**Task states.** The full lifecycle is `queued → blocked → ready → reserved → running ⇄
needs-input → awaiting-merge → done`, with `failed`, `cancelled` and `lost` off-path. M2 built the
slice from `ready`. M3 adds `queued` (an app's create, which the leader admits to `blocked` or
`ready`), `blocked` (until every dependency edge releases) and `awaiting-merge`, which frees the
concurrency slot (the session ended) but keeps `after: merged` dependents blocked. The three are
in the schema already, with no edges until M3 item 4a.

**Takeover (M3).** M2's reconcile stands. M3 adds the store's half: list the store, open every
body, and skip and report one that does not decrypt or whose version or id disagrees with its
key — as the PWA skips registry entries, never fatal — before the reconcile runs.

**Routing, ahead.** Today's cadence, for reference: the leader runs a pass on every change to
its leg's machine list, after each `submit`, and on a 30s timer that runs for the whole term
whether or not anything is ready; reservation TTLs and `lost` are checked only inside a pass. A
task's decision is written with its reservation (one store write) — never after the spawn —
and an unplaced task's stays in memory. M3 and M4 add:

- Filters: the per-account cap (`cap_reached` with `scope: "account"`, M3 item 5) and the
  per-batch strategy (`sequential` / `parallel(n)` / `auto`, M3 item 4a); `skill absent` (M4,
  _Skills_: a hard filter when declared or the prompt starts with `/name`); stacked base
  unpushed and not on this exclave (M4, _Stacking_).
- Score: `dependencyDistance` gets an input once M3's deps fill `TaskSpec.base`. The Proxmox
  node view (M4) reaches `machinePressure` folded into the LXC daemon's own `status`, so the
  library reads it as any other pressure.
- Projected usage: the fixed per-task estimate (_Settled defaults_ 8), to be tuned from observed
  deltas per task.

**Credits spill:** dispatching to an account past the hard threshold with extra usage on — a
candidate the record already marks `spill` — is detected and shown in the PWA from M3 item 5,
and from M4 fires a Web Push ("Spending credits on <account> for <task>" + Pause actions).
Re-alerts once per account per window, not per task.

**Done detection:** Linear Done (if linked, poll) or daemon `branch-state merged` → `done`;
session `ended` without merge → `awaiting-merge` (PR open) or `failed` (no PR, nonzero) —
manual override always wins.

**Secrets (M4).** The first draft gave a fixed box a Linear key, a VAPID key and a Proxmox
token. Under a moving leader: the Proxmox token stays on the LXC daemons, which read their own
host (above); the VAPID keypair and Linear key live as one more sealed key in the store
(`settings`), opened by whichever daemon leads — the PSK is already the only trust boundary,
so sealing them under it adds no second one. Linear polling is optional from day one, since
daemon-local merge detection is the primary done signal.

## Milestones

Each milestone ships something usable on its own and is cut into PR-sized tasks in the order
listed — the order is the dependency graph. _Exit_ is what proves it done, phrased as tests
where a test can say it. _Gaps_ are what the milestone deliberately leaves manual or broken, so
nobody files them as bugs. _Record_ names the DESIGN.md sections it folds into; the plan text it
replaces is deleted here in the same PR.

| M   | Ships                                                  | One line                                            |
| --- | ------------------------------------------------------ | --------------------------------------------------- |
| M1  | Visibility across machines, exclaves and accounts      | See pressure and quota everywhere; no scheduler yet |
| M2  | Routing + leadership                                   | "spawn this in repo X" without picking a machine    |
| M3  | Durable queue                                          | Queue a block of work with deps and walk away       |
| M4  | Stacking, OAuth quota, skills, Proxmox, alerts, Linear | Refinement; items are independent                   |

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
(session reports are M2, the OAuth poll M4), so an exclave shows whatever its last Claude
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

**Gaps, until later milestones close them.** The queue is in memory on the leader: a leader
change forgets `auto` tasks not yet dispatched (sessions already running are ordinary sessions and
survive), and `submit` is the only way in until M3's `store-put` replaces it. No deps, no batches,
no caps beyond the global max, no pause, no alerts; the PWA polls `queue` for a task's progress
instead of hearing `queue-changed`. An account nothing has observed yet is `quota unknown` and
gets no `auto` work until a direct spawn or a session report gives it a reading (M4's OAuth poll).
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
- **Gap 3** (open until M3): a `submit` whose reply is lost cannot be reconciled — the verdict
  says it may have queued and offers no retry. M3's app-minted ids make enqueue idempotent
  (M3 item 1).
- **Gap 4** (closed, #127): a `lost` task waited for its own machine indefinitely, with no
  way to give up on it; it can now be cancelled (DESIGN.md "`lost`").

### M3 — durable queue

**Goal.** Queue a block of work with dependencies and leave; it runs, survives leader changes,
and finishes without anyone watching.

**Gate (done 2026-10-16).** Leader capture reopens and is settled with a relay-side guard (Risks,
_Leader capture_) before the store lands — under M2's reader-only check a squatter's term would
delete the queue. Settled with the `SCHEDULER_LEADERS` allowlist, a Worker secret the relay
filters nomination through (unset nominates nobody), with M2's reader check kept as its tripwire;
recorded in DESIGN.md _Scheduler_ ("Leadership") and _Threat model_ (item 3). Exit, as tests: a
bearer-token holder's self-minted daemon with signed roles and the oldest socket is never
nominated while a listed one is, an unset list nominates nobody (`scheduler: null`, the address
`offline`), and junk entries are ignored (relay); a current leader taken off the list loses the
role (`leadership.test.ts`); and end to end, a squatter is never nominated while a listed seed
without the PSK reads "leader unverified" and is sent nothing (e2e).

**Lands as** (cut approved by the owner, 2026-10-16): a schema PR, then three waves. Each
wave's PRs run in parallel; a wave starts once the one before it has merged.

- **PR 0 — schema.** Every M3 wire and record shape in `shared/src/types.ts`, with its
  `parse.ts` validator and tests, and no behaviour change. What it decided where this plan was
  silent is in the type comments; the ones that shape later PRs:
  - Store frames are Layer 1 plaintext (the relay answers them), so each carries a client `id`
    and the reply echoes it as `re`: `store-listed`, `store-record`, `store-written`,
    `store-refused` with a `STORE_ERROR_CODES` code.
  - `store-listed` is one frame, unpaged: records are small (Settled defaults 11), so a full
    `task:` prefix lists in 5 MiB. Paging stays possible without a break — `after` on the request,
    which an older relay ignores and answers whole, and `next` on the reply, which today's
    clients refuse rather than read a page as the whole queue.
  - A write's `term` exists on the daemon leg only. On the app leg the term is public (every
    registry push carries it), so no app frame has one: overwrite and delete are the leader's
    verified socket's, never a token holder's who copied the term.
  - `store-changed { key, version }`: the relay nudges the leader's daemon socket after any write
    the leader did not make, so an app's enqueue reaches a running leader without the leader
    polling the store.
  - A second prefix, `queue:` (one key, `queue:pause`, leader-only and term-fenced), so a pause
    survives leader changes, which are routine. `account:` stays reserved for M4.
  - A reader binds a task record to its key twice: the sealed `version` to the relay's, and the
    sealed `task.id` to the key's id — without the second, a token holder could re-file a task's
    version-1 blob under a fresh key and have it run twice.
  - **Tombstones** (owner, 2026-10-17). Version binding cannot see a deleted key re-created from
    its own authentic version-1 blob, so a finished task the leader pruned could be put back and
    run again. A delete under a prefix apps may create into leaves the key and its last version
    for `STORE_TOMBSTONE_MS` (30 days); a put there is `version_conflict`, and tombstones count
    toward no cap. They expire, so the leader also admits no `queued` task whose sealed
    `createdAt` is older than the same 30 days. Normal use leaves ~2 MB of tombstones a year;
    junk deleted at the create floor is bounded by that floor over 30 days.
  - An app creates a task only as `queued`; the leader admits it to `blocked` or `ready`.
- **PR 0b — the schema's review follow-up** (2026-10-17, from the review of M2). What the waves
  would otherwise each have decided alone, in `types.ts` and `parse.ts`, shapes only:
  - `SessionsResponse.progress` (Wire changes, _Daemon → scheduler_): the takeover's source for
    a task's PR, branch, `pushed` and `merged`, so a leader gap loses none of them.
  - One routing-id bound, `ROUTING_ID_PATTERN`, that `TASK_ID_PATTERN` (no `:` now),
    `STORE_KEY_PATTERN` and the relay's id checks derive from: a task id is a key part as it stands.
  - Record headroom: creates cap at `STORE_CREATE_MAX_CT_LENGTH` (28 KiB) under a 40 KiB record,
    every field the leader writes is bounded (`TARGET_LIMITS`, `TASK_FAILURE_LIMITS`), and a write
    that would not fit cuts the decision first, marked `Decision.trimmed`.
  - Dependency semantics (`TaskDep`, `DEP_AFTER`): a `failed` or `cancelled` predecessor fails its
    dependents, cascading (`dependency_failed`); one the store does not hold past
    `DEP_MISSING_GRACE_MS` fails them too (`dependency_missing`) — so pruning never deletes a task
    an unfinished one names; a cycle fails every member at admission (`dependency_cycle`); a
    `lost` predecessor is waited on; `done` releases every edge, whatever settled it; a `here`
    predecessor has no task branch, so `opened` releases on its PR and `merged` only at `done`.
  - `cap_reached` scope `batch` (a batch at its strategy's bound; `sequential` is 1).
  - `bindTaskRecord` (Wire changes, _Version binding_), `QueueRequest.tasks` and
    `QueueChanged.tasks`.
- **Before wave 1: the store port** (the M2 review's store PR; DESIGN.md _Scheduler_, "The
  library", is its record): `QueueStore.list`/`get` return an unreadable record as
  `{ id, version, reason }`, so "skipped and reported" is tested in the library; every write
  failure is a value but `StoreRevoked`; the `queue:pause` slot; `Scheduler.refresh(id)` for
  `store-changed`; `MemoryQueueStore` with tombstones and fault hooks. The writer bounds 0b set
  (failure message, window, decision cap) are applied where the library writes, and the pause
  hold's `Reason` (`paused`) and raw scheduler error codes ride along, now that the PWA's and
  MCP's wording is one module (`shared/src/scheduler-text.ts`).
- **Wave 1**, in parallel:
  - **1. Relay store** — `relay/src/store.ts`, with `hub.ts` and `wire.ts`: the four frames, the
    per-prefix rules, term-fenced writes, `expect: 0` creates on the app leg, `MAX_TASKS` /
    `MAX_RECORDS`, `STORE_MAX_CT_LENGTH` and the create cap, the create rate floor, tombstones and
    their expiry, `store-changed`. The only M3 PR that touches `hub.ts`. It starts by moving the
    term's state out of `hub.ts` into `leadership.ts` behind `holdsTerm(term, socket)`: a store
    write is the leader's only from the socket the term was issued to, which today's term-only
    `#holdsTerm` cannot say. Tombstones get a key range of their own, so a `task:` list and the
    caps never walk them; counts are kept rather than listed — `#entryCount` reads every value,
    which for a full `task:` prefix is 5 MiB per create; app sockets get an attachment (only
    daemon sockets have one today) to hold the create floor's window.
    `relay/test/layering.test.ts` admits shared values by name, constants free: `STORE_KEY_PATTERN`
    passes, `isStoreKey` or a parser does not. `STORE_TOMBSTONE_MS` takes an env override so
    `relay/test/harness.ts` can expire a tombstone inside a test.
    **The term fence is not a PSK check.** The relay hands the term to whichever listed machine
    is earliest connected, and a listed machine's seed copied out of `state.json` without the
    PSK still gets it — it cannot seal a `lead-proof`, so readers call that leader unverified and
    send it nothing, but the relay cannot read the proof and still accepts its term-fenced writes. Such a thief cannot
    forge or read a record, so an overwrite fails `bindTaskRecord` and is skipped; a delete,
    though, loses the task. Item 1 decides whether a delete's tombstone keeps the last `env`, so
    a person can put a task deleted that way back within `STORE_TOMBSTONE_MS` — cheap (records
    are small, deletes rare) — or records the loss as accepted, beside DESIGN.md _Threat model_
    item 3. Version binding and tombstones stop a token holder, not the relay itself: a
    compromised relay can still roll a record back or resurrect one.
    **Enqueue is idempotent by construction** (M2's gap 3, decided 2026-10-16): the app mints the
    task id, so a retry after a lost reply re-puts the same `task:<id>` at `expect: 0`, and a
    `version_conflict` there means the first put landed — the client reads it as queued, never as
    a failure, and never mints a second id for the same submission. That is why M2's `submit`
    got no interim fix; until item 6 a lost `submit` reply stays "may have queued", with no retry.
  - **2. The at-rest `task` op and version binding** — sealing in `shared/src/crypto.ts`, the
    app-client's store methods in `shared/src/app-client.ts`; readers open without the
    `ReplayGuard` and keep a record only through `bindTaskRecord`. A create checks its sealed
    length against the create cap before sending.
  - **4a. The library's M3 states**, batches, hand-declared deps with PR 0b's semantics, done
    detection — `branch-state` live, `progress` on takeover and when a machine holding a waiting
    task comes back — and `awaiting-merge`, against `MemoryQueueStore` (`scheduler/`). The M3
    states join `shared/src/task-phase.ts`, which `FINISHED` and `PLACED` derive from. Pruning
    moves into the library: finished tasks past a keep count, never one an unfinished task names,
    after takeover and on `store_full`. Today its one caller is `submit`, so without this, item 6
    deleting `submit` would leave creates at `store_full` once 128 tasks had ever run.
  - **4b. The daemon's `branch-state` emitter and `progress`.** Resized from S to M–L: merges show
    only after a fetch, and `reap` — the one thing that fetches — is off by default, so the
    emitter fetches on a cadence of its own; the launch ledger holds ids and times, no worktree
    path, branch or PR URL, and `progress` must survive a restart, so it gains them; `claude
--worktree` branches `--no-track`, so `pushed` compares with the remote ref, not an upstream;
    and a session can rename its branch, so the branch is read from the worktree each time, never
    remembered from the spawn. The leader's own machine hands its `branch-state` over in process,
    as `run.ts` already does its session events.
- **Before wave 2: split `leader.ts`**, no behaviour change: its store and fleet adapters, its
  request handlers (`answer`, `queueView`), and the term lifecycle, so items 3 and 5 can run in
  parallel. `scheduler/test/layering.test.ts` names one `LEADER` file; it takes the set, which
  item 3's `queue-store.ts` then joins — as the test stands, any second daemon file importing
  the library fails it.
- **Wave 2**, in parallel:
  - **3. The `QueueStore` adapter** on the store ops (new `daemon/src/queue-store.ts`, wired in
    the term lifecycle); takeover reconciliation over opened, `bindTaskRecord`-checked bodies.
    Also, unowned until now: the store frames' send and correlate on the daemon leg
    (`daemon/src/relay-client.ts`; item 2 does the app leg); `store-changed` driving the
    one-record refresh; the leader handling `branch-state` (its event handler drops every op but
    `session-event`) and the PR URL reaching the library (`run.ts`'s in-process forward and the
    leader's handler both drop `prUrl` before `onSession`); `e2e/harness.ts` no longer injecting
    `MemoryQueueStore`; and a store double in `daemon/test/harness.ts` — term fence, tombstones,
    `store-changed` — for the adapter's daemon tests.
  - **5. Caps** (global, per account), `pause` / `resume`, `needs-input` + 30-min escalation,
    credits-spill detection (logged and shown in the PWA; the push alert is M4). Owns the request
    handlers after the split.
- **Wave 3. 6. PWA queue** — enqueue by `store-put`, cancel, mark-done, pause; `queue-changed`.
  **Removes M2's `submit`**: the op in `SCHEDULER_OPS` and `OP_TIMEOUT_MS`, `SubmitResponse`,
  `SubmitReply`, `MAX_ACTIVE_TASKS`, the `queue_full` code and its wording, `parseSubmitReply`,
  the `submit` methods on `RelayClient`, `AppRelay` and `daemon/src/fleet.ts`'s scheduler, the
  leader's `submit` case with `KEEP_FINISHED`, and `Scheduler.submit` (with `newId` unless
  something else mints ids). Moved here from item 1, where the plan
  first put it: the PWA's `auto` sends `submit` until this item gives it `store-put`, so dropping
  the op with the store would leave `auto` broken for every PR in between. **Also moves MCP's
  `auto`** (`spawn_session { machine: "auto" }` and `get_queue`, built on M2's `submit` on
  2026-10-17 — DESIGN.md "MCP server") to `store-put`, in `daemon/src/mcp.ts`: it is the
  other `submit` caller, so it must move in the same PR that drops the op. Its verdict then
  becomes "queued" plus the task id, and its tool descriptions lose the in-memory caveat.

**Who edits what** — the collision map that makes the waves parallel. `shared/src/types.ts` and
`parse.ts` are PR 0's and 0b's: a later PR that finds a shape missing changes it in a PR of its
own, not inside its wave. The one exception is item 6, which deletes M2's `submit` shapes from
both — a deletion in the last wave, so it races nothing. `relay/src/hub.ts` and `leadership.ts`
are item 1's alone. `daemon/src/leader.ts` is split before wave 2; then item 3 owns the adapters
and the term lifecycle, and the request handlers go 5 → 6. `scheduler/src/scheduler.ts` goes
4a → 5. `daemon/src/run.ts` goes 4b → 3, `shared/src/app-client.ts` 2 → 6,
`daemon/src/relay-client.ts` and both test harnesses' store doubles are item 3's (the relay
harness's TTL override is item 1's), and `daemon/src/launch-ledger.ts` is 4b's. PR 0 touched
`leader.ts` (a `not supported yet` answer for the four new ops, so they are refused rather than
met with silence), `task.ts` (the three states with no edges) and the PWA's state wording, only
as the widened types forced.

**Exit.**

- Enqueue with no leader, then start a daemon: it leads, reconciles, and runs the task (e2e).
- Kill the leader between `spawn` and its verdict: the next leader finds the session by
  `taskId` and does not spawn again (e2e).
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

**Gaps.** No stacking: every task starts from the default branch. Alerts are PWA-only until
M4's Web Push. Linear is not consulted; done comes from local merge detection, the session
ending, or manual marking. Quota is still session-reported.

**Record.** DESIGN.md _Scheduler_ (store, states, takeover), _Security model_ and _Threat
model_ (the bearer token's one new act, prompts at rest, rollback closed by version binding),
_Wire protocol_ rows, _Presence & identity_ if the registry push changes shape.

### M4 — refinement

Independent items, any order, each its own PR with its own DESIGN.md update:

- **Stacking** — `baseBranch` + `base_not_found`, lineage, the handoff preamble. Exit: a
  dependent task's worktree starts from its predecessor's branch; an unresolvable base fails
  with the code, not a shell error. Gap: a rebase after the predecessor changes is manual.
- **OAuth quota poll** — `daemon/src/oauth-quota.ts`, token never leaves the daemon. Exit: an idle exclave's
  quota refreshes within `staleAfter`; a failing endpoint is quiet.
- **Skills** — hard filter on declared or `/name` prompts, PWA autocomplete.
- **Proxmox node view** — read by the LXC daemons, folded into their own `status`.
- **Sealed `settings` + Web Push** — VAPID keypair in the store under the PSK, the
  credits-spill and needs-input alerts, `push-subscribe`; also a machine health alert (disk
  nearly full, from the `disk_pct`/`disk_free_mib` series M1 already stores — the PWA shows no
  disk numbers, since a fill level is upkeep rather than load).
- **Linear** — key in `settings`; relation-derived deps and Done as a done signal.
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
  account id — clearing an alias falls back to the email. Exit: an alias set in one client shows in another; a record whose
  `accountId` does not hash to its key is ignored (shared + e2e). Record: DESIGN.md _Threat
  model_ (the HKDF label, what the key reveals, a token holder can delete an alias).
- **Fleet quota record** (after account records; decided 2026-10-17, no longer conditional) —
  a single `quota` key, `{ accountId → newest observation }`, written by daemons on a fixed
  cadence (~5 min) whether or not anything changed, by read-open-compare-`expect`: a daemon
  writes only an observation newer than the one stored, so the record keeps the newest
  observation, not the last write. One key, not one per account — per-account writes would
  tell the relay when each account is in use. Why it is needed, not just nice: the kept-status
  fold (M2) holds an account's quota only as long as some machine's own snapshot does. Each
  daemon writes over its own, so the fleet's newest reading lives only on the machine that saw
  it, and a `forget`, a reinstall or a machine retired takes that reading with it. Persisting
  `SessionQuota` (DESIGN.md, "Session events") stops a restart regressing it, and does nothing
  for those. The record makes the newest observation a fleet fact rather than a machine's.
  Its other payoff is `status` shrinking to pressure, which frees most of the 2 KiB socket
  attachment; its cost is a daemon write path into the store and a 5-min floor on freshness,
  where `status` is faster — so readers fold both, newest wins, as they fold statuses today.
- **Auth health** — `authOk` says only that `.claude.json` names an `oauthAccount`: a revoked
  or lapsed login still reads as signed in, and the `auth missing` filter routes to an exclave
  that cannot start a session. Per exclave `auth: ok | expired | unknown` with its observed-at,
  carried in `status`, not the register blob (a change there re-registers and drops the status,
  #102). Filter widens to "missing **or expired**"; `unknown` routes, since it is every exclave
  before its first poll. Signals:
  - _The OAuth poll's 401, read against the access token's `expiresAt`._ A 401 with
    `expiresAt` still ahead is `expired` (revoked or lapsed); a 401 after it is `unknown` —
    Claude Code refreshes on next use. **The daemon never refreshes**: refresh tokens rotate,
    so a daemon refresh would sign the exclave out of Claude Code. (`invalid_grant` comes only
    from the refresh endpoint, so it is never a signal here.)
  - _A session that died on auth_ — only if a hook surfaces it, which is unverified; check
    before relying on it.
  - _A `claude setup-token` token_ (`CLAUDE_CODE_OAUTH_TOKEN`) has the one predictable expiry;
    handled only if an exclave runs on one.

  `expired` clears to `unknown` when a rescan sees the exclave's `.claude.json` or credentials
  change (a `/login`); the next poll decides. PWA: "needs `/login`" on the exclave row; a Web
  Push beside the disk health alert. Exit: a revoked exclave is filtered `auth expired` and
  clears after `/login`; an expired access token alone never reads as `expired` (daemon).

- **CLI `auto`, and keyless MCP `auto`** — MCP's `auto` on a box that reads the key itself
  exists already (DESIGN.md "MCP server"; M3 item 6 moves it to the store). What remains:
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
   usage (current + this task's estimate + reservations), so with a 5% v1 estimate a new task
   is refused from ~85% current; and a window that resets within 15 min counts as empty for the
   filter, since a task started then runs almost entirely after the reset.
5. **`needs-input` escalation** after 30 min: re-alert once, keep the slot, never kill.
6. **Disk is a floor, not a load.** Under 1 GiB free (`status.free`) filters the machine out;
   above it disk adds nothing to the score. A fill level says how much upkeep a machine needs,
   not how busy it is — scored, an 85%-full idle disk would read as 85% busy and push work off
   it. The same series feeds M4's health alert, and the PWA shows no disk numbers.
7. **No age cap on a quota reading** beyond the reset rule. The 5h window bounds itself — a
   reading older than 5h is past its reset and reads 0% — so only the 7d window can drift, and
   only through use the fleet does not see. Fleet accounts are used almost only inside the
   fleet (the owner, 2026-10-16); the rare cloud session is a blip the next session report or
   OAuth poll overwrites. A cap would fail every time a machine sleeps past it, and on the
   account with the most headroom; no cap fails only on unseen use, for one dispatch, until the
   session's own `rate_limits` report (the session-events mod, M2 item 5) corrects it. Revisit with a 7d-only cap (~24h) if
   out-of-fleet use becomes routine.
8. **Score weights and the rest of `SchedulerConfig`** (set with the library, 2026-10-16;
   `scheduler/src/config.ts` is the copy that runs): weights account 1, machine 4,
   dependency 4, queue 1; sticky bonus 2; per-task estimate 5%; global max 8 in-flight
   tasks. Account pressure is the convex cost (1 at 50%, 16 at 80%) while the other three
   are fractions or counts, so the weights put one busy machine, or the farthest base, on
   the scale of an account near 70%. First guesses, to tune from decision records; nothing
   observed yet argues for them.
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
    whole queue lists in one 5 MiB frame with no paging. A task names its work ("implement this
    Linear issue, and here are the details") and the session gathers the rest with tools; 8K
    characters is far more than that takes. A direct spawn is not bound by it. Measured: a
    create with every field at its bound and the prompt in two-byte characters fits the create
    cap, and all a leader adds at every bound fits beside it with a 10-candidate decision; past
    that the leader cuts the stored decision. Raised from 32 KiB on 2026-10-17 (the M2 review):
    at 32 a full create left the leader no room for its own fields, and its first write would
    have been `too_large`, leaving the task `queued` for good.
12. **Running tasks are checked against their machines every 2 min** (`sweepIntervalMs`, set
    with the M2 review, 2026-10-17): the backstop for an `ended` event that never arrived,
    whose task would otherwise hold its slot for good. One `sessions` per connected machine
    holding running tasks, shared with the pass's other checks; a lost event costs at most
    two minutes of a slot, where a sweep every pass would cost a call per busy machine per
    status beat.

## Risks / unknowns

- **Bearer-token blast radius grows, by one act.** Today a token holder can register junk and
  delete registry entries, which DESIGN.md calls harmless because the daemon rebuilds them.
  Queued tasks are not rebuilt: a token holder can list the queue (ciphertext) and create junk
  (the leader skips what doesn't decrypt, as the PWA does for the registry). It still cannot
  read a prompt, forge a task, roll one back (version binding), or replay a deleted one
  (tombstones and the 30-day admit rule, M3 PR 0). Accepted: what is lost is a
  pointer to work, never the work or the repo it lives in; the remedy is the one that already
  exists (rotate). DESIGN.md's "destroys nothing that exists" paragraph gets this caveat.
  M4's account records add a smaller one: being app-writable, a token holder can delete an
  alias or overwrite it with junk that readers skip — but not read, forge or roll one back, and
  an alias is a label, retyped in a second. Holding the leader's term would be a larger act,
  and as planned it is not an edge case — next item.
- **Leader capture is routine. Decided for M2: readers ignore an unverifiable leader (B
  below); for M3's gate: the deploy-time allowlist, with the reader check kept.**
  Earliest `connectedAt` wins, and `roles` is the only other gate. Device ids are
  self-certifying, so anyone with the bearer token can mint one, sign a valid register with
  `roles: ["scheduler"]` and hold one socket open. A real leader's socket is replaced after
  every laptop sleep or network change, resetting its `connectedAt`; the squatter's never
  resets. So the first sleep, network change or relay deploy that drops the leader's socket
  makes the squatter the earliest-connected capable daemon, with no reconnect storm needed —
  the assumption this item used to rest on. Holding the term it can
  delete every task (overwrite and delete are leader-only and term-fenced, so the fence now
  protects the squatter) or simply never dispatch. Two ways to close it:
  - _A deploy-time allowlist._ A wrangler var (say `SCHEDULER_LEADERS`: device ids, not a
    secret) names the daemons the relay may nominate; unset, it nominates no one. Register
    verification already proves a socket is the machine its device id names, so the relay can
    enforce this alone, before anything acts on the term. Cost: a new leader-capable machine
    is a config change and a relay deploy, after reading its device id off `seanced doctor`.
  - _Readers ignore an unverifiable leader._ Apps and daemons treat a nominated leader whose
    registry entry does not open — `info` sealed `from` its own device id, the rule that
    already decides which entries become a `Machine` — as no leader. No config, nothing to
    deploy. But it changes only what readers believe: the relay still holds the term for the
    squatter, so its `store-put` and `store-delete` still succeed, and no honest daemon can
    lead until the squatter's socket goes. It turns a silent stall into a visible one and
    stops apps sending it requests; it does not protect the queue.

  **Decision (owner, 2026-10-16): the reader check for M2.** M2 has no store — the queue is
  in-memory on the leader — so what a squatter's term can do there is hold `auto` unavailable
  until its socket goes, and the reader check makes that visible ("leader unverified") instead
  of a silent stall. It cannot read a prompt, forge a spawn or open an event: everything it
  would receive is sealed under the PSK it lacks. M3 changes that: term-fenced `store-put` and
  `store-delete` would let it delete the queue, and only a check in the relay — the one party
  that acts on the term — stops that. So the question reopens as M3's gate; the allowlist is
  the standing recommendation, with the reader check kept as its tripwire (an allowlisted seed
  copied out of `state.json` without the PSK then reads "leader unverified").

  **Decision (owner, 2026-10-16, M3 gate): the allowlist, as a secret; the reader check
  kept.** `SCHEDULER_LEADERS` is a Worker secret (`wrangler secret put`), not a var — not
  because ids are secret, but so a CI deploy never overwrites it and no ids sit in git. Unset
  or empty nominates nobody; there is no wildcard. The cost is as planned, plus one effect of
  the mechanism: adding a leader-capable machine is a `wrangler secret put` with its id off
  `seanced doctor`, which rolls a new relay version, so every socket drops and re-registers.
  What remains open is the allowlist's own trust — whoever can put secrets on the Cloudflare
  account, who could already replace the relay — and a listed machine's stolen seed, which the
  reader check catches unless the PSK went with it. Built and recorded in DESIGN.md
  (_Scheduler_, "Leadership"; _Threat model_, item 3).

- **Prompts at rest on Cloudflare.** Sealed under the PSK like `info`, and ciphertext length is
  unpadded, so the relay bounds prompt length — the same concession as live frames.
- **OAuth usage endpoint** is unofficial; reading tokens per config dir differs by platform
  (macOS keychain entry naming per config dir is unverified). Session reports are the floor.
- **Session `rate_limits` cadence** (was: statusline cadence). The tap is `session.measure`,
  not the statusline, so it reports after each turn and when a window moves a point, rendered
  or not. An idle session still reports nothing new, which the reset floor and M4's OAuth poll
  cover.
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
