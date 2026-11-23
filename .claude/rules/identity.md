---
paths:
  - "relay/src/{hub,seat,leadership,auth,index,wire}.ts"
  - "shared/src/{identity,app-client,crypto}*.ts"
  - "daemon/src/{relay-client,machine-info*,deregister,lead-fallback*,app-relay*,state*}.ts"
  - "archivist/src/{info,run}.ts"
---

# Identity, the registry and nomination

Requirements, not observations: DESIGN.md's Threat model and wire protocol are the record. The relay is
blind, so only a seal says who wrote a blob.

- A registry entry whose `info` blob is not sealed `from` its own `deviceId` never becomes a `Machine`
  (verified app-side in `shared/src/app-client.ts` — only the AAD-bound `from` says which machine an entry
  describes).
- Every blob opened outside the replay guard (`machine-info`, `status`, `lead-proof`, and the store's
  `task`, `pause-state` and `scheduler-settings` records) goes through `openAtRest` in
  `shared/src/crypto.ts`, which refuses one whose `op` isn't the slot's — shape alone does not say which
  blob it is.
- An app believes a scheduler nominee only with a `lead-proof` sealed `from` the nominee for the pushed
  term, never because its registry entry opens (its `info` blob is readable off any push and
  re-registrable under a stolen seed).
- A `register` moves a route only when it is signed by the key its `deviceId` hashes (verified in
  `relay/src/hub.ts` through `shared/src/identity.ts`; the seed never leaves `state.json`), and any
  register field the relay acts on — today `roles`, which decides nomination — is covered by that
  signature (the v2 message), never trusted as plaintext.
- The relay nominates only ids on its `SCHEDULER_LEADERS` secret — unset nominates nobody, and no
  wildcard exists, in product code or as a test escape hatch.
- The relay honours the `archivist` role only on a verified v2 register from the one id on its
  `ARCHIVIST` secret (`relay/src/seat.ts`) — unset honours nobody, no wildcard in product code or tests,
  and any other claim, or one beside `scheduler`, is closed `register role-refused` and writes nothing.
  It pushes an entry as the seat only while its stored claim's id is the secret's now (`isSeat`), never a
  stored flag, and `RelayClient` never makes a seat entry a `Machine` (`#rebuildMachines`), so it is no
  spawn target to any reader.
- An app believes the archivist card only from the flagged entry whose `info` blob is sealed `from` its
  own `deviceId` and parses as `ArchivistInfo`.
