# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Séance spawns remote-controlled Claude Code sessions on dev machines via a blind relay. Bun workspaces
monorepo: `daemon/` (seanced, per-machine), `relay/` (Cloudflare Worker + Durable Object), `pwa/`
(Vite + Preact app), `raycast/` (a local-only Raycast extension — spawn only), `shared/` (wire types,
envelope crypto + the app-role RelayClient), `scheduler/` (the scheduler as a pure library: routing,
task state, reservations — no I/O, hosted only by the leader's modules — `LEADER_MODULES` in `scheduler/test/layering.test.ts`), `e2e/` (full-stack test suite, no shipped code).
`claude-mods/` is not a workspace: Claude Code function-hook plugins, installed by
`seanced mod install` (DESIGN.md, "Claude Code mods").

Read the docs before changing behavior — this file deliberately doesn't repeat them:

- **README.md** — setup, deploy, and update walkthrough.
- **DESIGN.md** — the decision record: architecture, wire protocol spec, threat model, and every
  rejected alternative with rationale. If a change alters decided behavior, update DESIGN.md with it.
  For protocol work, start at its "The map: one spawn, end to end" subsection — a sequence diagram
  plus a frame→module table saying which file owns each frame; `shared/src/types.ts` is the schema
  of record, so a frame change touches both.
- **docs/psk.md** — where the PSK lives on each platform (keychain / DPAPI blob / TPM-sealed blob /
  a blob systemd unseals and delivers to the unit on systemd ≥ 256),
  how import keeps it off argv and shell history, and what the TPM path does and does not protect.
  Constraints on the psk-store/import code live here, nowhere else in prose.
- **docs/platform-notes.md** — Linux/WSL service specifics: linger, the Windows logon pin task, and
  the service-definition lag that update/install code must respect, plus the one-time catch-up for
  older installs.

- **docs/development.md** — commands, local dev (dev server, `.dev.vars`), deploy mechanics
  (wrangler is per-workspace, not hoisted), and how the tests are layered. Read it before running
  the suite, setting up local dev, or deploying; don't restate it here — a change to commands,
  deploys or test layout updates that file.
- **docs/scheduler.md** — the scheduler plan (a sealed queue in the relay, run by a relay-nominated
  daemon; filter/score routing across machines and accounts). M1 (visibility: the `status`
  frame, daemon telemetry, the Machines screen), M2 (routing, leadership, the PWA's `auto`) and
  M3 (the durable queue in the relay's store) are built and recorded in DESIGN.md; M4 records
  decisions ahead of code, and DESIGN.md takes over each part as it lands. Read it before
  scheduler work.
- **docs/leaving.md** — spec, nothing built: the daemon's sealed `leaving` note (why it is going
  away: update, restart, reboot, shutdown, sleep, unknown), how the relay keeps it, what clients
  and the leader do with it, macOS sleep/DarkWake, and the shutdown drain on a dying box. Read it
  before touching shutdown, presence or the systemd unit.

Like DESIGN.md, the docs/ files are part of the record: a change that alters behavior they describe
updates them in the same commit. They are not auto-discovered — this list is how sessions find them.

## Deploys

- Before any deploy or other Cloudflare operation, confirm auth with `bun run wrangler whoami` from
  inside `relay/` or `pwa/` (mechanics in docs/development.md). If the output doesn't name an
  authenticated account, stop and ask the user to run `wrangler login` rather than discovering it
  mid-deploy.

## Testing

Layout, commands and env vars are in docs/development.md; these are the rules that keep the suite
green:

- Run the suite with `bun run test` (`scripts/test.ts`), never bare `bun test` — the last bullet
  below is why.
- Runner is `bun:test`, not Vitest — deliberate (DESIGN.md), don't introduce Vitest idioms.
  The one exception is `claude-mods/`, whose tests only `claude plugin test` can run.
- The daemon suites' isolation env vars (`SEANCE_TMUX_SOCKET`, `SEANCE_CLAUDE_BIN`) are set by the
  tests themselves — useful to know when debugging. `spawn.test.ts` also sets
  `SEANCE_MACHINE_TAG` before its tmux server boots, to prove an untagged spawn overrides it.
- A fixed sleep before a _positive_ assertion is a latent flake: it has to outlast the slowest
  machine and reports a timeout instead of the thing that never happened. Poll instead (`pollUntil`
  in `daemon/test/fixtures.ts`). Before a _negative_ assertion ("nothing happened") a sleep is
  legitimate — a non-event can't be polled — so leave those alone.
- An e2e test ends every task it queued through `cancelTask` (`e2e/harness.ts`), never a bare
  `client.cancel(...).catch(() => null)`, and never by killing its window alone. A file's tests share
  one account under the leader's per-account cap (4), so a task left running starves later tests, and
  a killed window frees its slot only at the 120s sweep. The leader refuses a task it still holds
  `reserved` with `dispatching` — a reply, not a throw — including just after the store shows it
  `running`, since the leader takes the write's ack after the store has it. `cancelTask` asks again on
  that, and a suite that queues tasks asserts `takeLeakedTasks()` empty in `afterEach` (as
  `auto.test.ts` and `leader.test.ts` do), so the test that leaked fails, not a later one. Before any other
  leader op on a task you just saw `running` in the store, wait for the leader's own view
  (`client.queue()`), as the mark-done test does.
- Never let a test's first exec of a freshly written executable land inside a timed window. macOS
  scans every never-executed file on first exec, one at a time machine-wide, so concurrent shards
  queue behind each other's stubs; GitHub's macOS runners measurably skip the scan, which is how
  this stays green in CI while failing every local run. Link rather than copy, and exec it once in
  setup — `makeClaudeStub` shows both and carries the measurements; a bash stub is a `scriptStub`
  (`daemon/test/fixtures.ts`), a link to one committed file, never a new script. Setup means
  `beforeAll`: a stub written in `beforeEach` is a new file every test (`raycast-cli.test.ts` passes
  per-test paths in by env instead).
- A shell stub that a test stops with SIGINT traps it before writing anything the test waits on,
  and idles as `sleep 1 >/dev/null 2>&1 & wait $!` in a loop, never a foreground `sleep`. macOS
  `/bin/sh` is bash 3.2: a SIGINT landing while it waits on a foreground child is ignored outright
  when untrapped, and lost now and then when trapped (after the child is reaped, before the handler
  is restored), so the stub runs on to its SIGKILL. The redirect keeps the outliving `sleep` off
  pipes the caller drains to EOF. `raycast-cli.test.ts`'s `ray` stubs are the example.
- A private tmux server still loads the developer's own `~/.tmux.conf` — product code boots it, and
  only `-f` skips the file — so local runs get its default-shell, hooks and `automatic-rename-format`
  while CI gets none. Don't assert on what a config can set: name a test window at creation (`-n`,
  as `spawn.ts` does) rather than reading its automatic name, which on macOS is whatever tmux caught
  mid-exec (`kernel_task`, `tmux`, `""`).
- A test server binds the address it is dialed at — `hostname: "127.0.0.1"` on every `Bun.serve`.
  Bun's default is the dual-stack `[::]`, and macOS lets another process's `SO_REUSEADDR` bind of
  `127.0.0.1` on the same port (a VS Code helper, a dev server) sit on top of it and take every
  `127.0.0.1` dial; the client then retries into the wrong server until its wait times out.
  `daemon/test/harness.test.ts` holds the relay double to it.
- `daemon/test/harness.ts` is a throwaway relay double with behaviors _inverted_ from the real DO
  (its header comment says which). Never treat it as a reference for relay behavior — DESIGN.md's
  wire protocol section is the spec.
- Each pairwise suite keeps its double on purpose — the daemon's fake relay is controllable in ways
  the real DO forbids — and the e2e suite is what catches fake-vs-real drift. Don't "upgrade" a
  double to the real component.
- The full suite is green on macOS and Linux. Two hard-won portability rules: tmux `-F` format
  strings must use printable separators (tmux 3.4 mangles tabs to `_`; see `sessions.ts`/`tmux.ts`),
  and sockets Bun dials into workerd need `perMessageDeflate: false` (frames die with close code
  1002 otherwise).
- Parallelism lives between shard processes (`scripts/test.ts`), never `bun test --parallel` at the
  top level: `--parallel` implies `--isolate`, which re-evaluates modules per file and resets the
  once-per-process memos below — and under `--isolate` neither `globalThis` nor `process.env` carries
  across files, so no in-process cache can survive it. `--parallel` inside the two daemon shards is fine — two because a GitHub-runner run stopped dead past ~64 KiB of output, probably the non-blocking-stdout drop `flush` now works around rather than `--parallel` (`SHARDS` says more).
- Reuse `relay/test/harness.ts`'s `startRelay`; never boot your own Miniflare. Its worker bundle is
  memoized because `Bun.build` runs once per process, and every caller must `dispose()` — `bun test`
  fires no exit hooks, so an undisposed instance leaves its workerd running past the test process.
  (An older note here said the opposite, that disposing mid-process hangs the next boot. That scar
  is real but sharding routes around it: the relay, pwa and e2e boots now sit in three separate
  processes, never one. Put them back together — a bare `bun test` over the whole tree — and the
  rate-limit suite still fails, because booting workerd within ~100ms of a previous instance being
  disposed makes Bun's `child_process` fail to wire up the new one's stdio (`Failed to connect`,
  ENOENT). Run the suite through `scripts/test.ts`.)

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
  run-now, account list), for a keyless `seanced mcp`, `seanced spawn` or `seanced start`, `schedule` for
  the daemon's reap timer, `probe` for the daemon's trait probes, `harvest` for the daemon closing a dead task pane after noting its exit
  status, `handoff` for the daemon closing a session that handed its PR off (`hand_off_task`),
  `successor` for the daemon pushing a task's branch on its own session's `pass_to_successor` and closing
  that session once the leader confirmed it,
  `leader` for the scheduler loop dispatching to its own machine in
  process and admitting a task, `mcp` for `seanced mcp`'s own `spawn_session`/`queue_batch`/`continue_task` enqueue lines, and `cli` for
  anything typed at this machine's shell, its `spawn` enqueue line included — a new
  surface adds an origin, never reuses one),
  prompt text is never logged, a service-delivered credential never leaves the daemon process
  (`exec.ts` strips `CREDENTIALS_DIRECTORY`, or the tmux server it boots hands the PSK's path to
  every session), and a registry entry whose `info` blob is not sealed `from` its own `deviceId`
  never becomes a `Machine` (verified app-side in `shared/src/app-client.ts` — the relay is blind,
  so only the AAD-bound `from` says which machine an entry describes), and the daemon process never holds a Claude credential: auth health (`daemon/src/auth-health.ts`) reads each exclave's credential store only through a short-lived `bun -e` child running the one constant script, with the file handed over as a file descriptor (or, on macOS, `security -w` run by the child), a bare env and a timeout, and keeps only the child's `{lapsed, refreshExpiresAt}` after an exact-shape check — never the child's stdout or stderr in a log, and nothing on the wire but `ax`/`ae`/`au` indices, an expiry time and `CAPABILITIES.authHealth`, every blob opened outside
  the replay guard (`machine-info`, `status`, `lead-proof`, and the store's `task` and
  `pause-state` records) goes through `openAtRest` in
  `shared/src/crypto.ts`, which refuses one whose `op` isn't the slot's — shape alone does not say
  which blob it is — and an app believes a scheduler nominee only with a `lead-proof` sealed `from`
  the nominee for the pushed term, never because its registry entry opens (its `info` blob is
  readable off any push and re-registrable under a stolen seed),
  and a `register` moves a route only when it is signed by the key its `deviceId` hashes (verified in `relay/src/hub.ts`
  through `shared/src/identity.ts`; the seed never leaves `state.json`), and any register field the
  relay acts on — today `roles`, which decides nomination — is covered by that signature (the v2
  message), never trusted as plaintext, and the relay nominates only ids on its
  `SCHEDULER_LEADERS` secret — unset nominates nobody, and no wildcard exists, in product code or
  as a test escape hatch, and the leader honours a scheduler request only when it was sealed
  `from: "app"`, parsed into a fresh value by that op's own parser (`parseQueueRequest`,
  `parseTaskRequest`, `parseTaskRef`, `parseAmendRequest`, …), and checked against the one replay guard per daemon
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
  clone its `repo` name resolved to, and only while no later launch in that ledger noted the same worktree, and a task record carrying `continues` always carries
  `mode: "continue"`, which an older leader's parser refuses, and the leader's version floor (`daemon/src/version-floor.ts`) is one per
  process like `schedulerGuard`, persisted 0600, and only ever raised by a read (the leader's own
  pause write alone may set it lower): a task record below it is `version_regressed`, a pause
  below it or missing holds the whole queue, and a task record that vanishes without the
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
  lapses must be too old to admit, and every task record carrying `pin.account` or `avoid` is sealed through the one task sealer (`taskRecordAtRest`/`sealTaskRecord`), which emits `pin.exclave: ""` for an older leader to refuse, and the parser never nulls a spec over `pin.exclave`, and every task record carrying `attachments` is sealed through that same sealer, which appends `ATTACHMENTS_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside a manifest and nulls the spec over any malformed manifest — never drops the field, and the leader dispatches such a task only to a machine advertising `CAPABILITIES.attachments` (`attachments_unsupported` otherwise), copying the manifest unchanged into the spawn, and drops it only on the write that finishes the task (`forgetPrompt`), and every task record carrying `requires` is sealed through that same sealer, which appends `REQUIRES_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside `requires` and nulls the spec over the sentinel without it, and a client writes `requires` only to a verified leader advertising `CAPABILITIES.traits`, and a machine's traits are declared only in its own `config.json` — never from a frame, the PWA or another machine, and a trait's probe runs only the argv that file names — an argv array, never a shell string, under the environment a session gets less `CREDENTIALS_DIRECTORY`, stdio ignored and never read or logged, one probe at a time per process, killed by process group at its timeout and swept by group when it exits on its own, audited under origin `probe` with an argv word count, hash and `argv[0]`'s basename (the one argv text written, so never a secret in that word), never another argv word or any output (`daemon/src/trait-probes.ts`) — and an attachment object opens only through `openAttachment` (`shared/src/crypto.ts`), its AAD bound to the op and its own id, and the relay's `/attachments/<id>` routes (`relay/src/attachments.ts`) read no body (`relay/test/layering.test.ts`), take the token from the `Authorization` header only, store create-only under an id held to `ATTACHMENT_ID_PATTERN`, refuse on the declared length and the Hub's upload allowance (`relay/src/allowance.ts`) before R2 sees a byte, and log no accepted transfer, and a daemon accepts `attachments` only on a spawn sealed `from` the scheduler with `client: "scheduler"` (or the leader's in-process dispatch), fetches each object only from `attachmentUrl` over its own config's `relayUrl` with the manifest's id, before the launch ledger's write-ahead record, checks its length and `attachmentHash` before `openAttachment`, writes it only as `<index>.<ext>` (`ATTACHMENT_EXTENSIONS`, never the name) under the 0700 `stateDir()/attachments/<taskId>`, refuses `attachment_unavailable` on any failure with nothing left behind, puts names only in the seed on stdin, and audits a count and total bytes, never names, ids or hashes (`daemon/src/attachments.ts`), and the PWA writes a task carrying `attachments` only to a verified leader advertising `CAPABILITIES.attachments`, only once every file in it answered `201 stored`, uploads only through `RelayClient.uploadAttachment` with the token in the `Authorization` header, and shows names only on the form, never on the Queue screen or verdict (`pwa/src/store.ts`), and the daemon's one write to a forge is `pushTaskBranch` (`daemon/src/push-branch.ts`): a `git push` through `networkGit`, never forced, of `<tip sha>:refs/heads/<r>` to `origin` only, `<tip>` that of `<b>`, the branch its own launch ledger's worktree has checked out and `<r>` that branch's configured upstream on `origin` (one on another remote counts as none); with no upstream and a scheduler-sealed `push-branch`'s `expect` (the PR head the leader read), that `expect` only when origin's tip of it is an ancestor of the local tip and of no default branch's tip, the default fetched with it (else nothing is pushed, `branch_mismatch`; the default branch itself is `default_branch`); with neither, `<b>`; a push refused as a non-fast-forward is `push_rejected` unless the pushed sha is already part of origin's refetched `<r>`, which is `ok` with nothing pushed, never forced, merged or rebased — never a path, never a branch a session names, only on a clean tree and never to the default branch, refusing repo-local `remote.*.pushurl` and `url.*.pushinsteadof` (`pushConfigRefusal`), only on a `push-branch` sealed `from` the scheduler (or the leader in process), audited with no branch name and with git's stderr never in a reply, a log or an audit line, and the leader reads a PR's head only with its own `gh` (`readPrHead`), bound to the task's `prUrl`, its values passed as GraphQL variables, and never logs it, and a task record's `successor` is written only by the leader and only after the successor's create, and a successor is created only through the leader's app-role leg (`createTask` at `expect: 0`, never the daemon leg), sealed through the one task sealer, which appends `SUCCESSOR_DEP_SENTINEL` to its deps for an older leader to refuse (the parser drops it only beside `succeeds`, and `openTaskRecord` holds a stored record carrying `succeeds` without it `malformed`; its `after` differs from the attachments and requires sentinels', so each stays tied to its own field), and is held until its predecessor is `superseded` naming it and never spilled into credits, and the leader passes a task on its own (`trigger: "quota"`) only for `autonomy: "auto"`, never a `needs-input` task, and its successor is never placed on `succeeds.account`, and a `superseded` predecessor's dependents follow its `successor` chain, never fail on it, and a pass is offered, by the PWA, `seanced pass` and MCP `pass_task`, only through `passOffer` (`shared/src/successor.ts`) to a verified leader and a task machine that advertise `CAPABILITIES.successor`, and is sent once and never retried, and a session's own pass (`pass_to_successor`) is offered only to a verified leader advertising `CAPABILITIES.successorSelf` (a 2a leader would drop its `session-pass` after the push) and checks the record's length before any push, and the leader acts on a `session-pass` only when it is sealed `from` the machine the task is placed on, never logging its `record` (the successor's prompt) or the branch, and sends `pass-close` only after the successor's commit write, and a daemon sends no pass for a caller whose connection has closed (an interrupted call: checked before and after the push) and marks a pane for one close only (a pass outranks a hand-off), and a `branch-state` is never accepted from an app, and an
  event — a session event or a branch state — moves only a task placed (or, for a session event,
  reserved) on the machine that sealed it, and a PR status is read only by the leader's own `gh`,
  bound to a PR URL the record holds (`taskPrs`), its values passed as GraphQL variables, and no frame
  carries one, and a task's prompt, title, model and effort change after its create only by the
  leader's own write on an `amend` (`Scheduler.amend`), only while the task is `queued`, `blocked` or
  `ready` with no spawn out, a prompt change only at the `basis` it names (never a replace on a
  successor), the record re-sealed through the one task sealer, and no prompt text — the amendment's
  included — in any log or audit line, and the settings record (`settings:main`) is written only by the leader, held to
  the version floor, never regenerated nor written over when it cannot be read or has regressed,
  and never logged nor put in `queue`, MCP or `status`, and a push send goes only to an endpoint
  `pushEndpoint` accepts at send time (https, a `PUSH_SERVICE_HOSTS` host), redirects refused and
  timed out, never awaited by the scheduler pass; its payload carries ids and state only, and no
  endpoint, key, JWT or payload is logged, and the service worker (`pwa/public/push-sw.js`) holds
  no PSK, so a notification's text is fixed per kind (a spill's window label shown only as one of
  the known `5h`/`7d`; a blocked PR's one of four texts by its `reason`, an enum; a quota-exhausted's window shown only as `5h`/`7d` and its one of two texts by `reason`, an enum; a pass-refused's text fixed) and a click opens only a same-origin path it
  built from an id that passed `isTaskId` (`/?task=<id>`, `/?screen=machines`), which the app
  reads back through the same rule. Don't let changes drift from them.
- The daemon's local op socket (`daemon/src/local-socket.ts`) is what makes MCP's `get_sessions` and
  `despawn_session` aimed at this machine skip the relay (`spawn` stays on its allowlist only for a
  `seanced mcp` started before spawns became tasks). Its access control is the **0700 `stateDir()/run` directory**, not
  the socket's own mode — `Bun.listen({ unix })` creates it 0755 and the `chmod` races. Its op
  allowlist is `sessions`, `spawn` and `despawn` only; widening it is a threat-model change, not a
  tweak (DESIGN.md's "Local op socket" records why `despawn` got in). On a daemon whose key is
  service-delivered (`source: "credential"`) — and only there — the same socket carries the
  fleet broker (`broker.ts`): its own frame kind, never a `Plain` or an `OpName`, four actions —
  `machines`, `fleet`, `request` (the same three remote ops) and `scheduler` (`enqueue`, `queue`,
  `cancel`, `run-now`, `pass`, `amend`, `accounts`) — DESIGN.md's "Fleet broker" is the record, and any widening of it,
  including running it on other daemons, is the same kind of change. A brokered enqueue is a create
  at `expect: 0` of a task the daemon sealed itself from a parsed spec, with the daemon's own
  `createdAt`, no lineage or base (a continue spec's `continues` is carried, and only while the
  leader advertises `continueTask`; its `requires` is carried only while the leader advertises
  `traits` and the broker's own daemon does — an older one would drop it and queue the task unrestricted), and a client of `mcp` or `cli` only, audited as `claimed_client`
  (the peer's unverified word); a `landedEarlier` on it is the relay's answer for a peer-chosen id:
  it may stand for a tombstone or another client's task, never an overwrite. The socket's third frame
  kind, `session-event` (`session-events.ts`, DESIGN.md "Session events"), is ingest-only and
  bound to the sender's pane by its kernel-reported peer pid, never by a field it sends — the
  frame's `pane` decides only on a host that names no peer at all (`peerPidSupported`), never for
  one connection whose pid came back null. Its five acts past ingest are poking the bound
  exclave's `/usage` refresh (`usage-refresh.ts`), which spawns only on a stale reading, with
  fixed argv and an env built from the scan — no frame field reaches either — and a `done`
  report, which only `report_task_done` sends (`seanced session-event` drops a `done` unsent):
  the daemon notes it in the launch ledger and forwards it once, both for the pane's own task
  only, and answers `untasked` for a pane with none and `unrecorded` for a task its ledger holds
  no launch of (nothing sent); the leader settles that task only under `until: "reported"` and
  only from the machine it was placed or reserved on — and clearing its own pane's task's
  `interrupted` mark in the launch ledger, only on an `ended` or `done` frame (proof the session ran;
  never when ingest is stopped), bound to the pane like the `done` report (including on a
  host with no peer pid) and never to an id from the frame — and a hand-off, which only
  `hand_off_task` sends (`seanced session-event` drops one unsent), carries no state, and is taken
  only for the pane's own task when its launch ledger holds a launch and a PR URL of it — one its
  session reported, or, for a continuation, the one that ledger noted on it at launch from the launch
  it continues (`continuedPr`, from any launch but one the scheduler cancelled: a despawn sealed from the scheduler naming
  `client: "scheduler"`, noted `cancelled`), never
  from a frame — (`untasked`,
  `unrecorded`, `prless` otherwise): the daemon marks the pane in memory and, at that pane's next
  `idle` carrying `turnEnded` (its turn's end, never a respawn's idle), closes it through the graceful despawn after re-reading that it still carries that task,
  audited `origin=handoff` (`handoff.ts`), never a pane or task a frame names, and a pass, which only
  `pass_to_successor` sends (`seanced session-event` drops one unsent), carries no state and a `record`
  bounded by `SUCCESSOR_RECORD_MAX` (prompt text, never logged, never used to bind, route or close
  anything), and is taken only for the pane's own task when its launch ledger holds a worktree launch of it
  (`untasked`, `unrecorded`, `here` otherwise): the daemon pushes that worktree's branch through
  `pushTaskBranch` with no `expect` (`hasPr` from its ledger), audited `origin=successor`, marks the
  pane in memory, sends one `session-pass`, and closes the session through the same graceful despawn,
  audited `origin=successor`, only when both that pane's next `idle` carrying `turnEnded` (a later `busy`
  or `needs-input` clears it) and a `pass-close` sealed `from` the scheduler (or the leader in process)
  naming that pane's task have arrived, after re-reading that it still carries the task; an `ended`, a
  pane reused for another task or a restart drops the mark, and `pass-close` arms only a live pane
  carrying the task (`no_pane` otherwise), never a pane or task a frame names.
  The frame's other carried claims are `remoteSession`, Remote Control's id for the session:
  display-only (the PWA's claude.ai link), kept only as `isRemoteSessionId` passes it, and
  never used to bind, route or move anything — and `reason`, kept only as a known
  `NEEDS_INPUT_REASONS` value (`question` or `permission`) beside `needs-input` (dropped otherwise,
  never the event), whose one effect on behaviour is `question` making the leader alert that
  needs-input stay at once instead of after its debounce (`questionAlert`), only for the task's
  own machine and once per stay; it never binds, routes, moves or settles anything — and `tool`,
  only beside `permission` and only as `isToolName` passes it, display-only like `remoteSession`
  (written onto `Task.inputTool`, never used to bind, route, move, settle or alert, and kept out of
  `get_queue`).
  Giving it any other act, or taking a session or task id from the frame to bind by, is the same
  kind of change too.
  Nothing reachable from `seanced mcp` may call `log.ts` — that writes to stdout, which is the MCP
  server's JSON-RPC channel (this is why `readState` exists alongside `loadOrInitState`).
- **`raycast/` layering: nothing under `raycast/src/lib/` may import `@raycast/api`.** It throws
  outside the Raycast host, so such a module could not run under `bun test` and would take every
  test in the directory down at import time. Views are `.tsx` at `src/`, logic is `.ts` at
  `src/lib/`; platform APIs (`LocalStorage`, preferences) reach the logic as injected seams. The rule
  is enforced by `raycast/src/lib/layering.test.ts`, not just remembered.
- The Raycast extension is a third app-role relay client, exactly as `seanced mcp` is — no relay or
  daemon change. Its credentials come only from the local daemon's config plus the macOS keychain;
  Raycast preferences hold defaults, never secrets. `raycast/src/lib/credentials.ts` reimplements
  what `daemon/src/config.ts` and `keychain.ts` do in Bun, so its test imports _both_ and asserts
  they agree on names and precedence. Diverge in mechanism there, never in names.
- **Two TypeScript versions on purpose.** The root is on TS 7 (the native port, different API
  surface); `raycast/` pins `typescript@^5.9` because `ray` resolves tsc from the extension and
  cannot drive TS 7. Bun's isolated linker contains the divergence — that is why the extension must
  be installed by `bun install` as a workspace member and never by npm (`workspace:*` is not a valid
  npm spec, and npm would flatten the tree the containment depends on).
- Raycast runs extensions on Node 22 but in a sandbox that withholds `crypto` and `WebSocket`
  (probed from inside: `fetch`/`btoa`/`TextEncoder` present, those two undefined — a bare `node` of
  the same version has all four, so the version alone answers nothing). `shared/` uses both as
  globals, so `raycast/src/lib/runtime.ts` installs them and the extension carries a `ws` dependency
  for it. Don't add injectable crypto/socket seams to `shared/` for this.
- The daemon never runs as root. `install --system` / `uninstall --system` are the only commands
  that require it (they write `/etc/systemd/system`), they refuse a target user that resolves to
  root, and they never invoke `sudo` themselves — the operator supplies the privilege. Under them
  nothing may read the ambient environment for a value that ends up in the unit: as root
  `homedir()`, `stateDir()`, `logPath()`, `PATH` and `Bun.which` all answer for the wrong user, and
  the unit outlives the install. `daemon/src/target-user.ts` resolves the target instead.
