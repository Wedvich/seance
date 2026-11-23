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
