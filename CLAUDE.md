# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Séance spawns remote-controlled Claude Code sessions on dev machines via a blind relay. Bun workspaces
monorepo: `daemon/` (seanced, per-machine), `relay/` (Cloudflare Worker + Durable Object), `pwa/`
(Vite + Preact app), `raycast/` (a local-only Raycast extension — spawn only), `shared/` (wire types,
envelope crypto + the app-role RelayClient), `e2e/` (full-stack test suite, no shipped code).

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
- The daemon suites' isolation env vars (`SEANCE_TMUX_SOCKET`, `SEANCE_CLAUDE_BIN`) are set by the
  tests themselves — useful to know when debugging.
- A fixed sleep before a _positive_ assertion is a latent flake: it has to outlast the slowest
  machine and reports a timeout instead of the thing that never happened. Poll instead (`pollUntil`
  in `daemon/test/fixtures.ts`). Before a _negative_ assertion ("nothing happened") a sleep is
  legitimate — a non-event can't be polled — so leave those alone.
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
  across files, so no in-process cache can survive it. `--parallel` inside the daemon shard is fine.
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
  not free-text throws.
- Comments state rationale and constraints, not narration — match that density and style.
- Never persist `process.execPath`. It's the realpath'd binary (on Homebrew,
  `…/Cellar/bun/1.3.14/bin/bun`), so anything recording it — launchd plist, systemd unit, the Claude
  MCP entry — dangles the moment a package manager retires that version. Resolve through PATH
  (`resolvedBun()` in `daemon/src/link.ts`) or invoke bun by bare name and let exec resolve it
  (`update.ts`). Resolving at _use_ time is always fine; the hazard is only what outlives the process.
- DESIGN.md's threat-model invariants are requirements, not observations: argv-array exec (the one
  shell string is the tmux inner command, every wire-supplied value through `shq()`), `spawn`
  resolves repos by name against the cached scan set, every spawn path audits through one formatter
  under its own origin (`relay`, `cli`, `local` — a new surface adds an origin, never reuses one),
  prompt text is never logged, and a service-delivered credential never leaves the daemon process
  (`exec.ts` strips `CREDENTIALS_DIRECTORY`, or the tmux server it boots hands the PSK's path to
  every session). Don't let changes drift from them.
- The daemon's local op socket (`daemon/src/local-socket.ts`) is what makes an MCP spawn aimed at
  this machine skip the relay. Its access control is the **0700 `stateDir()/run` directory**, not
  the socket's own mode — `Bun.listen({ unix })` creates it 0755 and the `chmod` races. Its op
  allowlist is `sessions` and `spawn` only; widening it is a threat-model change, not a tweak.
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
