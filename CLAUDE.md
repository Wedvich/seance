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
- **docs/codex.md** — Codex as a first-class account; every question decided by the owner. Built so far: item 1
  (the daemon's login: `codex` block, home, probe, `logins`/`lq`, `seance codex`, DESIGN.md "Codex login") and item 5
  (the driver seam: `AgentDriver`, `daemon/src/agents/`, DESIGN.md "Agent drivers"). Read it, and docs/agents.md,
  before any Codex work.
- **docs/orchestrator.md** — draft, nothing decided: tracker projects as task graphs. Read before amend
  deps, anything that reads a tracker, or a non-task session; build nothing from it.
- **docs/tags.md** — tags and session identity; built, keeps open questions and spike evidence. Read
  DESIGN.md's "Tags and session identity" before adding a field that labels a session or task, or
  touching session identity or adapter addressing.

Like DESIGN.md, the docs/ files are part of the record: a change that alters behavior they describe
updates them in the same commit. They are not auto-discovered — this list is how sessions find them.

**This file holds rules, never the record.** A decision, its history or its evidence goes in DESIGN.md
or a doc; here goes only the rule an agent must not break, and where its record lives. A subsystem's
rule goes in its `.claude/rules/` file. `scripts/claude-md.test.ts` caps this file at 20 kB and checks
every rules file is listed below and every glob still matches a file.

## Deploys

- Before any deploy or other Cloudflare operation, confirm auth with `bun run wrangler whoami` from
  inside `relay/` or `pwa/` (mechanics in docs/development.md). If the output doesn't name an
  authenticated account, stop and ask the user to run `wrangler login` rather than discovering it
  mid-deploy.

## Testing

Layout, commands and env vars are in docs/development.md, and so is the evidence behind each rule here
("Why the testing rules hold"). The rules that keep the suite green:

- **A flaky test is a bug, not acceptable in a PR or on `main`.** Before a PR adds or changes a test,
  admit it (docs/development.md, "Admitting a test"): run its file with
  `bun run test <file> --rerun-each=20 --randomize`, then again under CPU load, and make sure every
  real-time window it races (a grace, a debounce, a timeout it does not drive) is driven by the test
  through an injected clock or a held boundary, or outlasts the test's own timeout — never sized to
  outlast a slow machine. Reruns and load
  alone miss a window lost only on a busy CI runner. Fix a flake by reproducing it first (the
  `/fix-flaky-test` method), never with `--retry`, a per-test `retry` or a longer timeout.
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
- **Argv-array exec.** The one shell string is the tmux inner command, every wire-supplied value
  through `shq()`. `spawn` resolves repos by name against the cached scan set, never a path from a frame.
- **Every spawn, despawn and reap audits** through its one formatter under its own origin; a new surface
  adds an origin, never reuses one (`.claude/rules/audit.md` lists them).
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
| `.claude/rules/drain.md`        | Closing and draining a machine, the drain's session ask                                 |
| `.claude/rules/archivist.md`    | The archivist's key, ops, layering and archives                                         |
| `.claude/rules/raycast.md`      | The Raycast extension's layering, credentials and runtime                               |
| `.claude/rules/audit.md`        | Audit origins, one per surface                                                          |
| `.claude/rules/credentials.md`  | Credentials in the daemon: `CREDENTIALS_DIRECTORY`, auth health                         |
| `.claude/rules/identity.md`     | Registry entries, `openAtRest`, lead-proof, signed register, nomination, the seat       |
| `.claude/rules/scheduler.md`    | Leader requests, launch ledger, continuations, version floor, passes, amend, limits     |
| `.claude/rules/task-records.md` | Reading task/account/quota records, the one task sealer and its sentinels, traits       |
| `.claude/rules/relay-store.md`  | The relay's store: prefixes, term fence, write floor, deletes                           |
| `.claude/rules/attachments.md`  | Attachment objects: relay routes, daemon fetch, PWA upload                              |
| `.claude/rules/github.md`       | `pushTaskBranch`, the leader's PR and watch reads, reap's check, the GitHub budget      |
| `.claude/rules/push.md`         | Web push endpoints, the service worker's fixed texts, deep links                        |

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
- DESIGN.md's threat-model invariants are requirements, not observations. The ones any change can hit
  are the recurring rules above; the rest live in `.claude/rules/`, by area (table above). Don't let
  changes drift from them.
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
