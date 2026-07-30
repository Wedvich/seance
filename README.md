# Séance

A tiny PWA that contacts your machines through a blind relay and asks a daemon (`seanced`)
to spawn a fresh remote controlled Claude Code session in `tmux`.

## Why

Claude Code Remote Control lets you _continue_ sessions from your phone, but
can't _start_ new ones on a machine remotely. Keeping a persistent "god"
session alive just to run a spawn script works, but it's fragile and
awkward. Séance replaces it with a per-machine daemon that's always ready.

## Components

| Component | Where it runs                                                            | What it does                                                                                 |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `relay/`  | Cloudflare Worker + Durable Object                                       | Routes opaque encrypted blobs phone↔daemon, persists machine registry (presence = discovery) |
| `daemon/` | Each dev machine (Bun; launchd on macOS, systemd user unit on Linux/WSL) | Holds WebSocket to relay, scans repo roots, spawns `claude` in a named tmux session          |
| `pwa/`    | Cloudflare Worker (static assets)                                        | Machine list, repo picker, spawn form, spawn verdict, read-only session list                 |

See [DESIGN.md](DESIGN.md) for the full architecture and every decision with
its rationale.

## Status

Daemon (`seanced`) implemented for macOS, Linux (systemd), and WSL: relay
client with encrypted op dispatch, repo scanning, tmux spawning, service
install (launchd / systemd user unit, plus a Windows logon task on WSL), a
platform PSK store (macOS login keychain / WSL DPAPI blob / TPM-sealed blob
on Linux with a TPM 2.0; TPM-less Linux keeps the PSK in `config.json`), and a CLI
(`init` / `install` / `doctor` / `status` / `scan` / `sessions` / `spawn`).

Relay implemented: Worker + hibernating Durable Object with path-based roles,
bearer auth, the machine registry, envelope routing, and `undeliverable`
notices.

PWA implemented: spawn screen, bottom sheets, verdicts, first-run setup and
settings, offline-capable shell.

Tests: `bun run test` (the script raises bun's 5s hook timeout — the suites
that boot workerd need the headroom). The daemon suite uses a throwaway in-process relay, a
private tmux server, and a stub claude; the relay and PWA suites boot the real
Worker and Durable Object under workerd via Miniflare — the PWA's relay client
is exercised against the shipped relay rather than a double. The `e2e/` suite
then wires all three real components together — the daemon from `daemon/src`,
the Worker + Durable Object under workerd, and the app's relay client and
store — and runs the user flows end to end: machine discovery, spawns (and
their failures), dropped-reply reconciliation, rescan, and daemon restart.
It needs `tmux` and `git` on PATH, but no Cloudflare account and no real
`claude`.

## Setting up end to end

Everything runs from one dev machine — which can also be the first daemon
machine. There is no chicken-and-egg: the two secrets are minted by you before
anything exists, and the only other shared value (the relay URL) is _produced_
by step 2 and consumed by steps 3 and 4.

Prerequisites: [Bun](https://bun.sh), a Cloudflare account, and this repo
cloned with `bun install` run at the root. Each daemon machine (macOS, Linux,
or WSL) additionally needs `tmux`, `git`, and `claude` on PATH. Linux machines
need systemd for `seanced install` — a standard Debian/Ubuntu box, VM, or LXC
container (unprivileged is fine) qualifies; without systemd, run `seanced`
under your own supervisor. A WSL machine also needs `systemd=true` under
`[boot]` in `/etc/wsl.conf` — flipping it takes a `wsl.exe --shutdown`, which
kills every session on the box, so do it before anything else.

### 1. Mint the shared secrets

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='   # bearer token
openssl rand -base64 32                               # PSK
```

Keep both in a password manager — every daemon and the phone get the same two
values. The bearer token must be base64url-safe because the app sends it as a
query parameter: a `+` decodes to a space and you get a silent 401 instead of
an error. The PSK is the actual trust boundary; the relay never sees it.

### 2. Deploy the relay

```sh
cd relay
bun run wrangler login                     # once
bun run wrangler secret put BEARER_TOKEN   # paste the bearer token
bun run deploy                             # prints https://seance-relay.<subdomain>.workers.dev
```

Note the `<subdomain>` in the printed URL — steps 3 and 4 derive their URLs
from it.

The first deploy also mints the `workers.dev` hostname, which needs a few
minutes to route and get a certificate. Until it does, requests fail the TLS
handshake or return a 404 with body `error code: 1042` — propagation, not a
broken deploy. The edge caches those errors, so re-check with a cache-buster
(`curl -sI '<url>/?x=1'`) rather than the path you already probed.

### 3. Deploy the app

`VITE_RELAY_URL` is required: it pins the CSP's `connect-src` to your relay, so
a build without it fails rather than shipping a page that cannot connect. It
also means pointing the app at a different relay later requires a rebuild, not
just a settings edit.

```sh
cd pwa
VITE_RELAY_URL=wss://seance-relay.<subdomain>.workers.dev/app bun run deploy
```

Or put it in a gitignored `pwa/.env` (see `.env.example`) and just
`bun run deploy`. This hostname is new too — the step 2 propagation note
applies again.

### 4. Install seanced on each machine

Distribution is the git checkout itself: the service runs
`bun <checkout>/daemon/src/main.ts`, so updating is `git pull` + restart. Run
the CLI the same way from the checkout root (`alias seanced='bun
<checkout>/daemon/src/main.ts'` if you like).

```sh
git clone <this repo> && cd seance && bun install
bun daemon/src/main.ts init      # writes the ~/.config/seance/config.json skeleton
```

Edit `~/.config/seance/config.json`:

- `relayUrl` — `wss://seance-relay.<subdomain>.workers.dev/daemon` (must end
  in `/daemon`)
- `bearerToken` — from step 1
- `psk` — from step 1, or leave empty and run `seanced psk-import` to keep it
  in the platform store instead (macOS login keychain / WSL DPAPI blob / Linux
  TPM-sealed blob)
- `repoRoots` — directories to scan for repos

Config is read once at startup, so `seanced restart` after any edit here. A repo
added _inside_ an existing root needs no restart — the hourly rescan, or the
app's refresh, picks it up; only `repoRoots` itself is sticky.

```sh
bun daemon/src/main.ts doctor    # preflight: config, tmux/git/claude, relay reachability
bun daemon/src/main.ts install   # macOS: launchd agent (RunAtLoad + KeepAlive)
                                 # Linux/WSL: systemd user unit + linger (+ a Windows logon task on WSL)
```

On a fresh headless Linux box the systemd user instance may not exist until
linger is enabled — if `install`'s preflight says so, run
`sudo loginctl enable-linger <user>` once and re-run it.

On WSL, `install` also registers a `SeanceWslPin` scheduled task via
`schtasks.exe` — it starts the distro at Windows logon and pins the VM so the
idle timeout never takes the daemon offline. If registration is denied,
`install` prints the exact command to run from a Windows shell instead. The
machine is offline while no Windows user is logged in — the same class of
limitation as a launchd agent, which is also per-login.

`doctor` prints a PSK fingerprint — compare it across machines to confirm they
all hold the same key. A daemon with the right token and PSK simply appears in
the app; there is no pairing step.

#### Storing the PSK

The PSK belongs in the platform store, not `config.json`: the login keychain
on macOS, a DPAPI (CurrentUser) blob under `~/.local/state/seance/` on WSL,
and on Linux with a TPM 2.0 a `systemd-creds` blob sealed to the TPM at
`~/.local/state/seance/psk.cred` — in every case a filesystem sweep, backup,
or stolen disk gets ciphertext. (Linux without a usable TPM has no such
store — there the PSK stays in `config.json`, which `init` creates 0600, and
`psk-import` says so and stores nothing.) Run `seanced psk-import` bare and
it prompts on the terminal (no echo), or pipe it straight from 1Password —
the key never lands in argv or shell history:

```sh
op item get Séance --fields password --reveal --account my | seanced psk-import
```

Then clear `psk` in `config.json` and `seanced restart`.

The Linux path needs `/dev/tpmrm0` and `systemd-creds` on PATH (systemd
≥ 250 — Debian 12+/Ubuntu 24.04+). The blob is sealed to the TPM alone, with
no PCR binding, so firmware updates don't invalidate it — but it is
machine-bound by design: restore a container backup or copy the blob to other
hardware and it will not decrypt. The daemon fails closed with "no psk" and
`doctor` explains why; re-run `psk-import` on the new machine. This protects
the key at rest (container backups, ZFS snapshots, stolen disks) — not
against root on the host or other processes running as your user.

In a Proxmox LXC container, pass the TPM through once on the host:

```sh
pct set <ctid> --dev0 path=/dev/tpmrm0,uid=<uid>,gid=<gid>,mode=0660
```

In an unprivileged container, `uid=`/`gid=` are the container-side ids the
device maps to — set them to the daemon's user so it can open the device; the
daemon never needs root.

### 5. Set up the phone

Open `https://seance-pwa.<subdomain>.workers.dev`, add it to your home screen,
and in first-run setup enter the relay URL
(`wss://seance-relay.<subdomain>.workers.dev/app`), the bearer token, and the
PSK. Machines appear as their daemons register.

### Updating

```sh
git pull && bun daemon/src/main.ts restart    # daemon, on each machine
bun run --cwd relay deploy                    # relay
VITE_RELAY_URL=... bun run --cwd pwa deploy   # app
```

### Local development

Put `BEARER_TOKEN=...` in a gitignored `relay/.dev.vars` (see
`.dev.vars.example`) and use `bun run dev` in `relay/` and `pwa/` — the app
defaults to `ws://127.0.0.1:8787/app` outside production builds.
