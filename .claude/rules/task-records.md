---
paths:
  - "shared/src/{task-record,account-record,fleet-quota,traits,tags,crypto}*.ts"
  - "scheduler/src/{task,deps,traits,chain-tags,prune,expiry}.ts"
  - "daemon/src/{fleet-quota*,traits*,trait-probes,config,account-cache*,queue-store,store-frames}.ts"
  - "pwa/src/{account-store,task-tags,scheduler-store,store}.ts"
---

# Task, account and quota records

Requirements, not observations: DESIGN.md's Threat model and docs/scheduler.md are the record. CLAUDE.md's
recurring rule "Offer only what the peer advertises" is why every new field carries a dep sentinel. The
relay's side of the store is relay-store.md; who may write which field is scheduler.md.

## Reading a record

- A task record is read only through `openTaskRecord` then `bindTaskRecord` (`shared/src/task-record.ts`).
- An account record is read only through `openAccountRecord` (`shared/src/account-record.ts`) — sealed to
  `"app"` under op `account`, its sealed version the relay's, its `accountId` HMAC'd under the
  PSK-derived account key to its own key — and an alias is display-only, never used to route, bind or
  place.
- No reader deletes a record it cannot read on its own — after a PSK rotation every record reads that way
  — with one bounded exception: the fleet quota writer (`daemon/src/fleet-quota.ts`) overwrites a
  `quota:fleet` record it cannot read, at its version, only once that record has stood unchanged at one
  store version for `FLEET_QUOTA_STALL_MS` (24 h of awake observation time since this writer first saw it
  there, each gap between sightings counted up to twice the interval; a readable read resets it) (no
  deletes on `quota:`, so a dead one would hold the slot for good), and the record is read only through
  `openFleetQuotaRecord`.
- A tombstone lives exactly as long as admission's age limit (`STORE_TOMBSTONE_MS` for both: the relay's
  tombstone, `isExpired` in `scheduler/src/deps.ts`), since a pruned task's version-1 blob put back after
  its tombstone lapses must be too old to admit.

## The one task sealer

Every new task-record field goes through `taskRecordAtRest`/`sealTaskRecord` with a marker an older
leader's parser refuses.

- **`pin.account`, `avoid`**: the sealer emits `pin.exclave: ""` for an older leader to refuse, and the
  parser never nulls a spec over `pin.exclave`.
- **`attachments`**: the sealer appends `ATTACHMENTS_DEP_SENTINEL` to its deps for an older leader to
  refuse, and the parser drops that sentinel only beside a manifest and nulls the spec over any malformed
  manifest — never drops the field. The leader dispatches such a task only to a machine advertising
  `CAPABILITIES.attachments` (`attachments_unsupported` otherwise), copying the manifest unchanged into
  the spawn, and drops it only on the write that finishes the task (`forgetPrompt`). The object and its
  transfer: attachments.md.
- **`requires`**: the sealer appends `REQUIRES_DEP_SENTINEL` to its deps for an older leader to refuse, and
  the parser drops that sentinel only beside `requires` and nulls the spec over the sentinel without it.
  A client writes `requires` only to a verified leader advertising `CAPABILITIES.traits`.
- **`tags`**: the sealer appends `TAGS_DEP_SENTINEL` to its deps for an older leader to refuse, and the
  parser drops that sentinel only beside `tags` and nulls the spec over the sentinel without it. A client
  writes `tags` or `ownerTags` only to a verified leader advertising `CAPABILITIES.taskTags`, a client's
  create seals only `creator.*` (the record is version 1, and `bindTaskRecord` drops every other key from
  one), `owner.*` changes only through `amend` from the PWA, in any state, and adapters write none, and no
  tag is ever in a push, a log or an audit line.
- **`succeeds`**: `SUCCESSOR_DEP_SENTINEL`, scheduler.md "Successors and passes".

## Traits

- A machine's traits are declared only in its own `config.json` — never from a frame, the PWA or another
  machine.
- A trait's probe runs only the argv that file names — an argv array, never a shell string, under the
  environment a session gets less `CREDENTIALS_DIRECTORY`, stdio ignored and never read or logged, one
  probe at a time per process, killed by process group at its timeout and swept by group when it exits on
  its own, audited under origin `probe` with an argv word count, hash and `argv[0]`'s basename (the one
  argv text written, so never a secret in that word), never another argv word or any output
  (`daemon/src/trait-probes.ts`).
