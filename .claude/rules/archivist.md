---
paths:
  - "archivist/**"
  - "daemon/src/metrics-tiers.ts"
---

# The archivist

**The archivist holds the PSK and never acts.** Requirements, not observations: DESIGN.md's Threat model
item 2 and its "Archivist" section (A1–A37) are the record. CLAUDE.md's recurring rules hold throughout.

- Its key comes only from its unit's `$CREDENTIALS_DIRECTORY/seance-psk` (`CRED_NAME`, imported), never a
  config field; it never runs as root; its state dir is its own, never the daemon's.
- It registers only claiming `archivist`, with a blob `parseMachineInfo` refuses, and answers three ops,
  `archive-status`, `archive-metrics` and `archive-tasks`, sealed `from: "app"` to its own id past the
  seat leg's replay guard, with counts, sizes and timestamps, metric points, or stripped task records
  with the machines the archive holds tasks for.
- It sends no `status` and no store frame, and never enqueues; the fleet's `update-available` broadcast
  only makes it write `update-requested`, for the credential-less update unit to act on.
- `archivist/test/layering.test.ts` walks `run`'s whole import closure (type-only imports too) and its
  own source's calls: a module that spawns, drives tmux, dispatches ops, brokers, leads or writes the
  queue or store, `daemon/src/config.ts`, anything in `scheduler/`, or a client write method is refused.
- `install.ts`, `self-update.ts` and `units.ts` are the admin closure: reached only by `main.ts`'s
  `import()`, allowed the daemon's exec path (`exec.ts`, `tpmcreds.ts`) and, type-only (`import type`,
  checked per edge), the two modules `audit.ts` names for its line formats (`backend.ts`,
  `broker-protocol.ts`), nothing else forbidden, and never run with the key.
- When a daemon module it needs sits beside one it must not load, move the module (as `config-checks.ts`
  was), never copy it, and never widen the forbidden list's exceptions.
- `seance-archivist install --system` / `uninstall --system` (`archivist/src/install.ts`) follow
  CLAUDE.md's "The daemon never runs as root", reusing `daemon/src/target-user.ts` and the daemon's unit
  helpers rather than copying them.

## Its answers and its archives

- It answers only `archive-status`, `archive-metrics` and `archive-tasks`, only when sealed `from: "app"`
  with no `re`, parsed by that op's own parser (`parseArchiveStatusRequest`, `parseArchiveMetricsRequest`,
  `parseArchiveTasksRequest`) through one gate (`answerApp`, `archivist/src/answer.ts`), through its seat
  leg's replay guard, with a reply of counts, sizes and timestamps, metric points, or task records
  re-stripped through `archivedTask` (never a prompt, an attachment or a raw account id) with the machines
  the archive holds tasks for (device id, last known name, newest end time; display only), every task
  filter a bound SQL parameter, and nothing of a request logged.
- An app believes the archivist card only as identity.md says.
- `archive.sqlite` (`archivist/src/archive.ts`) holds no prompt text, no attachment manifest and no raw
  account id:
  - a task row is written only through `taskRow`, only for a finished task read through
    `listTasks`/`getTask`, after `forgetPrompt` and with `pin.account`, `spillAlert`, `quotaExhausted`,
    `assignment.window`, `branch`, `failure.message`, `decision`, `flag.note` and every task tag but
    `creator.ref` and `creator.ref-url` dropped (the daemon slugs a title-less task's window and branch
    from its prompt) and `succeeds.account` replaced by the constant `ARCHIVED_SUCCEEDS_ACCOUNT`, its
    account only as the `account:` store key, and only over a row at a lower store version;
  - an account row only from `openAccountRecord` or a key `accountStoreKey` made;
  - no statement there removes a row (`archivist/test/layering.test.ts`) — its one `DROP`, migration 2's
    pinned `DROP TABLE tasks`, runs only after every row was copied into the rebuilt table and the count
    checked.
- `metrics.sqlite` (`archivist/src/metrics-archive.ts`) labels an account only by the `account:` store key
  and removes rows only through the shared tiers' two horizon prunes (`daemon/src/metrics-tiers.ts`, the
  daemon's own rollup, imported, never copied).
