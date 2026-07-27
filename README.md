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
| `pwa/`    | Cloudflare Pages                                                   | Machine list, repo picker, spawn form, spawn verdict, read-only session list                 |

See [DESIGN.md](DESIGN.md) for the full architecture and every decision with
its rationale.

## Status

Daemon (`seanced`) implemented for macOS: relay client with encrypted op
dispatch, repo scanning, tmux spawning, launchd install, and a CLI
(`init` / `install` / `doctor` / `status` / `scan` / `sessions` / `spawn`).
Relay and PWA are next; WSL support deferred. Tests: `bun test` (uses a
throwaway in-process relay, a private tmux server, and a stub claude).
