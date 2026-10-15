# Séance scheduler — plan

**Status: plan, nothing built.** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview; placement revised 2026-10-15 (below). Folds into DESIGN.md
(new section "Scheduler") as each milestone lands; until then this file is the working record and
DESIGN.md describes what exists.

## Glossary

One word per thing. The wire names in `shared/src/types.ts` are older than this table and
stay as they are; the table says which word each one means.

| Term    | Meaning                                                                                                                                                                                                                        | On the wire / in code                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| machine | A box running one `seanced`: the unit of presence, pressure and dispatch                                                                                                                                                       | `deviceId` is its routing key, `MachineInfo` its blob   |
| exclave | One Claude Code config dir and the tree it owns: `default` (`~/.claude`, `~`) or a line of `~/.exclaves` (`~/.claude-<name>`, `~/<name>`). Decides which account a spawn bills. Never "workspace", which is a Bun package here | `exclaves[]` in the register blob, `exclave` on a clone |
| account | The billed Claude identity an exclave is signed into; the 5h/7d quota attaches here. Never "subscription", which is the plan that account is on, and never the email                                                           | `accountId` = `organizationUuid:accountUuid`            |
| repo    | A repository as a logical thing, the same across machines: what a task names. Keyed by normalized `origin`, basename when there is no remote                                                                                   | `tasks.repo`, `RepoEntry.origin`                        |
| clone   | One machine's checkout of a repo, inside one exclave, under a machine-local, collision-disambiguated name. What `spawn` takes                                                                                                  | `RepoEntry`, `spawn { repo }` (historical name)         |
| session | One Claude Code process in one tmux pane, spawned in a clone                                                                                                                                                                   | pane id, `sessions` op                                  |
| task    | A unit of queued work: repo + prompt + spawn opts, with deps and a state. Becomes a session when dispatched                                                                                                                    | `task:<id>` in the store, `taskId` on spawn             |
| leader  | The daemon currently nominated to run the scheduler loop                                                                                                                                                                       | `lead`/`follow`, `scheduler:term`                       |

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
| Slicing           | M1 inventory → M2 route → M3 queue → M4 stacking/OAuth/skills/Proxmox/alerts                                                                                                                                                                                                 |

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
- Config dir follows location via the user's shell hook (`.zshenv` → `update_exclave_env`),
  as today; the daemon doesn't set it. A machine's shell setup being correct is out of scope —
  the daemon only _reports_ which exclave a repo sits in.
- `telemetry.ts`: per-platform collectors (macOS `vm_stat`/`sysctl`/`iostat`; Linux
  `/proc` + PSI + cgroup v2 files in LXC; in an LXC also the Proxmox node view via a read-only
  API token, which never leaves the daemon process). argv-array exec only. Samples every 30s
  into `stateDir()/metrics.sqlite` (`bun:sqlite`, no dependency; created 0600 like the other
  state files): raw 30s for 48h, 5-min rollups 30d, 1h rollups 1y. Quota observations (from
  session events and the OAuth poll) land in the same store. The latest goes out as `status`;
  history is served by the `metrics` op.
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
   stacked base unpushed and not on this exclave; account over hard threshold **and**
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

| M   | Scope                                                                                                                                                                                                                | Ships something usable?                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| M1  | Exclaves + `exclave`/`origin` on clones; `status` frame through the relay; daemon telemetry store + `metrics` op; session-reported quota; PWA machines/exclaves/accounts view + charts. No scheduler yet             | Yes: visibility across machines and accounts |
| M2  | `scheduler/` library + fakes; `roles`/`lead`/`follow`/term in the relay; `leader.ts` with the two adapters; `session-event` op + mod; `taskId` on spawn; filter/score/explain; `auto` spawn + `route-preview` in PWA | Yes: "spawn this in repo X" without picking  |
| M3  | `queue-*` store ops + version binding; durable queue, batches, deps (hand + Linear), takeover reconciliation, done detection, caps, pause, needs-input                                                               | Yes: queue a work block and walk away        |
| M4  | Stacking (`baseBranch`, lineage, handoff preamble), OAuth quota poll, skills filter + autocomplete, Proxmox host metrics, Web Push + Linear via sealed `settings`                                                    | Refinement                                   |

## Defaults I picked without asking — confirm or override

1. Leader = earliest-connected capable daemon, ties by `deviceId`; nomination only, no voting.
2. Apps may create tasks in the store with no leader; everything else waits for one.
3. Scheduler spawns audit as `origin=relay client=scheduler` rather than a new origin
   — the daemon-side surface is still the relay. (Counter-argument: CLAUDE.md's "a new surface
   adds an origin"; the scheduler is autonomous like `schedule`.)
4. Hard quota threshold 90% (either window); reserve 10% for continuations.
5. `needs-input` escalation after 30 min.
6. Retention numbers above (daemon-side).
7. `status` every 30s per machine whether or not anyone is watching (cheap; keeps the
   leader's view fresh without pulls).

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
