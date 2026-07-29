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
the _specific_ session the spawn verdict just created. The success screen links to
`claude://code` (opens the app's Code tab/session list — mobile-only, no desktop
equivalent), because no Claude-assigned session ID ever reaches the daemon: Remote
Control's session ID is only observable from inside the spawned `claude` process
(`$CLAUDE_CODE_BRIDGE_SESSION_ID`, set once its own async connection to the Anthropic
API completes), and the relay's blind request/response design has no channel to
deliver a value that becomes known only after the spawn reply already went out.
Handoff to the right session in the list is manual.

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

| Behaviour                                            | ATT&CK                            |
| ---------------------------------------------------- | --------------------------------- |
| launchd agent runs `seanced`                         | T1543.001 Launch Agent            |
| systemd user unit + Windows logon task run it on WSL | T1543.002, T1053.005              |
| persistent outbound WSS to the relay                 | T1071.001, T1102.002              |
| AES-256-GCM under a PSK                              | T1573.001 Symmetric Cryptography  |
| remotely starting an interactive coding agent        | **T1219.001 IDE Tunneling**       |
| pre-answering claude's trust dialog in its config    | T1562.001 Disable or Modify Tools |
| `caffeinate -is` per spawn + the AC-power hold       | T1653 Power Settings              |
| depth-2 `.git` scan of `repoRoots`                   | T1083                             |
| tmux pane enumeration                                | T1057                             |
| `git pull` + service kickstart as the update path    | T1195.001                         |

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
   `loadPsk()`. Revised again at the actual WSL machine (2026-07-28): WSL gets
   its own store behind the same `loadPsk()` — a DPAPI blob
   (`ProtectedData`, CurrentUser scope) at `~/.local/state/seance/psk.dpapi`,
   encrypted and decrypted through `powershell.exe` interop, written by the
   same `seanced psk-import`. What it buys: a Linux-context sweep of
   `~/.config` gets ciphertext, and the key never rests in plaintext inside
   the ext4.vhdx, so at-rest theft (the vhdx itself, backups of it) is
   covered. What it honestly does not: DPAPI has no ACL — any process in the
   Windows user's session decrypts silently, where macOS records an ACL for
   `/usr/bin/security` and prompts anything else. That principal could
   already read the vhdx and `\\wsl.localhost`, so interop adds no new
   trusted party; it just fails to subtract one. The PSK crosses the interop
   boundary as stdin/stdout data only — never argv (visible in both OS
   process lists), never script text (PowerShell script-block logging,
   event 4104, captures script text but not `$input` data). Rejected:
   Windows Credential Manager (DPAPI underneath plus a vault entry
   enumerable by name — strictly more discoverable for no added
   protection), secret-service/gnome-keyring (headless WSL has no login
   ceremony to unlock a keyring; the unlock secret would itself need
   storing — circular), systemd-creds (no TPM device in the WSL VM, so it
   falls back to a host key on the same disk), kernel keyring (not
   persistent across VM restart), DPAPI's optional entropy parameter (a
   second secret with nowhere to live — the same circle). A plain Linux
   box — neither darwin nor WSL — still has only the config field.
3. **Bearer token disclosure** (T1654 Log Enumeration). The `?t=` reasoning
   above holds for Cloudflare itself, but the token also reaches Workers Trace
   Events and any Logpush sink — enabling Logpush to a third party later moves
   the blast radius off Cloudflare, so that choice is not free. The token also
   buys slightly more than stated: `register` overwrites by `deviceId`, so a
   holder can blank a real machine's entry until it re-registers (T1565.001),
   and nothing caps registry growth (T1499.003). Bounded in the DO by a
   32-entry cap that turns away only _unknown_ ids — so a full registry locks
   out machines you have not added yet and never knocks a known one offline —
   plus a per-socket register rate limit, which bounds write rate as the entry
   cap does not: re-registering one id is otherwise unbounded puts and a
   registry push to every app each time. Neither cap defends _against_ a token
   holder; rotating the token does. They keep the cost finite. The rate limit
   is per socket, so it bounds one connection's spend, not an attacker's total.
   Wire-level bounds back both: ids are ≤64 safe characters and ciphertext
   ≤64 KiB, so a register can never reach the DO's 128 KiB value limit as an
   unhandled throw. `deviceId` is not required to be a UUID — it is an
   identifier, not a credential, so exact shape buys nothing the bounds don't.
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
- Every spawn is **logged at start and outcome** with repo, mode, title, model,
  effort, prompt length and prompt SHA-256 prefix — never the prompt text,
  which would make `seanced.log` a transcript of everything ever asked. With a
  stolen PSK this log is the only thing that says someone else used your
  machines.
- **Both spawn paths audit, through one formatter**, tagged `origin=relay` or
  `origin=cli`. A trail that covered only the relay would make `seanced spawn`
  the quieter way in — precisely the path someone with local shell access would
  choose — and the tag is what separates "me at my desk at 2pm" from "my phone
  was in a drawer at 3am". The daemon writes via stdout (launchd redirects it);
  the CLI appends to the same file itself, and failing to do so warns rather
  than failing a spawn the human asked for. Two independent writers is safe
  only while nothing rotates the file.
- The log is local and rewritable by whoever compromised the machine, so it is
  evidence for the honest-machine case only. There is no off-box copy in v1.

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
- `lastSeen` is written on register, on `webSocketClose`, and by the sweep —
  which stamps the last heartbeat rather than sweep time, since the machine
  has been gone since then.
- **Silent daemon sockets are swept.** An abruptly-slept Mac sends no close
  frame, so its socket would read `connected: true` until Cloudflare noticed
  the dead TCP peer — unbounded, hours in practice. A storage alarm runs
  every 60s while daemon sockets exist and closes any socket silent past 90s
  (three missed heartbeats), stamping `lastSeen` and pushing the registry.
  Heartbeats still never wake the object: the sweep reads
  `getWebSocketAutoResponseTimestamp()`, with the socket's accept time as the
  floor before its first ping. Accepted cost: the hub wakes every 60s while
  any daemon is connected (wake is milliseconds, ~1.4k alarms/day); the
  alternative was presence that lies for hours. The `undeliverable` frame
  below remains the backstop for the residual ≤ ~2.5 min window.
- Offline machines stay listed with last-seen (an asleep PC is actionable;
  a vanished one is confusing). Entries are permanent, overwritten only by a
  later register. **No forget verb and no TTL in v1** — deliberately, so the
  bearer token authorizes nothing destructive (see below).
- Online = WebSocket open. Heartbeats catch silent drops from both ends: a
  missed pong makes the daemon close and redial; a daemon socket that stops
  pinging is swept by the relay's alarm.
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
exponential backoff, reset on successful register; the relay in turn sweeps
sockets that stop pinging — see Presence & identity). The daemon authenticates
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
- **`iv` is also the cross-tier debug join key**, for the same reason it carries
  `undeliverable`: it is the only per-message identifier a blind relay can name.
  All three tiers emit `wire <event> iv=… ` lines through one `quote()` in
  `shared/`, so one grep spans the daemon log, `wrangler tail`, and the browser
  console. Failure paths carry the same prefix (`wire dropped … reason=…`,
  `wire unsent … reason=…`) rather than prose, because the case you grep for is
  usually the one that failed. Success lines are emitted _after_ the send, so a
  line never claims a frame that never left the socket. The two encrypting ends
  add the `id` (or `re`) the relay cannot read;
  the relay adds only routing. Because `seal` mints a fresh iv per envelope, a
  request and its reply have _different_ ivs — a round trip joins in two hops,
  endpoints on `id`, relay on `iv`, and reading it as one iv end to end is the
  mistake to avoid. The registry path is deliberately not instrumented: a
  `machine-info` iv repeats across every push (the PWA keys `#infoCache` on it),
  so it is not a message identity there. Payloads are never logged, on any tier.
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
- **CLI**: `seanced` (run in foreground; launchd/systemd supervises), `init`
  (write config skeleton + deviceId), `install`/`uninstall` (launchd plist on
  macOS; systemd unit + linger + Windows logon task on WSL),
  `doctor` (preflight: tmux/claude/git/roots/relay/config), `status`,
  `scan`, and `spawn <repo>` — the last runs the spawn path locally with no
  relay, the SSH-debuggability hook.
- **Config split**: `~/.config/seance/config.json` (hand-edited, 0600,
  never rewritten by the daemon: relayUrl — which must include the `/daemon`
  path, so `doctor` warns when it doesn't; the failure mode is a rejected
  upgrade and a silent backoff loop — bearerToken, psk, name,
  repoRoots, tmuxSession) and `~/.local/state/seance/state.json`
  (daemon-owned: deviceId, repo cache, scannedAt). Rejected: single file
  the daemon writes back (clobbers hand edits). PSK-in-OS-keychain was
  rejected here as having no clean WSL counterpart; both halves of that are
  now revised — each platform has a store (login keychain / DPAPI blob in
  the state dir) as the fallback behind `loadPsk()`, with a non-empty
  config field still winning, so `psk-import` never rewrites config.json
  and a plain Linux box keeps the file path. See threat-model item 2.
- **Lifecycle**: launchd agent on macOS. On WSL (resolved 2026-07-28 at the
  actual machine): **systemd user unit + linger + a Windows logon task**.
  The unit (`seanced.service`, `Restart=on-failure`) appends stdout/stderr
  to the same `seanced.log` path launchd redirects to
  (`StandardOutput=append:`), so the audit trail, the CLI's second writer,
  and `doctor`'s size warning stay one story on both platforms — journald
  was rejected for forking all three. `loginctl enable-linger` starts the
  unit at distro boot with no login session; the Windows scheduled task at
  logon runs `conhost.exe --headless wsl.exe -d <distro> --exec sleep
infinity`, which both boots the distro after a Windows restart (nothing
  else starts WSL until poked) and pins the VM against its idle timeout.
  `install` automates all three — the task via `schtasks.exe` interop,
  printing the manual command if registration is denied — and requires
  `systemd=true` in `/etc/wsl.conf`, which it checks for and explains but
  never flips itself: the flip restarts the distro and kills every session
  on the box. `uninstall` reverses unit and task but leaves linger on (it
  may serve other units). Logged out of Windows or sitting at the login
  screen, WSL cannot run and the machine shows offline — same class as a
  LaunchAgent, which is also per-login. Update = `git pull` +
  `seanced restart` (`launchctl kickstart -k` / `systemctl --user
restart`). Rejected: daemon-inside-tmux (reboot silently takes
  the machine offline — recreates the god-session fragility), the logon
  task running the daemon directly through `wsl.exe` (scheduled tasks
  don't supervise — no restart-on-crash), `[boot] command =` in wsl.conf
  (runs as root, same no-supervision hole).
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
  (prompt slug; see the naming note below), seed-prompt preamble (worktree setup instructions),
  `--remote-control` always, **opus**/medium defaults (revised from
  sonnet), `--permission-mode auto`, per-spawn `caffeinate -is`
  unconditionally (a session you asked for stays awake even on battery),
  and the pane-death verification (remain-on-exit, then poll `pane_dead`
  up to a 3s deadline — tmux returning 0 does not mean claude started;
  polling reports a death the moment it happens instead of after the full
  wait, and a window that vanished mid-check counts as a death that beat
  remain-on-exit, not a success). `--here` mode
  spawns at the repo root (no remote "current directory" exists).
  Failures return structured codes (`repo_not_found`, `fetch_failed`,
  `no_default_branch`, `tmux_error`, `claude_died` + captured pane output,
  `timeout`) plus a non-fatal `note` field (e.g. "default branch diverged —
  basing worktree on local HEAD").
- **Pre-trust on spawn**: Claude Code blocks startup on a per-directory trust
  dialog (`projects[<path>].hasTrustDialogAccepted` in `~/.claude.json`, or
  under `$CLAUDE_CONFIG_DIR` when set — the daemon mirrors claude's own
  lookup) that no remote can answer, so an untrusted repo spawned from the
  phone reports success and sits dead at the prompt. Both spawn paths answer
  it up front (`trust.ts`): read claude's config, set the flag for the repo
  root when missing, write back atomically (tmp + rename, mode preserved).
  The dialog guards less than spawning already grants — a PSK holder starts
  claude in the repo under `--permission-mode auto` — so pre-answering it
  widens nothing; it is still an external tool's safety prompt being
  disabled, hence the T1562.001 row in the footprint table. Fails open: a
  failed write means the dialog may reappear, never a failed spawn. A
  missing config (claude never ran on the machine) is left alone —
  first-run onboarding would block the session regardless, and fabricating
  claude's own file is worse. The worktree needs no separate entry: claude
  starts at the repo root and moves into the worktree after the trust
  check. Memoized in-process per (config, repo) pair, so it costs one
  config read per repo per daemon run. Rejected: caching trust in
  state.json or `RepoEntry` (stale in the dangerous direction — revoking
  trust in claude would be silently overridden forever by a cache that
  outlives the decision; and `RepoEntry` crosses the wire, where trust is
  daemon-local business), pre-trusting the whole scan set at scan time
  (writes trust for repos never spawned).
- **Worktree/window naming**: the prompt (or explicit `--title`) slugified
  to 40 chars, nothing more. A trailing `-2`, `-3`, … is appended only when
  the name is already taken — either the worktree directory exists or a
  `worktree-<name>` branch survived a `git worktree remove`, which would
  otherwise base a new session on old work. Rejected: unconditional
  `-YYYYMMDD-HHMMSS` suffix (as originally shipped — these sessions rarely
  live a day, so the stamp was noise in every window title and every path).
- **Repo discovery**: config lists parent roots (e.g. `~/pengefix`,
  `~/repos`); daemon scans for `.git` at depth 2. A root that is itself a
  repo counts as that one repo and is not descended into — it lets a lone
  clone (`~/dotfiles`) be exposed without making its parent a root, and
  stopping the walk keeps submodules and linked worktrees inside it from
  registering as separate repos. Measured: 19ms for 58
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
  stdout/stderr; the launchd plist (macOS) and the systemd unit's
  `StandardOutput=append:` (WSL) redirect both to
  `~/.local/state/seance/seanced.log`. No rotation in v1; `doctor` warns
  past ~10 MB.
- **Testing: `bun:test`**, overriding the personal Vitest default — tests
  run on the runtime the daemon ships on (Bun.spawn, WebSocket, WebCrypto
  work without shims), and the integration harness is a throwaway Bun
  WebSocket relay under the daemon's test dir (not the real relay). The
  `e2e/` workspace then wires the real daemon, the real Worker + DO under
  workerd, and the real app transport + store together for the user flows;
  the pairwise doubles stay, because they are controllable in ways the real
  components forbid (a relay that stops answering pings, a daemon with a
  scripted handler map).
- **Sleep policy**: daemon holds `caffeinate -is` **only while on AC power**;
  on battery the Mac sleeps and shows offline. Keeps desk machines always
  spawnable without cooking laptop batteries. Rejected: no assertion
  (marquee use case fails on idle machines), Wake-on-LAN (flaky on Wi-Fi,
  needs cross-daemon coordination). On WSL there is no caffeinate
  analogue the VM could hold that outlives Windows power policy — the box
  sleeps per Windows settings and shows offline; configure the power plan,
  not the daemon. Both caffeinate call sites are already platform-gated.
- Config file: relay URL, bearer token, PSK, deviceId, machine name, repo
  roots.

## PWA (Cloudflare Workers, static assets)

Vite + Preact, deployed as an **assets-only Worker** (no `main`) rather than
Pages, which is in maintenance. Security headers ship as a generated
`dist/_headers`, because the CSP has to carry two build-time facts: the sha256
of the inline theme boot script, and the relay origin for `connect-src`. A
production build without `VITE_RELAY_URL` fails rather than shipping a policy
that silently blocks the only socket the app has. HSTS rides in the same file
(the workers.dev hostname is not a zone, so Cloudflare's dashboard toggle does
not apply), without `includeSubDomains`/`preload` — that hostname is not ours to
make claims about, and `.dev` is preloaded at the TLD anyway.

V1 surface: machine list (online/offline + last-seen), per-machine repo
picker, spawn form (prompt optional, worktree/`--here` toggle, model and
effort as first-class tiles, defaults opus/medium), spawn verdict (daemon
relays tmux window name or the captured error), and a **read-only** list of
running claude tmux windows per machine (avoids spawning duplicates).
Models offered: `fable`/`opus`/`sonnet`; efforts: all five the CLI accepts.

- **Preact, not React, and without `preact/compat`.** The whole app is two screens,
  four sheets and a verdict; React's runtime cost 70 kB gzip against Preact's 16 kB,
  all of it also precached onto a phone. `compat` was rejected because it re-adds the
  layer whose size was the reason to switch. Going native costs the three things
  compat papers over: no `StrictMode` (nothing here relies on double-invoked effects),
  no `useSyncExternalStore` (`app.tsx` has an 8-line stand-in — Preact renders
  synchronously, so there is no torn read to guard, only the render-to-effect gap the
  resync closes), and `onChange` means the _native_ change event, so every text input
  and the prompt use `onInput`.
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
- **A gap in the relay socket is held back for 1.5s before it is shown.** The app is
  legitimately not connected for a moment on the way in — a refresh dials from
  scratch, and the resume above re-dials unconditionally — so rendering the status
  as it stands flashed "Relay unreachable" for a frame or two on every refresh and
  every foregrounding. `RelayState.settling` marks that window: the screen reads
  "connecting…" with the pulsing amber dot and no banner, and anything that recovers inside
  it is never reported at all. The window opens only on leaving `open`, so the
  backoff retries after a real outage keep the banner up rather than blinking it.
- **The service worker's update lifecycle is configured explicitly, not inherited
  from `registerType`.** vite-plugin-pwa only derives `skipWaiting`/`clientsClaim`
  from `autoUpdate` when `injectRegister` is left at `"auto"`, and this build sets
  `injectRegister: null` to keep a second inline script hash out of the CSP — so
  `autoUpdate` was inert and a new worker waited behind the old one indefinitely,
  which an installed PWA never reliably releases. Registration lives in
  `src/sw.ts` for two things the injected script cannot do: check for an update on
  resume, because an installed PWA can go days without a navigation, and reload
  only on a visibility change, so a new build lands like a cold launch instead of
  yanking the screen mid-use.
- **Every layer is exactly one history entry, owned by the store.** Sheets, the
  verdict and the Settings screen all push on open and are cleared by
  `popstate`, so Android back dismisses the layer instead of exiting the app.
- **Relay status is a passive dot, settings is the button, and they share one
  pill.** The header control is a segmented pill on the `.seg` track/face idiom:
  a flat left area holding the status dot and a raised cog on the right. The
  whole pill is a single `<button>`, so the 4px padding around a 36px face gives
  a 44px tap target without the old hit-area overlay, and the split makes plain
  that the dot reports and the cog acts. The three states differ by shape as well
  as hue — solid green with a glow, steady amber behind an expanding sonar ring,
  hollow red ring — so the failed state is not carried by colour alone. The ring
  is dropped outright under `prefers-reduced-motion` rather than left to the
  global clamp, which would freeze it at full size over the dot. The settings
  header's own status line renders the same three dots from the same component:
  one state must never read two ways.
- **Settings is one screen, reached straight from the header's relay pill.** It absorbed
  what used to be a bottom-sheet drawer plus a separate Relay & keys screen:
  credentials, connection status and theme in one place. The drawer's
  entry-replacing history special case went with it, and its "Reconnect now" row
  is folded into the screen's single bottom action, which reads "Reconnect"
  while the relay is down, saves-then-reconnects when credentials were edited,
  and otherwise just returns.
- **Stored secrets show as a masked placeholder, and a blank field keeps them.**
  The PSK cannot be read back at all and the bearer is not worth redisplaying,
  but two empty inputs read as "credentials lost" on a working install. So
  Settings is editable without being a re-entry chore, and only a field
  actually typed into is written.
- **A lost spawn reply is reconciled, not guessed.** Backgrounding the app
  mid-spawn loses the reply (a blind relay cannot queue it), so the pending
  spawn is persisted and the machine is asked what is running once there is a
  socket again. Reporting a failure there would be a lie: the session may well
  be live. A refused delivery is reported as a known no, separately.

## Accepted trade-offs

- `/spawn` and the daemon duplicate git/tmux logic — drift risk, owned, and on
  its way out: `seanced spawn` now audits like the relay path, so the slash
  command can become a thin wrapper over it and the duplication disappears.
- Key rotation or a new phone touches 4 devices manually, with spawns failing
  closed in between — no `keyId`, no rollover window.
- Battery-powered Macs show offline when asleep.
- No deep link from spawn verdict into the _specific_ Claude app session — only the
  coarse `claude://code` (session list) link; see Problem & scope.
- A spawn reply lost to a >45s background cannot be recovered exactly, only
  reconciled from the session list. Relay-side buffering of app-bound envelopes
  would fix the short cases, but `ts` lives inside the ciphertext so a blind
  relay cannot re-stamp one; anything flushed beyond `REPLAY_WINDOW_MS` is
  rejected as stale. Deliberately not built — see below.
- A PSK holder has arbitrary code execution on every machine; the spawn audit
  log is local and rewritable, so detection assumes the machine is honest.
- The daemon's own footprint is indistinguishable from a RAT — machines that
  gain an EDR need it allowlisted by hand.
- Relay tracing (`observability.traces`) is **dashboard-only, no OTLP
  destination**. Cloudflare can export traces and correlated logs to Honeycomb,
  Grafana or Sentry, but span attributes carry the request URL and the app
  authenticates with `?t=<bearer>` — a browser cannot set a header on a
  WebSocket — so any export moves the token off Cloudflare, which is exactly the
  cost threat-model item 3 refuses to pay for free. Getting the token out of the
  query string is the prerequisite for wiring a destination later. Note that
  "dashboard-only" is not "not stored": traces persist in Cloudflare's own
  observability store and are queryable there, so this is a second retained copy
  of the `?t=` token alongside the invocation logs `observability.enabled`
  already produces. Item 3 already accepts that exposure to Cloudflare; what is
  refused here is widening it to a third party.
- True distributed tracing across daemon→relay→pwa is not available and was not
  faked. Trace context rides `traceparent` on an HTTP request, but both tiers
  hold one long-lived WebSocket whose only header exchange is the upgrade; every
  frame after it is a separate hibernation-wake invocation with its own trace.
  Cloudflare's external W3C context propagation is unreleased. The relay's own
  traces are still worth having (DO wake latency, storage ops), and `iv`-keyed
  logs cover the cross-tier question they cannot answer.
- The PWA now logs wire metadata to the browser console in production builds —
  op name, `id`/`re`, `iv`, target deviceId, and timeouts. Never payloads or key
  material. Accepted so a phone-only failure, the one case that cannot be
  reproduced at a desk, arrives with its join key already in hand.

## Open design details (build time)

- Optional: relay buffers app-bound envelopes (bounded, TTL ≤ ~45s to stay
  inside the replay window) so a spawn reply survives a short background
  instead of falling through to reconciliation.

Resolved 2026-07-28, at the WSL machine: WSL support — DPAPI PSK store
(threat-model item 2) and the systemd-unit + linger + logon-task lifecycle
(daemon section). Verified on the machine that day: the DPAPI round-trip
through `powershell.exe`, and interop surviving a stripped environment (no
`WSL_INTEROP`, detached session). The post-flip pass ran later the same day
and settled both open claims. Interop from the lingering unit: confirmed —
the daemon under `user@1000` (zero logind sessions registered; WSL shells
never create one) decrypted the DPAPI blob and served an encrypted app
request. Non-elevated `schtasks` registration: answered the other way —
`/Create` through interop fails with `Access is denied`, and `install`
falls back to printing the manual command as designed; registration from a
Windows shell is the supported path. One sequencing discovery from the same
pass: on a fresh box `user@<uid>` does not exist until linger is enabled
(no logind sessions means nothing else starts it), so `loginctl
enable-linger` has to run before the first `install`. The preflight now
tells the two apart via sd_booted's `/run/systemd/system` check and names
the linger fix when system systemd is up.

Resolved 2026-07-27: repo-scan caching/rescan triggers, replay window, and
DO hibernation — decisions recorded in their sections above. Also resolved with
the PWA: `/app` close codes, PSK at rest, session fan-out, and lost-reply
reconciliation.

The threat model is fully built out as of 2026-07-27: spawn audit logging on
both paths with `origin`; keychain-backed PSK on macOS behind `loadPsk()` plus
`seanced psk-import`; PSK fingerprint in `doctor`; tests pinning the two spawn
invariants; registry entry cap, wire-level id and ciphertext bounds, and
per-socket register rate limiting in the DO. The PWA's non-extractable-key and
CSP items landed with the app (see the PWA section).

- Log rotation now has two writers to reconcile — the daemon holds the file
  through launchd's redirect while the CLI opens it by path, so a
  rename-and-recreate would strand the daemon on the old inode. Still no
  rotation in v1; `doctor` warns past ~10 MB.
- The keychain ACL path is unverified from CI: read and write both go through
  `/usr/bin/security`, so the entry recorded on create should be the one
  presented on read, but confirming the launchd agent is never prompted needs
  one real `psk-import` + `restart` on a machine.
