# Séance — Design

Finalized 2026-07-26 after a decision-tree review. Each section records the
decision, the alternatives considered, and why. Revised 2026-07-27 with
daemon implementation decisions from a second grilling.

## Problem & scope

Claude Code Remote Control (shipped 2026-02) can continue existing sessions
from the phone but cannot start new ones on a machine. Existing tools (Happy
Coder, Omnara, VibeTunnel) solve this by replacing the client UI with their
own. Decision: **build a spawner only** — sessions start in tmux with
`--remote-control`, and the official Claude app remains the session UI.
Happy Coder was evaluated and rejected because it wraps sessions in its own
UI instead of tmux + Remote Control.

Out of scope for v1: killing sessions, streaming output, deep-linking into
the Claude app (no such link exists — handoff is manual).

## Topology: blind relay, daemons dial out

Rejected: phone→device direct over Tailscale (requires Tailscale active on
phone; discovery via tailnet), UniFi Teleport + LAN discovery (home-network
only, mDNS doesn't traverse the VPN, PWA mixed-content pain).

Chosen: each daemon holds a persistent WebSocket **out** to one relay; the
PWA talks HTTPS/WebSocket to the relay only. Discovery is free — connected
daemons are the device list. Works from anywhere, no VPN on the phone, one
TLS cert.

**Relay host: Cloudflare Worker + Durable Object** (personal account, free
tier, zero servers to patch; Pages hosts the PWA). Rejected: personal VPS
(patching burden), pengefix-bots VPS (company infra for a personal tool, and
its Tailscale lockdown defeats the relay's purpose).

## Security model

- **Pre-shared 256-bit symmetric key (PSK)**, manually placed in each
  daemon's config and the phone (SSH + paste; no pairing flow to build).
  Rejected: Ed25519 sign-only (prompts would transit Cloudflare in
  plaintext), per-device asymmetric keypairs (needless key management when
  one human owns every device), QR pairing (requires being at the machine).
- **AES-256-GCM via native WebCrypto** on both ends (built into browsers and
  Bun — zero crypto dependencies). Encrypt-and-authenticate in one
  primitive. Rejected: XSalsa20-Poly1305 secretbox (same properties, needs a
  library).
- **Envelope**: `{ v, to, from, iv, ct }`. The random 12-byte GCM IV doubles
  as the replay nonce — a replayed frame is byte-identical, so receivers
  dedup on the IV. Rejected: separate nonce inside the ciphertext (as
  originally written here — redundant; catches nothing IV dedup misses).
- **Routing fields bound as AAD** (`` `${v}|${to}|${from}` ``): one PSK
  covers all devices, so without this a compromised relay could re-address
  a captured spawn blob to a different machine and it would decrypt. AAD
  makes "relay compromise cannot spawn anything" literally true. Both ends
  build the AAD via one shared helper (byte-identical or nothing decrypts).
- **Replay window**: plaintext carries `ts`; receivers reject frames outside
  ±60s of local time and keep seen IVs for 120s (2× window, pruned lazily on
  insert). All devices are NTP-synced; 60s is generous. Rejected: ±30s
  (confusing false rejections after sleep/resume clock drift), ±300s
  (5-minute replayability for no benefit).
- **PSK is generated offline by the human** (1Password) and pasted into each
  config. `seanced` never generates key material — `init` writes a skeleton
  with an empty `psk` field; `doctor` validates it decodes to 32 bytes.
- **Post-quantum safe by construction**: symmetric-only crypto — no key
  exchange exists to attack (Grover only halves a 256-bit key's strength;
  ML-KEM/ML-DSA solve problems this design doesn't have).
- **The relay is blind**: it routes opaque blobs and stores encrypted
  machine info it cannot read. Relay compromise cannot spawn anything or
  read prompts/repo names.
- **Structured payloads only**: daemons accept
  `{repo, prompt, title, mode, model, effort}` and build shell commands
  themselves. Raw command strings never cross the wire.
- **Relay-level bearer token** (shared, in daemon config + PWA) gates
  registration. Anti-junk hygiene only — the PSK is the trust boundary; the
  PWA ignores registry entries that don't decrypt.

## Threat model

Mapped against MITRE ATT&CK v19 (released 2026-04-28) on 2026-07-27. ATT&CK
catalogues observed adversary behaviour, not design flaws, so it is used two
ways here: as an inventory of what Séance itself does that an attacker would
inherit, and as a frame for the paths into it. What it doesn't cover is
recorded as invariants below.

**Assets, in order**: the PSK (it is the only trust boundary); code execution
on four dev machines; prompts and repo names; presence metadata. The bearer
token is not an asset in the same sense — see its blast radius above.

**Séance's own footprint.** The daemon is structurally a remote access tool and
reads as one to any EDR:

| Behaviour                                                | ATT&CK                           |
| -------------------------------------------------------- | -------------------------------- |
| launchd agent runs `seanced`                             | T1543.001 Launch Agent           |
| persistent outbound WSS to the relay                     | T1071.001, T1102.002             |
| AES-256-GCM under a PSK                                  | T1573.001 Symmetric Cryptography |
| remotely starting an interactive coding agent            | **T1219.001 IDE Tunneling**      |
| `caffeinate -is` per spawn + the AC-power hold           | T1653 Power Settings             |
| depth-2 `.git` scan of `repoRoots`                       | T1083                            |
| tmux pane enumeration                                    | T1057                            |
| `git pull` + `launchctl kickstart -k` as the update path | T1195.001                        |

T1219.001 is the closest published match — ATT&CK added it for `code tunnel`
and JetBrains Gateway, i.e. this exact shape. Consequence: those persistence
and C2 techniques firing together is a RAT signature, so a machine that later
gets an EDR needs Séance allowlisted deliberately — and once allowlisted,
Séance's noise is cover for a real intruder.

**Paths in, ranked.**

1. **PSK theft from the browser** (T1189 → T1555.003-adjacent; localStorage has
   no exact technique). The PWA holds the only copy of the key outside the four
   configs, and is the only place reachable without touching a machine. Every
   control in the security model above defends the _channel_ — AAD binding, IV
   dedup, the ±60s window, relay blindness — and none of them touch this.
   Decision: the PWA keeps the key as a non-extractable `CryptoKey`
   (`importPsk` already imports with `extractable: false`) in IndexedDB, never
   as base64 in local storage, under a strict CSP. XSS can then use the key
   while a tab is open but cannot exfiltrate it — the difference between a
   transient compromise and a permanent silent one.
2. **Infostealer reading `config.json`** (T1552.001). 0600 stops other users,
   not a process running as the user, and macOS commodity stealers already
   sweep `~/.config`. The keychain rejection above optimised for parity with a
   WSL machine that doesn't exist yet; revised — macOS reads the PSK from the
   login keychain when present and falls back to the config field, behind one
   `loadPsk()` so WSL keeps the file path.
3. **Bearer token disclosure** (T1654 Log Enumeration). The `?t=` reasoning
   above holds for Cloudflare itself, but the token also reaches Workers Trace
   Events and any Logpush sink — enabling Logpush to a third party later moves
   the blast radius off Cloudflare, so that choice is not free. The token also
   buys slightly more than stated: `register` overwrites by `deviceId`, so a
   holder can blank a real machine's entry until it re-registers (T1565.001),
   and nothing caps registry growth (T1499.003). Bounded by entry caps, a
   UUID check on `deviceId`, and a per-socket register rate limit in the DO.
4. **Relay compromise** (T1557 — the relay _is_ the AiTM position). Handled:
   AAD binding makes re-addressing fail closed. Residual is availability and
   traffic analysis, both accepted. One unstated dependency: the ±60s window
   trusts local time and NTP is unauthenticated, so an attacker who can skew a
   daemon's clock widens the window.
5. **Supply chain** (T1195.001). `git pull` + `launchctl kickstart -k` is
   unsigned; a compromised repo is RCE on every machine, onto boxes that
   already carry launchd persistence. Bounded by 2FA and branch protection
   rather than an update daemon — proportionate to four machines.
6. **Prompt injection into the spawned agent.** Outside ATT&CK Enterprise;
   v19's AI additions (T1682, T1683) model adversaries _using_ AI, not
   compromising an agent — MITRE ATLAS is the companion frame. Two parts: a PSK
   holder's `prompt` reaches Claude under `--permission-mode auto`, and the
   spawned agent then reads repo content Séance does not control.

**What "structured payloads only" does and does not mean.** It stops wire input
being interpolated into the daemon's own shell construction. It is not a
capability limit: `prompt` is free text handed to a Claude session running
`--permission-mode auto`, so anyone who can form a valid spawn frame has
arbitrary code execution, laundered through the agent. The PSK is the whole
boundary and there is nothing behind it. Recorded here so the control isn't
read as a sandbox.

**Invariants.** The first two hold in the code today and are requirements, not
observations — they are exactly the kind of thing that drifts silently. The
third is the gap they leave.

- `spawn` resolves `repo` by **name lookup against the cached scan set**
  (`repos.find(r => r.name === request.repo)`). A wire-supplied string is never
  joined onto a path root. `repo_not_found` is a security outcome, not just UX.
- Every external process is invoked as an **argv array** (`exec.ts`). The one
  shell string is the tmux inner command, where every wire-supplied value —
  `title`, `model`, `effort`, worktree name — goes through `shq()`. Nothing
  wire-supplied may be concatenated into a command unquoted.
- Every spawn is **logged at start and outcome** with repo, mode, title, prompt
  length and prompt SHA-256 prefix. With a stolen PSK this log is the only
  thing that says someone else used your machines, and today a _successful_
  spawn logs nothing at all — only crashes do. This is the design's largest
  detection gap; the log is local and rewritable by whoever compromised the
  machine, so it is evidence for the honest-machine case only.

**Non-goals**: multi-user access control (one human owns every device); relay
availability (an outage is no spawns, not a breach); defending a dev machine
that is already compromised (it holds the PSK, so it _is_ the boundary);
zero-downtime key rotation.

**Key rotation runbook.** Rotation and revocation are one operation: generate
32 bytes in 1Password, paste into all four configs and the PWA, `seanced
restart` on each. Spawns fail closed in between. No `keyId` in the envelope —
considered and rejected, because a rollover window buys nothing for four
devices owned by one person and costs a wire-format change. `seanced doctor`
prints a PSK fingerprint (SHA-256 prefix of the raw key) so agreement across
devices is checkable without comparing secrets.

## Presence & identity

The Durable Object persists a machine registry:

```
{ deviceId, info, lastSeen }
```

- `deviceId`: random UUID generated by the daemon on first run, stored in
  its config. Plaintext routing key — an identifier, not a credential.
- `info`: name, platform, repo list — encrypted "hello" blob only the PWA can
  decrypt. Re-sent on reconnect and repo rescan; DO overwrites.
- `connected` is **not persisted** — it's derived from `state.getWebSockets()`
  when the registry is read, so an eviction or crash can never leave a stale
  `true` on disk. Entries go out to the PWA as `RegistryEntry & { connected }`.
- `lastSeen` is written on register and on `webSocketClose` — the only
  liveness events the DO observes, since auto-response heartbeats
  deliberately never wake it. An abruptly-slept Mac can therefore read
  `connected: true` until Cloudflare notices the dead socket; the
  `undeliverable` frame below is the backstop.
- Offline machines stay listed with last-seen (an asleep PC is actionable;
  a vanished one is confusing). Entries are permanent, overwritten only by a
  later register. **No forget verb and no TTL in v1** — deliberately, so the
  bearer token authorizes nothing destructive (see below).
- Online = WebSocket open, with heartbeat pings to catch silent drops.
- Daemon sockets use DO WebSocket hibernation. No connection state in class
  fields (`state.getWebSockets()` + DO storage are truth), heartbeats via
  `setWebSocketAutoResponse()` so pings don't wake the DO. Wake is
  milliseconds — no cold-start hang.
- Human names live in daemon config (`name: "MacBook Pro"`), never visible
  to Cloudflare.

## Wire protocol

Two layers, and two roles decided by **upgrade path**: daemons dial
`/daemon`, the PWA dials `/app`. Path-as-role means the PWA sends no register
frame and the DO knows what a socket is before any frame arrives.
`APP_ID = "app"` is the PWA's only wire address — and it is AAD-bound, so both
ends must agree byte-for-byte or nothing decrypts.

Layer 1 (plaintext, daemon↔relay): `register { deviceId, info: <envelope> }`
on connect and whenever the repo set changes; `msg { envelope }` for routed
traffic; literal `"ping"`/`"pong"` strings for heartbeats (bare strings, not
JSON, so DO auto-response can answer without waking — daemon pings every 30s,
expects pong within 10s, else closes and redials with 1→60s jittered
exponential backoff, reset on successful register). The daemon authenticates
with an `Authorization: Bearer` header.

Layer 1 (plaintext, PWA↔relay): `msg { envelope }` outbound. Inbound:
`registry { entries }` pushed on connect **and on every change** (so presence
needs no polling); `msg { envelope }` for daemon replies; and
`undeliverable { to, iv, code }` when the target daemon has no open socket.

- **Auth is `?t=<token>`**, because browsers cannot set WebSocket headers.
  The token therefore lands in Cloudflare's request logs — accepted: TLS
  terminates at Cloudflare and the relay must read the token to do its job,
  so this discloses nothing CF doesn't already hold. Rejected: WS subprotocol
  (constrains the token to base64url — `=` and `/` aren't legal RFC 7230
  tchars — for a benefit the threat model doesn't need), first-frame auth
  (unauthenticated sockets plus a reaper timer, i.e. state in the one place
  the design keeps stateless).
- **`/app` rejects after upgrading, not before.** A browser cannot read the
  HTTP status of a failed WS handshake, so a pre-upgrade 401 is
  indistinguishable from a dead relay and the app would retry a token that will
  never be accepted, forever. `/app` therefore completes the handshake and
  closes with `4401` (bad token) or `4400` (no token), which the app treats as
  permanent and stops on. The socket never reaches the DO, so an
  unauthenticated caller still cannot wake it, and non-upgrade requests keep
  the plain 401. `/daemon` is unchanged — daemons read the real status from
  `fetch`.
- **Bearer-token blast radius, restated:** with the token but not the PSK an
  attacker can register junk (the PWA ignores non-decrypting entries) and read
  registry metadata (machine count, deviceIds, last-seen), but cannot spawn or
  read prompts. This is why v1 has no `forget` verb — a relay-side delete
  would be the one destructive act the bearer authorizes, and the relay is
  blind so it cannot demand PSK proof.
- **App-bound envelopes broadcast to every open app socket** (phone and
  laptop tabs both address `"app"`). Stateless — just `getWebSockets("app")` —
  and clients already correlate on `re`, so another tab's reply matches no
  pending request and is dropped silently. Rejected: newest-socket-wins
  (opening the PWA on the laptop kills the phone), per-session `app:<rand>`
  ids (two identities in play, since the register blob is sealed to the bare
  constant before any client exists).
- **`undeliverable` correlates by `iv`**, not by request `id` — the `id` is
  inside the ciphertext, so a blind relay has nothing else to echo. The PWA
  also refuses to send when `connected === false`; the frame exists for the
  stale-presence race, where the alternative is a 90s spinner that ends in
  "timed out" when the truth was "that Mac is asleep".
- **`OP_TIMEOUT_MS`** lives in `shared/` (sessions 10s, rescan 15s, spawn
  90s) because the right values derive from daemon internals — `exec.ts`'s 60s
  command timeout plus `spawn.ts`'s 3s pane-death check — and would silently
  drift if kept in PWA code. It is a backstop; the daemon returns a structured
  error on its own.

Layer 2 (end-to-end encrypted ops, PWA→daemon request/response):

- `sessions {}` → running claude tmux windows. The one live pull — session
  state is inherently fresh-only.
- `spawn { repo, prompt?, title?, mode: "worktree"|"here", model?, effort? }`
  → `{ ok, window, path, sessions }` or `{ ok: false, code, message }`. The
  verdict embeds a refreshed session list so the PWA updates without a
  second round trip.
- `rescan {}` → fresh repo list; daemon re-registers if the set changed.

Repos are **pushed, not pulled**: they ride the encrypted register blob, so
the PWA's repo picker renders from the machine registry alone and works for
offline machines. Rejected: a `status` op returning repos + sessions
together (re-sends registry data on every poll, useless offline).

## Daemon (`seanced`, Bun)

- **Runtime: Bun** (TS end-to-end with relay + PWA, shared payload types,
  native WebSocket/WebCrypto). Rejected: Node (chosen defaults fit, but Bun
  preferred), Go (second language, no shared types).
- **Distribution: run from the git checkout** — the launchd plist executes
  `bun <checkout>/daemon/src/main.ts`; update = `git pull` +
  `launchctl kickstart -k`. Rejected: `bun build --compile` single-file
  install (originally written here — ~100 MB artifact plus a build/ship
  step per machine, and every machine already runs Bun).
- **CLI**: `seanced` (run in foreground; launchd supervises), `init` (write
  config skeleton + deviceId), `install`/`uninstall` (launchd plist),
  `doctor` (preflight: tmux/claude/git/roots/relay/config), `status`,
  `scan`, and `spawn <repo>` — the last runs the spawn path locally with no
  relay, the SSH-debuggability hook.
- **Config split**: `~/.config/seance/config.json` (hand-edited, 0600,
  never rewritten by the daemon: relayUrl — which must include the `/daemon`
  path, so `doctor` warns when it doesn't; the failure mode is a rejected
  upgrade and a silent backoff loop — bearerToken, psk, name,
  repoRoots, tmuxSession) and `~/.local/state/seance/state.json`
  (daemon-owned: deviceId, repo cache, scannedAt). Rejected: single file
  the daemon writes back (clobbers hand edits), PSK in OS keychain (no
  clean WSL counterpart).
- **Lifecycle**: launchd agent on macOS. **WSL support deferred** to a
  later pass at the actual machine (systemd user unit **plus a
  Windows-side keepalive** — scheduled task pinning the WSL VM, which halts
  when idle; untestable blind from a Mac). `install` exits with a clear
  message on non-macOS. Rejected: daemon-inside-tmux (reboot silently takes
  the machine offline — recreates the god-session fragility).
- **tmux**: spawns a window into the **`main` session group**
  (`tmux new-window -t main:`) — terminals auto-attach to that group via
  zshrc, so daemon-spawned windows appear in every attached terminal
  instantly. Cold boot with no session: create it detached
  (`tmux new-session -d -s main`); the next terminal attaches to it
  seamlessly. If only a grouped sibling (e.g. `main-1`) survives, target any
  session whose `session_group` is `main`. Configurable as `tmuxSession`,
  default `"main"`. Rejected: separate named `claude` session (as originally
  written here — orphans spawned windows outside the one-window-per-task
  workflow), daemon child processes without tmux (loses walk-up-and-attach).
- **Spawn logic is reimplemented natively** in the daemon (structured
  errors, no shell-script templating). The `/spawn` slash command stays
  as-is for in-terminal use; drift between the two implementations is an
  accepted risk. Port the accumulated wisdom from `/spawn`
  (`~/.claude/commands/spawn.md`): ff-only fast-forward of the default
  branch before `claude --worktree`, worktree/window naming
  (slug + timestamp), seed-prompt preamble (worktree setup instructions),
  `--remote-control` always, **opus**/medium defaults (revised from
  sonnet), `--permission-mode auto`, per-spawn `caffeinate -is`
  unconditionally (a session you asked for stays awake even on battery),
  and the pane-death verification (remain-on-exit + 3s wait + `pane_dead`
  check — tmux returning 0 does not mean claude started). `--here` mode
  spawns at the repo root (no remote "current directory" exists).
  Failures return structured codes (`repo_not_found`, `fetch_failed`,
  `no_default_branch`, `tmux_error`, `claude_died` + captured pane output,
  `timeout`) plus a non-fatal `note` field (e.g. "default branch diverged —
  basing worktree on local HEAD").
- **Repo discovery**: config lists parent roots (e.g. `~/pengefix`,
  `~/repos`); daemon scans for `.git` at depth 2. Measured: 19ms for 58
  repos — the walk is free. Scans run at startup, hourly, and on explicit
  `rescan` — never implicitly from PWA activity. Results cached in
  state.json (restart re-registers instantly from cache); re-register only
  when the set changed. `defaultBranch` is best-effort from local refs only
  (`origin/HEAD` on disk, null otherwise — ~⅓ of repos lack it), carried
  forward for known repos; the network-touching `git remote set-head -a`
  runs only in the spawn path when unresolved. Rejected: explicit repo list
  (config edit per clone — the friction being eliminated), whole-home scan
  (slow, noisy), authoritative default-branch resolution at scan time
  (turns a 19ms local walk into a multi-second networked operation that
  fails offline).
- **Session detection**: list all tmux panes across all sessions, dedup by
  window id (grouped sessions repeat windows), count a window as claude
  when `pane_current_command` matches `/^\d+\.\d+\.\d+$/` — claude retitles
  its process to its bare version string. Repo mapped by longest path
  prefix; worktrees under `<repo>/.claude/worktrees/*` map to their repo.
  Undocumented convention; if a release changes it the list goes visibly
  empty and the pattern is a one-line fix. Rejected: daemon-tracked window
  ids (manual `/spawn` windows invisible — defeats duplicate avoidance;
  union variant adds id-reconciliation state for a hedge the visible
  breakage already covers).
- **Logging**: plain text (`ISO-timestamp level message`) to
  stdout/stderr; the launchd plist redirects both to
  `~/.local/state/seance/seanced.log`. No rotation in v1; `doctor` warns
  past ~10 MB.
- **Testing: `bun:test`**, overriding the personal Vitest default — tests
  run on the runtime the daemon ships on (Bun.spawn, WebSocket, WebCrypto
  work without shims), and the integration harness is a throwaway Bun
  WebSocket relay under the daemon's test dir (not the real relay).
- **Sleep policy**: daemon holds `caffeinate -is` **only while on AC power**;
  on battery the Mac sleeps and shows offline. Keeps desk machines always
  spawnable without cooking laptop batteries. Rejected: no assertion
  (marquee use case fails on idle machines), Wake-on-LAN (flaky on Wi-Fi,
  needs cross-daemon coordination).
- Config file: relay URL, bearer token, PSK, deviceId, machine name, repo
  roots.

## PWA (Cloudflare Workers, static assets)

Vite + React, deployed as an **assets-only Worker** (no `main`) rather than
Pages, which is in maintenance. Security headers ship as a generated
`dist/_headers`, because the CSP has to carry two build-time facts: the sha256
of the inline theme boot script, and the relay origin for `connect-src`. A
production build without `VITE_RELAY_URL` fails rather than shipping a policy
that silently blocks the only socket the app has.

V1 surface: machine list (online/offline + last-seen), per-machine repo
picker, spawn form (prompt optional, worktree/`--here` toggle, model and
effort as first-class tiles, defaults opus/medium), spawn verdict (daemon
relays tmux window name or the captured error), and a **read-only** list of
running claude tmux windows per machine (avoids spawning duplicates).
Models offered: `fable`/`opus`/`sonnet`; efforts: all five the CLI accepts.

- **The PSK is stored as a non-extractable `CryptoKey` in IndexedDB** and its
  base64 is never persisted. An XSS can then use the key while it runs but
  cannot exfiltrate 32 bytes that would otherwise grant permanent authority
  over every machine, so there is nothing to rotate afterwards. Consequence:
  the key can never be redisplayed — 1Password stays the source of truth.
  Bearer token and relay URL remain in `localStorage`; the token has to be
  readable because it goes on the URL.
- **The form and any in-flight spawn are persisted.** iOS kills backgrounded
  PWAs freely, and the prompt is the only thing here the user wrote. The prompt
  therefore sits in plaintext `localStorage` — a deliberate asymmetry against
  the PSK, weighing one message's text against standing authority.
- **Sessions are fanned out, not polled.** The header total spans every online
  machine, so `sessions` is sent to each on connect, when a machine wakes, and
  on resume from background — that last one because a suspended PWA's socket
  dies silently and stale counts under a green dot are worse than none.
- **A lost spawn reply is reconciled, not guessed.** Backgrounding the app
  mid-spawn loses the reply (a blind relay cannot queue it), so the pending
  spawn is persisted and the machine is asked what is running once there is a
  socket again. Reporting a failure there would be a lie: the session may well
  be live. A refused delivery is reported as a known no, separately.

## Accepted trade-offs

- `/spawn` and the daemon duplicate git/tmux logic — drift risk, owned.
- Key rotation or a new phone touches 4 devices manually, with spawns failing
  closed in between — no `keyId`, no rollover window.
- Battery-powered Macs show offline when asleep.
- No deep link from spawn verdict into the Claude app session.
- A spawn reply lost to a >45s background cannot be recovered exactly, only
  reconciled from the session list. Relay-side buffering of app-bound envelopes
  would fix the short cases, but `ts` lives inside the ciphertext so a blind
  relay cannot re-stamp one; anything flushed beyond `REPLAY_WINDOW_MS` is
  rejected as stale. Deliberately not built — see below.
- A PSK holder has arbitrary code execution on every machine; the spawn audit
  log is local and rewritable, so detection assumes the machine is honest.
- The daemon's own footprint is indistinguishable from a RAT — machines that
  gain an EDR need it allowlisted by hand.

## Open design details (build time)

- Exact WSL keepalive mechanism (WSL support deferred to a later pass).
- Optional: relay buffers app-bound envelopes (bounded, TTL ≤ ~45s to stay
  inside the replay window) so a spawn reply survives a short background
  instead of falling through to reconciliation.

Resolved 2026-07-27: repo-scan caching/rescan triggers, replay window, and
DO hibernation — decisions recorded in their sections above. Also resolved with
the PWA: `/app` close codes, PSK at rest, session fan-out, and lost-reply
reconciliation.

Decided but not yet built (threat model, 2026-07-27): spawn audit logging;
keychain-backed PSK on macOS behind `loadPsk()`; PSK fingerprint in `doctor`;
registry entry caps, UUID `deviceId` validation and register rate limiting in
the DO; regression tests pinning the two spawn invariants. The PWA's
non-extractable-key and CSP items are tracked in `HANDOFF-pwa-security.md`.
