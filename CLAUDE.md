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

Read the docs before changing behavior — this file deliberately doesn't repeat them:

- **README.md** — setup, deploy, and update walkthrough.
- **DESIGN.md** — the decision record: architecture, wire protocol spec, threat model, and every
  rejected alternative with rationale. If a change alters decided behavior, update DESIGN.md with it.
  For protocol work, start at its "The map: one spawn, end to end" subsection — a sequence diagram
  plus a frame→module table saying which file owns each frame; `shared/src/types.ts` is the schema
  of record, so a frame change touches both. Its "Archivist" section is the archivist's whole
  record — the decisions code cites as A1–A37 and their rejected alternatives at its end; read it
  before touching history, retention, registry roles or the Machines screen's charts (setup,
  move-the-seat runbook and schema are the README's step 9).
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
- **docs/drain.md** — spec for closing a machine to new scheduled work and draining it. Item 1
  (close, reopen, `MachineStatus.cl`, the `closed` filter and `machine_closed` gate, the PWA switch,
  `seance close`/`open`, MCP `set_machine_open`) is built and recorded in DESIGN.md, "Closing a
  machine"; the leader's outside pass (item 2: `trigger: "drain"`, `Task.drained`, `drainView`, `seance close --wait`) is built too, in DESIGN.md, "The drain's outside pass", and so is the session ask (item 3: `CAPABILITIES.drainAsk`, `now`, the
  `drain` mark on `session-pass`), in DESIGN.md, "The drain's session ask". §6's close warning (a closed leader keeps leading) is in
  "Closing a machine" and §12's time-to-empty line in "The drain's outside pass", and so is the soft close by default
  (N5: `soft`, `closed.drainAt`, `MachineStatus.dr`, `drainStart`, `CAPABILITIES.softClose`, and the clients' surfaces —
  the PWA's soft Close, Drain and Drain now, `seance close --drain`, MCP `drain` — in the three DESIGN.md sections
  above); what is left in the file is §6's "Later" (re-register without the lead role once empty) and §12's list of
  measures. Read it before scheduler routing or shutdown work.
- **docs/leaving.md** — spec, nothing built: the daemon's sealed `leaving` note (why it is going
  away: update, restart, reboot, shutdown, sleep, unknown), how the relay keeps it, what clients
  and the leader do with it, macOS sleep/DarkWake, and the shutdown drain on a dying box. Read it
  before touching shutdown, presence or the systemd unit.
- **docs/messaging.md** — spec, PR 1, PR 2, the reply by handle and the adapter seam's 3a (the child and state out) built: local delivery (the `inbox` mod, the `inbox`
  and `message` frames, `send_message`), cross-machine routing through the leader (`session-message`,
  `deliver-message`, `message-receipt`, `CAPABILITIES.messageRoute`) and replies to a session with no task, by the id of
  the message answered, on one machine or across (`replyTo`, `CAPABILITIES.messageReply`, `wake`; D3 amended), recorded
  in DESIGN.md (Local op socket, "Session messages" and its "Cross-machine" and "Replies by handle" subsections;
  "Adapters" for 3a: `config.json` `adapters`, the supervisor, the handshake, `snapshot`, `session`, `session-gone`,
  `task`, `shared/src/adapter-protocol.ts` and its committed JSON Schema, audit origin `adapter`; Claude Code mods; MCP
  server; Threat model item 6). What is left in the file is the adapter seam's 3b (delivery in, messages out, the
  subscription) and 3c (installing), the open questions and the spike evidence. Read it before adding a leader event op or an adapter.
- **docs/presence.md** — spec, nothing built: a session's self-declared `self.doing` tag (`set_self_tag`, the first key of docs/tags.md's model), `status` questions its daemon answers from presence without waking it, and the inbox mod merging a burst of wakes into one turn. Read it before touching `doing`, presence, receipts or the inbox mod's delivery.
- **docs/custodian.md** — what is left of the custodian spec: what 4b's drills left unsettled (the round's
  containment — its own socket, the masks, the built environment, no network — is built, rounds are live, and it was
  drilled on macOS and on Linux in both bwrap modes under its vsock filter: strict on WSL2, weaker nested on LXC), the open build-time details, and an
  index of where each decision (C1–C49) is recorded in DESIGN.md. Everything else is built and recorded there: the
  seat, the round and its containment ("The custodian's seat"), the round's verbs `sessions`, `close`, `capture`, `pr`,
  `flag`, `nudge`, `interrupt`, `notes` and `done`, the flags and counts file and the round log ("The custodian frame
  kind"), and `MachineStatus.cu`, the Machines row, the owner's shell verbs, the `custodian` app op and the card's menu
  ("The custodian's status and the Machines row"). The custodian is one
  seat per machine whose daemon starts a fresh, fenced Claude session per round to close finished sessions
  (removing a worktree when nothing would be lost), nudge and interrupt stuck ones and flag the rest, through
  `seance custodian` verbs the daemon checks, served only on the round's own socket. Read it, and those DESIGN.md
  sections, before touching despawn, reap's merged check, a pane's tracked state, or anything that reads a live
  session's screen.
- **docs/agents.md** — analysis, nothing decided: what spawning agents other than Claude Code
  (Codex first) would touch — the agent as a task field, launch, accounts, quota, session events,
  MCP, clients — the two risks (Codex's remote control, binding by peer pid) and a spike-first
  order. Read it before adding a second agent or making the launch path agent-neutral.
- **docs/orchestrator.md** — draft, nothing decided or built: queueing a whole tracker project as
  a living task graph, tended by long-lived orchestrator sessions that are not tasks, with the
  tracker (Linear first) kept out of Séance's code. It recommends withdrawing the leader's Linear
  item and lists the open questions. Read it before building amend deps, anything that reads a
  tracker, or a new kind of session that is not a task; build nothing from it until it is decided.
- **docs/tags.md** — spec: tags at task and session scope (namespace = writer), session identity
  (pane, process, conversation; a verified `agent.session`) and the adapter subscription that amends messaging's D3.
  Step 1 is built (the vocabulary in `shared/src/tags.ts`, the frame's `agent`, the conversation table and its
  verification, `SessionEntry.tags`), recorded in DESIGN.md, "Session events", "Session identity"; owner labels, task
  tags and the subscription are not. Read it before adding a field that labels a session or a task, or touching session identity or adapter addressing.

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
- Waiting on one signal proves nothing about another that nothing orders after it. A _positive_
  assertion read straight after a wait on an independent chain (one stub's `requests()` after
  another stub's answer was acted on; two sends of one `send`) is a latent flake too: the chains
  finish within a fraction of a millisecond in either order, and the read rides on `pollUntil`'s
  10 ms pace. Wait on the asserted thing's own signal (`waitForRequests`), as
  `push-sender.test.ts`'s prune test does. A read is safe only when the awaited signal can come
  solely after it (the same stub's answer, which follows its recording).
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
- Every tmux call that opens a pty (`new-window`, `new-session`, `split-window`, `respawn-pane`,
  `respawn-window`) goes through `tmuxOk` (`daemon/src/tmux.ts`), in tests as in product code, or retries until
  it lands as `machine-tag.test.ts`'s restart does. macOS's pty allocator fails such an open now and then, at
  any call site (`respawn-pane`, then `new-window`, hit it on GitHub's macOS runners): `fork failed: Device not
  configured` (ENXIO) when the machine reaches a new high of ptys in use since boot while another process frees
  one, and `Unknown error: -6` when two opens collide. `tmuxOk` retries exactly those (`PTY_RACE` names the
  kernel code). Only a freshly booted Mac shows the ENXIO race, since the kernel's pty table never shrinks:
  reproduce it on a GitHub macOS runner beside a process churning ptys, not locally.
- A test that needs its own process inside a session's pane (to be bound by peer pid, as a tool would be)
  runs it through `ClaudeStub.runInPane` (`daemon/test/fixtures.ts`), not `respawn-pane -k`: it opens no pty
  and kills nothing, where a respawn that hits the pty race above has already killed the pane's process.
  `runInPane` starts it as the stub's child on the pane's own tty and untitles the pane, as the respawn did.
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
  is real but sharding routes around it: the relay, pwa, e2e and archivist boots now sit in four separate
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
  run-now, account list), for a keyless `seance mcp`, `seance spawn` or `seance start`, `schedule` for
  the daemon's reap timer, `probe` for the daemon's trait probes, `harvest` for the daemon closing a dead task pane after noting its exit
  status, `handoff` for the daemon closing a session that handed its PR off (`hand_off_task`),
  `drain` for the daemon typing its constant drain prompt, or the Escape before it, into a pane of a closed machine,
  `custodian` for the daemon's seat starting, closing, refusing to start or ending a custodian round and for a round's `close` and the worktree it decides, its `flag`, `nudge` and `interrupt`,
  `message` for a session's message to another task, on this machine or routed through the leader (one `dir=out` and one `dir=in` line per message, and a `dir=receipt` line for the leader's receipt: task ids, kind, byte count and outcome, never text; a custodian nudge writes only its `dir=in` line, `from=custodian`),
  `adapter` for the daemon starting, restarting, refusing, holding as `failed` and stopping a configured adapter (its
  name, `argv`'s word count and `argv[0]`'s basename, an exit code and a reason, never another argv word or anything the
  adapter wrote),
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
  lapses must be too old to admit, and every task record carrying `pin.account` or `avoid` is sealed through the one task sealer (`taskRecordAtRest`/`sealTaskRecord`), which emits `pin.exclave: ""` for an older leader to refuse, and the parser never nulls a spec over `pin.exclave`, and every task record carrying `attachments` is sealed through that same sealer, which appends `ATTACHMENTS_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside a manifest and nulls the spec over any malformed manifest — never drops the field, and the leader dispatches such a task only to a machine advertising `CAPABILITIES.attachments` (`attachments_unsupported` otherwise), copying the manifest unchanged into the spawn, and drops it only on the write that finishes the task (`forgetPrompt`), and every task record carrying `requires` is sealed through that same sealer, which appends `REQUIRES_DEP_SENTINEL` to its deps for an older leader to refuse, and the parser drops that sentinel only beside `requires` and nulls the spec over the sentinel without it, and a client writes `requires` only to a verified leader advertising `CAPABILITIES.traits`, and a machine's traits are declared only in its own `config.json` — never from a frame, the PWA or another machine, and a trait's probe runs only the argv that file names — an argv array, never a shell string, under the environment a session gets less `CREDENTIALS_DIRECTORY`, stdio ignored and never read or logged, one probe at a time per process, killed by process group at its timeout and swept by group when it exits on its own, audited under origin `probe` with an argv word count, hash and `argv[0]`'s basename (the one argv text written, so never a secret in that word), never another argv word or any output (`daemon/src/trait-probes.ts`) — and an attachment object opens only through `openAttachment` (`shared/src/crypto.ts`), its AAD bound to the op and its own id, and the relay's `/attachments/<id>` routes (`relay/src/attachments.ts`) read no body (`relay/test/layering.test.ts`), take the token from the `Authorization` header only, store create-only under an id held to `ATTACHMENT_ID_PATTERN`, refuse on the declared length and the Hub's upload allowance (`relay/src/allowance.ts`) before R2 sees a byte, and log no accepted transfer, and a daemon accepts `attachments` only on a spawn sealed `from` the scheduler with `client: "scheduler"` (or the leader's in-process dispatch), fetches each object only from `attachmentUrl` over its own config's `relayUrl` with the manifest's id, before the launch ledger's write-ahead record, checks its length and `attachmentHash` before `openAttachment`, writes it only as `<index>.<ext>` (`ATTACHMENT_EXTENSIONS`, never the name) under the 0700 `stateDir()/attachments/<taskId>`, refuses `attachment_unavailable` on any failure with nothing left behind, puts names only in the seed on stdin, and audits a count and total bytes, never names, ids or hashes (`daemon/src/attachments.ts`), and the PWA writes a task carrying `attachments` only to a verified leader advertising `CAPABILITIES.attachments`, only once every file in it answered `201 stored`, uploads only through `RelayClient.uploadAttachment` with the token in the `Authorization` header, and shows names only on the form, never on the Queue screen or verdict (`pwa/src/store.ts`), and the daemon's one write to a forge is `pushTaskBranch` (`daemon/src/push-branch.ts`): a `git push` through `networkGit`, never forced, of `<tip sha>:refs/heads/<r>` to `origin` only, `<tip>` that of `<b>`, the branch its own launch ledger's worktree has checked out and `<r>` that branch's configured upstream on `origin` (one on another remote counts as none); with no upstream and a scheduler-sealed `push-branch`'s `expect` (the PR head the leader read), that `expect` only when origin's tip of it is an ancestor of the local tip and of no default branch's tip, the default fetched with it (else nothing is pushed, `branch_mismatch`; the default branch itself is `default_branch`); with neither, `<b>`; a push refused as a non-fast-forward is `push_rejected` unless the pushed sha is already part of origin's refetched `<r>`, which is `ok` with nothing pushed, never forced, merged or rebased — never a path, never a branch a session names, only on a clean tree and never to the default branch, refusing repo-local `remote.*.pushurl` and `url.*.pushinsteadof` (`pushConfigRefusal`), only on a `push-branch` sealed `from` the scheduler (or the leader in process), audited with no branch name and with git's stderr never in a reply, a log or an audit line, and the leader reads a PR's head only with its own `gh` (`readPrHead`), bound to the task's `prUrl`, its values passed as GraphQL variables, and never logs it, and a daemon reads a forge only for reap's nothing-lost rule (`nothingLost`, `daemon/src/reap-git.ts`): its own `gh` through `askGithub` (`daemon/src/gh.ts`), read-only, argv-array, a constant query, owner, name and branch as `-f` GraphQL variables, bound to the worktree's own branch and `origin`'s GitHub repo, merged same-repository PRs only, its output never logged, deciding only whether a worktree on that machine is removed and only when local git shows the PR's head contains the tip, and a rule that cannot be evaluated (no network, `gh` failing, a non-GitHub origin) keeps the worktree and is never reported as a failure, and a task record's `successor` is written only by the leader and only after the successor's create, and a successor is created only through the leader's app-role leg (`createTask` at `expect: 0`, never the daemon leg), sealed through the one task sealer, which appends `SUCCESSOR_DEP_SENTINEL` to its deps for an older leader to refuse (the parser drops it only beside `succeeds`, and `openTaskRecord` holds a stored record carrying `succeeds` without it `malformed`; its `after` differs from the attachments and requires sentinels', so each stays tied to its own field), and is held until its predecessor is `superseded` naming it and never spilled into credits, and the leader passes a task on its own (`trigger: "quota"`) only for `autonomy: "auto"`, never a `needs-input` task, and for a closed machine's tasks (`trigger: "drain"`) only a worktree task (never `here`) placed on a connected machine advertising `CAPABILITIES.successor` whose status carries `cl`, only after `drainSelfPassMs` past `drainStart`, one at a time per machine, behind a write-ahead `Task.drained` stamp (a `conflict` that follows the successor's create is `held`: never retried for that `cl`, or a second successor would follow), and the drain is, with the session's own pass, a trigger that passes a `needs-input` task (the manual and quota passes never do; the app's `pass` op cannot reach the drain), and its successor is never placed on `succeeds.account`, and a `superseded` predecessor's dependents follow its `successor` chain, never fail on it, and the drain's session ask (`daemon/src/drain-ask.ts`) sends a pane only constant keys —
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
  included — in any log or audit line, and the limits record (`settings:scheduler`, DESIGN.md "Routing caps") is written only by the leader, on a `set-limits` sealed `from: "app"`, read only through `getLimits` (`openAtRest` under `scheduler-settings`, then `parseSchedulerSettingsRecord`, strict down to an unknown key in `limits`), and one the leader cannot read places nothing (a fleet limit of 0, which `run-now` alone passes) until a `set-limits` overwrites it — never read as no limit; no record is no limit, the default; `set-limits` is on no MCP tool, broker action or local op (a session must not raise a limit its owner set), and a client offers it only to a verified leader advertising `CAPABILITIES.limits`, and the settings record (`settings:main`) is written only by the leader, held to
  the version floor, never regenerated nor written over when it cannot be read or has regressed,
  and never logged nor put in `queue`, MCP or `status`, and a push send goes only to an endpoint
  `pushEndpoint` accepts at send time (https, a `PUSH_SERVICE_HOSTS` host), redirects refused and
  timed out, never awaited by the scheduler pass; its payload carries ids and state only, and no
  endpoint, key, JWT or payload is logged, and the service worker (`pwa/public/push-sw.js`) holds
  no PSK, so a notification's text is fixed per kind (a spill's window label shown only as one of
  the known `5h`/`7d`; a blocked PR's one of four texts by its `reason`, an enum; a quota-exhausted's window shown only as `5h`/`7d` and its one of two texts by `reason`, an enum; a pass-refused's text fixed; the archivist's silence one text, nothing of its payload shown; a flag's one of four texts by its `reason`, an enum, and a
  generic one for any other value, the note never shown; a failing custodian's one text, opening only `/?screen=machines`) and a click opens only a same-origin path it
  built from an id that passed `isTaskId` (`/?task=<id>`, `/?screen=machines`), which the app
  reads back through the same rule, and the archivist's `archive.sqlite` (`archivist/src/archive.ts`)
  holds no prompt text, no attachment manifest and no raw account id: a task row is written only
  through `taskRow`, only for a finished task read through `listTasks`/`getTask`, after
  `forgetPrompt` and with `pin.account`, `spillAlert`, `quotaExhausted`, `assignment.window`, `branch`,
  `failure.message`, `decision` and `flag.note` dropped (the daemon slugs a title-less task's window and branch
  from its prompt) and `succeeds.account` replaced by the constant `ARCHIVED_SUCCEEDS_ACCOUNT`, its account only as the
  `account:` store key, and only over a row at a lower store version; an account row only from
  `openAccountRecord` or a key `accountStoreKey` made; and no statement there removes a row
  (`archivist/test/layering.test.ts`) — its one `DROP`, migration 2's pinned `DROP TABLE tasks`,
  runs only after every row was copied into the rebuilt table and the count checked — and its `metrics.sqlite` (`archivist/src/metrics-archive.ts`)
  labels an account only by the `account:` store key and removes rows only through the shared
  tiers' two horizon prunes (`daemon/src/metrics-tiers.ts`, the daemon's own rollup, imported,
  never copied). Don't let changes drift from them.
- **Closing a machine is the owner's sealed act** (DESIGN.md, "Closing a machine"): the daemon answers
  `availability` only when sealed `from: "app"` on the relay leg, parsed by `parseAvailabilityRequest`,
  audited without a payload, and neither `LOCAL_OPS` nor `BROKER_OPS` carries it (a keyless box
  refuses `seance close` and points to the PWA). A `closed` it cannot read in `state.json` loads as
  closed — in `loadOrInitState` only, `readState` stays log-free — `MachineStatus.cl` is never trimmed
  by `fitStatus`, the gate runs after `relaunchRefusal` and before any fetch or ledger write, and
  `SpawnRequest.routesClosed` is accepted only as `true`: a closed daemon answers `machine_closed` only
  when it is set and `internal_error`, unrecorded, otherwise. A close is offered only to a target
  advertising `CAPABILITIES.close` under a verified leader advertising `CAPABILITIES.drain`. `availability`'s
  `now` is `true` only, honoured only by a daemon advertising `CAPABILITIES.drainAsk`, offered only to such a target
  (refused locally otherwise, before anything is sent), and never persisted. `availability`'s `soft` is `true`
  only, never beside `now` (`invalid_request`), never persisted, and sent by a client only to a target advertising
  `CAPABILITIES.softClose` under a verified leader advertising it (refused locally otherwise in the PWA, the draining
  close sent instead by the CLI and MCP; an older daemon would drop it and drain); a `closed.drainAt` it cannot read loads as not
  draining; `MachineStatus.dr` is sent only beside `cl` and never trimmed by `fitStatus`; and the leader's outside pass
  drains a machine only from `drainStart` (`shared/src/status-reader.ts`: `dr`, else `cl` for a daemon not advertising
  `CAPABILITIES.softClose`, else never).
- **The custodian's controls are the owner's sealed act too** (DESIGN.md, "The custodian's status and the Machines
  row"): the daemon answers `custodian` (round now, pause, resume) only when sealed `from: "app"` on the relay leg,
  parsed by `parseCustodianRequest`, audited without a payload, and neither `LOCAL_OPS`, `BROKER_OPS` nor MCP carries
  it. It acts only through the shell verbs' one implementation (`daemon/src/custodian-owner.ts`: never a second), which
  writes the pause or a round request in `custodian/` and nothing else; a daemon running no seat or one still
  starting answers `unsupported`, one whose host checks failed (or that refused to run rounds) refuses a round
  `host_failed`, reading the seat's own state, never `seat.json`; a round meets the shell's spacing and refusals; the daemon runs the op's acts on one chain, and against the shell
  the later owner act wins (each write one atomic rename of a file holding only the pause). The PWA offers the
  controls only for a connected machine advertising `CAPABILITIES.custodian` and shows a refusal as fixed text by its
  code; thresholds, the model and on/off stay in `config.json` (C46), never the op's.
- The daemon's local op socket (`daemon/src/local-socket.ts`) is what makes MCP's `get_sessions` and
  `despawn_session` aimed at this machine skip the relay (`spawn` stays on its allowlist only for a
  `seance mcp` started before spawns became tasks). Its access control is the **0700 `stateDir()/run` directory**, not
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
  report, which only `report_task_done` sends (`seance session-event` drops a `done` unsent):
  the daemon notes it in the launch ledger and forwards it once, both for the pane's own task
  only, and answers `untasked` for a pane with none and `unrecorded` for a task its ledger holds
  no launch of (nothing sent); the leader settles that task only under `until: "reported"`, or under
  `until: "merged"` while it holds no PR and no successor (`reportSettles`), and
  only from the machine it was placed or reserved on — and clearing its own pane's task's
  `interrupted` mark in the launch ledger, only on an `ended` or `done` frame (proof the session ran;
  never when ingest is stopped), bound to the pane like the `done` report (including on a
  host with no peer pid) and never to an id from the frame — and a hand-off, which only
  `hand_off_task` sends (`seance session-event` drops one unsent), carries no state, and is taken
  only for the pane's own task when its launch ledger holds a launch and a PR URL of it — one its
  session reported, or, for a continuation, the one that ledger noted on it at launch from the launch
  it continues (`continuedPr`, from any launch but one the scheduler cancelled: a despawn sealed from the scheduler naming
  `client: "scheduler"`, noted `cancelled`), or, for a successor, the one that ledger noted on it at launch
  from the spawn's `inheritedPr` (`SpawnRequest`), taken only on a worktree spawn sealed `from` the scheduler
  with `client: "scheduler"` (or the leader's in-process dispatch) carrying a task id, held exact to
  `httpsUrl`, ignored (never refused) from any other sender, beside any other mode, or when unreadable, kept out of `progress` and
  never logged (the audit line says `inheritedPr=true`), and set by the leader only from the dispatched
  task's own `prUrl`, only for a task carrying `succeeds` and never under `until: "reported"`, never
  from a session-event frame — (`untasked`,
  `unrecorded`, `prless` otherwise): the daemon marks the pane in memory and, at that pane's next
  `idle` carrying `turnEnded` (its turn's end, never a respawn's idle), closes it through the graceful despawn after re-reading that it still carries that task,
  audited `origin=handoff` (`handoff.ts`), never a pane or task a frame names, and a pass, which only
  `pass_to_successor` sends (`seance session-event` drops one unsent), carries no state and a `record`
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
  The frame's other carried claims are `agent` (`kind`, `session`, `remote`; `remoteSession` read as `remote`'s
  fallback), each kept only as its parser (`parseTagValue`, `shared/src/tags.ts`; `agent.remote` through
  `isRemoteSessionId`) passes it, display-only (`agent.remote` is the PWA's claude.ai link) and never used to bind, route
  or move anything; `agent.session` is verified only against the launch ledger or the `claude` process's own
  `sessions/<pid>.json`, opened as `custodian-remote.ts` opens it (`readSessionFile`), re-read at each act (`atAct`), a
  refuted claim dropped, and is to be used only to address adapter delivery and the owner's `session-tag` (docs/tags.md
  §8, §3.1; neither built), never a reply — and `reason`, kept only as a known
  `NEEDS_INPUT_REASONS` value (`question` or `permission`) beside `needs-input` (dropped otherwise,
  never the event), whose effects on behaviour are `question` making the leader alert that
  needs-input stay at once instead of after its debounce (`questionAlert`), only for the task's
  own machine and once per stay, and, on a closed machine, making the drain ask send its one Escape to that pane at
  once instead of at the deadline; it never binds, routes, moves or settles anything — and `tool`,
  only beside `permission` and only as `isToolName` passes it, display-only like `agent.remote`
  (written onto `Task.inputTool`, never used to bind, route, move, settle or alert, and kept out of
  `get_queue`) — and a `stop` note, sent alone by the settings `Stop`/`StopFailure` hooks (`seance session-event
  --hook`, DESIGN.md "Settings hooks"): counts by `BACKGROUND_KINDS` and a `STOP_ERRORS` value only, never a command,
  description or prompt, held in memory for the pane's own pid and task (an untasked pane's too, forwarded nowhere),
  joined to a tasked pane's `idle` and dropped at any other state or when a frame finds the pane gone or under another
  pid, kept by the leader beside its idle clock and in `queue`'s idle entries only (never on a record), display-only like
  `tool` but for one effect: a held note with any count makes the custodian's `close` answer `busy` and the seat count
  no round due for that pane (`awaitsWake`), never a hand-off's or pass's close. `elicitation` joins `NEEDS_INPUT_REASONS` with `permission`'s effects (none).
  While this machine is draining, a bound, tasked frame's state, `turnEnded` and `reason` also time the drain ask's
  constant keys for that pane (`onState`), and never choose what is typed or which pane.
  A bound `busy` following an `idle` this process retained for that pane (`isNewTurn`; a pane with no state retained is not a new turn) also lifts the pane's own
  `stuck` or `look` flag, by one `unflag` at the leader and then in the flags file: an act on the pane's own entry
  only, never one a frame names.
  Keeping each `ours` pane's last state and `turnEnded`, tasked or not, in memory (`pane-activity.ts`, only while a
  custodian seat runs) is retention of what ingest bound, not an act: nothing there is run or sent, no reply
  depends on it, and its screen sampler keeps only a hash of `capture-pane` and timestamps, never the text. Its one
  write is the daemon's own 0600 `custodian/activity.json` (`pane-activity-store.ts`): those facts, keyed by pane id
  and the pane process's pid and start time, never screen text; a reloaded entry stays hidden from every reader until
  the pane's process matches and a fresh sample hashes its screen the same, and is dropped otherwise.
  Keeping, for each pane whose peer resolves to a `claude` process (tasked or not, `ours` or not), that process's last
  state, `reason` and `agent` claims, keyed on the process (`<pid>:<start time>`), with the conversation table beside
  it (`conversations.ts`, memory only), is retention too: nothing there is run or sent, no reply depends on it, and its
  tags reach only an app's `sessions` (`SessionEntry.tags`: never a scheduler-sealed one, and MCP's `get_sessions` only
  `AGENT_VISIBLE_TAG_KEYS`), never a log, an audit line or argv.
  Giving it any other act, or taking a session or task id from the frame to bind by, is the same
  kind of change too.
  Nothing reachable from `seance mcp` may call `log.ts` — that writes to stdout, which is the MCP
  server's JSON-RPC channel (this is why `readState` exists alongside `loadOrInitState`).
- The local socket's fourth and fifth frame kinds are `message` (`send_message`,
  `daemon/src/send-message.ts`) and `inbox` (the `inbox` mod's `seance inbox` child,
  `daemon/src/messages.ts`; DESIGN.md "Session messages"). Both are bound to a pane only by the
  kernel-reported peer pid: refused `unbound` where the host names no peer (`peerPidSupported`; an `inbox`
  listener there is told `unsupported`, not `unbound`, since no retry can bind) or the pid came back null, never
  falling back to a claimed pane. `inbox` is the first frame that hands text
  out, and binds once at accept; there is one listener per pane, closed (lazily, at the next send or listen)
  when the pane's task changes. Every bound pane is acked, an untasked one included: no task id reaches it, but a reply
  by handle (below) can. The daemon's inbox is memory only (32 messages, `4 × MESSAGE_MAX`), cleared on `ended`, rebind and
  restart. A message addressed by task id is delivered only to a live pane carrying a task this machine's launch ledger
  holds, and a sender counts as tasked only when the ledger holds its pane's task. Text is never
  logged and never in argv: `--append-system-prompt` carries only the constant `STANDING_INSTRUCTION`,
  on tasked spawns. The mod delivers only by `$.prompt.submit` or `$.session.append`, never `asUser`,
  `$.prompt.fill` or tmux keys. A sending task may send 20 messages a minute and 200 an hour. The daemon has a second
  way into a pane's inbox, `Messages.deliverAsCustodian` (a custodian `nudge`, DESIGN.md "Session messages"): it binds
  no peer (the `custodian` frame was bound to the round's pane) and has no rate bucket (the verb's counts bound it),
  but it addresses only a live pane carrying a task the ledger holds, and only the pid and task the verb counted under.
  Nothing reachable from `seance mcp` imports `log.ts` (`send-message.ts`, `message-frame.ts`), and
  `inbox-cli.ts` is silent because its stdout is the mod's data channel. Giving either frame any
  other act, or binding by a field, is a threat-model change.
  **A session with no task is reached only as a reply, by the id of a message it sent** (DESIGN.md, "Session messages",
  "Replies by handle"; docs/messaging.md D3, amended). A `message` frame carries `inReplyTo` and no `to` (or the same id as
  `to`, which is the same reply). Two memory-only tables, 1 h and 256 entries each (past the cap the oldest entry of the busiest pane goes, a note's before a question's), hold a handle:
  `sent` (ids this daemon minted, for the asker) and `received` (ids placed in a pane, for the replier). A message id is
  `crypto.randomUUID`, so the id is a bearer handle and no audit line, log line or warn carries one (the audit names the
  recipient as the constant `reply`). **Every entry binds the `claude` process, not the pane and its pid alone**
  (`Bound.session`: `<pid>:<start time>` of the innermost process on the peer's chain, peer first, that is called `claude`
  (`sessionOf`, read by `processNames`; a name is a hint any process can take, and only the innermost counts, so a
  wrapper script named `claude` is never the session), never from the pane's start command, `BoundPane.ours`, nor the
  executable's path; none on the chain is no session: that peer still sends by task id and listens where its task was
  launched here, but holds no handle, `sent` entry, `received` entry or `wake`), since a hand-started
  session's pane process is the shell, which outlives a restarted `claude`, and no `ended` fires for an untasked pane. A reply is accepted only from the pane, pid, task (null staying
  null) and session the message was placed for (`unknown` otherwise, in the sender's own rate bucket), and reaches the
  asker only at the pane, pid, task and session the `sent` entry names, while that `claude` still runs, the same
  process by start time as well as pid (`ended` otherwise): held for no other session, never given to the next `claude`
  in the same pane, and a held reply meets a listener of its own session only (`only`). A listener's bind drops every
  handle of its pane made for another pane process or task, or for a session that no longer runs. A reply to an asker on another machine goes through the leader as a `session-message` carrying
  `replyTo` (`{id, deviceId}`) and no `to`; the leader resolves nothing for it, forwards it to `replyTo.deviceId` only
  while that machine advertises `CAPABILITIES.messageReply` (`unsupported` otherwise), with `origin` the sealer's id
  (what a later reply routes back to), and the target daemon's own `sent` table decides. `wake` is on an inbox line only
  when the daemon's own `sent` table says the message answers a question or request that this pane's session sent (never
  from a frame), and only on that session's listener; the mod then submits even a note. A client sends a reply to
  another machine only after the same verified-leader gate, now for `messageReply` (`messageRouteGate("reply")`).
  **A message to a task not deliverable on its machine goes through the leader, which keeps nothing**
  (DESIGN.md, "Session messages", "Cross-machine"). A `message` frame carries `route` only as `"ask"` or
  `"send"`: `ask` is answered `remote` (in a rate bucket of its own, same limits, so a loop of asks is bounded
  and a routed message is one count in each bucket) and `seance mcp` sends `send` only after it found the
  **verified** leader advertising `CAPABILITIES.messageRoute` (`messageRouteGate`), never on the daemon's own
  word. That gate is the client's: the daemon routes any `send` a bound pane makes, and what binds the message is
  the leader's admit rule below, never an assumption that the sender was gated. A frame with no `route` is
  answered as before (`unknown`/`ended`), never `remote`.
  A routed text is held to `MESSAGE_ROUTE_MAX` of JSON-escaped bytes. The daemon sends `session-message` only
  sealed `from` its own device id (or in process), with `fromTask` only for a task its own ledger holds. The leader
  honours it only when it is not sealed `from: "app"`, parsed by `parseSessionMessage` into a fresh value, past
  the one `schedulerGuard`, and sealed by a registered machine; a `fromTask` only when the leader's own list places
  or reserves that task on the sealer (`elsewhere` is dropped with no receipt; `absent`, a pruned task, is
  forwarded without naming `fromTask`, its receipt still going to the sealer, whose own ledger bound it). The
  sender's machine name reaches the receiver's wrapper only through `displayTitle`'s scrub, cut to
  `ROUTING_ID_MAX_LENGTH`. It resolves the target only through its own list
  (`resolveMessageTarget`), forwards `deliver-message` only to a connected machine advertising both `messages`
  and `messageRoute` (this leader's own machine, when the registry lacks it, is delivered to in process: the
  leader is that daemon), for the task its own resolution chose (`settled` only for a finished record), sends
  `message-receipt` (ids, kind and an outcome; never text) only to the machine that sealed the message, keeps
  nothing and logs no line per message, title or id, only a drop or a failed forward or receipt that names a task
  or machine id. A daemon acts on `deliver-message` and `message-receipt` only sealed `from` the scheduler (or in
  process), through their own parsers; delivers only to a live pane carrying a task its own launch ledger holds
  (a `deliver-message` for another is `unknown`), or, for a `replyTo`, to the pane and session its own `sent` table
  names; de-duplicates a forward by message id, and a receipt by id and
  outcome, for `REPLAY_RETAIN_MS`; and hands a receipt only to the pane its own `sent` table says sent that message
  (an untasked sender's only way, to its session alone) or else the pane carrying the sending task, as the one fixed line
  `receiptNote` makes per outcome, never message text. A third audit line, `dir=receipt`, carries ids, kind and outcome with `bytes=-`.
- **An adapter is declared only in its machine's own `config.json` and speaks only on its stdin and stdout**
  (DESIGN.md, "Adapters"; docs/messaging.md §6). `adapters` is parsed strictly (`parseAdapters`, at most
  `ADAPTERS_MAX`, a name by `ADAPTER_NAME_PATTERN`, any mistake failing the load), never from a frame, the PWA, MCP or
  another machine, and nothing about adapters crosses the relay. Its `argv` is an argv array, never a shell string,
  `argv[0]` absolute or a bare name resolved through `PATH` at each start, never `process.execPath`. The supervisor
  (`adapter-supervisor.ts`) starts it with the env a session gets less `CREDENTIALS_DIRECTORY` and every `TMUX*`, plus
  `SEANCE_ADAPTER_NAME` and `SEANCE_ADAPTER_DIR` (0700 `stateDir()/adapters/<name>`, its cwd), in its own process group,
  stderr discarded, never while the daemon drains for a restart, and stops it with the daemon (stdin closed, SIGTERM to
  the group, SIGKILL after 5 s). Every line it writes goes through `parseAdapterLine` (`shared/src/adapter-protocol.ts`,
  the schema of record; the committed JSON Schema is generated from it), exact fields only, at most `ADAPTER_LINE_MAX`;
  a protocol major outside `ADAPTER_PROTOCOLS` or a `name` other than its key stops it for good, and the daemon sends
  only what its `wants` names. State out is `snapshot`, `session`, `session-gone` and `task` from the feed
  (`adapter-feed.ts`) and only those: never a prompt, an attachment, a session-to-session message, a transcript, the
  screen, an account id, an absolute path or anything of the PSK; `repos`, when set, bounds both sessions and tasks;
  another adapter's `adapter.*` tags are stripped (`tagsFor`); a `task` frame only for a task this machine's launch
  ledger holds. `closed` is read only from the despawn's own note (`closing-panes.ts`), never a log. Nothing an adapter
  writes, and no argv word but `argv[0]`'s basename, reaches a log or an audit line: the adapter modules load neither
  `log.ts` nor `audit.ts` at run time (`daemon/test/adapter-layering.test.ts`). An adapter runs as the owner's uid, so
  these rules bound what Séance grants, never what the program can do. Giving the seam another act (3b's delivery and
  messages out, 3c's installing) is a threat-model change, made in DESIGN.md with it.
- **The `custodian` frame kind is served only on the round's own socket** (`custodian-socket.ts`,
  `/tmp/seance-cu-s-<mkdtemp>/c.sock`, the directory kept in the seat record's `socketDir` and reused only while `lstat`
  shows it the daemon's own, else made fresh: a 0700 directory checked with `lstat`, a 0600 socket, 64 KiB
  inbound, every other kind answered `unsupported`; the daemon's main socket answers `custodian` `unsupported` too).
  Its verbs (`custodian-verbs.ts`, `custodian-frame.ts`; DESIGN.md, "The custodian frame kind") are `sessions`,
  `close <pane>`, `capture <pane>` (a pane of ours's screen as plain text, to the round only, never logged, audited or
  kept), `pr <pane>` (the state of the PR the task's own launch ledger holds, read by the daemon's `askGithub` through a
  constant query with variables, only for a PR in the GitHub repo the task worktree's `origin` names, else
  `foreign_pr`, or `unreadable` where no origin is known; never a title, body or comment; cached 60 s), `flag <pane>`,
  `nudge <pane>` (text on stdin, delivered daemon-side as a custodian message), `interrupt <pane>` (one constant Escape
  the daemon sends), `notes` and `done`, and no other
  act. It is bound only by the kernel-reported peer pid, to a process of the one live pane carrying
  `@seance-custodian` **that the seat record names as the running round** (`seat.roundPane()`), else `not_custodian`
  — as is every host that names no peer (`peerPidSupported`) and any pid not given, never a claimed pane, an env var
  or a field of the frame. A frame carries no path, branch, task id or session id. `close` re-reads the pane at the
  act and acts only on a session at rest by the daemon's own facts (`closeVerdict`: never the round's own pane,
  one that is `foreign` or `marked`, `needs-input`, `busy`, unobserved, or whose input box holds any typed text (a faint or grey prompt suggestion, through `capture-pane -e`, is not: `inputBoxDraft`; a paste or image placeholder is) or can't
  be found — `waiting`, since the despawn's Escape and Ctrl+C would clear a draft) through the graceful despawn;
  it then removes the task's worktree only for one its own launch ledger noted, under its clone's
  `.claude/worktrees/`, by `git worktree remove` **without `--force`**, after `nothingLost`, never one touched since
  the turn ended (`TOUCH_SLACK_MS`; only where a live session's turn end was observed, not for a dead or exit-prompt
  pane), locked in git (bar Claude's own lock whose process is gone) or with a pane in
  it (`custodian-worktree.ts`). `notes` is stored only through `pruneNotes` (sections by `standing`, a live task id
  or a live pane, once each) within `NOTES_MAX`, and `seance custodian notes --clear` is the owner's shell's act,
  never a frame. `flag` takes a reason from the fixed `FLAG_REASONS` (the daemon itself also sets `dirty` and
  `unpushed` when a close keeps a worktree) and an optional note of at most `FLAG_NOTE_MAX`
  characters, a printable-text rule applied before anything is stored; it acts only on a session of séance's own that is
  not the round's pane (`foreign` is refused; `marked` is not, since a flag acts on no pane), stores `{reason, note, at}` only in `custodian/sessions.json` (0600, the daemon's own
  file, never the owner CLI's `state.json`, keyed by task id or pane id, pane keys dropped at load) and tells the leader
  by one sealed, fire-and-forget `custodian-event`. `stuck` and `look` lift on the session's next turn (a bound `busy` after an
  `idle` this process saw), on a close that kept nothing, or when no live session holds it, and `dirty` and
  `unpushed` (whoever set them) only on a close that leaves nothing kept (the worktree removed, or none to decide on) or
  a re-assignment, never by a new turn or the session's end otherwise: each only after the leader's `unflag` was taken, or the entry
  stays for the next try; the flags file is masked from the round's sandbox with `stateDir()` and denied to its
  `Read` by path and realpath (`roundReadDenies`); the note is
  display-only and never logged, audited, pushed, archived, put in `get_queue` or returned by `sessions`. `nudge`
  delivers one `request` message only through messaging's local delivery (`Messages.deliverAsCustodian`, the `inbox`
  mod's submit: never a key, `asUser`, `$.prompt.fill` or tmux), the daemon its sender in the fixed
  `custodianRequest` wrapper, only to an `ours` pane carrying a task this machine's launch ledger holds, never one
  that is marked, the round's, sharing its task id with another live pane, or whose last state is `needs-input` or whose screen is
  a dialog or exit prompt, the pane read again after its count is written and handed to the delivery with the pid and task
  counted under (`gone` for any other), its text at most `MESSAGE_PUSH_MAX` bytes and
  never logged or audited, at most `maxNudges` per session and one per round. `interrupt` sends only the constant
  key Escape (`["Escape"]`, never a frame field), once per session, only to an `ours`, unmarked, `live` pane whose
  last state is `busy` (never `needs-input`) whose input box holds no draft and whose screen, as read by a sampling pass taken after the count is written, has stood
  still for `interruptAfterMinutes`, re-reading the pane (pid, task, ownership) and its facts before the key. Both
  counts are the daemon's (C30): in `custodian/sessions.json` beside the flags, keyed by task id (or pane id when
  untasked) and bound to the session's pid, written before the act, dropped when the session ends, kept across a
  restart, never set by a frame and never sent to the leader. `done` takes a summary of at most `SUMMARY_MAX` that goes only into `rounds.jsonl`. Each round's
  `seance` is its own `<tmp>/bin/seance`, first on its `PATH`. Nothing a pane, the notes or the summary held is
  logged or audited (the `custodian` origin's lines are `op=close`, `op=worktree`, `op=flag`, `op=nudge` and
  `op=interrupt` with ids, outcomes and reasons, never a note or a nudge's text), and nothing `custodian-cli.ts` reaches may call `log.ts`: its stdout is the round's data channel
  (`daemon/test/message-layering.test.ts`; `capture` and `pr` write no line at all). A new verb, or any other act, is a
  threat-model change.
- **The custodian's owner verbs are the shell's acts, never a frame** (`custodian-owner-cli.ts`; DESIGN.md, "The
  custodian's status and the Machines row"): `seance custodian status | log | round | pause | resume` are dispatched
  from `main.ts` by `import()`, outside `custodian-cli.ts`'s import closure (this module logs, audits `origin=cli`,
  and that closure must never reach `log.ts`), work from files and never the socket, and are denied to a round by
  generated fence entries (a mistake guard, not a boundary: the round's sandbox masks the `custodian/` dir and the tmux
  socket; drilled). Their files live in the 0700
  `custodian/` dir, each 0600 and written durably: `state.json` (the pause; one the daemon cannot read loads as
  paused indefinitely), `round-request` (honoured only within `ROUND_REQUEST_TTL_MS`, spaced by
  `ROUND_REQUEST_MIN_GAP_MS`, dropped before launch) and `seat.json` (the seat's view, no `rc`). Everything read from
  a file reaches the terminal through `printable` (control, format, surrogate and separator characters become U+FFFD),
  since a round's summary quotes untrusted pane text. `MachineStatus.cu` is display-only and never trimmed by
  `fitStatus`; a bad `cu` is dropped alone, never the status; its `rc` is kept only beside `running` and as
  `isRemoteSessionId` passes it, read by the daemon from `<configDir>/sessions/<pid>.json` only for the round pane's own
  pid or its direct child and never logged, and the PWA's link origin is a constant.
- **The custodian's round is a fenced reader of untrusted text and never a session** (DESIGN.md, "The
  custodian's seat"). Its pane carries the tmux pane option `@seance-custodian`, every pane reader skips it
  through its format-field parse (`listClaudeSessions`, `listPanes`, `parsePanePids`, `despawnSession`), only
  `despawnRound` closes it (a pane id and nothing else, no option a wire frame can set), and it starts only
  while the daemon is not draining. A `custodian` config key lives only in the machine's own `config.json`.
  Its fence (`custodian-fence.ts`) is generated: the deny list comes from constants and the one `COMMANDS`
  table, so a new `seance` command is denied to a round by default (under the CLI's old name `seanced` too), and it is for a cheap model's mistakes,
  never a boundary. What bounds an injected round is its sandbox plus the daemon's verbs behind the one socket it
  reaches (docs/custodian.md item 4b: drilled on macOS (Seatbelt, 2026-11-14) and on Linux in both bwrap modes under the vsock filter (`custodian-seccomp.ts`: an outer `bwrap --seccomp` around every Linux round, refusing `AF_VSOCK`, `io_uring_setup` and other ABIs, without which a round reached the Windows host from WSL2 and the host kernel's vsock loopback from an LXC container; strict mode on WSL2 2026-11-14, the weaker nested mode on LXC 2026-11-15), no hole found, so "contained" is claimed for those modes only; Linux on a CPU the filter has no table for is refused, and any change to the masks, the fence, the built environment or the round socket needs a re-drill before "contained" is said again): `denyRead` masks
  every path socket and every secret (Linux inverts the tree, macOS lists `allowUnixSockets` as the round socket's
  directory alone), `allowRead` gives back only the round dir, its tmp dir, its socket's directory and the read-only
  toolchain (never the checkout whole), the Read tool is held to the round dir by `Read(//…)` rules and secret denies,
  `network.allowedDomains` is `[]` (present: omitting it lifts the restriction) so there is no network and no `gh`, and
  the round starts under `env -i` with a built environment (never inherited; `CLAUDE_CONFIG_DIR` set for a named
  exclave, proxy variables and their CA bundle passed through only when set and a proxy URL with userinfo not at all, no
  credential or provider variable ever; the pane runs `exec /bin/sh '<tmp>/run.sh'`, the launch script in the round's tmp
  dir, so the owner's tmux `default-shell` parses no quoting of it). A host that cannot show this — Linux with no
  vsock filter for its CPU, a shim bun, or an `allowRead` entry covering any masked path (`sandboxMasks`) or leaving the checkout out — is refused (audited
  `op=refused`, `reason=sandbox_undrilled|toolchain`, a launch-time toolchain refusal included) and runs no round; a round
  this process launched that exits within two minutes of its start with no verb is audited `start_failed` (when it ended, not why:
  the sandbox's start is the usual cause, not the only one). The daemon reads an exclave's
  `.claude.json` for the round dir's trust and never writes it. The round dir and the tmp dir are made 0700, the tmp
  dir under the literal `/tmp/seance-cu-` (never `tmpdir()`, whose length makes Claude Code fall back to a shared
  `/tmp`), and the seat record in `state.json` is validated (`custodianSeatOf`) before the daemon closes a pane
  or removes a path it names. Nothing read from a pane, the seed, the notes or the agent's text is logged or
  audited; the lines carry an exclave id, a pane id, a reason and an outcome.
- **`raycast/` layering: nothing under `raycast/src/lib/` may import `@raycast/api`.** It throws
  outside the Raycast host, so such a module could not run under `bun test` and would take every
  test in the directory down at import time. Views are `.tsx` at `src/`, logic is `.ts` at
  `src/lib/`; platform APIs (`LocalStorage`, preferences) reach the logic as injected seams. The rule
  is enforced by `raycast/src/lib/layering.test.ts`, not just remembered.
- The Raycast extension is a third app-role relay client, exactly as `seance mcp` is — no relay or
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
- **The archivist holds the PSK and never acts** (DESIGN.md, Threat model item 2, and "Archivist").
  Its key comes only from its unit's `$CREDENTIALS_DIRECTORY/seance-psk` (`CRED_NAME`, imported),
  never a config field; it never runs as root; its state dir is its own, never the daemon's. It
  registers only claiming `archivist`, with a blob `parseMachineInfo` refuses, answers three ops,
  `archive-status`, `archive-metrics` and `archive-tasks`, sealed `from: "app"` to its own id past
  the seat leg's replay guard, with counts, sizes and timestamps, metric points, or stripped task
  records with the machines the archive holds tasks for, sends no `status` and no store frame, and never enqueues; the fleet's `update-available` broadcast only
  makes it write `update-requested`, for the credential-less update unit to act on. `archivist/test/layering.test.ts` walks
  `run`'s whole import closure (type-only imports too) and its own source's calls: a module that spawns,
  drives tmux, dispatches ops, brokers, leads or writes the queue or store, `daemon/src/config.ts`,
  anything in `scheduler/`, or a client write method is refused. `install.ts`, `self-update.ts` and
  `units.ts` are the admin closure: reached only by `main.ts`'s `import()`, allowed the daemon's
  exec path (`exec.ts`, `tpmcreds.ts`) and, type-only (`import type`, checked per edge), the
  two modules `audit.ts` names for its line formats (`backend.ts`, `broker-protocol.ts`), nothing else
  forbidden, and never run with the key. When a daemon module it needs sits
  beside one it must not load, move the module (as `config-checks.ts` was), never copy it, and
  never widen the forbidden list's exceptions.
- The daemon never runs as root. `install --system` / `uninstall --system` are the only commands
  that require it (they write `/etc/systemd/system`), they refuse a target user that resolves to
  root, and they never invoke `sudo` themselves — the operator supplies the privilege. Under them
  nothing may read the ambient environment for a value that ends up in the unit: as root
  `homedir()`, `stateDir()`, `logPath()`, `PATH` and `Bun.which` all answer for the wrong user, and
  the unit outlives the install. `daemon/src/target-user.ts` resolves the target instead. The same
  holds for `seance-archivist install --system` / `uninstall --system` (`archivist/src/install.ts`),
  which reuse that module and the daemon's unit helpers rather than copying them.
