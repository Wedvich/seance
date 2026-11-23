# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Séance spawns remote-controlled Claude Code sessions on dev machines via a blind relay. Bun workspaces
monorepo: `daemon/` (seanced, per-machine), `relay/` (Cloudflare Worker + Durable Object), `pwa/`
(Vite + Preact app), `raycast/` (a local-only Raycast extension — spawn only), `shared/` (wire types,
envelope crypto + the app-role RelayClient), `scheduler/` (the scheduler as a pure library: routing,
task state, reservations — no I/O, hosted only by the leader's modules — `LEADER_MODULES` in `scheduler/test/layering.test.ts`), `archivist/` (`seance-archivist`, the fleet's optional
history service — DESIGN.md, "Archivist"; it imports daemon modules by path, never copies them), `e2e/` (full-stack test suite, no shipped code).
`claude-mods/` is not a workspace: Claude Code function-hook plugins, installed by
`seance mod install` (DESIGN.md, "Claude Code mods").

Read the docs before changing behavior — this file deliberately doesn't repeat them. Each doc opens with
a **Status** line (built, spec, draft); trust it over memory.

- **README.md** — setup, deploy, update; the archivist's setup and move-the-seat runbook (step 9).
- **DESIGN.md** — the decision record: architecture, wire protocol, threat model, every rejected
  alternative. A change to decided behavior updates it. Protocol work starts at "The map: one spawn,
  end to end" (which module owns each frame); `shared/src/types.ts` is the schema of record, so a frame
  change touches both. "Archivist" holds A1–A37: read it before touching history, retention, registry
  roles or the Machines screen's charts.
- **docs/development.md** — commands, local dev, deploy mechanics, test layering and the reasons behind
  the Testing rules below. Read before running the suite, local dev or deploying.
- **docs/psk.md** — where the PSK lives per platform and how import keeps it off argv; the only prose
  home of the psk-store/import constraints.
- **docs/platform-notes.md** — Linux/WSL service specifics (linger, Windows logon pin task, the
  service-definition lag update/install code must respect).
- **docs/scheduler.md** — the scheduler plan; M1–M3 built, M4 ahead of code. Read before scheduler work.
- **docs/drain.md** — closing and draining a machine; built, keeps names, owner decisions and measures.
  Read before scheduler routing or shutdown work.
- **docs/leaving.md** — spec: the daemon's sealed `leaving` note. Read before touching shutdown,
  presence or the systemd unit.
- **docs/messaging.md** — session messages and the adapter seam; built, keeps spikes, D1–D4 and open
  questions. Read it, and DESIGN.md's "Adapters", before adding a leader event op or an adapter.
- **docs/presence.md** — spec: `self.doing`, presence-answered `status`, coalesced wakes. Read before
  touching `doing`, presence, receipts or the inbox mod's delivery.
- **docs/gh-watch.md** — GitHub watches; built, keeps an index into DESIGN.md. Read before touching the
  PR poller, `askGithub`, watches, or a new way for sessions to wait on GitHub.
- **docs/custodian.md** — the custodian; built, keeps 4b's open drill questions and an index of C1–C49.
  Read before touching despawn, reap's merged check, a pane's tracked state, or anything that reads a
  live session's screen.
- **docs/agents.md** — analysis: agents other than Claude Code (Codex, `agy`). Read before adding a
  second agent or making the launch path agent-neutral.
- **docs/codex.md** — design, nothing built, every question decided by the owner: Codex as a
  first-class account. Read it, and docs/agents.md, before any Codex work.
- **docs/orchestrator.md** — draft, nothing decided: tracker projects as task graphs. Read before amend
  deps, anything that reads a tracker, or a non-task session; build nothing from it.
- **docs/tags.md** — tags and session identity; built, keeps open questions and spike evidence. Read
  DESIGN.md's "Tags and session identity" before adding a field that labels a session or task, or
  touching session identity or adapter addressing.

Like DESIGN.md, the docs/ files are part of the record: a change that alters behavior they describe
updates them in the same commit. They are not auto-discovered — this list is how sessions find them.

**This file holds rules, never the record.** A decision, its history or its evidence goes in DESIGN.md
or a doc; here goes only the rule an agent must not break, and where its record lives.

## Deploys

- Before any deploy or other Cloudflare operation, confirm auth with `bun run wrangler whoami` from
  inside `relay/` or `pwa/` (mechanics in docs/development.md). If the output doesn't name an
  authenticated account, stop and ask the user to run `wrangler login` rather than discovering it
  mid-deploy.

## Testing

Layout, commands and env vars are in docs/development.md, and so is the evidence behind each rule here
("Why the testing rules hold"). The rules that keep the suite green:

- Run the suite with `bun run test` (`scripts/test.ts`), never bare `bun test` or a top-level
  `bun test --parallel`: parallelism lives between shard processes, since `--isolate` resets the
  once-per-process memos, and booting workerd within ~100 ms of a dispose in the same process breaks
  its stdio. (`--parallel` inside the two daemon shards is fine.)
- Runner is `bun:test`, not Vitest — deliberate (DESIGN.md). The one exception is `claude-mods/`,
  whose tests only `claude plugin test` can run.
- The daemon suites set their own isolation env vars (`SEANCE_TMUX_SOCKET`, `SEANCE_CLAUDE_BIN`;
  `spawn.test.ts` also `SEANCE_MACHINE_TAG`).
- Never a fixed sleep before a _positive_ assertion: poll (`pollUntil`, `daemon/test/fixtures.ts`).
  A sleep before a _negative_ assertion is legitimate.
- Wait on the asserted thing's own signal (`waitForRequests`), never on an independent chain's: two
  chains finish in either order. A read is safe only when the awaited signal can come solely after it.
- An e2e test ends every task it queued through `cancelTask` (`e2e/harness.ts`), never a bare
  `client.cancel(...).catch(() => null)` or a killed window, and a suite that queues tasks asserts
  `takeLeakedTasks()` empty in `afterEach`. Before another leader op on a task just seen `running` in
  the store, wait for the leader's own view (`client.queue()`).
- Never let a test's first exec of a freshly written executable land inside a timed window (macOS scans
  it first, one at a time machine-wide). Exec it once in `beforeAll`, and write no new one: a bash stub
  is a `scriptStub`, a renamed bun is `bunNamed` (`daemon/test/fixtures.ts`), never a hard link of the
  installed bun (`bun-links.test.ts`).
- A shell stub a test stops with SIGINT traps it before writing anything the test waits on, and idles
  as `sleep 1 >/dev/null 2>&1 & wait $!` in a loop, never a foreground `sleep` (`raycast-cli.test.ts`'s
  `ray` stubs).
- Don't assert on anything the developer's `~/.tmux.conf` can set: name a test window at creation (`-n`).
- Every tmux call that opens a pty (`new-window`, `new-session`, `split-window`, `respawn-pane`,
  `respawn-window`) goes through `tmuxOk` (`daemon/src/tmux.ts`), in tests as in product code. A test
  that needs its own process in a session's pane uses `ClaudeStub.runInPane`, not `respawn-pane -k`.
- A test server binds `hostname: "127.0.0.1"` on every `Bun.serve`, never Bun's dual-stack default.
- `daemon/test/harness.ts` is a throwaway relay double with behaviors _inverted_ from the real DO; never
  a reference for relay behavior (DESIGN.md's wire protocol is). Each pairwise suite keeps its double on
  purpose and e2e catches drift: don't "upgrade" a double to the real component.
- tmux `-F` format strings use printable separators (tmux 3.4 mangles tabs), and sockets Bun dials into
  workerd set `perMessageDeflate: false`.
- Reuse `relay/test/harness.ts`'s `startRelay`; never boot your own Miniflare, and every caller
  `dispose()`s (`bun test` fires no exit hooks, so workerd would outlive the process).

## Recurring rules

Stated once here; every subsystem rule assumes them.

- **Bound by peer pid, never by a field.** A local-socket frame that acts for a session (`session-event`,
  `message`, `inbox`, `watch`, `custodian`) is bound to its pane by the kernel-reported peer pid, never by
  anything it sends, and refused where the host names no peer (`peerPidSupported`) or the pid came back
  null — `session-event` alone falls back to its `pane` on a host that names no peer at all. Where a
  binding names a session it is the `claude` process (`<pid>:<start time>` of the innermost `claude` on
  the peer's chain), not the pane or its pid.
- **Some stdouts are data channels.** Nothing reachable from `seance mcp` (JSON-RPC), `inbox-cli.ts` (the
  inbox mod's) or `custodian-cli.ts` (the round's) may call `log.ts`; `daemon/test/message-layering.test.ts`
  holds it. That is why `readState` exists beside `loadOrInitState`.
- **The owner's sealed act.** An op only the owner may make (`availability`, `session-tag`, `custodian`)
  is honoured only sealed `from: "app"` on the relay leg, parsed into a fresh value by its own
  parser, audited without a payload, and is on none of `LOCAL_OPS`, `BROKER_OPS` or MCP, so a session can
  never make it. A client offers it only where its `CAPABILITIES` flag is advertised.
- **Offer only what the peer advertises.** A client sends a new field or op only to a _verified_ leader
  (and target machine) advertising its `CAPABILITIES` flag, since an older peer drops what it does not
  know and acts anyway. A new task-record field goes through the one task sealer with a marker (a dep
  sentinel) an older leader's parser refuses.
- **Text never reaches a log.** Prompt and message text, notes, labels, tags, task, PR and watch URLs, bearer-handle ids,
  credentials, and anything a pane, an adapter, `gh` or git wrote never reach a log or an audit
  line. Audit lines carry ids, counts, enums and outcomes, under an origin per surface.
- **A new act is a threat-model change.** Widening a frame's acts, an op allowlist, the broker, a verb or
  a seam is recorded in DESIGN.md in the same change, never a tweak.

## Path-scoped rules

Subsystem requirements live in `.claude/rules/`, each loading when you read or edit a file its `paths:`
names. DESIGN.md defers to them for the rule. When a change reaches a subsystem from a file outside its
globs, read its rules file yourself first.

| File                            | Covers                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `.claude/rules/local-socket.md` | The local op socket and its allowlist, the fleet broker, `session-event`, session names |
| `.claude/rules/messages.md`     | `message` and `inbox` frames, replies by handle, cross-machine routing                  |
| `.claude/rules/watches.md`      | The daemon's GitHub watch table and its notes                                           |
| `.claude/rules/adapters.md`     | Adapters: config, supervision, state out, delivery, subscriptions, install verbs        |
| `.claude/rules/custodian.md`    | The custodian's round, sandbox, socket, verbs, owner verbs and controls                 |
| `.claude/rules/drain.md`        | Closing and draining a machine                                                          |
| `.claude/rules/archivist.md`    | The archivist's key, ops and layering                                                   |
| `.claude/rules/raycast.md`      | The Raycast extension's layering, credentials and runtime                               |

## Conventions

- Imports carry explicit `.ts` extensions; `shared/` is consumed as raw TS via `workspace:*` — no
  build step anywhere except the pwa.
- A PostToolUse hook (`.claude/settings.json`) runs oxfmt on every file you write — don't add
  manual formatting steps.
- Errors that cross the wire are structured codes (`SPAWN_ERROR_CODES` in `shared/src/types.ts`),
  not free-text throws. Any op can also answer with an `ErrorResponse` (`TRANSPORT_ERROR_CODES`:
  a crashed handler, an oversized reply), so an op's code list spreads those, and every `request<T>`
  resolves to `T | ErrorResponse` — narrow it (`"ok" in reply`, or `reply.ok`) before reading a field.
- Comments state rationale and constraints, not narration — match that density and style.
- Never persist `process.execPath`. It's the realpath'd binary (on Homebrew,
  `…/Cellar/bun/1.3.14/bin/bun`), so anything recording it — launchd plist, systemd unit, the Claude
  MCP entry — dangles the moment a package manager retires that version. Resolve through PATH
  (`resolvedBun()` in `daemon/src/link.ts`) or invoke bun by bare name and let exec resolve it
  (`update.ts`). Resolving at _use_ time is always fine; the hazard is only what outlives the process.
- DESIGN.md's threat-model invariants are requirements, not observations: argv-array exec (the one
  shell string is the tmux inner command, every wire-supplied value through `shq()`), `spawn`
  resolves repos by name against the cached scan set, every spawn, despawn and reap path audits
  through its one formatter under its own origin (`relay`, `cli`, `local`, `local-broker` for
  requests the daemon forwards to other machines, or makes of the scheduler (enqueue, queue, cancel,
  run-now, account list), for a keyless `seance mcp`, `seance spawn` or `seance start`, `schedule` for
  the daemon's reap timer, `probe` for the daemon's trait probes, `harvest` for the daemon closing a dead task pane after noting its exit
  status, `handoff` for the daemon closing a session that handed its PR off (`hand_off_task`),
  `drain` for the daemon typing its constant drain prompt, or the Escape before it, into a pane of a closed machine,
  `custodian` for the daemon's seat starting, closing, refusing to start or ending a custodian round and for a round's `close` and the worktree it decides, its `flag`, `nudge` and `interrupt`,
  `message` for a session's message to another task, on this machine or routed through the leader (one `dir=out` and one `dir=in` line per message, and a `dir=receipt` line for the leader's receipt: task ids, kind, byte count and outcome, never text; a custodian nudge writes only its `dir=in` line, `from=custodian`),
  `watch` for the daemon's watch table adding, removing, noting and ending a GitHub watch (one line per act, closed-enum
  values only: op, kind, event, reason, outcome — never a URL, owner, repo, number, head, check name or watch id),
  `adapter` for the daemon starting, restarting, refusing, holding as `failed` and stopping a configured adapter (its
  name, `argv`'s word count and `argv[0]`'s basename, an exit code and a reason, never another argv word or anything the
  adapter wrote), and for each message an adapter delivers or a session sends one (`op=deliver dir=in`, `op=message
  dir=out`: a task id or the constant `session`/`reply`, kind, byte count, outcome and code, never text, a `from`
  label, a message or conversation id),
  `successor` for the daemon pushing a task's branch on its own session's `pass_to_successor` and closing
  that session once the leader confirmed it,
  `leader` for the scheduler loop dispatching to its own machine in
  process and admitting a task, `mcp` for `seance mcp`'s own `spawn_session`/`queue_batch`/`continue_task` enqueue lines, and `cli` for
  anything typed at this machine's shell, its `spawn` enqueue line included — a new
  surface adds an origin, never reuses one),
  prompt text is never logged, a service-delivered credential never leaves the daemon process
  (`exec.ts` strips `CREDENTIALS_DIRECTORY`, or the tmux server it boots hands the PSK's path to
  every session), and a registry entry whose `info` blob is not sealed `from` its own `deviceId`
  never becomes a `Machine` (verified app-side in `shared/src/app-client.ts` — the relay is blind,
  so only the AAD-bound `from` says which machine an entry describes), and the archivist answers only `archive-status`, `archive-metrics` and `archive-tasks`, only when sealed `from: "app"` with no `re`, parsed by that op's own parser (`parseArchiveStatusRequest`, `parseArchiveMetricsRequest`, `parseArchiveTasksRequest`) through one gate (`answerApp`, `archivist/src/answer.ts`), through its seat leg's replay guard, with a reply of counts, sizes and timestamps, metric points, or task records re-stripped through `archivedTask` (never a prompt, an attachment or a raw account id) with the machines the archive holds tasks for (device id, last known name, newest end time; display only), every task filter a bound SQL parameter, and nothing of a request logged, and an app believes the archivist card only from the flagged entry whose `info` blob is sealed `from` its own `deviceId` and parses as `ArchivistInfo`, and the daemon process never holds a Claude credential: auth health (`daemon/src/auth-health.ts`) reads each exclave's credential store only through a short-lived `bun -e` child running the one constant script, with the file handed over as a file descriptor (or, on macOS, `security -w` run by the child), a bare env and a timeout, and keeps only the child's `{lapsed, refreshExpiresAt}` after an exact-shape check — never the child's stdout or stderr in a log, and nothing on the wire but `ax`/`ae`/`au` indices, an expiry time and `CAPABILITIES.authHealth`, every blob opened outside
  the replay guard (`machine-info`, `status`, `lead-proof`, and the store's `task`,
  `pause-state` and `scheduler-settings` records) goes through `openAtRest` in
  `shared/src/crypto.ts`, which refuses one whose `op` isn't the slot's — shape alone does not say
  which blob it is — and an app believes a scheduler nominee only with a `lead-proof` sealed `from`
  the nominee for the pushed term, never because its registry entry opens (its `info` blob is
  readable off any push and re-registrable under a stolen seed),
  and a `register` moves a route only when it is signed by the key its `deviceId` hashes (verified in `relay/src/hub.ts`
  through `shared/src/identity.ts`; the seed never leaves `state.json`), and any register field the
  relay acts on — today `roles`, which decides nomination — is covered by that signature (the v2
  message), never trusted as plaintext, and the relay nominates only ids on its
  `SCHEDULER_LEADERS` secret — unset nominates nobody, and no wildcard exists, in product code or
  as a test escape hatch, and the relay honours the `archivist` role only on a verified v2
  register from the one id on its `ARCHIVIST` secret (`relay/src/seat.ts`) — unset honours nobody,
  no wildcard in product code or tests, and any other claim, or one beside `scheduler`, is closed
  `register role-refused` and writes nothing — and pushes an entry as the seat only while its
  stored claim's id is the secret's now (`isSeat`), never a stored flag, and `RelayClient` never
  makes a seat entry a `Machine` (`#rebuildMachines`), so it is no spawn target to any reader,
  and the leader honours a scheduler request only when it was sealed
  `from: "app"`, parsed into a fresh value by that op's own parser (`parseQueueRequest`,
  `parseTaskRequest`, `parseTaskRef`, `parseAmendRequest`, `parseSetLimitsRequest`, …), and checked against the one replay guard per daemon
  process that every term's leg and the `not_leader` answer share (`schedulerGuard` in
  `daemon/src/run.ts`) — never a guard per term, which would let the relay replay a `cancel` into
  each, and the launch ledger (`daemon/src/launch-ledger.ts`) is write-ahead — a task id is on
  disk before its spawn runs, a spawn whose id it cannot record is refused, and `since` only
  moves forward — since it is what makes `ledgerSince` a proof that a spawn never landed — and an id
  still pending when the ledger opens is reported `interrupted`, never removed from `ended` (an older
  leader would read the gap as never-landed), and a leader never re-dispatches an interrupted task, and
  a task launch the restart drain turns away is answered `internal_error` unrecorded, never held and
  run later, and a
  scheduler spawn for a task id the ledger holds as launched is refused `task_launched`, audited,
  never run again, and a continuation (`mode: "continue"`) runs only for a spawn sealed `from` the
  scheduler with `client: "scheduler"` (or the leader's in-process dispatch), in the worktree this
  machine's own launch ledger noted for the continued task id — never a path from a frame — resuming
  the Claude session id this daemon chose at that launch (`--session-id`) and noted beside it — never
  an id from a frame — under the
  clone its `repo` name resolved to, and only while no later launch in that ledger noted the same worktree — a gone worktree
  re-added only at that noted path, a direct child of the clone's canonical `.claude/worktrees`, on the branch that ledger
  noted and only while `refs/heads/<branch>` exists, under reap's lock, added detached at that ref's sha and then switched onto it (never origin's, never `--force`, never `worktree prune`) — and a task record carrying `continues` always carries
  `mode: "continue"`, which an older leader's parser refuses, and the leader's version floor (`daemon/src/version-floor.ts`) is one per
  process like `schedulerGuard`, persisted 0600, and only ever raised by a read (the leader's own
  pause write and its own limits write alone may set it lower): a task record below it is `version_regressed`, a pause
  below it or missing holds the whole queue, limits below it or missing place nothing, and a task record that vanishes without the
  leader's delete is never read as gone, and the
  relay's store: every store policy is a field on the prefix's `STORE_PREFIXES` rule and
  `relay/src/store.ts` names no prefix, a `term` on an app-leg store frame authorizes nothing, a
  daemon-leg write to a term-fenced prefix is fenced on the term and the socket it was issued to
  (`holdsTerm` in `relay/src/leadership.ts`), a `/daemon` socket's store frames are answered only
  once its register is accepted, every create the term fence does not cover meets the write
  floor, and so does every overwrite there, a singleton prefix accepts one key (`queue:pause`,
  `quota:fleet`: a cap of one alone lets a token holder squat the slot), store records live under their own storage namespaces so no key aliases `device:` or
  `scheduler:term`, deletes are refused on every prefix but `task:` (the leader's there, and only
  `task:` keeps tombstones), the app leg creates only under `task:` and `account:` and overwrites
  only under `account:`, and the relay logs no store `env`/`ct` and no
  line per accepted store read or write — nor one per delivered scheduler envelope, `queue-changed`
  or `store-changed` nudge or credited reply, only their failures (DESIGN.md threat model, "Bearer token
  disclosure"), and a task record is read only through `openTaskRecord` then `bindTaskRecord`
  (`shared/src/task-record.ts`), and an account record is read only through `openAccountRecord`
  (`shared/src/account-record.ts`) — sealed to `"app"` under op `account`, its sealed version the
  relay's, its `accountId` HMAC'd under the PSK-derived account key to its own key — and an alias
  is display-only, never used to route, bind or place, and no reader deletes a record it cannot
  read on its own — after a PSK rotation every record reads that way — with one bounded exception: the fleet quota
  writer (`daemon/src/fleet-quota.ts`) overwrites a `quota:fleet` record it cannot read, at its
  version, only once that record has stood unchanged at one store version for `FLEET_QUOTA_STALL_MS`
  (24 h of awake observation time since this writer first saw it there, each gap between sightings counted up to twice the interval; a readable read resets it) (no
  deletes on `quota:`, so a dead one would hold the slot for good), and the record is read only
  through `openFleetQuotaRecord` — and a tombstone lives exactly as long as
  admission's age limit (`STORE_TOMBSTONE_MS` for both: the relay's tombstone, `isExpired` in
  `scheduler/src/deps.ts`), since a pruned task's version-1 blob put back after its tombstone
  lapses must be too old to admit, and every task record carrying `pin.account` or `avoid` is sealed through the one task sealer (`taskRecordAtRest`/`sealTaskRecord`), which emits `pin.exclave: ""` for an older leader to refuse, and the parser never nulls a spec over `pin.exclave`, and every task record carrying `attachments` is sealed through that same sealer, which appends `ATTACHMENTS_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside a manifest and nulls the spec over any malformed manifest — never drops the field, and the leader dispatches such a task only to a machine advertising `CAPABILITIES.attachments` (`attachments_unsupported` otherwise), copying the manifest unchanged into the spawn, and drops it only on the write that finishes the task (`forgetPrompt`), and every task record carrying `requires` is sealed through that same sealer, which appends `REQUIRES_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside `requires` and nulls the spec over the sentinel without it, and a client writes `requires` only to a verified leader advertising `CAPABILITIES.traits`, and a machine's traits are declared only in its own `config.json` — never from a frame, the PWA or another machine, and a trait's probe runs only the argv that file names — an argv array, never a shell string, under the environment a session gets less `CREDENTIALS_DIRECTORY`, stdio ignored and never read or logged, one probe at a time per process, killed by process group at its timeout and swept by group when it exits on its own, audited under origin `probe` with an argv word count, hash and `argv[0]`'s basename (the one argv text written, so never a secret in that word), never another argv word or any output (`daemon/src/trait-probes.ts`) — and every task record carrying `tags` is sealed through that same sealer, which appends `TAGS_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside `tags` and nulls the spec over the sentinel without it, and a client writes `tags` or `ownerTags` only to a verified leader advertising `CAPABILITIES.taskTags`, a client's create seals only `creator.*` (the record is version 1, and `bindTaskRecord` drops every other key from one), `owner.*` changes only through `amend` from the PWA, in any state, and adapters write none, and no tag is ever in a push, a log or an audit line — and an attachment object opens only through `openAttachment` (`shared/src/crypto.ts`), its AAD bound to the op and its own id, and the relay's `/attachments/<id>` routes (`relay/src/attachments.ts`) read no body (`relay/test/layering.test.ts`), take the token from the `Authorization` header only, store create-only under an id held to `ATTACHMENT_ID_PATTERN`, refuse on the declared length and the Hub's upload allowance (`relay/src/allowance.ts`) before R2 sees a byte, and log no accepted transfer, and a daemon accepts `attachments` only on a spawn sealed `from` the scheduler with `client: "scheduler"` (or the leader's in-process dispatch), fetches each object only from `attachmentUrl` over its own config's `relayUrl` with the manifest's id, before the launch ledger's write-ahead record, checks its length and `attachmentHash` before `openAttachment`, writes it only as `<index>.<ext>` (`ATTACHMENT_EXTENSIONS`, never the name) under the 0700 `stateDir()/attachments/<taskId>`, refuses `attachment_unavailable` on any failure with nothing left behind, puts names only in the seed on stdin, and audits a count and total bytes, never names, ids or hashes (`daemon/src/attachments.ts`), and the PWA writes a task carrying `attachments` only to a verified leader advertising `CAPABILITIES.attachments`, only once every file in it answered `201 stored`, uploads only through `RelayClient.uploadAttachment` with the token in the `Authorization` header, and shows names only on the form, never on the Queue screen or verdict (`pwa/src/store.ts`), and the daemon's one write to a forge is `pushTaskBranch` (`daemon/src/push-branch.ts`): a `git push` through `networkGit`, never forced, of `<tip sha>:refs/heads/<r>` to `origin` only, `<tip>` that of `<b>`, the branch its own launch ledger's worktree has checked out and `<r>` that branch's configured upstream on `origin` (one on another remote counts as none); with no upstream and a scheduler-sealed `push-branch`'s `expect` (the PR head the leader read), that `expect` only when origin's tip of it is an ancestor of the local tip and of no default branch's tip, the default fetched with it (else nothing is pushed, `branch_mismatch`; the default branch itself is `default_branch`); with neither, `<b>`; a push refused as a non-fast-forward is `push_rejected` unless the pushed sha is already part of origin's refetched `<r>`, which is `ok` with nothing pushed, never forced, merged or rebased — never a path, never a branch a session names, only on a clean tree and never to the default branch, refusing repo-local `remote.*.pushurl` and `url.*.pushinsteadof` (`pushConfigRefusal`), only on a `push-branch` sealed `from` the scheduler (or the leader in process), audited with no branch name and with git's stderr never in a reply, a log or an audit line, and the leader reads a PR's head only with its own `gh` (`readPrHead`), bound to the task's `prUrl`, its values passed as GraphQL variables, and never logs it, and a watched target is read only by the leader's own poller (`daemon/src/pr-status.ts`), as a URL `parseWatchSet` (`shared/src/watch.ts`) holds to the PR or run pattern and the poller rebuilds from its parsed owner, repo and number or id, passed as GraphQL variables with the query text built from alias indices alone, never a session's string, read-only through `askGithub`, and a `watch-set` is honoured only sealed from a registered machine's own device id advertising `CAPABILITIES.watches` (never `from: "app"`, never the archivist) or in process, parsed fresh and past the one `schedulerGuard`, and a `watch-event` is acted on only sealed from the scheduler or in process, parsed by `parseWatchEvent`, and neither frame names a pane, a task or a session, and a watch never changes a task's `PrStatus` or record nor a poller class (`daemon/src/watch-registry.ts` imports no scheduler and no `log.ts`), and the fleet caps (100 PRs, 100 runs), the per-device cap (64) and the reserve for tasks' reads (under 500 points of `remaining`) are the leader's, never a frame's, and no URL, head, check name or watch id is logged, and a daemon reads a forge only for reap's nothing-lost rule (`nothingLost`, `daemon/src/reap-git.ts`): its own `gh` through `askGithub` (`daemon/src/gh.ts`), read-only, argv-array, a constant query, owner, name and branch as `-f` GraphQL variables, bound to the worktree's own branch and `origin`'s GitHub repo, merged same-repository PRs only, its output never logged, deciding only whether a worktree on that machine is removed and only when local git shows the PR's head contains the tip, and a rule that cannot be evaluated (no network, `gh` failing, a non-GitHub origin) keeps the worktree and is never reported as a failure, and beside it a daemon reads only its own GitHub budget (`daemon/src/github-rate.ts`, DESIGN.md "GitHub rate limits"): two constant REST reads in `gh.ts`, `gh api --hostname github.com rate_limit` (`readRateLimit`, on a timer, free of any limit) and `gh api --hostname github.com user --jq .id` (`readGithubUserId`, cached a day), argv arrays with no variable and nothing from a frame, session or config, a timeout with the group killed, read-only, keeping only `resources.core` and `resources.graphql`'s four counts after an exact-shape check and a 1–16 digit id, never logging stdout or stderr, a failure no reading and no line, and sending nothing but `MachineStatus.gh` (display-only but for the leader's `github` push, never trimmed by `fitStatus`, a bad one dropped alone), and the leader alerts a budget once per GitHub user (`gh.u`), budget and reset window (`SettingsRecord.githubAlerts`, `daemon/src/github-alerts.ts`) with a push carrying only the budget's name and reset, never the user id, and a task record's `successor` is written only by the leader and only after the successor's create, and a successor is created only through the leader's app-role leg (`createTask` at `expect: 0`, never the daemon leg), sealed through the one task sealer, which appends `SUCCESSOR_DEP_SENTINEL` to its deps for an older leader to refuse (the parser drops it only beside `succeeds`, and `openTaskRecord` holds a stored record carrying `succeeds` without it `malformed`; its `after` differs from the attachments and requires sentinels', so each stays tied to its own field), and is held until its predecessor is `superseded` naming it and never spilled into credits, and the leader passes a task on its own (`trigger: "quota"`) only for `autonomy: "auto"`, never a `needs-input` task, and for a closed machine's tasks (`trigger: "drain"`) only a worktree task (never `here`) placed on a connected machine advertising `CAPABILITIES.successor` whose status carries `cl`, only after `drainSelfPassMs` past `drainStart`, one at a time per machine, behind a write-ahead `Task.drained` stamp (a `conflict` that follows the successor's create is `held`: never retried for that `cl`, or a second successor would follow), and the drain is, with the session's own pass, a trigger that passes a `needs-input` task (the manual and quota passes never do; the app's `pass` op cannot reach the drain), and its successor is never placed on `succeeds.account`, and a `superseded` predecessor's dependents follow its `successor` chain, never fail on it, and the drain's session ask (`daemon/src/drain-ask.ts`) sends a pane only constant keys —
  `DRAIN_PROMPT` by `send-keys -l`, then Enter, and Escape and Ctrl+C, the Ctrl+C once and never a second, no Escape in
  the draft clear, never a field of any frame — only into a live pane whose launch ledger holds a worktree launch of its
  task (`EndedTasks.askable`), once per pane and task per `cl` per process (a repeated close at the same `cl` asks and
  Escapes nothing already asked), only while this machine is draining at the `cl` the ask began under (checked before an
  Escape goes, not after), the text only after
  that pane's `idle` carrying `turnEnded` and never while its last frame is `needs-input` (the drain can deny a
  permission, never grant one), re-checking the pane, its task, `cl`, its last frame and that its input box shows
  exactly the prompt before Enter, audited `origin=drain` with the task id and outcome, never the text; a
  `session-pass` carries `drain` only while its machine is closed, and the leader writes `trigger: "drain"` for it only
  while that machine's status carries `cl`, and a pass is offered, by the PWA, `seance pass` and MCP `pass_task`, only through `passOffer` (`shared/src/successor.ts`) to a verified leader and a task machine that advertise `CAPABILITIES.successor`, and is sent once and never retried, and a session's own pass (`pass_to_successor`) is offered only to a verified leader advertising `CAPABILITIES.successorSelf` (a 2a leader would drop its `session-pass` after the push) and checks the record's length before any push, and the leader acts on a `session-pass` only when it is sealed `from` the machine the task is placed on, never logging its `record` (the successor's prompt) or the branch, and sends `pass-close` only after the successor's commit write, and a daemon sends no pass for a caller whose connection has closed (an interrupted call: checked before and after the push) and marks a pane for one close only (a pass outranks a hand-off), and a `branch-state` is never accepted from an app, nor a `session-message` (from a daemon only), and a `custodian-event` (`flag`, `unflag`, `failing`: daemon to leader, sealed, no capability and no sentinel) writes
  `Task.flag` only when the task's `assignment.deviceId` is the machine that sealed it, in any task state (a finish keeps
  the flag, a move back to `ready` drops it), through the one task sealer, a repeat a no-op and a changed note keeping `at`;
  the leader never acts on one sealed `from: "app"`, never logs, audits or pushes the note, and a `failing` event only
  pushes `custodian-failing` carrying the sealer's own device id, and an
  event — a session event or a branch state — moves only a task placed (or, for a session event,
  reserved) on the machine that sealed it, and a PR status is read only by the leader's own `gh`,
  bound to a PR URL the record holds (`taskPrs`), its values passed as GraphQL variables, and no frame
  carries one, and a task's prompt, title, model, effort and not-before time change after its create only by the
  leader's own write on an `amend` (`Scheduler.amend`), only while the task is `queued`, `blocked` or
  `ready` with no spawn out, a prompt change only at the `basis` it names (never a replace on a
  successor), the record re-sealed through the one task sealer, and no prompt text — the amendment's
  included — in any log or audit line, and its `owner.*` tags alone by the same write in any state (`ownerTags`,
  no `basis`, no forgotten decision), never from `amend_task` or the broker, and the limits record (`settings:scheduler`, DESIGN.md "Routing caps") is written only by the leader, on a `set-limits` sealed `from: "app"`, read only through `getLimits` (`openAtRest` under `scheduler-settings`, then `parseSchedulerSettingsRecord`, strict down to an unknown key in `limits`), and one the leader cannot read places nothing (a fleet limit of 0, which `run-now` alone passes) until a `set-limits` overwrites it — never read as no limit; no record is no limit, the default; `set-limits` is on no MCP tool, broker action or local op (a session must not raise a limit its owner set), and a client offers it only to a verified leader advertising `CAPABILITIES.limits`, and the settings record (`settings:main`) is written only by the leader, held to
  the version floor, never regenerated nor written over when it cannot be read or has regressed,
  and never logged nor put in `queue`, MCP or `status`, and a push send goes only to an endpoint
  `pushEndpoint` accepts at send time (https, a `PUSH_SERVICE_HOSTS` host), redirects refused and
  timed out, never awaited by the scheduler pass; its payload carries ids and state only (never a tag), and no
  endpoint, key, JWT or payload is logged, and the service worker (`pwa/public/push-sw.js`) holds
  no PSK, so a notification's text is fixed per kind (a spill's window label shown only as one of
  the known `5h`/`7d`; a blocked PR's one of four texts by its `reason`, an enum; a quota-exhausted's window shown only as `5h`/`7d` and its one of two texts by `reason`, an enum; a pass-refused's text fixed; the archivist's silence one text, nothing of its payload shown; a flag's one of four texts by its `reason`, an enum, and a
  generic one for any other value, the note never shown; a failing custodian's one text, opening only `/?screen=machines`; a GitHub budget's one of two texts by its `resource`, an enum, opening only `/?screen=machines`) and a click opens only a same-origin path it
  built from an id that passed `isTaskId` (`/?task=<id>`, `/?screen=machines`), which the app
  reads back through the same rule, and the archivist's `archive.sqlite` (`archivist/src/archive.ts`)
  holds no prompt text, no attachment manifest and no raw account id: a task row is written only
  through `taskRow`, only for a finished task read through `listTasks`/`getTask`, after
  `forgetPrompt` and with `pin.account`, `spillAlert`, `quotaExhausted`, `assignment.window`, `branch`,
  `failure.message`, `decision`, `flag.note` and every task tag but `creator.ref` and `creator.ref-url` dropped (the daemon slugs a title-less task's window and branch
  from its prompt) and `succeeds.account` replaced by the constant `ARCHIVED_SUCCEEDS_ACCOUNT`, its account only as the
  `account:` store key, and only over a row at a lower store version; an account row only from
  `openAccountRecord` or a key `accountStoreKey` made; and no statement there removes a row
  (`archivist/test/layering.test.ts`) — its one `DROP`, migration 2's pinned `DROP TABLE tasks`,
  runs only after every row was copied into the rebuilt table and the count checked — and its `metrics.sqlite` (`archivist/src/metrics-archive.ts`)
  labels an account only by the `account:` store key and removes rows only through the shared
  tiers' two horizon prunes (`daemon/src/metrics-tiers.ts`, the daemon's own rollup, imported,
  never copied). Don't let changes drift from them.
- **Two TypeScript versions on purpose.** The root is on TS 7 (the native port, different API
  surface); `raycast/` pins `typescript@^5.9` because `ray` resolves tsc from the extension and
  cannot drive TS 7. Bun's isolated linker contains the divergence — that is why the extension must
  be installed by `bun install` as a workspace member and never by npm (`workspace:*` is not a valid
  npm spec, and npm would flatten the tree the containment depends on).
- The daemon never runs as root. `install --system` / `uninstall --system` are the only commands
  that require it (they write `/etc/systemd/system`), they refuse a target user that resolves to
  root, and they never invoke `sudo` themselves — the operator supplies the privilege. Under them
  nothing may read the ambient environment for a value that ends up in the unit: as root
  `homedir()`, `stateDir()`, `logPath()`, `PATH` and `Bun.which` all answer for the wrong user, and
  the unit outlives the install. `daemon/src/target-user.ts` resolves the target instead. The same
  holds for `seance-archivist install --system` / `uninstall --system` (`archivist/src/install.ts`),
  which reuse that module and the daemon's unit helpers rather than copying them.
