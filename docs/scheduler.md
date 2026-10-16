# Séance scheduler — plan

**Status: plan, M1 done, M2 in progress (items marked **Landed** under M2 are built).** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview; placement revised 2026-10-15 (below). Folds into DESIGN.md
(new section "Scheduler") as each milestone lands; until then this file is the working record and
DESIGN.md describes what exists. M1 (visibility: exclaves, telemetry, the `status` frame, the
`metrics` op, the PWA's Machines screen) folded in on 2026-10-15, and its plan text is gone from
here — DESIGN.md is the record for anything M1 built.

## Glossary

One word per thing. The wire names in `shared/src/types.ts` are older than this table and
stay as they are; the table says which word each one means.

| Term    | Meaning                                                                                                                                                                                                                                                                                                                                             | On the wire / in code                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| machine | A box running one `seanced`: the unit of presence, pressure and dispatch                                                                                                                                                                                                                                                                            | `deviceId` is its routing key, `MachineInfo` its blob                                       |
| exclave | A tree at `~/<name>` whose Claude Code config dir is `~/.claude-<name>`, signed into one account; `default` is `~` with `~/.claude`. Séance depends on those three attributes and the `~/.exclaves` contract below, nothing else an exclave carries (git identity, browser profile) is its business. Never "workspace", which is a Bun package here | `exclaves[]` in the register blob, `exclave` on a clone                                     |
| account | The billed Claude identity an exclave is signed into; the 5h/7d quota attaches here. Never "subscription", which is the plan that account is on, and never the email                                                                                                                                                                                | `accountId` = `organizationUuid:accountUuid`; `account:<hmac>` its record in the store (M4) |
| repo    | A repository as a logical thing, the same across machines: what a task names. Keyed by normalized `origin`, basename when there is no remote                                                                                                                                                                                                        | `tasks.repo`, `RepoEntry.origin`                                                            |
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
| Quota telemetry   | Layered: session-reported `rate_limits` → OAuth usage endpoint when stale → the config dir's `cachedUsageUtilization` (M1's only source) → last value + `resets_at` floor                                                                                                                                                                                                                   |
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
table gains rows.

**Relay (`hub.ts`, `wire.ts`, `index.ts`)**

- **Leadership — landed 2026-10-16 (M2 item 2); DESIGN.md _Scheduler_, "Leadership", is the
  record.** Signed `roles` on `register` (v2 domain tag; v1 registers roleless), nomination in
  the pure `relay/src/leadership.ts` called from `hub.ts`'s register, close and sweep paths,
  `scheduler:term` in DO storage, `lead`/`follow`, and the term fence. Decided while building
  it, beyond what this plan said: a current leader keeps the role across its own reconnect
  (the term still bumps, since its socket changed); `not_leader` is an `undeliverable` code,
  answered by `iv` to an app-leg `msg` sent `from: "scheduler"` whose `term` is stale or
  missing; and a daemon whose v2 register is refused alternates to v1, so one that updated ahead
  of its relay is not locked out. Every leader write in M3 carries its term through the same
  check.
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
  | `account:<hmac>` | any app         | any app, by `expect` (CAS) | no          | M4    |

  Tasks: apps may list and create (`expect: 0`) so enqueue works with no leader; every
  overwrite and delete is the leader's. App-writable records exist for state a person edits from
  any client with no leader up — an account's alias first; whether M4's `settings` is one is
  M4's call. Bounds in `wire.ts`: keys as for `deviceId` plus their prefix, `env.ct` under the
  existing 64 KiB cap (a DO value caps at 128 KiB), `MAX_TASKS` and `MAX_RECORDS` like
  `MAX_DEVICES`, and a create rate floor per socket.

- **Version binding closes rollback.** Anything with the bearer token can list the queue, keep a
  task's old sealed blob and put it back — authentic bytes, stale state (a cancelled task back to
  `ready`). So the sealed body carries the `version` its put will produce, and every reader
  rejects a blob whose inner version disagrees with the relay's. A replayed blob then fails like
  a forged one. `version_conflict` is the only other way a put fails.
- **Stored blobs are an at-rest format, not live frames.** Their `op` is the record's kind —
  `task` sealed to `"scheduler"`, `account` to `"app"` — opened _without_ the `ReplayGuard`
  through `openAtRest` — exactly as the register blob and `status` already are — and never
  accepted on a live routing path. Keeping the op distinct per kind is what stops a stored
  record being replayed as a request, or as a record of another kind.
- **Last `status` kept** (landed in M2, item 7; DESIGN.md _Presence & identity_). The close
  or sweep put that writes an entry's `lastSeen` keeps the socket's last `status` with it, the
  registry push carries it for an offline machine, and a `register` clears it. Readers take
  quota from it, never pressure (Routing, _quota freshness_): `newestQuotaByAccount` folds it,
  and pressure goes through `liveStatus`, which answers only while `connected`.
- Envelopes `to: "scheduler"`, the reserved `SCHEDULER_ID`, and the registry push's
  `scheduler: { deviceId, term } | null` landed with leadership (above). The push's field is
  null unless the recorded leader is connected; the app-role client does not read it yet (item
  6).
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
leader op: the app seals the task and `store-put`s it at `expect: 0`, so queuing works with
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
- `daemon/src/oauth-quota.ts` (M4; not `shared/src/quota.ts`, the fleet fold readers
  share): OAuth usage poll per exclave when the newest session report is older than
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

- `QueueStore`: `list()`, `get(id)`, `put(id, expect, body)`, `delete(id, expect)` over sealed task
  bodies, with `version_conflict` surfaced as a value. Daemon adapter: the relay's `store-*`
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
                                  4 RESERVE ──► store-put ──► spawn { taskId } ──► 5 RECORD decision
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

**Quota freshness is the observation's, not the status's.** A machine's status answers two
questions that age differently. Its pressure describes that machine now, so a status
`isStatusStale` calls stale — and every kept status (Wire changes, _Last `status` kept_), whose
machine is gone — says nothing about pressure, and the machine is filtered. Its quota
observations describe an account, which other machines share, each stamped with its own `at`:
they join the fold from live and kept statuses alike, the newest `at` per account wins, and a
window past its reset counts as 0% however old the reading. So an account last used on a
laptop that has since slept keeps that laptop's reading instead of falling back to an older
one, or to nothing.

An old reading is a _lower bound_: use since — on another machine the fleet would see, or on
claude.ai, which it would not — only raises it. v1 routes on it as observed and the decision
record shows its age. No age cap beyond the reset rule (_Settled defaults_ 7).

**Missing quota is unknown, never 0%.** An account is scored only on a reading it actually has.
It is filtered `quota unknown` when no status, live or kept, carries an observation for it, or
when a status from a machine hosting it is trimmed (`isQuotaTrimmed`), does not carry it, and
nothing newer than that status does — trimming may have dropped exactly the reading that said
the account was full. Reading either case as 0% would route the most work to the account the
scheduler knows least about.

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

1. **Landed 2026-10-16 — recorded in DESIGN.md _Scheduler_.** `scheduler/` library + in-memory
   fakes of `QueueStore` and `Fleet`; filter / score / sticky / reserve / record over fixtures,
   and the layering test. No wire change of its own: it reads item 4's `CAPABILITIES.taskId`,
   `task_running` and `SessionEntry.taskId`, and item 7's `liveStatus`. Not built, as M4's: the
   skill and stacked-base filters.
2. **(Landed 2026-10-16.)** Relay leadership — `roles` on `register`, inside the signed message (v2 domain tag);
   nomination as the pure `relay/src/leadership.ts`, called from `hub.ts` on connect, close and
   sweep; `scheduler:term`, `lead`/`follow`,
   `not_leader` on a stale term, `scheduler: { deviceId,
term } | null` in the registry push.
3. `leader.ts` — the leader's own persistent app-role `RelayClient` (not `LazyRelay`) and the
   `Fleet` adapter over it, lifecycle on `lead` / `follow` / socket loss, leaking nothing on
   demotion. `QueueStore` is the in-memory fake for this milestone.
4. `taskId` on `spawn`, `task_running`, `taskId` in `sessions`; advertised in `capabilities`.
   **Landed 2026-10-16** — DESIGN.md _Daemon_, "Task ids", is the record: a tmux pane option,
   so it survives a daemon restart, and `taskIdOfPane` in `daemon/src/sessions.ts` is item 5's
   pane → task lookup.
5. `session-event` on the local socket + `claude-mods/session-events`; the daemon binds each
   event to a pane and takes session and task from its own pane map, keeps only `https:` PR
   URLs, and forwards to the leader sealed to `"scheduler"`.
6. PWA — `auto` in the picker (greyed with no leader, or one whose registry entry does not
   open: "leader unverified"), `route-preview` and the decision view.
7. Kept `status` (landed) — the relay keeps the last one in the entry on close and sweep and clears it
   on `register`; `newestQuotaByAccount` folds kept statuses' quota, pressure readers skip
   them, and the PWA's account cards get an asleep machine's reading with its age. Independent
   of 2–6, and lands before the library's quota filter is trusted on real fleets.

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
- A register whose `roles` the signature does not cover is never nominated (relay). A
  bearer-token holder's daemon socket with signed `roles` and no PSK, connected first, is
  nominated, and the PWA reads it as "leader unverified": `auto` greys and nothing is sent to
  it (e2e).
- A `session-event` naming another session or task moves only the state the daemon's own pane
  map attributes to the sender; a non-`https:` PR URL never reaches the PWA or a push (daemon).
- The leader's app-role leg stays up through more than `LazyRelay`'s idle window with no
  calls, and nothing of it survives `follow` (daemon).
- An account with no observation in any live or kept status, or trimmed out of a status that
  hosts it with nothing newer elsewhere, is filtered `quota unknown` and never scored as 0%
  (scheduler).
- A daemon disconnects: its accounts' quota stays in the fold from the kept status, its
  pressure reads unknown and the machine is filtered; it re-registers with a new blob and the
  kept status is gone until its next `status` (relay + e2e).
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
unverified-leader check and the capture it leaves open until M3, term fencing, the mod as an ingest-only path whose every field is
untrusted), _Wire protocol_ rows, _Presence & identity_ (the kept `status`, replacing "never in
storage").

### M3 — durable queue

**Goal.** Queue a block of work with dependencies and leave; it runs, survives leader changes,
and finishes without anyone watching.

**Gate.** Leader capture reopens and is settled with a relay-side guard (Risks, _Leader
capture_) before the store lands — under M2's reader-only check a squatter's term would delete
the queue.

**Lands, in order.**

1. Relay store — `store-list` / `store-get` / `store-put` / `store-delete` with the per-prefix rules (only
   `task:` populated yet), `task:<id>` as `{ version, env }`,
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
- **Fleet quota record** (follow-up, after account records) — a single `quota` key,
  `{ accountId → newest observation }`, written by daemons on a fixed cadence (~5 min) whether
  or not anything changed, by read-open-compare-`expect`: a daemon writes only an observation
  newer than the one stored, so the record keeps the newest observation, not the last write.
  One key, not one per account — per-account writes would tell the relay when each account is
  in use. Its payoff is `status` shrinking to pressure, which frees most of the 2 KiB socket
  attachment; its cost is a daemon write path into the store and a 5-min floor on freshness,
  where `status` is faster. Taken up only if the attachment budget or the kept-status fold
  (M2) proves too tight.
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

- **CLI/MCP `auto`** — enqueue through the store, as the PWA does (M3 item 6): seal the task,
  `store-put` it at `expect: 0`, so it queues with no leader up. The scheduler mints the
  `taskId` and dispatches, so neither surface ever takes a `taskId` itself. The verdict is
  "queued" plus the task id, not a window; `get_sessions` finds the session by `taskId` once
  it runs. Spelling is open (e.g. `seanced spawn --auto`, `spawn_session { machine: "auto" }`).
  Needs M3's store. Two constraints:
  - `seanced spawn` is relay-free today: it drives local tmux and audits `origin=cli`.
    `--auto` is the one form that needs the relay and the PSK (an app-role leg, as `seanced
mcp` has), and a direct spawn stays relay-free.
  - A keyless `seanced mcp` reaches the relay only through the fleet broker, whose actions
    are fixed. An enqueue there is a new broker action, which is a threat-model change
    (DESIGN.md "Fleet broker"); without it, keyless MCP gets no `auto`.

  Raycast attaches the same way. Exit: a CLI and an MCP `auto` spawn each land as a task with
  no leader up and run once one leads (e2e); `seanced spawn` without `--auto` still works with
  the relay unreachable (daemon).

## Settled defaults (interview, 2026-10-15)

Nothing below is open. An implementer who wants a different value changes this section in the
same PR, with the reason.

1. **Leader** = earliest-connected capable daemon, ties by `deviceId`; nomination only, no
   voting. Capable is signed `roles`; readers ignore a leader whose entry does not open, and
   a relay-side guard is owed before M3 (Risks, _Leader capture_).
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
7. **No age cap on a quota reading** beyond the reset rule. The 5h window bounds itself — a
   reading older than 5h is past its reset and reads 0% — so only the 7d window can drift, and
   only through use the fleet does not see. Fleet accounts are used almost only inside the
   fleet (the owner, 2026-10-16); the rare cloud session is a blip the next session report or
   OAuth poll overwrites. A cap would fail every time a machine sleeps past it, and on the
   account with the most headroom; no cap fails only on unseen use, for one dispatch, until the
   session's own `rate_limits` report corrects it. Revisit with a 7d-only cap (~24h) if
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

## Risks / unknowns

- **Bearer-token blast radius grows, by one act.** Today a token holder can register junk and
  delete registry entries, which DESIGN.md calls harmless because the daemon rebuilds them.
  Queued tasks are not rebuilt: a token holder can list the queue (ciphertext) and create junk
  (the leader skips what doesn't decrypt, as the PWA does for the registry). It still cannot
  read a prompt, forge a task, or roll one back (version binding). Accepted: what is lost is a
  pointer to work, never the work or the repo it lives in; the remedy is the one that already
  exists (rotate). DESIGN.md's "destroys nothing that exists" paragraph gets this caveat.
  M4's account records add a smaller one: being app-writable, a token holder can delete an
  alias or overwrite it with junk that readers skip — but not read, forge or roll one back, and
  an alias is a label, retyped in a second. Holding the leader's term would be a larger act,
  and as planned it is not an edge case — next item.
- **Leader capture is routine. Decided for M2: readers ignore an unverifiable leader (B
  below); reopens before M3's store.**
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
