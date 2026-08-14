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
- **raycast** — the fastest shard: pure form/cache logic, plus drift guards that
  import the daemon's and the PWA's implementations alongside the extension's and
  assert they agree. No React harness — the relay client underneath is already
  covered by `shared/` and e2e. Running under Bun rather than under Raycast is
  what makes those cross-imports possible, and is why nothing in
  `raycast/src/lib/` may import `@raycast/api`.

No Cloudflare account and no real `claude` are needed anywhere; `tmux` and `git` are.

## The Raycast extension

Install it as a bun workspace member — `bun install` from the repo root, never
npm: `"@seance/shared": "workspace:*"` is not a valid npm spec, and npm would
flatten the isolated linker tree that keeps the extension on `typescript@^5.9`
while the root is on TS 7. Adding the member puts no new packages in the root
`node_modules`.

`ray` is not on PATH and not hoisted; it lives at `raycast/node_modules/.bin/ray`.
Run it from inside `raycast/`, or via `bun run --filter seance-raycast <script>`.
Never `npx ray` — that fetches `@raycast/api` from the registry instead of using
the linked one.

| Command                             | What it does                                 |
| ----------------------------------- | -------------------------------------------- |
| `bun run build` (in `raycast/`)     | bundles **and typechecks** — the real gate   |
| `bun run dev` (in `raycast/`)       | imports into Raycast and watches             |
| `bun run typecheck` (in `raycast/`) | `src` on node types, then tests on bun types |

`seanced raycast install` runs both of the first two in order — `ray build` for
the typecheck, then `ray develop` long enough to import — and is the command to
use rather than driving `ray` by hand; `seanced raycast uninstall` reverses what
it can, and `seanced doctor` reports whether the imported copy has gone stale.
`ray develop` by hand is still the right tool while iterating on the extension
itself: it watches, and `install` deliberately stops the watcher once the import
lands. Both go through `raycast/node_modules/.bin/ray`, so the "never `npx ray`"
rule holds for the CLI too.

The install path is macOS-only and needs the Raycast app, so CI never exercises
it. `daemon/test/raycast-cli.test.ts` drives the real CLI against a stub `ray` in
a temp `HOME` and self-skips where the app is absent, the way the `install
--system` test self-skips without systemd; `daemon/src/raycast.test.ts` covers the
parsing, path and staleness logic everywhere. Two seams exist for those tests:
`SEANCE_RAYCAST_DIR` points the CLI at a workspace other than this checkout's, and
`SEANCE_RAYCAST_ANY_PLATFORM=1` crosses the macOS-only gate so `uninstall`'s
guards — fs work against the temp `HOME`, no Raycast involved — are covered off
macOS too.

Two tsconfigs, for the same reason `pwa/` has two: `tsconfig.json` covers the
shipped extension on `@types/node` and is the one `ray build` drives;
`tsconfig.test.json` covers the colocated tests on bun types, because the drift
guards import the daemon's Bun-shaped modules. Neither loads `lib.dom` — doing so
withdraws the `CryptoKey` and `WebSocket` globals the type packages declare.
`@types/node` must stay on `^26` even though Raycast's runtime is Node 22: 22.x
declares `CryptoKey` only inside the `webcrypto` namespace, and the build fails
with five `TS2304`s.

`raycast/assets/icon.png` is the PWA's `public/icon-512.png` mark with a rounded
rect masked into its alpha channel — 114px on 512, Apple's 22.4% app-icon ratio,
so it sits with Raycast's built-ins instead of as a hard square. Regenerate it
from the PWA copy rather than editing it in place, and leave the PWA's own icons
square: they are masked by the OS and the manifest.

**`ray build` never runs in CI** — it wants macOS and the Raycast app installed —
so CI checks the extension only through `tsc` and `oxlint`. Run
`bun run build` in `raycast/` by hand before merging anything that touches it;
that is the only step that exercises esbuild and the reach into `shared/`'s raw
TS. `ray develop` skips the typecheck entirely, so the dev loop will not catch
`shared/` drift either. `ray develop` also only picks up files that existed when
it started; add a module and restart it, or you get a `ReferenceError` from a
bundle missing the new file.

`ray lint` is not expected to pass unaided, and nothing runs it: it wants
eslint/prettier configs that would fight oxfmt and the repo's formatting hook.
That is consistent with never publishing to the Raycast Store — publishing would
push the source into the `raycast/extensions` repo and force a second copy of the
PSK at rest. Enabling oxlint's `react` plugin for this workspace needed
`react/react-in-jsx-scope` off (both JSX surfaces use the automatic runtime, so
no import is in scope and none is needed) and `react/no-unescaped-entities` off
(an apostrophe in JSX prose is correct as written).

CI runs lint, format and typecheck once, alongside (not gating — the jobs are
independent) the full suite on both `ubuntu-latest` and `macos-latest` — ubuntu
standing in for WSL's Linux userland. The WSL interop tests self-skip on both legs
and stay local-only.

`CLAUDE.md` carries the conventions and the portability scars worth knowing before
changing test infrastructure; `DESIGN.md` is the decision record for everything else.
