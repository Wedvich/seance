# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Séance spawns remote-controlled Claude Code sessions on dev machines via a blind relay. Bun workspaces
monorepo: `daemon/` (seanced, per-machine), `relay/` (Cloudflare Worker + Durable Object), `pwa/`
(Vite + Preact app), `shared/` (wire types, envelope crypto + the app-role RelayClient), `e2e/` (full-stack test suite, no
shipped code).

Read the docs before changing behavior — this file deliberately doesn't repeat them:

- **README.md** — setup, deploy, and update walkthrough.
- **DESIGN.md** — the decision record: architecture, wire protocol spec, threat model, and every
  rejected alternative with rationale. If a change alters decided behavior, update DESIGN.md with it.
  For protocol work, start at its "The map: one spawn, end to end" subsection — a sequence diagram
  plus a frame→module table saying which file owns each frame; `shared/src/types.ts` is the schema
  of record, so a frame change touches both.

## Commands

- `bun run test` — everything via `scripts/test.ts`, which shards into concurrent `bun test`
  processes and raises bun's 5s hook timeout (the workerd-booting suites need it); narrow to one
  shard with `bun run test daemon/test/spawn.test.ts`
- `bun run typecheck` / `bun run lint` / `bun run lint:fix` / `bun run format:check` (root)
- `bun run dev` in `relay/` and `pwa/` for local dev; needs a gitignored `relay/.dev.vars` with
  `BEARER_TOKEN` (see `.dev.vars.example`)
- `bun run deploy` in `relay/` and `pwa/`; the pwa build fails without `VITE_RELAY_URL` by design
- Before any deploy or other Cloudflare operation (both `relay/` and `pwa/` deploy via wrangler),
  confirm auth with `bun run wrangler whoami` from inside `relay/` or `pwa/`. Wrangler is a
  per-workspace devDependency, not on PATH and not hoisted to the root — bare `wrangler` and
  `bun run wrangler` from the repo root both fail. Auth is global (`~/Library/Preferences/.wrangler`
  on macOS), so either workspace answers for both. If the output doesn't name an authenticated
  account, stop and ask the user to run `wrangler login` rather than discovering it mid-deploy.
- Daemon CLI: `bun daemon/src/main.ts <command>` (`help` lists them)

## Testing

- Runner is `bun:test`, not Vitest — deliberate (DESIGN.md), don't introduce Vitest idioms.
- Daemon integration tests need real `tmux` and `git` on PATH. They isolate via a private tmux
  server (`SEANCE_TMUX_SOCKET`) and a stub claude binary (`SEANCE_CLAUDE_BIN`) — set in the tests,
  useful to know when debugging.
- A fixed sleep before a _positive_ assertion is a latent flake: it has to outlast the slowest
  machine and reports a timeout instead of the thing that never happened. Poll instead (`pollUntil`
  in `daemon/test/fixtures.ts`). Before a _negative_ assertion ("nothing happened") a sleep is
  legitimate — a non-event can't be polled — so leave those alone.
- `daemon/test/harness.ts` is a throwaway relay double with behaviors _inverted_ from the real DO
  (its header comment says which). Never treat it as a reference for relay behavior — DESIGN.md's
  wire protocol section is the spec.
- Relay and PWA suites boot the real Worker + Durable Object under workerd via Miniflare, reading
  bindings from `wrangler.jsonc` — config drift there fails tests, which is intended.
- `e2e/` wires all three real components (daemon, workerd relay, app RelayClient + Store) and runs
  the user flows end to end. Each pairwise suite keeps its double on purpose — the daemon's fake
  relay is controllable in ways the real DO forbids — and the e2e suite is what catches
  fake-vs-real drift.
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
- DESIGN.md's threat-model invariants are requirements, not observations: argv-array exec only,
  `spawn` resolves repos by name against the cached scan set, both spawn paths audit through one
  formatter, prompt text is never logged. Don't let changes drift from them.
