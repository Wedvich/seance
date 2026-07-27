# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Séance spawns remote-controlled Claude Code sessions on dev machines via a blind relay. Bun workspaces
monorepo: `daemon/` (seanced, per-machine), `relay/` (Cloudflare Worker + Durable Object), `pwa/`
(Vite + React app), `shared/` (wire types + envelope crypto).

Read the docs before changing behavior — this file deliberately doesn't repeat them:

- **README.md** — setup, deploy, and update walkthrough.
- **DESIGN.md** — the decision record: architecture, wire protocol spec, threat model, and every
  rejected alternative with rationale. If a change alters decided behavior, update DESIGN.md with it.

## Commands

- `bun test` — everything; single file: `bun test daemon/src/scan.test.ts`
- `bun run typecheck` / `bun run lint` / `bun run lint:fix` / `bun run format:check` (root)
- `bun run dev` in `relay/` and `pwa/` for local dev; needs a gitignored `relay/.dev.vars` with
  `BEARER_TOKEN` (see `.dev.vars.example`)
- `bun run deploy` in `relay/` and `pwa/`; the pwa build fails without `VITE_RELAY_URL` by design
- Daemon CLI: `bun daemon/src/main.ts <command>` (`help` lists them)

## Testing

- Runner is `bun:test`, not Vitest — deliberate (DESIGN.md), don't introduce Vitest idioms.
- Daemon integration tests need real `tmux` and `git` on PATH. They isolate via a private tmux
  server (`SEANCE_TMUX_SOCKET`) and a stub claude binary (`SEANCE_CLAUDE_BIN`) — set in the tests,
  useful to know when debugging.
- `daemon/test/harness.ts` is a throwaway relay double with behaviors _inverted_ from the real DO
  (its header comment says which). Never treat it as a reference for relay behavior — DESIGN.md's
  wire protocol section is the spec.
- Relay and PWA suites boot the real Worker + Durable Object under workerd via Miniflare, reading
  bindings from `wrangler.jsonc` — config drift there fails tests, which is intended.
- The full suite is only green on macOS: session detection encodes macOS comm semantics
  (`pane_current_command` returns the bare versioned comm), so daemon integration tests fail on
  Linux containers, and sandboxed workerd can be flaky there too. On Linux, trust the unit tests
  and typecheck/lint; leave full-suite verification to a macOS machine.

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
