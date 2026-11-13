# The archivist — spec

**Status: spec; Build order item 1 (the role and the seat) built 2026-11-12, recorded in
DESIGN.md, Scheduler, "Leadership" ("The archivist's seat"); item 2 (the `archivist/` workspace)
built 2026-11-12, recorded in DESIGN.md, "Archivist", and its trust entry in the Threat model,
item 2.** Decided with the owner on 2026-11-12. Like docs/scheduler.md and
docs/leaving.md, this file is the working record until the code lands; each part folds into
DESIGN.md as it is built, and its text here goes.

## Problem

Séance keeps history in three places, each with a gap:

- **Machine and usage history** lives only in each daemon's `metrics.sqlite`
  (`daemon/src/metrics-store.ts`: 30 s for 48 h, 5 min for 30 days, hourly forever). A sleeping
  machine's history is unavailable (DESIGN.md, accepted), and an account's history is split across
  the machines whose exclaves observed it; the PWA charts an account from one host
  (`historyHost`, `pwa/src/machines-view.ts`).
- **Task history** lives only in the relay store. Once the store holds `pruneAt` (96) records the
  leader deletes the oldest finished tasks down to `keepFinished` (50)
  (`scheduler/src/config.ts`, `scheduler/src/prune.ts`). A pruned task is gone.
- **Fleet history** (a machine joined, left, updated; the leader changed) is kept nowhere.

The archivist is one optional service that keeps all three long-term in one SQLite database, so
the relay store and the PWA stay lean and the trail survives.

Scope: collecting, keeping and answering reads. **Not** in scope: routing on history, an MCP
surface, prompt text, any act on the fleet.

## Decisions

Each is the owner's, 2026-11-12, unless marked _derived_.

### 1. Optional, and never load-bearing

- **A1.** A fleet with no archivist behaves exactly as it does today. No task, spawn, scheduler
  pass, prune or PWA screen waits on it.
- **A2.** Pruning in the relay store is unchanged: the leader never waits for the archivist to
  have a record. Raising `keepFinished`/`pruneAt` is the lever if the window proves short.
- **A3.** Daemons are unchanged: their `metrics.sqlite`, retention and `metrics` op stay as they
  are. The archivist is removable by stopping it.
- **A4.** The scheduler library gets no dependency on the archivist. The one place the leader's
  host learns it exists is the silence alert (§8), which affects no routing.

### 2. The seat

- **A5, A6.** Built: one archivist per fleet, the `archivist` role on the one id on the
  `ARCHIVIST` secret, every other claim refused (DESIGN.md, Scheduler, "Leadership", "The
  archivist's seat", which is now the record).
- **A7, A8.** Built: a second, app-role connection for reading (live `status` frames, the
  `metrics` op and store reads arrive with items 3 and 4), and read-only by its own code, held by
  `archivist/test/layering.test.ts` (DESIGN.md, "Archivist", which is now the record).
- **A9.** Built: `RelayClient` skips the seat's entry as a machine, for every reader at once
  (DESIGN.md, as A5).
- **A10.** No endpoint of its own. The relay has one shared `BEARER_TOKEN`, and the box holds the
  PSK anyway, so a separate token would protect little.

### 3. Trust

- **A11, A12.** Built: a new kind of PSK holder that never acts, its key only from a systemd
  unit's `LoadCredentialEncrypted` credential, never as root (DESIGN.md, Threat model, item 2,
  "The archivist, a PSK holder that never acts", which is now the record).
- **A13.** Records are opened only through the existing readers (`openAtRest`, `openTaskRecord`
  then `bindTaskRecord`, `openAccountRecord`, `openFleetQuotaRecord`). The archivist deletes and
  overwrites nothing it cannot read.
- **A14.** No prompt text and no attachment is ever stored, logged or served. _Derived:_ the
  archivist applies `forgetPrompt` before writing a task row, in case a record it reads still
  carries one.
- **A15.** _Derived._ An account is keyed in the archive by the HMAC'd account id the store
  already uses, never by a raw account identifier or email. An alias is stored for display only.

### 4. What it collects

- **A16. Tasks.** Finished tasks only (`done`, `failed`, `cancelled`), metadata only. A row is
  upserted whenever the finished record's store version changes while the record is still in the
  store, so a PR that merges after its task settled is captured. Once the record is pruned the
  row is final.
- **A17. Metrics.** Two sources into one store: live `status` frames, and timed pulls from each
  daemon's `metrics` op with a watermark per series. Where both cover a timestamp the pulled
  sample wins. Rollups use the daemon's own formula (`metrics-store.ts`: each tier is the average
  of the tier below per bucket), from one module both import, not a copy.
- **A18. Fleet events.** From registry pushes: a machine first seen, connected, gone, its build
  changed, the scheduler leader's term changed.
- **A19. First start.** It pulls every machine's existing hourly and 5-minute history once, then
  continues from the watermark. Task history starts from what the store holds that day.
- **A20. Outages.** After its own downtime, or a machine's sleep, it backfills from the relay
  store and from the daemons' local history. What was pruned or rolled past in between is lost;
  that is accepted (A2, A3).

### 5. Retention

- **A21.** Tasks and fleet events: forever.
- **A22.** Metrics: 30 s for 48 h, 5 min for 1 year, hourly forever.
- **A23.** Append-only. Nothing on the wire removes or changes history; a purge is SQL on the box.
- **A24.** A retired machine's and a removed account's history stays, keyed by its stable id with
  the last known name.

### 6. Hosting and packaging

- **A25.** A workspace of its own, `archivist/`, command `seance-archivist` (`run`,
  `install --system`, `update`, `status`; the workspace, `run` and `status` built 2026-11-12,
  DESIGN.md, "Archivist"), unit `seance-archivist.service`, database
  `archive.sqlite` in its state dir (0600, WAL, migrations on `PRAGMA user_version` as
  `metrics-store.ts` does). Bun and `bun:sqlite`; no other database, no Node.
- **A26.** It runs from the same git checkout layout as `seanced` and follows the fleet's update
  announce: an archivist that cannot parse a newer task record would archive nothing, silently.
- **A27.** The archivist runs on any Linux box or container a daemon can run on (an unprivileged
  LXC included), alone or beside a `seanced`. Where it is deployed is the operator's choice and
  no part of this spec; this supersedes any task prompt that requires a container of its own.
  Séance ships the service's installer, never a container.
- **A27a.** On a shared box the archivist runs as a Unix user of its own, never the daemon's:
  sessions run as the daemon's user and must not be able to read or change `archive.sqlite`.
  `install --system` takes the target user, refuses root and refuses the user a `seanced` unit on
  the box runs as. That user owns the archivist's state dir (0700) and its own checkout, which
  `update` fast-forwards; it shares neither with the daemon. A daemon's user who can `sudo` is
  outside what this protects against.
- **A27b.** The archivist's PSK is its own sealed blob under its own unit, sealed by the operator
  as docs/psk.md describes for a daemon. Whether it may instead load the blob the box's `seanced`
  unit already uses is a build-time question (open details).
- **A28.** Backups are the host's (snapshots of the box or container it runs in). The service ships no
  copies anywhere.
- **A29.** Moving the seat is manual and documented: stop the service, copy `archive.sqlite`,
  seal the PSK on the new box (the blob is machine-bound), put the new id on `ARCHIVIST`.

### 7. Reading it

- **A30. SQL.** `ssh` to the box and `sqlite3`, opening the file read-only. The schema and a few
  example queries are documented.
- **A31. The PWA** reads through the relay only (its CSP allows nothing else): sealed requests
  addressed to the archivist's device id, answered sealed. Three ops: an archive status, a
  metrics query (the `MetricsRequest` shape, extended to name a machine or an account), and a
  paged task query.
- **A32. Charts.** A machine's own daemon stays the source for the short ranges, as today. The
  archivist is the source for an account's chart (merged across machines), for ranges past 30
  days (new 90-day and 1-year ranges), and for a machine that is asleep.
- **A33. Merging an account.** Series are stored per observer, unmerged. An account's value in a
  bucket is the newest observation in it from any machine, computed at query time, as the fleet
  quota record already takes the newest reading per account.
- **A34. Task history.** The Queue screen's finished list continues into the archive ("older"),
  with filters for repo, outcome, machine, account and date range, and a substring search on the
  title.
- **A35.** With no archivist online, none of these controls is shown.
- **A36. Health.** The Machines screen shows the archivist as its own card: online, last ingest,
  row counts, database size.

**The PWA's surfaces.** Settled 2026-11-12 by the owner's review of the design canvas
(https://claude.ai/artifact/B83Ftm67X654rGd4siUeBe, phone width, built from the PWA's own
`tokens.css`/`screen.css` and the markup of `machines.tsx`/`queue.tsx`). Nothing here adds a new
component or style.

- **A36a. Where the card sits.** Last in the machine list, after every machine and before
  Accounts; no heading of its own. It is a `fleet-card` like a machine's but carries no gauges,
  no exclave rows, no ⋯ menu (nothing to chart or act on) and no Scheduler badge. Its meta line
  reads `<platform> · last ingest <age>`, then the build line; both need the open detail on a
  `machine-info` blob below, and drop what it does not say.
- **A36b. Its rows.** Tasks, Samples, Events (row counts) and Database (size of
  `archive.sqlite`), each with the oldest date it holds, laid out in the exclave table's columns so
  the numbers share the right edge with every other card. One quiet line under them: "Keeps task,
  chart and fleet history. Never runs sessions."
- **A36c. Offline.** Grey dot, `offline · last seen <age>`, no rows (the status op needs it
  online), and one line: what is hidden until it is back. Shown while the registry holds its
  entry; a fleet whose registry never held an archivist shows no card.
- **A36d. Range picker.** One segmented control, `6h · 24h · 30d · 90d · 1y`; the last two only
  while the archivist is online (A35). If it leaves while one is showing, the chart falls back to
  24h.
- **A36e. No source marking.** A chart draws the same lines and legend whichever side answered;
  the UI never says which ranges are a daemon's and which the archive's. The source shows only in
  a failure, worded like today's daemon one: "No answer — the archivist may be offline."
- **A36f. Account and asleep charts.** A merged account chart (A33) adds nothing to its card: the
  detail line already names the machines. An asleep machine's card gains ⋯ › History while the
  archivist is online; its lines stop at its last beat and the rest of the window stays empty.
- **A36g. Older.** A collapsible section after Finished, with the Asleep section's toggle, closed
  by default, no count (the archive is paged). It lists only tasks not already in Finished
  (deduplicated by id). It disappears on the registry push that drops the archivist.
- **A36h. Filters.** Inside Older, first a title search (the rename field's style), then the spawn
  form's tile grid: Repo, Outcome, Machine, Account, Dates, each opening the existing bottom
  sheet. They filter Older only, never the live sections. Dates is presets only: last 7, 30 and 90
  days, last year, any time. Machine lists retired machines by last known name (A24).
- **A36i. Archived cards.** No ⋯ menu and no Continue: the record has left the store, so nothing
  can act on it. The PR chip is its last archived state, without the checks icon.
- **A36j. Paging and states.** 20 a page, "Showing 20 of N" and a quiet "Load older" at the end;
  loading is "Loading…" under the filters; no match is "No older tasks match." with "Clear search
  and filters".

### 8. The silence alert

- **A37.** The leader sends one push when the archivist's registry entry has been absent 24 h,
  and again only after it has returned and gone absent again. A fleet whose registry has never
  held an archivist is never alerted. The payload carries state only, with fixed text per kind,
  like every push.

## Rejected alternatives

- **A relay endpoint of its own (`/archive`) with a read-only rule.** One shared token and a PSK
  on the box make the rule weak, and the future case (requesting a session) is an ordinary
  app-role enqueue (A10).
- **A plain app-role client with no seat.** Every app socket is the anonymous `"app"`: the relay
  could not refuse a second archivist and the PWA could not address the one.
- **Sealed blobs only, decrypted by the PWA.** No SQL, no aggregation, no downsampling.
- **Pruning that waits for the archivist.** Makes an optional box load-bearing for the store's
  size (A2).
- **A mode of `seanced`.** The archivist must not be able to spawn; a separate workspace with a
  layering test is the stronger line (A8).
- **Live frames only, or pulls only.** Live alone loses whatever was sent while the archivist was
  down; pulls alone lag by the timer. Both, with the pull authoritative (A17).
- **Archiving tasks from creation.** An unfinished record still carries its prompt, and the live
  queue already shows it (A16).
- **A standby or failover seat** (A6), **a purge op on the wire** (A23), **service-run backups**
  (A28), **a provisioning script for a container** (A27).
- **Requiring a box of its own.** A box that already runs a daemon has the TPM, the checkout and
  Bun, and A29 moves the seat later; the separation that matters on a shared box is the Unix user
  (A27a).
- **Names.** `ledger` (the launch ledger), `codex` (an existing tool), `familiar` (acts for its
  master). `archivist` says what it does, like `scheduler` and `relay`.

## Build order

One stack of PRs, each based on the one before, merged together.

**Milestone 1 — collect**

1. The role and the seat: `DAEMON_ROLES.archivist`, the `ARCHIVIST` secret, the relay's refusal,
   and every registry reader skipping the entry as a machine (A5, A6, A9). **Built 2026-11-12.**
2. The `archivist/` workspace: config, PSK, signed register, the app-role leg, the layering test,
   `run` and `status` (A7, A8, A11, A12, A25). **Built 2026-11-12.**
3. Tasks and fleet events: schema, migrations, the store reader, upsert by version (A13–A16, A18,
   A21).
4. Metrics: the shared rollup module, live `status` ingest, `metrics` pulls with watermarks, the
   first-start import, retention (A17, A19, A20, A22).
5. `install --system`, update on the announce, and the docs: README setup, the move-the-seat
   runbook, schema and example queries (A26–A30).
6. The archive status op and the Machines screen's health card (A31, A36–A36c).

**Milestone 2 — read**

7. The metrics and task query ops, in the archivist and `RelayClient` (A31, A33).
8. PWA charts: 90-day and 1-year ranges, merged account charts, asleep machines (A32, A35,
   A36d–A36f).
9. PWA task history: the older list, filters, title search (A34, A35, A36g–A36j).

**Milestone 3 — alert**

10. The leader's silence push (A37).

## Open details (build time)

- Whether two system units on one box can each load the same `seance-psk` blob, or the archivist
  needs one sealed under a name of its own (A27b).

- Where the shared rollup module lives. `shared/` is bundled by the relay and the PWA, and
  `bun:sqlite` must not reach either bundle.
- The pull timer and the page size against `METRICS_MAX_POINTS` (720) and the relay's
  `store-list` floors (4 per minute per socket per prefix).
- **The flag is per push.** The relay stores the signed claim and derives `archivist` against
  `ARCHIVIST` as it is at each push. Moving the seat (A29, the runbook in item 5) turns the old
  id's kept entry into an ordinary offline entry. With the seat's blob (not a `MachineInfo`;
  DESIGN.md, "Archivist") it is never a `Machine`
  row, so the PWA counts it as skewed and offers no forget button; the runbook must say to
  forget it by id (`RelayClient.forget`, or a raw `forget` frame from an app socket). Item 6's health card and item 10's silence alert read the flag, so
  they follow the seat, not the old entry.
- The label an archived series carries for its observer, since a daemon's own series name no
  machine.
