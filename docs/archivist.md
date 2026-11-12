# The archivist — spec

**Status: spec, nothing built.** Decided with the owner on 2026-11-12. Like docs/scheduler.md and
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

- **A5.** One archivist per fleet. It registers on `/daemon` with a new role,
  `DAEMON_ROLES.archivist`, covered by the v2 register signature like `scheduler`.
- **A6.** The relay honours that role only from the one device id on a new Worker secret,
  `ARCHIVIST`. Unset honours nobody; there is no wildcard, in product code or as a test escape
  hatch. A register claiming the role from any other id is refused. No terms, no nomination, no
  standby: a second archivist would hold a different database, so failover would leave two
  partial archives.
- **A7.** It reads through a second, app-role connection, as the leader's own app leg does
  (`daemon/src/app-relay.ts`): live `status` frames, the `metrics` op, store reads.
- **A8.** It is read-only by its own code: it never enqueues, never writes the store, never
  handles a spawn, despawn or scheduler op, and advertises no repos and no exclaves. A layering
  test holds this (no import of spawn, tmux, broker or queue-writing modules), in the style of
  `scheduler/test/layering.test.ts`. Letting it request sessions later is a threat-model change
  with its own audit origin, not a tweak.
- **A9.** _Derived._ Every reader of the registry that treats an entry as a machine (the PWA's
  Machines screen and spawn form, the scheduler's candidates, `list_machines`, Raycast) skips an
  entry holding the archivist role as a spawn target.
- **A10.** No endpoint of its own. The relay has one shared `BEARER_TOKEN`, and the box holds the
  PSK anyway, so a separate token would protect little.

### 3. Trust

- **A11.** The archivist holds the PSK and a plaintext history database. It is a new kind of PSK
  holder, and DESIGN.md's threat model gains an entry for it. It differs from the standalone
  scheduler box rejected in docs/scheduler.md ("the fifth kind of PSK holder and the first to act
  on its own") in that it never acts (A8).
- **A12.** The PSK is held as a daemon's is on Linux: a TPM-sealed blob delivered by a systemd
  system unit (`LoadCredentialEncrypted`, docs/psk.md). The service never runs as root.
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
  `install --system`, `update`, `status`), unit `seance-archivist.service`, database
  `archive.sqlite` in its state dir (0600, WAL, migrations on `PRAGMA user_version` as
  `metrics-store.ts` does). Bun and `bun:sqlite`; no other database, no Node.
- **A26.** It runs from the same git checkout layout as `seanced` and follows the fleet's update
  announce: an archivist that cannot parse a newer task record would archive nothing, silently.
- **A27.** The host is an unprivileged Debian LXC the owner creates by hand, on the Proxmox host
  that runs Thad, with the TPM device passed through. Séance ships the service's installer, not
  the container.
- **A28.** Backups are the host's (Proxmox snapshots of the container). The service ships no
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
  (A28), **a provisioning script for the container** (A27).
- **Names.** `ledger` (the launch ledger), `codex` (an existing tool), `familiar` (acts for its
  master). `archivist` says what it does, like `scheduler` and `relay`.

## Build order

One stack of PRs, each based on the one before, merged together.

**Milestone 1 — collect**

1. The role and the seat: `DAEMON_ROLES.archivist`, the `ARCHIVIST` secret, the relay's refusal,
   and every registry reader skipping the entry as a machine (A5, A6, A9).
2. The `archivist/` workspace: config, PSK, signed register, the app-role leg, the layering test,
   `run` and `status` (A7, A8, A12, A25).
3. Tasks and fleet events: schema, migrations, the store reader, upsert by version (A13–A16, A18,
   A21).
4. Metrics: the shared rollup module, live `status` ingest, `metrics` pulls with watermarks, the
   first-start import, retention (A17, A19, A20, A22).
5. `install --system`, update on the announce, and the docs: README setup, the move-the-seat
   runbook, schema and example queries (A26–A30).
6. The archive status op and the Machines screen's health card (A31, A36).

**Milestone 2 — read**

7. The metrics and task query ops, in the archivist and `RelayClient` (A31, A33).
8. PWA charts: 90-day and 1-year ranges, merged account charts, asleep machines (A32, A35).
9. PWA task history: the older list, filters, title search (A34, A35).

**Milestone 3 — alert**

10. The leader's silence push (A37).

## Open details (build time)

- Where the shared rollup module lives. `shared/` is bundled by the relay and the PWA, and
  `bun:sqlite` must not reach either bundle.
- The pull timer and the page size against `METRICS_MAX_POINTS` (720) and the relay's
  `store-list` floors (4 per minute per socket per prefix).
- Whether the archivist's registry entry carries a `machine-info` blob, and what it says, given
  A8's "no repos, no exclaves".
- The label an archived series carries for its observer, since a daemon's own series name no
  machine.
