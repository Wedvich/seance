---
paths:
  - "daemon/src/{drain-*,lead-fallback*,availability-client,state,status,spawn,shutdown,handlers}.ts"
  - "shared/src/{drain,status-reader}.ts"
  - "scheduler/src/drain-trigger.ts"
  - "pwa/src/machines-view.ts"
---

# Closing and draining a machine

Requirements, not observations. DESIGN.md's "Closing a machine", "The drain's outside pass" and "The
drain's session ask" are the record; docs/drain.md keeps the names and the owner's decisions.
CLAUDE.md's recurring rules hold throughout.

## Closing a machine is the owner's sealed act

- `availability` is answered under the owner's-sealed-act rule (`parseAvailabilityRequest`; a keyless box
  refuses `seance close` and points to the PWA).
- A `closed` it cannot read in `state.json` loads as closed — in `loadOrInitState` only, `readState`
  stays log-free. `MachineStatus.cl` is never trimmed by `fitStatus`.
- The gate runs after `relaunchRefusal` and before any fetch or ledger write. `SpawnRequest.routesClosed`
  is accepted only as `true`: a closed daemon answers `machine_closed` only when it is set and
  `internal_error`, unrecorded, otherwise.
- A close is offered only to a target advertising `CAPABILITIES.close` under a verified leader
  advertising `CAPABILITIES.drain`.
- `availability`'s `now` is `true` only, honoured only by a daemon advertising `CAPABILITIES.drainAsk`,
  offered only to such a target (refused locally otherwise, before anything is sent), and never
  persisted.
- `availability`'s `soft` is `true` only, never beside `now` (`invalid_request`), never persisted, and
  sent by a client only to a target advertising `CAPABILITIES.softClose` under a verified leader
  advertising it (refused locally otherwise in the PWA, the draining close sent instead by the CLI and
  MCP; an older daemon would drop it and drain).
- A `closed.drainAt` it cannot read loads as not draining; `MachineStatus.dr` is sent only beside `cl` and
  never trimmed by `fitStatus`.
- The leader's outside pass drains a machine only from `drainStart` (`shared/src/status-reader.ts`: `dr`,
  else `cl` for a daemon not advertising `CAPABILITIES.softClose`, else never).

## The drain's session ask

The drain trigger's pass rules are scheduler.md's "Successors and passes".

- The drain's session ask (`daemon/src/drain-ask.ts`) sends a pane only constant keys — `DRAIN_PROMPT` by
  `send-keys -l`, then Enter, and Escape and Ctrl+C, the Ctrl+C once and never a second, no Escape in the
  draft clear, never a field of any frame.
- Only into a live pane whose launch ledger holds a worktree launch of its task (`EndedTasks.askable`; never a Codex launch),
  once per pane and task per `cl` per process (a repeated close at the same `cl` asks and Escapes nothing
  already asked), only while this machine is draining at the `cl` the ask began under (checked before an
  Escape goes, not after).
- The text only after that pane's `idle` carrying `turnEnded` and never while its last frame is
  `needs-input` (the drain can deny a permission, never grant one), re-checking the pane, its task, `cl`,
  its last frame and that its input box shows exactly the prompt before Enter, audited `origin=drain`
  with the task id and outcome, never the text.
- A `session-pass` carries `drain` only while its machine is closed, and the leader writes
  `trigger: "drain"` for it only while that machine's status carries `cl`.
