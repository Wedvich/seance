---
paths:
  - "relay/src/{store,leadership,hub}.ts"
  - "relay/test/store*.ts"
  - "daemon/src/{store-frames,queue-store,settings-store}.ts"
---

# The relay's store

Requirements, not observations: DESIGN.md's Threat model ("Bearer token disclosure") is the record. Reading
a record and the tombstone's lifetime are task-records.md.

- Every store policy is a field on the prefix's `STORE_PREFIXES` rule, and `relay/src/store.ts` names no
  prefix.
- A `term` on an app-leg store frame authorizes nothing. A daemon-leg write to a term-fenced prefix is
  fenced on the term and the socket it was issued to (`holdsTerm` in `relay/src/leadership.ts`).
- A `/daemon` socket's store frames are answered only once its register is accepted.
- Every create the term fence does not cover meets the write floor, and so does every overwrite there.
- A singleton prefix accepts one key (`queue:pause`, `quota:fleet`: a cap of one alone lets a token holder
  squat the slot).
- Store records live under their own storage namespaces so no key aliases `device:` or `scheduler:term`.
- Deletes are refused on every prefix but `task:` (the leader's there, and only `task:` keeps tombstones).
- The app leg creates only under `task:` and `account:` and overwrites only under `account:`.
- The relay logs no store `env`/`ct` and no line per accepted store read or write — nor one per delivered
  scheduler envelope, `queue-changed` or `store-changed` nudge or credited reply, only their failures.
