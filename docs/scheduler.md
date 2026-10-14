# Séance scheduler — plan

**Status: plan, nothing built.** Drafted 2026-10-14 from a planning transcript, a task-router
heuristics note, and an interview. Folds into DESIGN.md (new section "Scheduler") as each
milestone lands; until then this file is the working record and DESIGN.md describes what exists.

## Decisions (from the interview)

| Topic             | Decision                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Placement         | Standalone `scheduler/` workspace, Bun + SQLite, one instance in a Proxmox LXC                                                                                                                                                             |
| Workspace         | Derived: `default` (`~/.claude`) + one per line of `~/.exclaves` (`~/<name>`, `~/.claude-<name>`). Reported per repo in the register blob; a repo's location decides its config dir, so `spawn` is unchanged                               |
| Spawn contract    | Unchanged apart from optional `baseBranch`. Scheduler resolves "repo X" → (machine, repo entry) and calls the existing `spawn`                                                                                                             |
| Subscription id   | `organizationUuid:accountUuid` from `<configDir>/.claude.json` — never the email                                                                                                                                                           |
| Quota telemetry   | Layered: session-reported `rate_limits` → OAuth usage endpoint when stale → last value + `resets_at` floor                                                                                                                                 |
| Task              | Free-form (repo + prompt + spawn opts), optional Linear link                                                                                                                                                                               |
| Deps              | Per edge `after: opened` (stacked, default) or `after: merged`; Linear relations + hand-declared                                                                                                                                           |
| Done signal       | Layered: PR merged (daemon, local git) / Linear Done → session ended → manual                                                                                                                                                              |
| Quota exhausted   | Spill into credits, loudly (Web Push), with pause: until resume / until next reset                                                                                                                                                         |
| Concurrency       | Global max, per-subscription max, per-batch strategy (`sequential` / `parallel(n)` / `auto`)                                                                                                                                               |
| Alerts            | Web Push (VAPID) from scheduler to subscribed PWAs                                                                                                                                                                                         |
| Needs input       | `needs-input` state, alert, keeps its slot; idle timeout escalates, never kills                                                                                                                                                            |
| Event ingest      | New ingest-only `session-event` frame kind on the local socket, after the fleet broker's precedent (threat-model widening, recorded)                                                                                                       |
| Proxmox           | Machine pressure = max(container cgroup view, Proxmox node via API, pulled live; Proxmox's own RRD is the history)                                                                                                                         |
| Telemetry         | Current snapshot (pressure + latest quota) rides the relay as a sealed `status` frame held on the daemon's socket attachment and pushed to apps + scheduler. History stays on each daemon behind a `metrics` op. The scheduler stores none |
| Prompts at rest   | Prompt/title/repo columns sealed with an HKDF(PSK)-derived key; metrics plaintext                                                                                                                                                          |
| Skills            | Hard filter when declared or prompt starts with `/name`; otherwise informational (+ PWA autocomplete)                                                                                                                                      |
| Clients           | PWA in v1; op set designed so MCP, Raycast and CLI attach later without protocol change                                                                                                                                                    |
| Manual spawn      | Both: `auto` → scheduler; picking a machine → direct to daemon (works with scheduler down)                                                                                                                                                 |
| Handoff           | Dependent task gets a preamble: predecessor title, branch, PR URL, transcript path (same machine only)                                                                                                                                     |
| AI dep classifier | Later; dependency sources are pluggable                                                                                                                                                                                                    |
| Slicing           | M1 inventory → M2 route → M3 queue → M4 stacking/OAuth/skills/Proxmox                                                                                                                                                                      |

## Topology

```
PWA ──/app──┐                ┌──/daemon── seanced (mac)      ── tmux ── claude (+ mod hooks → local socket)
            ├── Relay (DO) ──┼──/daemon── seanced (wsl)
Scheduler ──┘  /scheduler    └──/daemon── seanced (lxc-*)
 (Proxmox LXC, PSK holder, SQLite queue only, Web Push, Linear, Proxmox API)
```

The relay stays blind. The scheduler is a fifth kind of PSK holder (after daemons, PWA, MCP,
Raycast) and the first that _acts on its own_, so it is also the most valuable to steal.

## Wire changes

All shapes land in `shared/src/types.ts` first (schema of record); DESIGN.md's frame→module
table gains rows.

**Relay (`hub.ts`, `wire.ts`, `index.ts`)**

- New upgrade path `/scheduler`, bearer-authed like `/daemon`; reserved id `SCHEDULER_ID =
"scheduler"`, refused by `register` like `"app"`/`"machines"`. Relay enforces `from ===
"scheduler"` on that socket, mirroring `hub.ts:251` for apps.
- Single instance, newest wins: a second `/scheduler` socket closes the first (a restarted
  scheduler must not wait out a half-dead predecessor's sweep). Logged.
- Envelopes `to: "scheduler"` route to that socket; absent → `undeliverable { code: "offline" }`
  to apps, silently dropped for daemon-origin events (fire-and-forget).
- The scheduler socket receives the same `registry` pushes as apps — that's its machine and
  workspace inventory, so it keeps no copy of its own.
- **New daemon→relay frame `status { env }`** every 30s, `env` sealed to `"app"` like the
  register blob (both apps and the scheduler hold the PSK and open it). The relay:
  - keeps the latest on the daemon socket's attachment (`serializeAttachment`, already used for
    `connectedAt`/`identity`) — never DO storage, so no write per sample, and it disappears
    with the socket, which is right: a disconnected machine's snapshot is stale by definition;
  - forwards `status { deviceId, env }` to every app socket and the scheduler socket as it
    arrives — a small frame, not a full registry re-push;
  - includes each connected daemon's latest `status` in the `registry` push on connect, so a
    freshly opened PWA renders pressure immediately;
  - bounds it in `wire.ts` (ciphertext ≤ 1 KiB, leaving the 2 KiB attachment room for the
    rest) and rate-floors it per socket (≥ 10s), as `register` already is.
    The relay stays blind: it holds ciphertext and routing only, as with `info`. Plaintext
    numbers were considered and rejected — they would be the first payload the relay can read,
    and pressure over time is an activity timeline (when you work, on which machine).
- Cost: one DO wake per machine per 30s (the sweep alarm already wakes it every 60s while
  daemons are connected); well inside free-tier request limits for a handful of machines.
- Scheduler socket gets heartbeat + sweep like a daemon socket.
- Registry push to apps gains `scheduler: { connected, lastSeen }` so the PWA can grey out
  `auto` without a round trip.

**`status` payload** (`MachineStatus` in `types.ts`): `at`; cpu, mem, disk pressure as
0–1 fractions (each already smoothed over ~2 min daemon-side, so the scheduler needs no window
of its own) plus disk free and r/w rates; running sessions per workspace; and `quota`: this
daemon's newest observation per subscription (5h/7d pct, `resets_at`, source
`session`/`oauth`, observed-at). Quota for one subscription is spread over every daemon
hosting one of its workspaces; readers take the newest observation per subscription.

**New daemon request op `metrics`** (app→daemon, like `sessions`) — history only:
`metrics { range, resolution }` → `{ series }` from the daemon's local store. The PWA calls it
when a chart is opened; nothing else needs it. History of an asleep machine is unavailable
until it wakes — accepted.

**Daemon → scheduler (fire-and-forget, sealed to `"scheduler"`)** — events only, the things
that must arrive when they happen rather than when someone asks:

| Op              | Cadence                      | Payload (sketch)                                                                               |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `session-event` | on event, coalesced ≤1/5s    | session id, workspace, state (`busy`/`idle`/`needs-input`/`ended`), PR URL seen, skill invoked |
| `branch-state`  | on change, for task branches | repo, branch, `pushed`, `merged` (reap-git's rules)                                            |

**Scheduler → daemon**: existing `spawn`/`sessions`/`despawn`, addressed from `"scheduler"`.
Daemon replies to `env.from` already (`relay-client.ts:239`), so no reply-path change.

**`SpawnRequest` is unchanged** — a direct spawn (PWA machine pick, MCP, Raycast, CLI) and a
scheduler spawn are the same op. The scheduler is a layer above it: "spawn X" → filter/score
over every (machine, repo entry) carrying X → existing `spawn { repo: <that machine's entry
name> }` to the winner. The workspace (and so the subscription) follows from where that repo
lives, exactly as today. Audit: `origin=relay client=scheduler`; task ↔ session correlation
is the scheduler's own bookkeeping, keyed on the pane id the spawn verdict already returns.

One optional addition, for stacked deps (M4): `baseBranch?: string` — start the worktree from
this branch instead of the default. Resolved against the repo's refs (`origin/<b>` or local),
never interpolated; unresolvable → new code `base_not_found`. Through `shq()` if it ever
reaches the shell string. Useful from the PWA directly too. Old daemons ignore it, which here
is wrong rather than harmless (B would start from main), so the scheduler only sends it to
daemons that advertise support (below).

**App → scheduler ops** (request/response, PWA via `AppClient`): `queue` (list + decisions),
`enqueue` (task or batch), `cancel`, `mark-done`, `pause`/`resume` (`until: "resume" |
"reset"`), `route-preview` (dry-run explanation), `push-subscribe`. Scheduler → app: `queue-changed` push to `"app"`
(broadcast, apps re-fetch) — no polling.

**`MachineInfo` additions** (register blob, optional on the wire like `source`):

- `workspaces: [{ id, subscriptionId, extraUsageEnabled, authOk, skills: string[] }]`.
- `RepoEntry` gains `workspace` (which workspace's tree it sits in) and `origin` (normalized
  remote URL). `origin` is the scheduler's _logical_ repo key: entry names are machine-local
  and collision-disambiguated (`seance` becomes `pengefix/seance` the day a second clone
  appears), so they can't identify "the same repo" across machines or over time. Fallback
  when there's no remote: basename.
- `capabilities: string[]` (e.g. `"baseBranch"`), so the scheduler never relies on a field an
  old daemon would drop.

This is what the scheduler's filter stage reads; it reaches apps the same way repos do, and
the PWA can show the workspace beside each repo in the manual picker.

## Daemon changes

- `workspaces.ts`: read `~/.exclaves` + default; map scanned repos by path prefix; read
  account/org/extra-usage/auth presence from each config dir. Rescan on `~/.exclaves` mtime.
- Config dir follows location via the user's shell hook (`.zshenv` → `update_exclave_env`),
  as today; the daemon doesn't set it. A machine's shell setup being correct is out of scope —
  the daemon only _reports_ which workspace a repo sits in.
- `telemetry.ts`: per-platform collectors (macOS `vm_stat`/`sysctl`/`iostat`; Linux
  `/proc` + PSI + cgroup v2 files in LXC). argv-array exec only. Samples every 30s into
  `stateDir()/metrics.sqlite` (`bun:sqlite`, no dependency; created 0600 like the other state
  files): raw 30s for 48h, 5-min rollups 30d, 1h rollups 1y. Quota observations (from session
  events and the OAuth poll) land in the same store. The latest goes out as `status`; history
  is served by the `metrics` op.
- `quota.ts` (M4): OAuth usage poll per workspace when the newest session report is older than
  `quota.staleAfter` (default 10m). **Token never leaves the daemon process** — same invariant
  class as the service-delivered PSK. Failure is quiet and non-fatal (unofficial endpoint).
- Local socket: `session-event` as its own frame kind, never a `Plain` or an `OpName` — the
  precedent the fleet broker set (DESIGN.md "Fleet broker"), so it can't arrive from the relay
  and no op can be smuggled in as one. Ingest-only: the handler may store and forward, may not
  spawn, despawn, or exec. DESIGN.md "Local op socket" + threat model updated.
- `claude-mods/session-events`: hooks (`SessionStart`, `Stop`, `Notification`,
  `UserPromptSubmit`, `SessionEnd`, `PostToolUse` matching PR-create output) + statusline tap
  for `rate_limits` → local socket. This is also the phase-2 bus.

## Scheduler (`scheduler/`)

**State (SQLite, WAL):** only what nobody else owns — `tasks`, `deps`, `batches`,
`assignments`, `reservations`, `decisions`, `lineages`, `push_subs`, `settings`. Machines and
workspaces come from the registry push; resources and quota are pulled from daemons; neither is
persisted here, so a scheduler restart loses nothing but its in-memory view. Sealed columns: `tasks.prompt`, `tasks.title`, `tasks.repo` (key =
HKDF-SHA256(PSK, "seance-scheduler-at-rest")).

**Task states:** `queued → blocked → ready → reserved → running → needs-input ⇄ running →
awaiting-merge → done` with `failed`, `cancelled` off-path. `awaiting-merge` frees the
concurrency slot (session ended) but keeps `after: merged` dependents blocked.

**Routing (per ready task, on any state change + a 30s tick while ready tasks exist)**, from
the latest `status` per machine; a snapshot older than ~90s counts as unknown and the machine
is filtered for new work:

1. _Filter_ (structured rejection reasons): machine offline/stale; workspace auth missing;
   repo absent in workspace; required skill absent; pin mismatch; stacked base unpushed and
   not on this workspace; subscription over hard threshold **and** extra usage disabled;
   per-subscription / global cap reached.
2. _Score_ (lower wins, weights in config):
   `subscription_pressure` = max(f(projected 5h), g(projected 7d)), convex, discounted by
   time-to-reset; `machine_pressure` = max(cpu, mem, disk, host) for LXCs;
   `dependency_distance` (0 same workspace … 0.5 pushed elsewhere); `queue_pressure`.
3. _Stickiness_: lineage owner bonus; only matters for continuations.
4. _Reserve_ then dispatch; reservation TTL 120s; spawn failure releases and re-routes.
5. _Record_ the decision with every component; PWA renders "chose X because …, rejected Y
   because …".

Projected usage counts reservations + running scheduler tasks (fixed per-task estimate in v1,
tuned later from observed deltas per task).

**Credits spill:** dispatching to a subscription past the hard threshold with extra usage on
fires a Web Push ("Spending credits on <sub> for <task>" + Pause actions). Re-alerts once per
subscription per window, not per task.

**Done detection:** Linear Done (if linked, poll) or daemon `branch-state merged` → `done`;
session `ended` without merge → `awaiting-merge` (PR open) or `failed` (no PR, nonzero) —
manual override always wins.

**Proxmox node metrics:** pulled live from the Proxmox API (read-only token) at routing
time, folded into each LXC's machine pressure. Not stored; Proxmox keeps its own RRD history.

**Deployment:** systemd system unit with `User=` + `LoadCredentialEncrypted=` for the PSK,
Linear key, VAPID key and Proxmox token — reuse `install --system` machinery rather than a
second installer.

## Milestones

| M   | Scope                                                                                                                                                                                                                     | Ships something usable?                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| M1  | Workspaces + `workspace`/`origin` on repo entries; `status` frame through the relay; daemon telemetry store + `metrics` op; session-reported quota; PWA machines/workspaces/subscriptions view + charts. No scheduler yet | Yes: visibility across machines and subscriptions |
| M2  | Scheduler skeleton + `/scheduler` role; `session-event` op + mod; filter/score/explain; `auto` spawn + `route-preview` in PWA                                                                                             | Yes: "spawn this in repo X" without picking       |
| M3  | Durable queue, batches, deps (hand + Linear), done detection, caps, pause, Web Push, needs-input                                                                                                                          | Yes: queue a work block and walk away             |
| M4  | Stacking (`baseBranch`, lineage, handoff preamble), OAuth quota poll, skills filter + autocomplete, Proxmox host metrics                                                                                                  | Refinement                                        |

## Defaults I picked without asking — confirm or override

1. `/scheduler` is single-instance, newest-wins.
2. Scheduler spawns audit as `origin=relay client=scheduler` rather than a new origin
   — the daemon-side surface is still the relay. (Counter-argument: CLAUDE.md's "a new surface
   adds an origin"; the scheduler is autonomous like `schedule`.)
3. Hard quota threshold 90% (either window); reserve 10% for continuations.
4. `needs-input` escalation after 30 min.
5. Retention numbers above (daemon-side).
6. `status` every 30s per machine whether or not anyone is watching (cheap; keeps the
   scheduler's view fresh without pulls).

## Risks / unknowns

- **OAuth usage endpoint** is unofficial; reading tokens per config dir differs by platform
  (macOS keychain entry naming per config dir is unverified). Session reports are the floor.
- **Statusline `rate_limits` cadence**: only refreshed when the statusline renders; an idle
  session reports nothing new.
- **Stacked rebases**: when A changes in review, B's branch drifts. v1 does nothing
  automatic; the dependent's preamble names the base so the session can rebase.
- **The scheduler is an autonomous PSK holder** that can spawn arbitrary prompts on every
  machine at any hour. Its LXC becomes the highest-value target in the system; that belongs in
  the threat model with the at-rest sealing and the newest-wins socket rule.
- **Daemons on old versions** report no `workspaces`/`origin`. The scheduler treats such a
  machine as ineligible for `auto` (it can't know which subscription a spawn would bill), while
  direct spawns to it keep working. Self-update makes this a short window.
