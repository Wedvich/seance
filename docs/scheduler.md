# Séance scheduler — plan

**Status: plan, M1 done, M2 next.** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview; placement revised 2026-10-15 (below). Folds into DESIGN.md
(new section "Scheduler") as each milestone lands; until then this file is the working record and
DESIGN.md describes what exists. M1 (visibility: exclaves, telemetry, the `status` frame, the
`metrics` op, the PWA's Machines screen) folded in on 2026-10-15, and its plan text is gone from
here — DESIGN.md is the record for anything M1 built.

## Glossary

One word per thing. The wire names in `shared/src/types.ts` are older than this table and
stay as they are; the table says which word each one means.

| Term    | Meaning                                                                                                                                                                                                                                                                                                                                             | On the wire / in code                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| machine | A box running one `seanced`: the unit of presence, pressure and dispatch                                                                                                                                                                                                                                                                            | `deviceId` is its routing key, `MachineInfo` its blob   |
| exclave | A tree at `~/<name>` whose Claude Code config dir is `~/.claude-<name>`, signed into one account; `default` is `~` with `~/.claude`. Séance depends on those three attributes and the `~/.exclaves` contract below, nothing else an exclave carries (git identity, browser profile) is its business. Never "workspace", which is a Bun package here | `exclaves[]` in the register blob, `exclave` on a clone |
| account | The billed Claude identity an exclave is signed into; the 5h/7d quota attaches here. Never "subscription", which is the plan that account is on, and never the email                                                                                                                                                                                | `accountId` = `organizationUuid:accountUuid`            |
| repo    | A repository as a logical thing, the same across machines: what a task names. Keyed by normalized `origin`, basename when there is no remote                                                                                                                                                                                                        | `tasks.repo`, `RepoEntry.origin`                        |
| clone   | One machine's checkout of a repo, inside one exclave, under a machine-local, collision-disambiguated name. What `spawn` takes                                                                                                                                                                                                                       | `RepoEntry`, `spawn { repo }` (historical name)         |
| session | One Claude Code process in one tmux pane, spawned in a clone                                                                                                                                                                                                                                                                                        | pane id, `sessions` op                                  |
| task    | A unit of queued work: repo + prompt + spawn opts, with deps and a state. Becomes a session when dispatched                                                                                                                                                                                                                                         | `task:<id>` in the store, `taskId` on spawn             |
| leader  | The daemon currently nominated to run the scheduler loop                                                                                                                                                                                                                                                                                            | `lead`/`follow`, `scheduler:term`                       |

## Decisions (from the interview, placement revised 2026-10-15)

| Topic             | Decision                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement         | **Queue lives in the relay's DO as sealed blobs; the loop runs on a relay-nominated daemon.** No standalone process, no new PSK holder. `scheduler/` is a pure library the daemon hosts behind two adapter interfaces, so it can move to a fixed box later without a rewrite        |
| Exclave           | Derived: `default` (`~/.claude`) + one per line of `~/.exclaves` (`~/<name>`, `~/.claude-<name>`). Reported per repo in the register blob, and as the blob's `MachineInfo.exclaves` list (account, auth, skills); a repo's location decides its config dir, so `spawn` is unchanged |
| Spawn contract    | Unchanged apart from optional `baseBranch` and `taskId`. Scheduler resolves "repo X" → (machine, clone) and calls the existing `spawn`                                                                                                                                              |
| Account id        | `organizationUuid:accountUuid` from `<configDir>/.claude.json` (`~/.claude.json` for `default`) — never the email                                                                                                                                                                   |
| Quota telemetry   | Layered: session-reported `rate_limits` → OAuth usage endpoint when stale → the config dir's `cachedUsageUtilization` (M1's only source) → last value + `resets_at` floor                                                                                                           |
| Task              | Free-form (repo + prompt + spawn opts), optional Linear link                                                                                                                                                                                                                        |
| Deps              | Per edge `after: opened` (stacked, default) or `after: merged`; Linear relations + hand-declared                                                                                                                                                                                    |
| Done signal       | Layered: PR merged (daemon, local git) / Linear Done → session ended → manual                                                                                                                                                                                                       |
| Quota exhausted   | Spill into credits, loudly (Web Push), with pause: until resume / until next reset                                                                                                                                                                                                  |
| Concurrency       | Global max, per-account max, per-batch strategy (`sequential` / `parallel(n)` / `auto`)                                                                                                                                                                                             |
| Alerts            | Web Push (VAPID) from the leader to subscribed PWAs (M4; key sealed in the DO, see _Secrets_)                                                                                                                                                                                       |
| Needs input       | `needs-input` state, alert, keeps its slot; idle timeout escalates, never kills                                                                                                                                                                                                     |
| Event ingest      | New ingest-only `session-event` frame kind on the local socket, after the fleet broker's precedent (threat-model widening, recorded)                                                                                                                                                |
| Proxmox           | Machine pressure = max(container cgroup view, Proxmox node via API); the LXC daemon reads the node view itself and folds it into its own `status`, so no reader needs Proxmox reach                                                                                                 |
| Telemetry         | Current snapshot (pressure + latest quota) rides the relay as a sealed `status` frame held on the daemon's socket attachment and pushed to apps + the leader. History stays on each daemon behind a `metrics` op. Neither the relay nor the scheduler stores telemetry              |
| At rest           | The queue is sealed envelopes in DO storage: the relay holds id, version and ciphertext, nothing else. No second at-rest scheme                                                                                                                                                     |
| Skills            | Hard filter when declared or prompt starts with `/name`; otherwise informational (+ PWA autocomplete)                                                                                                                                                                               |
| Clients           | PWA in v1; op set designed so MCP, Raycast and CLI attach later without protocol change                                                                                                                                                                                             |
| Manual spawn      | Both: `auto` → scheduler; picking a machine → direct to daemon (works with no leader)                                                                                                                                                                                               |
| Handoff           | Dependent task gets a preamble: predecessor title, branch, PR URL, transcript path (same machine only)                                                                                                                                                                              |
| AI dep classifier | Later; dependency sources are pluggable                                                                                                                                                                                                                                             |
| Slicing           | M1 visibility → M2 routing + leadership → M3 durable queue → M4 refinement (independent items)                                                                                                                                                                                      |

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

No new kind of PSK holder. The leader is an ordinary daemon with two extra legs: a queue-store
client on its daemon socket and an app-role client (the fleet broker's precedent) to receive
registry and `status` pushes and to address other daemons. That client is the leader's own
and long-lived, not the broker's idle-closing `LazyRelay` (Daemon changes, `leader.ts`).

## Wire changes

All shapes land in `shared/src/types.ts` first (schema of record); DESIGN.md's frame→module
table gains rows.

**Relay (`hub.ts`, `wire.ts`, `index.ts`)**

- **Leadership.** `register` gains a plaintext `roles?: ["scheduler"]` — the one capability the
  relay must read, since it is what it nominates on; an old daemon sends none and is never
  nominated. **`roles` joins the signed message**, and so does any other register field the
  relay comes to act on: `registerMessage` (`shared/src/identity.ts`) covers only
  `seance-register|deviceId|ts`, so today a register's signature vouches for the route and for
  nothing else in the frame. The extended message takes a new domain tag
  (`seance-register-v2|deviceId|ts|roles`), so a v1 register still verifies — as a daemon with
  no roles, never nominated. After every daemon connect, close and sweep the relay
  re-evaluates: the leader is the capable connected daemon socket with the earliest
  `connectedAt` (tie: lowest `deviceId`), where capable is signed `roles` plus whichever
  capture guard Risks settles on (_Leader capture_). **Nomination is a pure module**,
  `relay/src/leadership.ts`: the candidates' `{ deviceId, roles, connectedAt }` and the
  current leader in, the next leader out, with its own suite that needs no workerd. `hub.ts`
  (580 lines already) only calls it from its connect, close and sweep paths and applies the
  result. A change bumps `scheduler:term` (DO storage, monotonic) and sends `lead { term }` to
  the new leader and `follow` to the old one if still connected. Term is a fencing token: a leader that
  was demoted while partitioned still holds a socket and may still write, so every leader write
  carries its term and the relay refuses a stale one with `not_leader`. Nomination is the only
  election; daemons never vote.
- **Queue store ops** on the daemon leg (leader) and app leg: `queue-list` → `[{ id, version,
env }]`, `queue-put { id, expect, env, term? }` → `{ version }` or `version_conflict`,
  `queue-delete { id, expect, term }`. Values live at `task:<id>` as `{ version, env }`; `version`
  starts at 1 on create and increments per put. Apps may `queue-list` and create (`expect: 0`)
  so enqueue works with no leader; every overwrite and delete is term-fenced, leader-only.
  Bounds in `wire.ts`: ids as for `deviceId`, `env.ct` under the existing 64 KiB cap (a DO value
  caps at 128 KiB), `MAX_TASKS` like `MAX_DEVICES`, and a create rate floor per socket.
- **Version binding closes rollback.** Anything with the bearer token can list the queue, keep a
  task's old sealed blob and put it back — authentic bytes, stale state (a cancelled task back to
  `ready`). So the sealed body carries the `version` its put will produce, and every reader
  rejects a blob whose inner version disagrees with the relay's. A replayed blob then fails like
  a forged one. `version_conflict` is the only other way a put fails.
- **Stored blobs are an at-rest format, not live frames.** Their `op` is `task`, sealed to
  `"scheduler"`, opened _without_ the `ReplayGuard` — exactly as `parseMachineInfo` consumers
  already open the register blob — and never accepted on a live routing path. Keeping the op
  distinct is what stops a stored task being replayed as a request.
- Envelopes `to: "scheduler"` route to the leader's socket; no leader → `undeliverable { code:
"offline" }` to apps, dropped for daemon-origin events. `SCHEDULER_ID = "scheduler"` is
  reserved, refused by `register` like `"app"`/`"machines"`.
- Registry push to apps gains `scheduler: { deviceId, term } | null` so the PWA can grey out
  `auto` without a round trip.
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

| Op              | Cadence                      | Payload (sketch)                                                                              |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `session-event` | on event, coalesced ≤1/5s    | session id, task id, exclave, state (`busy`/`idle`/`needs-input`/`ended`), PR URL seen, skill |
| `branch-state`  | on change, for task branches | repo, branch, `pushed`, `merged` (reap-git's rules)                                           |

A leader change loses nothing here: every event is also reflected in the daemon's `sessions`
reply, which the new leader reconciles against on takeover (below). The session and task ids
in a `session-event` are the daemon's own, from its pane map, never copied from what the mod
sent (Daemon changes, local socket).

**Scheduler → daemon**: existing `spawn`/`sessions`/`despawn`, addressed from `"scheduler"` by
the leader's app-role leg. Daemon replies to `env.from` already (`#onEnvelope` seals through `#sealReply` in `relay-client.ts`), so no
reply-path change.

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
client=scheduler`; task ↔ session correlation is `taskId`.

**App → scheduler ops** (request/response, PWA via `RelayClient`, routed to the leader):
`queue` (list + decisions), `cancel`, `mark-done`, `pause`/`resume` (`until: "resume" |
"reset"`), `route-preview` (dry-run explanation), `push-subscribe`. `enqueue` is _not_ a
leader op: the app seals the task and `queue-put`s it at `expect: 0`, so queuing works with
no leader and the next one picks it up. Scheduler → app: `queue-changed` push to `"app"`
(broadcast, apps re-fetch) — no polling.

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
- `quota.ts` (M4): OAuth usage poll per exclave when the newest session report is older than
  `quota.staleAfter` (default 10m). **Token never leaves the daemon process** — same invariant
  class as the service-delivered PSK. Failure is quiet and non-fatal (unofficial endpoint).
- Local socket: `session-event` as its own frame kind, never a `Plain` or an `OpName` — the
  precedent the fleet broker set (DESIGN.md "Fleet broker"), so it can't arrive from the relay
  and no op can be smuggled in as one. Ingest-only: the handler may store and forward, may not
  spawn, despawn, or exec. DESIGN.md "Local op socket" + threat model updated.
  **Every field of an event is untrusted.** The socket checks only the OS user (the 0700 run
  directory), and every spawned session is that user, so any session — or anything it runs —
  can write an event naming any session or task. The daemon binds an event to a pane itself,
  from the connecting peer's pid walked up to a pane's `pane_pid`, and takes session and task
  from its own pane map (the `taskId` it recorded at spawn), never from ids in the event.
  Whether Bun surfaces a unix socket's peer pid is unverified; without it the pane is the
  event's claim, and what remains — one same-uid process mislabelling another session's state
  on its own machine — is the residual the threat model records. A PR URL is kept only if it
  parses as an `https:` URL, checked before it can become an `href` in the PWA or text in a
  Web Push.
- `claude-mods/session-events`: hooks (`SessionStart`, `Stop`, `Notification`,
  `UserPromptSubmit`, `SessionEnd`, `PostToolUse` matching PR-create output) + statusline tap
  for `rate_limits` → local socket. This is also the phase-2 bus.
- **`leader.ts` — the scheduler role.** Advertises `roles: ["scheduler"]` on register. On
  `lead { term }`: open the leader's app-role leg, build the two adapters (below), take over
  (reconcile reservations against `sessions`), run the loop. **The leg is persistent**: a
  `RelayClient` of the leader's own, with its own `ReplayGuard`, held for the whole term. Not
  `LazyRelay` (`daemon/src/app-relay.ts`), which hangs up after 5 minutes idle and redials on
  the next call — right for a Claude session that calls hours apart, wrong for a loop that must
  hear every registry and `status` push between its own calls — and not shared with the
  broker, so neither lifecycle can end the other's socket. On `follow`, socket loss or
  `not_leader`: stop the loop, stop that client, drop the adapters, leak nothing — the broker's
  lifecycle discipline: no timer, listener or socket outlives the term.
  Nothing else in the daemon imports `scheduler/`. The daemon's own relay socket is still
  daemon-role; the leader addresses other machines only through its app-role leg, and may
  address itself only through the local op path (the broker's rule).

## Scheduler (`scheduler/`)

**A pure library, no I/O of its own.** It owns the task state machine, filter, score,
stickiness, reservations and decision records over plain inputs, and depends on two small
interfaces. Whoever hosts it supplies both; the library never learns which. This is what makes
the placement decision reversible: moving the scheduler to a fixed box later is two new
adapter implementations (SQLite store, own app-role client) and no change here.

- `QueueStore`: `list()`, `put(id, expect, body)`, `delete(id, expect)` over sealed task
  bodies, with `version_conflict` surfaced as a value. Daemon adapter: the relay's `queue-*`
  ops, sealing/opening with the daemon's already-imported `CryptoKey`, carrying its term.
- `Fleet`: a registry + `status` feed, and `spawn`/`sessions`/`despawn` to a `deviceId`.
  Daemon adapter: the leader's own long-lived app-role `RelayClient` (`leader.ts`, above).

Tests run the library against in-memory fakes of both; the daemon suite proves the adapters
against `daemon/test/harness.ts`; the e2e suite proves the store against the real DO.

**State (in the store, one sealed body per task):** prompt, title, repo (`origin`),
spawn opts, batch, deps, state, assignment (`deviceId`, pane, `taskId`), reservation
(`deviceId`, `expiresAt`), decision (every scoring component), lineage. Machines, exclaves,
resources and quota come from the fleet feed and are persisted nowhere. `settings` and
`push_subs` are two more sealed keys. A leader change loses only the in-memory view.

**Task states:** `queued → blocked → ready → reserved → running → needs-input ⇄ running →
awaiting-merge → done` with `failed`, `cancelled` off-path. `awaiting-merge` frees the
concurrency slot (session ended) but keeps `after: merged` dependents blocked.

**Takeover** (on `lead`): list the store, open every body (skip and report non-decrypting or
version-mismatched ones, as the PWA skips registry entries), then for each `reserved` or
`running` task ask `sessions` on its machine: a session carrying the `taskId` → `running` with
that pane; none and the reservation is unexpired → keep waiting; none and expired → release
and re-route. Only then does the loop start dispatching.

```
                 registry + status (per machine)        task (sealed body)
                 exclaves · clones · skills · caps       repo · deps · pin · skill · lineage
                              │                                   │
                              ▼                                   ▼
 every clone of the task's   ─┬─► 1 FILTER ──► drop, with a reason ──────────────────────┐
 repo, on any machine         │   offline/stale · no taskId · auth missing · repo absent   │
                              │   skill absent · pin mismatch · base unpushed             │
                              │   free disk < 1 GiB · account quota unknown               │
                              │   account over threshold ∧ credits off · cap reached      │
                              │                                                           │
                              └─► 2 SCORE  (lower wins, weights in config)                │
                                  account_pressure       max(f(5h), g(7d)), ÷ time-to-reset
                                  machine_pressure       max(cpu, mem, host)              │
                                  dependency_distance    0 same exclave … 0.5 elsewhere   │
                                  queue_pressure                                          │
                                      │                                                   │
                                      ▼                                                   │
                                  3 STICKY  lineage owner bonus (continuations only)      │
                                      │                                                   │
                                      ▼                                                   ▼
                                  4 RESERVE ──► queue-put ──► spawn { taskId } ──► 5 RECORD decision
                                  TTL 120s      (one write)   task_running /       chose X because …
                                                              failure → release    rejected Y because …
```

**Routing (per ready task, on any state change + a 30s tick while ready tasks exist)**, from
the latest `status` per machine; a snapshot `isStatusStale` calls stale (older than 90s) counts as unknown and the machine
is filtered for new work:

1. _Filter_ (structured rejection reasons): machine offline/stale; `taskId` unsupported;
   free disk under 1 GiB; account quota unknown; exclave auth missing; repo absent in exclave; required skill absent; pin mismatch;
   stacked base unpushed and not on this exclave; projected account usage over the 90% line (a window resetting within 15 min counts as empty) **and**
   extra usage disabled; per-account / global cap reached.
2. _Score_ (lower wins, weights in config):
   `account_pressure` = max(f(projected 5h), g(projected 7d)), convex, discounted by
   time-to-reset; `machine_pressure` = max(cpu, mem, host) for LXCs — disk is the filter's
   floor, never a score;
   `dependency_distance` (0 same exclave … 0.5 pushed elsewhere); `queue_pressure`.
3. _Stickiness_: lineage owner bonus; only matters for continuations.
4. _Reserve_ (one store write) then dispatch with `taskId`; reservation TTL 120s; spawn failure
   or `task_running` from a stale read both resolve the reservation without a second spawn.
5. _Record_ the decision with every component; PWA renders "chose X because …, rejected Y
   because …".

Projected usage counts reservations + running scheduler tasks (fixed per-task estimate in v1,
tuned later from observed deltas per task). Current usage is read exactly as the PWA's account
cards read it — the newest observation per account across the fleet, a window past its reset
counting as 0% — from the one copy of both rules, `newestQuotaByAccount` and `effectivePct` in
`shared/src/quota.ts`.

**Missing quota is unknown, never 0%.** An account is scored only on a reading it actually has.
It is filtered `quota unknown` when no fresh status carries an observation for it (statuses
`isStatusStale` reports as stale are left out of the fold), or when a status from a machine
hosting it is trimmed (`isQuotaTrimmed`) and does not carry it — trimming may have dropped
exactly the reading that said the account was full. Reading either case as 0% would route the
most work to the account the scheduler knows least about.

**Credits spill:** dispatching to an account past the hard threshold with extra usage on
fires a Web Push ("Spending credits on <account> for <task>" + Pause actions). Re-alerts once per
account per window, not per task.

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

### M2 — routing and leadership

**Goal.** A PWA spawn with `auto` lands on the machine and exclave the scheduler chose, with
the decision explained, and the role survives the leading machine going away. No durable
queue yet.

**Lands, in order.**

1. `scheduler/` library + in-memory fakes of `QueueStore` and `Fleet`; filter / score /
   sticky / reserve / record over fixtures. No wire change — depends only on M1's schema. Includes the layering test: nothing in `scheduler/`
   imports `daemon/`, and nothing in `daemon/` imports `scheduler/` except `leader.ts`.
2. Relay leadership — `roles` on `register`, inside the signed message (v2 domain tag);
   nomination as the pure `relay/src/leadership.ts`, called from `hub.ts` on connect, close and
   sweep; the leader-capture guard, once Risks has it decided; `scheduler:term`, `lead`/`follow`,
   `not_leader` on a stale term, `scheduler: { deviceId,
term } | null` in the registry push.
3. `leader.ts` — the leader's own persistent app-role `RelayClient` (not `LazyRelay`) and the
   `Fleet` adapter over it, lifecycle on `lead` / `follow` / socket loss, leaking nothing on
   demotion. `QueueStore` is the in-memory fake for this milestone.
4. `taskId` on `spawn`, `task_running`, `taskId` in `sessions`; advertised in `capabilities`.
5. `session-event` on the local socket + `claude-mods/session-events`; the daemon binds each
   event to a pane and takes session and task from its own pane map, keeps only `https:` PR
   URLs, and forwards to the leader sealed to `"scheduler"`.
6. PWA — `auto` in the picker (greyed with no leader), `route-preview` and the decision view.

**Exit.**

- Two daemons up: an `auto` spawn lands on the one whose decision record says so, and the
  record names why the other was rejected or scored lower (e2e).
- Kill the leader's daemon: a new leader is nominated within one sweep, `auto` greys and
  returns, the term increased (relay + e2e).
- A demoted leader's write or dispatch is refused `not_leader` (relay).
- A second `spawn` with a `taskId` the daemon already runs is refused `task_running` with the
  existing pane (daemon).
- A `session-event` from the mod reaches the leader's state (daemon + e2e).
- A daemon without `roles` is never nominated; one without `taskId` in `capabilities` is never
  reserved against (relay, scheduler).
- Nomination, re-nomination and the `deviceId` tie reproduce over plain inputs in
  `leadership.ts`'s own suite, without workerd (relay).
- A register whose `roles` the signature does not cover is never nominated; a bearer-token
  holder's socket that connected first holds no term the fleet acts on — tested against
  whichever capture guard Risks settles on (relay, e2e).
- A `session-event` naming another session or task moves only the state the daemon's own pane
  map attributes to the sender; a non-`https:` PR URL never reaches the PWA or a push (daemon).
- The leader's app-role leg stays up through more than `LazyRelay`'s idle window with no
  calls, and nothing of it survives `follow` (daemon).
- An account with no fresh observation, or trimmed out of a status that hosts it, is filtered
  `quota unknown` and never scored as 0% (scheduler).
- Library suite: every filter reason, every score component and stickiness reproduce the
  fixture decisions; the layering test fails on either forbidden import (scheduler).

**Gaps.** The queue is in-memory on the leader: a leader change forgets `auto` spawns not yet
dispatched (sessions already running are ordinary sessions and survive). No deps, no batches,
no caps beyond the global max, no pause, no alerts. An account nothing has observed yet — an
exclave before its first session — is `quota unknown` and gets no `auto` work until a direct
spawn or a session report gives it a reading; M4's OAuth poll closes this.

**Record.** DESIGN.md gains a _Scheduler_ section (leadership and term, nomination in
`leadership.ts`, library and adapters, `taskId` idempotency, quota unknown), _Local op socket_
(the `session-event` frame kind), _Threat model_ (plaintext but signed `roles`, the
leader-capture guard, term fencing, the mod as an ingest-only path whose every field is
untrusted), _Wire protocol_ rows.

### M3 — durable queue

**Goal.** Queue a block of work with dependencies and leave; it runs, survives leader changes,
and finishes without anyone watching.

**Lands, in order.**

1. Relay store — `queue-list` / `queue-put` / `queue-delete`, `task:<id>` as `{ version, env }`,
   term-fenced writes, `expect: 0` creates on the app leg, `MAX_TASKS`, create rate floor.
2. The at-rest `task` op and version binding — sealed body carries the version its put
   produces; readers open without the `ReplayGuard` and reject a mismatch.
3. `QueueStore` adapter on those ops; takeover reconciliation against `sessions`.
4. Task states, batches, hand-declared deps (`after: opened` / `merged`), done detection via
   `branch-state`, `awaiting-merge`.
5. Caps (global, per account), `pause` / `resume`, `needs-input` + 30-min escalation,
   credits-spill detection (logged and shown in the PWA; the push alert is M4).
6. PWA queue — enqueue, cancel, mark-done, pause; `queue-changed` push.

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
  fatal (scheduler).
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
- **OAuth quota poll** — `quota.ts`, token never leaves the daemon. Exit: an idle exclave's
  quota refreshes within `staleAfter`; a failing endpoint is quiet.
- **Skills** — hard filter on declared or `/name` prompts, PWA autocomplete.
- **Proxmox node view** — read by the LXC daemons, folded into their own `status`.
- **Sealed `settings` + Web Push** — VAPID keypair in the store under the PSK, the
  credits-spill and needs-input alerts, `push-subscribe`; also a machine health alert (disk
  nearly full, from the `disk_pct`/`disk_free_mib` series M1 already stores — the PWA shows no
  disk numbers, since a fill level is upkeep rather than load).
- **Linear** — key in `settings`; relation-derived deps and Done as a done signal.

## Settled defaults (interview, 2026-10-15)

Nothing below is open. An implementer who wants a different value changes this section in the
same PR, with the reason.

1. **Leader** = earliest-connected capable daemon, ties by `deviceId`; nomination only, no
   voting. The ordering is settled; what makes a daemon capable beyond signed `roles` is not
   (Risks, _Leader capture_).
2. **Enqueue needs no leader.** Apps create tasks in the store at `expect: 0`; everything else
   waits for one. Matters only for old daemons and the ≤ ~90s re-nomination gap, and costs
   nothing (a token holder could already fill the registry with junk).
3. **Audit** as `origin=relay client=scheduler`, not a new origin — the daemon-side surface is
   still the relay, and `client` is what already tells the PWA, MCP and Raycast apart.
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

## Risks / unknowns

- **Bearer-token blast radius grows, by one act.** Today a token holder can register junk and
  delete registry entries, which DESIGN.md calls harmless because the daemon rebuilds them.
  Queued tasks are not rebuilt: a token holder can list the queue (ciphertext) and create junk
  (the leader skips what doesn't decrypt, as the PWA does for the registry). It still cannot
  read a prompt, forge a task, or roll one back (version binding). Accepted: what is lost is a
  pointer to work, never the work or the repo it lives in; the remedy is the one that already
  exists (rotate). DESIGN.md's "destroys nothing that exists" paragraph gets this caveat.
  Holding the leader's term would be a second, larger act, and as planned it is not an edge
  case — next item.
- **Leader capture is routine. Open: the owner decides before M2's relay leadership lands.**
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
    squatter, so its `queue-put` and `queue-delete` still succeed, and no honest daemon can
    lead until the squatter's socket goes. It turns a silent stall into a visible one and
    stops apps sending it requests; it does not protect the queue.

  **Recommendation: the allowlist.** The relay is the only party that acts on the term, so
  only a check in the relay keeps a squatter from holding one. The reader-side check is a
  cheap tripwire on top — an allowlisted seed copied out of `state.json` without the PSK
  (a separate secret on a keychain, DPAPI or TPM install) then reads "leader unverified" rather
  than a stalled queue — but no substitute. The choice lands in _Settled defaults_ and
  DESIGN.md's threat model.

- **Prompts at rest on Cloudflare.** Sealed under the PSK like `info`, and ciphertext length is
  unpadded, so the relay bounds prompt length — the same concession as live frames.
- **OAuth usage endpoint** is unofficial; reading tokens per config dir differs by platform
  (macOS keychain entry naming per config dir is unverified). Session reports are the floor.
- **Statusline `rate_limits` cadence**: only refreshed when the statusline renders; an idle
  session reports nothing new.
- **Stacked rebases**: when A changes in review, B's branch drifts. v1 does nothing
  automatic; the dependent's preamble names the base so the session can rebase.
- **Daemons on old versions** report no `exclaves`/`origin`/`taskId`. The scheduler treats
  such a machine as ineligible for `auto` (it can't know which account a spawn would bill,
  and can't dedupe a re-dispatch), while direct spawns to it keep working. Self-update makes
  this a short window.
- **Reversibility is only as real as the adapter boundary.** If daemon code starts reaching into
  `scheduler/` internals, or the library grows an import from `daemon/`, the move to a fixed
  box becomes the rewrite this design exists to avoid. Enforce it the way `raycast/` enforces
  its layering: a test that fails the build on either import direction.
