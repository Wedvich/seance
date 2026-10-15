# Séance scheduler — plan

**Status: plan, nothing built.** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview; placement revised 2026-10-15 (below). Folds into DESIGN.md
(new section "Scheduler") as each milestone lands; until then this file is the working record and
DESIGN.md describes what exists.

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

| Topic             | Decision                                                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement         | **Queue lives in the relay's DO as sealed blobs; the loop runs on a relay-nominated daemon.** No standalone process, no new PSK holder. `scheduler/` is a pure library the daemon hosts behind two adapter interfaces, so it can move to a fixed box later without a rewrite |
| Exclave           | Derived: `default` (`~/.claude`) + one per line of `~/.exclaves` (`~/<name>`, `~/.claude-<name>`). Reported per repo in the register blob; a repo's location decides its config dir, so `spawn` is unchanged                                                                 |
| Spawn contract    | Unchanged apart from optional `baseBranch` and `taskId`. Scheduler resolves "repo X" → (machine, clone) and calls the existing `spawn`                                                                                                                                       |
| Account id        | `organizationUuid:accountUuid` from `<configDir>/.claude.json` — never the email                                                                                                                                                                                             |
| Quota telemetry   | Layered: session-reported `rate_limits` → OAuth usage endpoint when stale → last value + `resets_at` floor                                                                                                                                                                   |
| Task              | Free-form (repo + prompt + spawn opts), optional Linear link                                                                                                                                                                                                                 |
| Deps              | Per edge `after: opened` (stacked, default) or `after: merged`; Linear relations + hand-declared                                                                                                                                                                             |
| Done signal       | Layered: PR merged (daemon, local git) / Linear Done → session ended → manual                                                                                                                                                                                                |
| Quota exhausted   | Spill into credits, loudly (Web Push), with pause: until resume / until next reset                                                                                                                                                                                           |
| Concurrency       | Global max, per-account max, per-batch strategy (`sequential` / `parallel(n)` / `auto`)                                                                                                                                                                                      |
| Alerts            | Web Push (VAPID) from the leader to subscribed PWAs (M4; key sealed in the DO, see _Secrets_)                                                                                                                                                                                |
| Needs input       | `needs-input` state, alert, keeps its slot; idle timeout escalates, never kills                                                                                                                                                                                              |
| Event ingest      | New ingest-only `session-event` frame kind on the local socket, after the fleet broker's precedent (threat-model widening, recorded)                                                                                                                                         |
| Proxmox           | Machine pressure = max(container cgroup view, Proxmox node via API); the LXC daemon reads the node view itself and folds it into its own `status`, so no reader needs Proxmox reach                                                                                          |
| Telemetry         | Current snapshot (pressure + latest quota) rides the relay as a sealed `status` frame held on the daemon's socket attachment and pushed to apps + the leader. History stays on each daemon behind a `metrics` op. Neither the relay nor the scheduler stores telemetry       |
| At rest           | The queue is sealed envelopes in DO storage: the relay holds id, version and ciphertext, nothing else. No second at-rest scheme                                                                                                                                              |
| Skills            | Hard filter when declared or prompt starts with `/name`; otherwise informational (+ PWA autocomplete)                                                                                                                                                                        |
| Clients           | PWA in v1; op set designed so MCP, Raycast and CLI attach later without protocol change                                                                                                                                                                                      |
| Manual spawn      | Both: `auto` → scheduler; picking a machine → direct to daemon (works with no leader)                                                                                                                                                                                        |
| Handoff           | Dependent task gets a preamble: predecessor title, branch, PR URL, transcript path (same machine only)                                                                                                                                                                       |
| AI dep classifier | Later; dependency sources are pluggable                                                                                                                                                                                                                                      |
| Slicing           | M1 visibility → M2 routing + leadership → M3 durable queue → M4 refinement (independent items)                                                                                                                                                                               |

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
client on its daemon socket and an app-role client (the fleet broker's `app-relay.ts`
precedent) to receive registry and `status` pushes and to address other daemons.

## Wire changes

All shapes land in `shared/src/types.ts` first (schema of record); DESIGN.md's frame→module
table gains rows.

**Relay (`hub.ts`, `wire.ts`, `index.ts`)**

- **Leadership.** `register` gains a plaintext `roles?: ["scheduler"]` — the one capability the
  relay must read, since it is what it nominates on; an old daemon sends none and is never
  nominated. After every daemon connect, close and sweep the relay re-evaluates: the leader is the
  capable connected daemon socket with the earliest `connectedAt` (tie: lowest `deviceId`). A
  change bumps `scheduler:term` (DO storage, monotonic) and sends `lead { term }` to the new
  leader and `follow` to the old one if still connected. Term is a fencing token: a leader that
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
- **New daemon→relay frame `status { env }`** every 30s, `env` sealed to `"app"` like the
  register blob (apps and the leader's app-role leg both open it). The relay:
  - keeps the latest on the daemon socket's attachment (`serializeAttachment`, already used for
    `connectedAt`/`identity`) — never DO storage, so no write per sample, and it disappears
    with the socket, which is right: a disconnected machine's snapshot is stale by definition;
  - forwards `status { deviceId, env }` to every app socket as it arrives — a small frame, not a
    full registry re-push;
  - includes each connected daemon's latest `status` in the `registry` push on connect, so a
    freshly opened PWA (or a freshly nominated leader) renders pressure immediately;
  - bounds it in `wire.ts` (ciphertext ≤ 1 KiB, leaving the 2 KiB attachment room for the
    rest) and rate-floors it per socket (≥ 10s), as `register` already is.
    The relay stays blind: it holds ciphertext and routing only, as with `info`. Plaintext
    numbers were considered and rejected — they would be the first payload the relay can read,
    and pressure over time is an activity timeline (when you work, on which machine).
- Cost: one DO wake per machine per 30s for `status` (the sweep alarm already wakes it every
  60s while daemons are connected), plus one storage write per task _transition_ — never per
  tick. Well inside free-tier limits for a handful of machines and tens of tasks.

**`status` payload** (`MachineStatus` in `types.ts`): `at`; cpu, mem, disk pressure as
0–1 fractions (each already smoothed over ~2 min daemon-side, so the scheduler needs no window
of its own) plus disk free and r/w rates; running sessions per exclave; and `quota`: this
daemon's newest observation per account (5h/7d pct, `resets_at`, source
`session`/`oauth`, observed-at). Quota for one account is spread over every daemon
hosting one of its exclaves; readers take the newest observation per account.

**New daemon request op `metrics`** (app→daemon, like `sessions`) — history only:
`metrics { range, resolution }` → `{ series }` from the daemon's local store. The PWA calls it
when a chart is opened; nothing else needs it. History of an asleep machine is unavailable
until it wakes — accepted.

**Daemon → scheduler (fire-and-forget, sealed to `"scheduler"`)** — events only, the things
that must arrive when they happen rather than when someone asks:

| Op              | Cadence                      | Payload (sketch)                                                                              |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `session-event` | on event, coalesced ≤1/5s    | session id, task id, exclave, state (`busy`/`idle`/`needs-input`/`ended`), PR URL seen, skill |
| `branch-state`  | on change, for task branches | repo, branch, `pushed`, `merged` (reap-git's rules)                                           |

A leader change loses nothing here: every event is also reflected in the daemon's `sessions`
reply, which the new leader reconciles against on takeover (below).

**Scheduler → daemon**: existing `spawn`/`sessions`/`despawn`, addressed from `"scheduler"` by
the leader's app-role leg. Daemon replies to `env.from` already (`relay-client.ts:239`), so no
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

**App → scheduler ops** (request/response, PWA via `AppClient`, routed to the leader):
`queue` (list + decisions), `cancel`, `mark-done`, `pause`/`resume` (`until: "resume" |
"reset"`), `route-preview` (dry-run explanation), `push-subscribe`. `enqueue` is _not_ a
leader op: the app seals the task and `queue-put`s it at `expect: 0`, so queuing works with
no leader and the next one picks it up. Scheduler → app: `queue-changed` push to `"app"`
(broadcast, apps re-fetch) — no polling.

**`MachineInfo` additions** (register blob, optional on the wire like `source`):

- `exclaves: [{ id, accountId, extraUsageEnabled, authOk, skills: string[] }]`.
- `RepoEntry` gains `exclave` (which exclave's tree it sits in) and `origin` (normalized
  remote URL). `origin` is the scheduler's repo key: clone names are machine-local
  and collision-disambiguated (`seance` becomes `pengefix/seance` the day a second clone
  appears), so they can't identify "the same repo" across machines or over time. Fallback
  when there's no remote: basename.
- `capabilities: string[]` (e.g. `"taskId"`, `"baseBranch"`), so the scheduler never relies on
  a field an old daemon would drop. (`roles` is the plaintext sibling: what the _relay_ must
  read; `capabilities` is sealed, what only the leader reads.)

This is what the scheduler's filter stage reads; it reaches apps the same way repos do, and
the PWA can show the exclave beside each repo in the manual picker.

## Daemon changes

- `exclaves.ts`: read `~/.exclaves` + default; map scanned repos by path prefix; read
  account/org/extra-usage/auth presence from each config dir. Rescan on `~/.exclaves` mtime.
- **The `~/.exclaves` contract.** One name per line, matching `^[a-z0-9][a-z0-9-]*$`; each
  names a tree at `~/<name>` and a config dir at `~/.claude-<name>`, and `default` is implied.
  The daemon validates every line against that regex and skips the rest, so a stray line costs
  one exclave, not the scan. The file has two readers — the owner's shell hook and skill in
  their dotfiles maintain it, the daemon only reads it — and this paragraph is the agreement
  between them: a format change there is a daemon change here.
- Config dir follows location via the user's shell hook (`.zshenv` → `update_exclave_env`),
  as today; the daemon doesn't set it. A machine's shell setup being correct is out of scope —
  the daemon only _reports_ which exclave a clone sits in.
- `telemetry.ts`: per-platform collectors (macOS `vm_stat`/`sysctl`/`iostat`; Linux
  `/proc` + PSI + cgroup v2 files in LXC; in an LXC also the Proxmox node view via a read-only
  API token, which never leaves the daemon process). argv-array exec only. Samples every 30s
  into `stateDir()/metrics.sqlite` (`bun:sqlite`, no dependency; created 0600 like the other
  state files): raw 30s for 48h, 5-min rollups for 30d, hourly rollups kept forever (one row
  per series per hour is megabytes a decade). Quota observations (from session events and the
  OAuth poll) land in the same store. The latest goes out as `status`; history is served by the
  `metrics` op. **Sample shape is Prometheus's data model and nothing else**: metric name, a
  label set of machine / exclave / account, timestamp, number. The routing loop reads only the
  latest `status`, never this store, so a later Prometheus + Grafana stack on the Proxmox host
  is a new consumer (an exposition endpoint on the daemon, or remote write — daemons dial out
  and laptops roam) and could replace the store for charts without touching the scheduler.
- `quota.ts` (M4): OAuth usage poll per exclave when the newest session report is older than
  `quota.staleAfter` (default 10m). **Token never leaves the daemon process** — same invariant
  class as the service-delivered PSK. Failure is quiet and non-fatal (unofficial endpoint).
- Local socket: `session-event` as its own frame kind, never a `Plain` or an `OpName` — the
  precedent the fleet broker set (DESIGN.md "Fleet broker"), so it can't arrive from the relay
  and no op can be smuggled in as one. Ingest-only: the handler may store and forward, may not
  spawn, despawn, or exec. DESIGN.md "Local op socket" + threat model updated.
- `claude-mods/session-events`: hooks (`SessionStart`, `Stop`, `Notification`,
  `UserPromptSubmit`, `SessionEnd`, `PostToolUse` matching PR-create output) + statusline tap
  for `rate_limits` → local socket. This is also the phase-2 bus.
- **`leader.ts` — the scheduler role.** Advertises `roles: ["scheduler"]` on register. On
  `lead { term }`: build the two adapters (below), take over (reconcile reservations against
  `sessions`), run the loop. On `follow`, socket loss or `not_leader`: stop the loop, drop the
  adapters, leak nothing — the same lifecycle discipline as the broker's app-role client.
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
  Daemon adapter: the app-role client from `app-relay.ts`.

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
                              │   account over threshold ∧ credits off · cap reached      │
                              │                                                           │
                              └─► 2 SCORE  (lower wins, weights in config)                │
                                  account_pressure       max(f(5h), g(7d)), ÷ time-to-reset
                                  machine_pressure       max(cpu, mem, disk, host)        │
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
the latest `status` per machine; a snapshot older than ~90s counts as unknown and the machine
is filtered for new work:

1. _Filter_ (structured rejection reasons): machine offline/stale; `taskId` unsupported;
   exclave auth missing; repo absent in exclave; required skill absent; pin mismatch;
   stacked base unpushed and not on this exclave; projected account usage over the 90% line (a window resetting within 15 min counts as empty) **and**
   extra usage disabled; per-account / global cap reached.
2. _Score_ (lower wins, weights in config):
   `account_pressure` = max(f(projected 5h), g(projected 7d)), convex, discounted by
   time-to-reset; `machine_pressure` = max(cpu, mem, disk, host) for LXCs;
   `dependency_distance` (0 same exclave … 0.5 pushed elsewhere); `queue_pressure`.
3. _Stickiness_: lineage owner bonus; only matters for continuations.
4. _Reserve_ (one store write) then dispatch with `taskId`; reservation TTL 120s; spawn failure
   or `task_running` from a stale read both resolve the reservation without a second spawn.
5. _Record_ the decision with every component; PWA renders "chose X because …, rejected Y
   because …".

Projected usage counts reservations + running scheduler tasks (fixed per-task estimate in v1,
tuned later from observed deltas per task).

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

### M1 — visibility

**Goal.** From the PWA, see every machine with its exclaves and accounts, current pressure and
the newest quota observation per account, and open a history chart — without a scheduler.

**Lands, in order.**

1. _Schema, alone._ `MachineInfo.exclaves`, `RepoEntry.exclave`/`origin`, `capabilities`,
   `MachineStatus`, the `status` frame, the `metrics` op, and `registry` carrying each
   connected daemon's latest `status` — all of them in `shared/src/types.ts` and DESIGN.md's
   frame→module table in one small PR before anything else, so no later task touches either
   file for more than the field its brief names.
2. `exclaves.ts` — the `~/.exclaves` contract, clones mapped by path prefix, account/auth
   presence per config dir. Daemon-only, no wire change; runs in parallel with 3.
3. `telemetry.ts` — collectors, the SQLite store with the three retention tiers, quota
   observations from session reports. Daemon-only; parallel with 2.
4. `status` — daemon sender; relay attachment, forwarding, ≤ 1 KiB bound and ≥ 10s floor;
   `registry` includes the latest per connected daemon.
5. `metrics` op — daemon handler over the store; app-side request.
6. PWA — machines / exclaves / accounts view, pressure and quota per machine, charts.

**Exit.**

- A freshly opened PWA renders pressure for every connected machine from the registry push,
  with no wait for the next tick (pwa + e2e).
- A daemon's `status` disappears with its socket; a swept socket leaves none behind (relay).
- A `status` over 1 KiB or under 10s since the last is refused, and `relay/test/layering.test.ts`
  still passes — the relay gained no readable payload (relay).
- A stray line in `~/.exclaves` costs one exclave, not the scan; `default` is always present
  (daemon).
- An old daemon reporting no `exclaves` still renders as a machine, marked ineligible for
  `auto` later (pwa).
- `status` round-trips through the real DO to a real app client (e2e).

**Gaps.** No scheduler: you pick the exclave by hand and read the pressure yourself. Quota
is session-reported only (OAuth poll is M4), so an idle exclave shows a stale number with its
observed-at. Proxmox node view absent (M4); LXCs report their cgroup view.

**Record.** DESIGN.md _Presence & identity_ (status on the attachment), _Wire protocol_ (frame
table rows), _Daemon_ (exclaves, telemetry, the contract paragraph), _PWA_.

### M2 — routing and leadership

**Goal.** A PWA spawn with `auto` lands on the machine and exclave the scheduler chose, with
the decision explained, and the role survives the leading machine going away. No durable
queue yet.

**Lands, in order.**

1. `scheduler/` library + in-memory fakes of `QueueStore` and `Fleet`; filter / score /
   sticky / reserve / record over fixtures. No wire change — depends only on M1's schema, so
   it can start before M1 finishes. Includes the layering test: nothing in `scheduler/`
   imports `daemon/`, and nothing in `daemon/` imports `scheduler/` except `leader.ts`.
2. Relay leadership — `roles` on `register`, `scheduler:term`, `lead`/`follow`,
   re-nomination on close and sweep, `not_leader` on a stale term, `scheduler: { deviceId,
term } | null` in the registry push.
3. `leader.ts` — the `Fleet` adapter over the app-role leg (`app-relay.ts`), lifecycle on
   `lead` / `follow` / socket loss. `QueueStore` is the in-memory fake for this milestone.
4. `taskId` on `spawn`, `task_running`, `taskId` in `sessions`; advertised in `capabilities`.
5. `session-event` on the local socket + `claude-mods/session-events`; forwarded to the
   leader sealed to `"scheduler"`.
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
- Library suite: every filter reason, every score component and stickiness reproduce the
  fixture decisions; the layering test fails on either forbidden import (scheduler).

**Gaps.** The queue is in-memory on the leader: a leader change forgets `auto` spawns not yet
dispatched (sessions already running are ordinary sessions and survive). No deps, no batches,
no caps beyond the global max, no pause, no alerts.

**Record.** DESIGN.md gains a _Scheduler_ section (leadership and term, library and adapters,
`taskId` idempotency), _Local op socket_ (the `session-event` frame kind), _Threat model_
(plaintext `roles`, term fencing, the mod as an ingest-only path), _Wire protocol_ rows.

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
  credits-spill and needs-input alerts, `push-subscribe`.
- **Linear** — key in `settings`; relation-derived deps and Done as a done signal.

## Settled defaults (interview, 2026-10-15)

Nothing below is open. An implementer who wants a different value changes this section in the
same PR, with the reason.

1. **Leader** = earliest-connected capable daemon, ties by `deviceId`; nomination only, no
   voting.
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
6. **Retention**: raw 30s for 48h, 5-min for 30d, hourly forever; Prometheus-shaped samples
   (above) so an external metrics stack is a consumer, not a redesign.
7. **`status` every 30s** per machine whether or not anyone is watching: one DO wake per
   machine per tick, the leader's view never older than one tick, and a fresh PWA renders
   pressure from the registry push without waiting.

## Risks / unknowns

- **Bearer-token blast radius grows, by one act.** Today a token holder can register junk and
  delete registry entries, which DESIGN.md calls harmless because the daemon rebuilds them.
  Queued tasks are not rebuilt: a token holder can list the queue (ciphertext), create junk
  (the leader skips what doesn't decrypt, as the PWA does for the registry), and — by
  registering as a capable "daemon" and winning nomination after a reconnect storm — hold a
  term and delete or stall the queue until the token is rotated. It still cannot read a
  prompt, forge a task, or roll one back (version binding). Accepted: what is lost is a
  pointer to work, never the work or the repo it lives in; the remedy is the one that already
  exists (rotate). DESIGN.md's "destroys nothing that exists" paragraph gets this caveat.
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
