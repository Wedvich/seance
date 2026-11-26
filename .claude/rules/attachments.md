---
paths:
  - "relay/src/{attachments,allowance}.ts"
  - "daemon/src/attachments.ts"
  - "shared/src/{crypto,upload-attachment}*.ts"
  - "pwa/src/{attachments,upload-queue,store,share*}.ts"
---

# Attachments

Requirements, not observations: DESIGN.md's "Attachments" and Threat model are the record. The task
record's `attachments` field and its sentinel are task-records.md.

- An attachment object opens only through `openAttachment` (`shared/src/crypto.ts`), its AAD bound to the
  op and its own id.
- The relay's `/attachments/<id>` routes (`relay/src/attachments.ts`) read no body
  (`relay/test/layering.test.ts`), take the token from the `Authorization` header only, store create-only
  under an id held to `ATTACHMENT_ID_PATTERN`, refuse on the declared length and the Hub's upload
  allowance (`relay/src/allowance.ts`) before R2 sees a byte, and log no accepted transfer.
- A daemon accepts `attachments` only on a spawn sealed `from` the scheduler with `client: "scheduler"`
  (or the leader's in-process dispatch). It fetches each object only from `attachmentUrl` over its own
  config's `relayUrl` with the manifest's id, before the launch ledger's write-ahead record, checks its
  length and `attachmentHash` before `openAttachment`, writes it only as `<index>.<ext>`
  (`ATTACHMENT_EXTENSIONS`, never the name) under the 0700 `stateDir()/attachments/<taskId>`, refuses
  `attachment_unavailable` on any failure with nothing left behind, puts names only in the seed (stdin for Claude,
  the first `turn/start`'s text for Codex, never argv),
  and audits a count and total bytes, never names, ids or hashes (`daemon/src/attachments.ts`).
- The PWA writes a task carrying `attachments` only to a verified leader advertising
  `CAPABILITIES.attachments`, only once every file in it answered `201 stored`, uploads only through
  `RelayClient.uploadAttachment` with the token in the `Authorization` header, and shows names only on the
  form, never on the Queue screen or verdict (`pwa/src/store.ts`).
