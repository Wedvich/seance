# Séance

A tiny PWA that contacts your machines through a blind relay and asks a daemon (`seanced`)
to spawn a fresh remote controlled Claude Code session in `tmux`.

## Why

Claude Code Remote Control lets you _continue_ sessions from your phone, but
can't _start_ new ones on a machine remotely. Keeping a persistent "god"
session alive just to run a spawn script works, but it's fragile and
awkward. Séance replaces it with a per-machine daemon that's always ready.

## Components

| Component | Where it runs                                                      | What it does                                                                                 |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `relay/`  | Cloudflare Worker + Durable Object                                 | Routes opaque encrypted blobs phone↔daemon, persists machine registry (presence = discovery) |
| `daemon/` | Each dev machine (Bun; launchd on macOS, systemd user unit on WSL) | Holds WebSocket to relay, scans repo roots, spawns `claude` in a named tmux session          |
| `pwa/`    | Cloudflare Worker (static assets)                                  | Machine list, repo picker, spawn form, spawn verdict, read-only session list                 |

See [DESIGN.md](DESIGN.md) for the full architecture and every decision with
its rationale.

## Status

Daemon (`seanced`) implemented for macOS: relay client with encrypted op
dispatch, repo scanning, tmux spawning, launchd install, and a CLI
(`init` / `install` / `doctor` / `status` / `scan` / `sessions` / `spawn`).

Relay implemented: Worker + hibernating Durable Object with path-based roles,
bearer auth, the machine registry, envelope routing, and `undeliverable`
notices.

PWA implemented: spawn screen, bottom sheets, verdicts, first-run setup and
settings, offline-capable shell. WSL support deferred.

Tests: `bun test`. The daemon suite uses a throwaway in-process relay, a
private tmux server, and a stub claude; the relay and PWA suites boot the real
Worker and Durable Object under workerd via Miniflare — the PWA's relay client
is exercised against the shipped relay rather than a double.

## Deploying the relay

```sh
cd relay
bun run wrangler secret put BEARER_TOKEN   # same value as every daemon config + the app
bun run deploy
```

## Deploying the app

`VITE_RELAY_URL` is required: it pins the CSP's `connect-src` to your relay, so
a build without it fails rather than shipping a page that cannot connect.

```sh
cd pwa
VITE_RELAY_URL=wss://seance-relay.<subdomain>.workers.dev/app bun run deploy
```

Daemons then point `relayUrl` at
`wss://seance-relay.<your-subdomain>.workers.dev/daemon`. For local runs, put
`BEARER_TOKEN=...` in a gitignored `relay/.dev.vars` (see `.dev.vars.example`)
and use `bun run dev`.

## Storing the PSK

On macOS the PSK belongs in the login keychain, not `config.json`. Run
`seanced psk-import` bare and `security` prompts for it on the terminal, or
pipe it straight from 1Password — either way it never lands in argv or shell
history:

```sh
op item get Séance --fields password --reveal | seanced psk-import
```

Then clear `psk` in `config.json` and `seanced restart`.
