# Development

## Running locally

Put `BEARER_TOKEN=...` in a gitignored `relay/.dev.vars` (see `.dev.vars.example`),
then `bun run dev` in `relay/` and in `pwa/`. Outside production builds the app
defaults to `ws://127.0.0.1:8787/app`, so no `VITE_RELAY_URL` is needed for local
work.

## Commands

| Command                | What it does                                       |
| ---------------------- | -------------------------------------------------- |
| `bun run test`         | the whole suite, sharded into concurrent processes |
| `bun run typecheck`    | root `tsc --noEmit` plus each workspace's own      |
| `bun run lint`         | oxlint (`lint:fix` to apply)                       |
| `bun run format:check` | oxfmt (`format` to apply)                          |

The daemon CLI runs straight from source: `bun daemon/src/main.ts <command>` (`help`
lists the commands).

Narrow the suite to one shard by naming a file: `bun run test daemon/test/spawn.test.ts`.
The runner is `scripts/test.ts`, which also raises bun's 5s hook timeout — the suites
that boot workerd need the headroom.

## Deploying

`bun run deploy` in `relay/` and in `pwa/`; the pwa build fails without `VITE_RELAY_URL`
by design (it pins the CSP to your relay — see the README's setup walkthrough).

Wrangler is a per-workspace devDependency, not on PATH and not hoisted to the root —
bare `wrangler` and `bun run wrangler` from the repo root both fail; run
`bun run wrangler <cmd>` from inside `relay/` or `pwa/`. Auth is global
(`~/Library/Preferences/.wrangler` on macOS), so logging in from either workspace
answers for both; `bun run wrangler whoami` says where you stand.

## How the tests are layered

- **daemon** — a throwaway in-process relay, a private tmux server
  (`SEANCE_TMUX_SOCKET`), and a stub claude binary (`SEANCE_CLAUDE_BIN`). Needs real
  `tmux` and `git` on PATH.
- **relay** and **pwa** — the real Worker and Durable Object under workerd via
  Miniflare, reading bindings from `wrangler.jsonc`, so config drift there fails tests
  by design. The app's relay client is exercised against the shipped relay rather than
  a double.
- **e2e** — all three real components at once: the daemon from `daemon/src`, the
  Worker + Durable Object under workerd, and the app's relay client and store. It runs
  the user flows end to end — machine discovery, spawns and their failures,
  dropped-reply reconciliation, rescan, daemon restart — and is what catches drift
  between the doubles and the real thing.

No Cloudflare account and no real `claude` are needed anywhere; `tmux` and `git` are.

CI runs lint, format and typecheck once, alongside (not gating — the jobs are
independent) the full suite on both `ubuntu-latest` and `macos-latest` — ubuntu
standing in for WSL's Linux userland. The WSL interop tests self-skip on both legs
and stay local-only.

`CLAUDE.md` carries the conventions and the portability scars worth knowing before
changing test infrastructure; `DESIGN.md` is the decision record for everything else.
