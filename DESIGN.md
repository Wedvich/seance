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
- **Structured payloads only**: daemons accept the `SpawnRequest` fields
  (`shared/src/types.ts` is the schema of record) and build shell commands
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

| Behaviour                                                            | ATT&CK                            |
| -------------------------------------------------------------------- | --------------------------------- |
| launchd agent runs `seanced`                                         | T1543.001 Launch Agent            |
| systemd user unit runs it on Linux/WSL (+ Windows logon task on WSL) | T1543.002, T1053.005 (WSL)        |
| persistent outbound WSS to the relay                                 | T1071.001, T1102.002              |
| AES-256-GCM under a PSK                                              | T1573.001 Symmetric Cryptography  |
| remotely starting an interactive coding agent                        | **T1219.001 IDE Tunneling**       |
| pre-answering claude's trust dialog in its config                    | T1562.001 Disable or Modify Tools |
| `caffeinate -is` per spawn + the AC-power hold                       | T1653 Power Settings              |
| depth-2 `.git` scan of `repoRoots`                                   | T1083                             |
| tmux pane enumeration                                                | T1057                             |
| `git pull` + service kickstart as the update path                    | T1195.001                         |

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
   second secret with nowhere to live — the same circle). Reconsidered for
   plain Linux (2026-07-30, adding LXC-friendly support): the rejections
   transfer — a headless box has the same no-login-ceremony circularity for
   secret-service, and an unprivileged container has no TPM for
   systemd-creds — so a plain Linux box — neither darwin nor WSL — still
   has only the config field. Revised once more (2026-07-30, same day) for
   boxes that do have a TPM: where `/dev/tpmrm0` exists — bare metal, or a
   Proxmox LXC with the device passed through — `systemd-creds encrypt
--with-key=tpm2` seals the PSK at `~/.local/state/seance/psk.cred`,
   behind the same `loadPsk()` and the same `seanced psk-import`. Sealed to
   the TPM alone, deliberately no PCR binding: a PCR-bound blob dies on the
   next firmware update, and the threat here is at-rest exfiltration
   (container backups, ZFS snapshots, stolen disks), not a tampered boot
   chain. Machine-bound by design — a blob restored from backup onto other
   hardware fails closed (daemon reports no psk, doctor names the cause).
   Like DPAPI it does not subtract the user's own session: any process
   running as the user on the same machine can drive the same unseal. Linux
   without a usable TPM keeps only the config field, as decided above.
   Revised again (2026-08-10, verified on hardware — Proxmox VE host,
   unprivileged Debian 13 LXC, systemd 257): systemd ≥ 256 refuses
   unprivileged seal/unseal outright — `systemd-creds` delegates the crypto
   to PID 1 over varlink and system-scope TPM operations are root-only
   (`org.varlink.service.PermissionDenied`), on bare metal as much as in a
   container — and `--user` scope is no way out: it cannot express TPM-only
   keys, and its default key degrades to a host key file inside the rootfs,
   which travels with backups — the very exposure sealing exists to prevent.
   So on modern systemd the key is _delivered_, not unsealed: seanced runs as
   a system unit with `User=` plus `LoadCredentialEncrypted=seance-psk:<blob>`
   (`install --system` writes it; the daemon still never runs as root, and a
   target user that resolves to root is refused), PID 1 unseals at service
   start, and the daemon reads the plaintext from the service-private
   `$CREDENTIALS_DIRECTORY` mount — a `credential` store ahead of every
   platform store in `loadPsk` resolution. The daemon never touches the TPM
   there; the plaintext exists only in that tmpfs and daemon memory, and the
   sealing itself is a one-time root step (docs/psk.md). `install --system`
   verifies a blob is loadable before recording it, decrypting to `/dev/null`
   rather than through a pipe — the installer has no business holding the key
   either.
   Rejected: a sudoers NOPASSWD rule letting the user's processes call
   `systemd-creds decrypt` — it hands the PSK to _anything_ running as the
   user, i.e. to any prompt-injected command on exactly the box built to run
   semi-trusted sessions; at-rest protection with a runtime hole. Direct
   unseal by the daemon remains supported for pre-256 systems. One more
   verified wrinkle: `has-tpm2` reports partial support (non-zero exit)
   inside an LXC guest whose seal path fully works — masked sysfs/ACPI
   firmware info — so the strict probe gates only _import_, and reads never
   consult it.
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
   traffic analysis, both accepted — the accepted kind is a relay that stops
   relaying, not one that reaches into the app. So the app-role client parses
   every relay→app frame — and the rescan reply, the other payload that lands
   on the render path — before handling it, and never half-applies what it
   cannot handle: a half-applied frame used to leave the client throwing on
   every later rebuild, an availability loss that outlived the connection and
   ended only at a reload. Two deliberate softenings keep skew from becoming
   its own availability loss: a registry entry that does not parse is skipped
   and counted (every push carries the full stored registry, so dropping the
   push whole would let one bad entry suppress every machine indefinitely),
   and an `undeliverable` code minted after the build still fails its request
   fast as `refused` instead of riding the timeout. What cannot be read is
   counted as `skewed`, apart from `ignored` (didn't decrypt) — version skew
   must never tell an operator to rotate a correct key. `#infoCache` is
   rebuilt from each push's own IVs for the same reason — keyed by envelope
   iv, it otherwise grows for as long as a peer cares to mint them. One
   unstated dependency: the ±60s window trusts local
   time and NTP is unauthenticated, so an attacker who can skew a daemon's
   clock widens the window.
5. **Supply chain** (T1195.001). `git pull` + `launchctl kickstart -k` is
   unsigned; a compromised repo is RCE on every machine, onto boxes that
   already carry launchd persistence. Bounded by 2FA and branch protection
   rather than an update daemon — proportionate to four machines.
6. **Prompt injection into the spawned agent.** Outside ATT&CK Enterprise;
   v19's AI additions (T1682, T1683) model adversaries _using_ AI, not
   compromising an agent — MITRE ATLAS is the companion frame. Two parts: a PSK
   holder's `prompt` reaches Claude under the machine's configured permission
   mode, and the spawned agent then reads repo content Séance does not control.

**What "structured payloads only" does and does not mean.** It stops wire input
being interpolated into the daemon's own shell construction. It is not a
capability limit: `prompt` is free text handed to a Claude session whose
permission mode is whatever the machine's settings say — `auto` or
`bypassPermissions` on the machines this runs on — so anyone who can form a
valid spawn frame has arbitrary code execution, laundered through the agent.
The PSK is the whole boundary and there is nothing behind it. Recorded here so
the control isn't read as a sandbox.

**Invariants.** All but the last hold in the code today and are requirements,
not observations — they are exactly the kind of thing that drifts silently, and
the audit-log ownership one below did drift, in production, for as long as
nothing checked it. The last is the gap they leave.

- `spawn` resolves `repo` by **name lookup against the cached scan set**
  (`repos.find(r => r.name === request.repo)`). A wire-supplied string is never
  joined onto a path root. `repo_not_found` is a security outcome, not just UX.
- Every external process is invoked as an **argv array** (`exec.ts`). The one
  shell string is the tmux inner command, where every wire-supplied value —
  `title`, `model`, `effort`, worktree name — goes through `shq()`. Nothing
  wire-supplied may be concatenated into a command unquoted. `plan` is the one
  wire field exempt, and only because it is a boolean whose flag value is a
  literal: no wire-supplied text reaches the command line, so there is nothing
  to quote. A future flag carrying wire _text_ is back under the rule.
- Every spawn is **logged at start and outcome** with repo, mode, title, model,
  effort, plan mode when on, prompt length and prompt SHA-256 prefix — never the
  prompt text, which would make `seanced.log` a transcript of everything ever
  asked. With a stolen PSK this log is the only thing that says someone else
  used your machines.
- **Every spawn path audits, through one formatter**, tagged `origin=relay`,
  `origin=cli` or `origin=local`. A trail that covered only the relay would make
  `seanced spawn` the quieter way in — precisely the path someone with local
  shell access would choose — and the tag is what separates "me at my desk at
  2pm" from "my phone was in a drawer at 3am". `local` is the third: the op
  socket below, driven by something on this box that is not the human at the
  keyboard. Adding a surface means adding an origin, never reusing one — an
  indistinguishable path is what makes the invariant stop meaning what it says.
  The origin also rides the per-op `audit request` line, not just the spawn
  lines, because enumeration is the same signal as spawning. The daemon writes
  via stdout (launchd redirects it); the CLI appends to the same file itself,
  and failing to do so warns rather than failing a spawn the human asked for.
  Two independent writers is safe only while nothing rotates the file.
- **The redirect that makes one file of the two writers is also what can break
  the `cli` half**, so the daemon repairs it on every start. Both service
  managers open the log _before_ dropping to the daemon's user — under a systemd
  system unit that is root, so a log the manager has to create lands root-owned
  and every `seanced spawn` then fails its append, warns to stderr and proceeds
  unaudited. That was the production state on a `--system` box: `install`
  chowned the log once, and nothing re-established it after the file was
  replaced. `ensureAuditLog` now creates it 0600 outright and tightens the mode
  on each daemon start and install; ownership it cannot take back, so it names
  the `chown` and keeps serving, and `doctor` checks `W_OK` rather than only the
  size — a broken audit trail must be loud, never a silent gap in the record.
  Repair is in place: never a rename, which would leave the daemon's redirect on
  the old inode.
- **Files at rest are owner-only.** `config.json` and the sealed PSK blobs
  already were; the audit log, `state.json` and `runtime.json` were 0644 by
  umask alone, and they hold repo paths, device ids and window titles (which,
  unlike the prompt, are logged verbatim). All created at 0600 rather than
  written and chmod'd, so no umask-mode window exists. Enforced as explicit
  modes and not as a `UMask=` in the unit, deliberately: the daemon may
  cold-boot the tmux server as its child, and a umask there would follow every
  file a Claude session writes.
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
  decrypt. Re-sent on reconnect and repo rescan; DO overwrites. It also carries
  the daemon checkout's git identity (`source {sha, commitTs, branch}`) and the
  last self-update report (`lastUpdate`), both optional on the wire — older
  blobs lack them. Deliberately not rendered in the app: once updates
  self-propagate, converged is the steady state and a SHA per row is noise.
  `seanced doctor`/`status` print both instead; a PWA warning on a stuck
  (skip/fail) machine is deferred and needs no wire change.
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
  a vanished one is confusing). An entry is overwritten by a later register and
  removed only by an app's `forget` (see below); **there is no TTL** — nothing
  expires a machine you own just because it slept through a holiday.
- Online = WebSocket open. Heartbeats catch silent drops from both ends: a
  missed pong makes the daemon close and redial; a daemon socket that stops
  pinging is swept by the relay's alarm.
- **The app socket heartbeats too**, same 30s ping / 10s pong, answered by the
  same DO auto-response. It is the app leg's only liveness signal: presence is
  pushed, not polled, so a silently dead app socket (network switch, mobile
  doze with the screen on) would otherwise freeze the machine list with no
  symptom until a spawn failed into it. A missed pong re-dials, and the fresh
  socket gets a fresh registry. The relay does not sweep app sockets — nothing
  server-side depends on their liveness.
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

### The map: one spawn, end to end

`shared/src/types.ts` is the schema of record for every frame and payload —
this diagram and the table below are orientation, not a second copy of the
shapes. The prose that follows them holds the decisions.

```mermaid
sequenceDiagram
    participant P as PWA
    participant R as Relay (DO)
    participant D as Daemon

    D->>R: WSS /daemon (Authorization: Bearer)
    D->>R: register { deviceId, info: envelope }
    P->>R: WSS /app?t=token
    R->>P: registry { entries } — again on every change

    Note over P,D: spawn round trip — seal() mints a fresh iv per envelope,<br/>so the two hops never share one
    P->>R: msg { env: seal(spawn, to=deviceId) } + probe "ping"
    alt daemon socket open
        R->>D: msg { env }
        D->>D: open(): AAD + replay check, audit, spawn in tmux
        D->>R: msg { env: seal(verdict, re=id, to="app") }
        R->>P: msg { env } — broadcast to every app socket
        P->>P: match re → verdict; other tabs drop it
    else no open socket
        R->>P: undeliverable { to, iv, code } — iv, because id is inside the ct
    end
```

Who owns each frame in code — the place to change when a frame changes:

| Frame / op                          | Sent from                                         | Handled in                                                                                                      |
| ----------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `register`                          | `daemon/src/relay-client.ts`                      | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`)                                                      |
| `msg` (app→daemon)                  | `shared/src/app-client.ts`                        | routed by `relay/src/hub.ts`; opened in `daemon/src/relay-client.ts`; op dispatched in `daemon/src/handlers.ts` |
| `msg` (daemon→app)                  | `daemon/src/relay-client.ts`                      | broadcast by `relay/src/hub.ts`; correlated on `re` in `shared/src/app-client.ts`                               |
| `msg` (→`"machines"` broadcast)     | any PSK holder                                    | fanned by `relay/src/hub.ts` to registered daemons except the sender; receivers allowlist the op                |
| op `update-available`               | `daemon/src/run.ts` via `broadcast()`             | allowlisted in `daemon/src/relay-client.ts`; pipeline in `daemon/src/update.ts`                                 |
| `registry`                          | `relay/src/hub.ts`                                | `shared/src/app-client.ts`                                                                                      |
| `undeliverable`                     | `relay/src/hub.ts`                                | `shared/src/app-client.ts`                                                                                      |
| `forget`                            | `shared/src/app-client.ts`                        | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`); the registry push it causes is its only ack         |
| `forget-refused`                    | `relay/src/hub.ts`                                | `shared/src/app-client.ts` — logged, never modelled                                                             |
| `"ping"` / `"pong"`                 | both socket legs                                  | DO auto-response — answered without waking `hub.ts`; sweep reads the timestamps                                 |
| envelope `seal`/`open`, AAD, replay | `shared/src/crypto.ts`                            | same file — both ends share it, or nothing decrypts                                                             |
| ops `sessions` / `spawn`            | `pwa/src/store.ts` via `shared/src/app-client.ts` | `daemon/src/handlers.ts` → backend in `daemon/src/backend-default.ts`                                           |
| op `rescan`                         | `pwa/src/store.ts` via `shared/src/app-client.ts` | `daemon/src/handlers.ts` → the scan closure in `daemon/src/run.ts`; never reaches the backend                   |

`sessions` and `spawn` have a second, relay-free sender: `daemon/src/local-client.ts`
over the local op socket, arriving at the same `daemon/src/handlers.ts` routing.
The daemon builds one handler per surface over a single context, so the two differ
only in the audit origin they are tagged with — see "Local op socket".

Layer 1 (plaintext, daemon↔relay): `register { deviceId, info: <envelope> }`
on connect and whenever the repo set changes; `msg { envelope }` for routed
traffic; literal `"ping"`/`"pong"` strings for heartbeats (bare strings, not
JSON, so DO auto-response can answer without waking — daemon pings every 30s,
expects pong within 10s, else closes and redials with 1→60s jittered
exponential backoff, reset on successful register; the relay in turn sweeps
sockets that stop pinging — see Presence & identity). The daemon authenticates
with an `Authorization: Bearer` header.

Layer 1 (plaintext, PWA↔relay): `msg { envelope }` outbound, plus the same
bare `"ping"`/`"pong"` heartbeat as the daemon leg (30s beat, 10s pong
deadline, a miss re-dials — see Presence & identity). Inbound:
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
  attacker can register junk (the PWA ignores non-decrypting entries), read
  registry metadata (machine count, deviceIds, last-seen) and delete entries,
  but cannot spawn or read prompts.
- **`forget` is authorized by the bearer token alone, and that is not a new
  hole.** An earlier revision refused a delete verb on the grounds that it would
  be the one destructive act the token authorizes, with a blind relay unable to
  demand PSK proof. Both halves of that were wrong. A registry entry is derived
  state — the daemon re-registers on its next connect and rebuilds it — so
  deleting a live machine's entry costs a reconnect, and deleting a retired one
  destroys nothing that exists. And the destructive act was already reachable:
  `register` overwrites `device:<id>` for any wire-supplied id, so a token holder
  could always blank a real machine's `info` with a blob that decrypts for
  nobody. What the delete adds over that is honesty, not authority.
  Rotating the token is still the answer to a leaked token; the caps
  (`MAX_DEVICES`, the register rate limit) still bound cost rather than defend.
- **Uninstalling deregisters the machine, and does it as an app-role client.**
  `seanced uninstall` sends the same `forget` on `/app` that the PWA's bin does
  (`daemon/src/deregister.ts`), after the service is stopped and before the links
  are removed — that order matters, because the relay refuses while it still
  holds the socket, so the refusal is retried three times a second apart. It
  waits for the registry push that no longer lists the entry: the push is the
  protocol's only acknowledgement, so nothing else could tell "forgotten" from
  "absent". Rejected: a `deregister` frame on the daemon leg, whose appeal is
  that socket identity would prove the id. The process holding that socket is
  the one being shut down, and the CLI running the uninstall never has it — it
  would have to register in order to delete, or reach the running daemon through
  the local op socket, which is a threat-model change (`Conventions`) buying an
  authorization the bearer token already grants on `/app`. No PSK is read either:
  the entry is routing metadata, and under a service-delivered key there is
  nothing to read from a CLI. Never fatal — an unreachable relay or a config
  already cleared prints a note and the uninstall still succeeds. The `--system`
  variant deliberately does not do this: as root the relay URL and token belong to
  the target user's config, and nothing under `--system` may read the ambient
  environment for a value that answers for the wrong user, so it prints the note
  and leaves the row to the app.
- **The one check a blind relay can make is connectedness, so that is the only
  refusal.** `forget` on a machine with an open daemon socket is answered
  `forget-refused` and changes nothing — it would come straight back and read as
  a broken button — while an id the registry never held is not a refusal at all
  but the state the caller asked for (and pushes no registry, so a flood of them
  costs one read each). A machine whose socket is dead but not yet swept is
  briefly unforgettable; the sweep bounds that at three missed heartbeats, which
  is why the app leaves the refusal to resolve itself rather than modelling it.
- **App-bound envelopes broadcast to every open app socket** (phone and
  laptop tabs both address `"app"`). Stateless — just `getWebSockets("app")` —
  and clients already correlate on `re`, so another tab's reply matches no
  pending request and is dropped silently. Rejected: newest-socket-wins
  (opening the PWA on the laptop kills the phone), per-session `app:<rand>`
  ids (two identities in play, since the register blob is sealed to the bare
  constant before any client exists).
- **`MACHINES_ID = "machines"` is the daemon-side group address**, the mirror
  of `"app"`: the relay fans an envelope addressed to it to every _registered_
  daemon socket except the sender. One seal reaches all machines — the AAD
  binds `to`, so a group needs one shared address; per-recipient seals would
  also require the sender to know the registry, which daemons never see.
  Fire-and-forget: no `undeliverable` (nothing correlates a broadcast — offline
  machines converge from their own register-time self-check), and no
  echo-to-sender (every announce would be a self-nudge). `register` refuses
  both reserved ids, so no machine can squat the group address. Receivers
  allowlist which ops may arrive group-addressed — `spawn` to `"machines"`
  must stay structurally impossible, not merely unused, because the group
  address is an amplification primitive a bearer-token holder can drive
  (non-decrypting frames drop at each daemon; the cost stays bounded).
  Rejected: client-side fan-out for daemon-origin messages (daemons don't see
  the registry), relay-stored "latest" blob pushed on connect (new relay
  state plus a second at-rest replay exemption, for convergence the startup
  self-check already provides).
- **`undeliverable` correlates by `iv`**, not by request `id` — the `id` is
  inside the ciphertext, so a blind relay has nothing else to echo. The PWA
  also refuses to send when `connected === false`; the frame exists for the
  stale-presence race, where the alternative is a 90s spinner that ends in
  "timed out" when the truth was "that Mac is asleep".
- **Delivery outcomes outrank the `connected` flag.** The PWA marks a machine
  proven-offline on an `undeliverable offline` refusal _and_ on a request
  timeout (a dead-but-unswept daemon socket swallows the request without a
  refusal — the sweep's residual window). A timeout blames the machine only
  with positive uplink evidence: same socket as the send, and at least one
  frame received since it. Each request sends a probe `"ping"` alongside the
  envelope, so a healthy socket produces that evidence within an RTT while a
  dead one produces nothing. A silently dead app socket looks
  exactly like a silent machine from the timer's side, and blaming on that
  guess would paint every polled machine asleep at once — with nothing left to
  clear the marks, since a connected daemon's `lastSeen` never advances and the
  clearing replies were lost with the socket. The mark clears on a later
  register — or on any message from that device that decrypts (`from` is
  AAD-bound, so decryption alone authenticates the sender). The clear is
  deliberately ahead of the replay guard: a phone off NTP rejects every reply
  as replay, and gating the clear on the guard would turn "every request times
  out" into "every machine sticks asleep". A replayed frame can at worst fake
  presence for a moment; the next failed delivery re-marks it. The store's
  wake-driven session refresh keys on `lastSeen`, not the `connected` flag, so
  a mark clearing is not a "wake" — otherwise a machine answering slower than
  its op timeout enters a permanent mark → clear → re-poll flap loop.
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
  so it is not a message identity there — the one registry line, a blob that
  opened but was not shaped like a `MachineInfo`, names its sender instead.
  Payloads are never logged, on any tier.
- **`OP_TIMEOUT_MS`** lives in `shared/` (sessions 10s, rescan 15s, spawn
  90s) because the right values derive from daemon internals — `exec.ts`'s 60s
  command timeout plus `spawn.ts`'s 3s pane-death check — and would silently
  drift if kept in PWA code. It is a backstop; the daemon returns a structured
  error on its own.

Layer 2 (end-to-end encrypted ops, PWA→daemon request/response):

- `sessions {}` → running claude tmux windows. The one live pull — session
  state is inherently fresh-only.
- `spawn { repo, prompt?, title?, mode: "worktree"|"here", model?, effort?, plan?, client? }`
  → `{ ok, window, path, sessions }` or `{ ok: false, code, message }`. The
  verdict embeds a refreshed session list so the PWA updates without a
  second round trip. That list is polled (2s cap) until it holds the window
  just announced: detection keys off claude's process title, which it can set
  after the spawn returns, and the PWA adopts this list verbatim — an ack
  short by its own window renders the machine as idle.
- `update-available { sha, commitTs }` → no reply — the one broadcast op,
  sealed to `"machines"` (see the group-address bullet above), sent once per
  process when a daemon starts on a sha different from its last run. Advisory
  only: receivers verify against their own origin, so the payload authenticates
  nothing and needs to. The daemon's transport allowlists it — any other op
  arriving group-addressed is dropped before dispatch.
- `rescan {}` → `{ repos, scannedAt }`; daemon re-registers if the set changed.
  The app folds the reply into the machine it came from, overriding that
  machine's register blob until a later one carries the scan: an unchanged set
  produces no register, so the reply is the only report the scan ever gets.

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
- **The recorded bun is PATH's, never `process.execPath`** (`resolvedBun()` in
  `link.ts`, used by the plist, the unit, and the MCP registration). execPath is
  the realpath'd binary — on Homebrew a versioned keg — and `brew upgrade bun`
  deletes it, leaving every definition that recorded it pointing at nothing.
  macOS cannot recover from that on its own: `launchd.selfRestart()` exits rather
  than rewriting, because launchd caches job definitions and a rewrite wouldn't
  land until the next bootstrap, so only `seanced install` ever repoints the
  plist. The systemd unit does get rewritten on self-restart, but from the
  pre-update process still serving old code, so a definition change lands one
  update later. `doctor` reports drift (recorded path gone → fail; alive but no
  longer what PATH resolves → warn) precisely because nothing else notices.
  Rejected: `process.execPath` (what this originally did — precise about the
  running binary, and wrong about the next one).
- **`install` is re-runnable against a live agent.** Repointing a loaded agent is
  the normal reason to run it, and `launchctl bootout` returns before launchd has
  finished the teardown — bootstrapping into that window fails with EIO (5) and
  leaves the agent _unloaded_, a worse state than before the command. So a pass is
  bootout → poll until the job is gone (5s cap) → bootstrap, and a failed pass
  gets exactly one retry. Rejected: reporting the error and letting the user
  re-run (observed behavior was a half-installed machine with no daemon at all).
- **CLI**: `seanced` (run in foreground; launchd/systemd supervises), `init`
  (write config skeleton + deviceId), `install`/`uninstall` (launchd plist on
  macOS; systemd unit + linger on Linux, plus a Windows logon task on WSL),
  `link`/`unlink` (opt-in `seanced` name on PATH — a plain symlink to
  `main.ts`, which is executable with a bun shebang, so it tracks the checkout
  with nothing to re-run; `uninstall` also unlinks, so a torn-down machine
  never keeps a name into a deleted checkout. Rejected: `bun link` — its
  global registry is per-name indirection a second clone silently steals; a
  wrapper script — its realpath doesn't lead back to `main.ts`, blinding
  doctor's stale-clone detection),
  `doctor` (preflight: tmux/claude/git/roots/relay/config, plus whether the
  `seanced` name resolves to this checkout), `status`,
  `scan`, and `spawn <repo>` — the last runs the spawn path locally with no
  relay, the SSH-debuggability hook.
- **Config split**: `~/.config/seance/config.json` (hand-edited, 0600,
  never rewritten by the daemon: relayUrl — which must include the `/daemon`
  path, so `doctor` warns when it doesn't; the failure mode is a rejected
  upgrade and a silent backoff loop — bearerToken, psk, name,
  repoRoots, tmuxSession, machineTag) and `~/.local/state/seance/state.json`
  (daemon-owned: deviceId, repo cache, scannedAt). Rejected: single file
  the daemon writes back (clobbers hand edits). PSK-in-OS-keychain was
  rejected here as having no clean WSL counterpart; both halves of that are
  now revised — each platform has a store (login keychain / DPAPI blob in
  the state dir / TPM-sealed systemd-creds blob, plus the credential a
  service manager delivers, which is read ahead of all three) as the
  fallback behind `loadPsk()`, with a non-empty config field still winning,
  so `psk-import` never rewrites config.json and a TPM-less Linux box keeps
  the file path. See threat-model item 2.
- **Config hot reload** (added 2026-07-30): the daemon _watches_ config.json and
  reloads on change — still never writes it, so the invariant above is intact.
  Two cases motivated it: editing config on a machine you are only reachable on
  through the app, and letting a Claude Code session on the box adjust it; both
  otherwise need a shell to run `seanced restart`. Reload rebuilds the whole
  `startDaemon` handle (key import, backend, relay client) rather than diffing
  fields into the live objects — every field is read exactly once, at start, and
  a full swap keeps it that way; the cost is one reconnect, which a changed
  relayUrl/bearerToken/psk forces regardless. tmux sessions live outside the
  process, so nothing spawned is disturbed. The new config is validated
  (`loadConfig` + `loadPsk` + `runnableProblems`) _before_ the running daemon is
  stopped: a broken hand edit logs and is ignored, because a typo must not take
  the machine offline until someone notices. Watching is directory-level and
  unfiltered — Bun's `fs.watch` reports an atomic replace under the temp file's
  name on both macOS and Linux, so filename filtering would miss exactly the
  write pattern editors use; a deep-equal against the running config absorbs
  the extra wakeups and keeps identical rewrites from churning the connection —
  except while nothing is running, when the guard yields, because reverting a
  bad edit rewrites bytes the supervisor already holds and that is precisely
  the edit that has to be allowed to restart. Validation only covers what a
  config can be blamed for; `startDaemon` can still throw on something else (an
  unreadable state dir), so a failed swap rolls back onto the old config and
  the key it had already imported, rather than re-reading a store that may be
  half-rotated. If the rollback fails too the daemon is down, and every later
  save is a fresh attempt to come back — the swap's outcome is what decides
  whether "reloaded as …" is logged at all, since a rollback readopts a config
  that was already running. The watcher re-arms itself: the runtime closes it
  after an `error` event, so an inotify limit or a wholesale directory replace
  would otherwise end hot reload for the life of the process while the README
  promises the opposite. Restarting `startDaemon` in-process is also what makes
  state.json's write atomic (tmp + rename) load-bearing — the outgoing daemon's
  background rescan can be writing while the incoming one reads, and a torn
  read is indistinguishable from corruption, which mints a new deviceId and
  re-registers the machine as a stranger. runtime.json stays an in-place write:
  it is fixed-size and cannot tear. One accepted gap, found 2026-07-31 while
  chasing a flaky test: macOS brings an `fs.watch` FSEvents stream up
  asynchronously, so an edit landing in the window between `watch()` returning
  and the stream going live is dropped outright — never delivered, so no
  amount of waiting recovers it. Measured at ~20% when the write follows
  arming immediately on a saturated machine, 0% otherwise. Untouched because
  the daemon arms its watch at startup and real edits arrive minutes or hours
  later; the exposure is an edit within milliseconds of `seanced restart`, and
  the next save is picked up normally. Tests do write that fast: the two that
  are about the watcher itself wait for the stream (`awaitWatcherLive` in
  `daemon/test/fixtures.ts`), and the rest substitute `SuperviseOpts.watch`
  with a trigger they fire directly, so nothing about _reacting_ to a config
  change depends on FSEvents at all. Rejected:
  re-exec or `systemctl restart` on change (loses the keep-running-on-a-bad-edit
  property and burns the supervisor's restart budget), and per-field reload
  (four call sites to keep in sync with every future config field).
- **Lifecycle**: launchd agent on macOS; **systemd user unit + linger** on
  Linux. WSL (resolved 2026-07-28 at the actual machine) adds **a Windows
  logon task**; plain Linux (resolved 2026-07-30) is the same unit + linger
  with the WSL pieces gated behind `isWsl()` — no pin-task counterpart
  because nothing idles an LXC container or server out, linger alone covers
  reboots. Linux without systemd stays a manual supervisor with a clear
  error — a service-manager abstraction for init systems nobody here runs
  isn't worth carrying. Revised 2026-07-31, and only in the narrow sense:
  there is still no third init system and no plugin seam, but launchd.ts and
  systemd.ts had drifted into different return shapes for the same actions
  (`Promise<string>` vs `InstallResult`, `Promise<void>` vs the notes list),
  which `service.ts` paid for by adapting at two call sites. Both now satisfy
  one `ServiceManager` type and the dispatcher picks a module per platform
  instead of branching per action. The type is a drift guard, not an
  extension point — adding a platform is still a module plus a line in
  `manager()`.
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
- **Session backend seam** (`backend.ts`): the daemon splits at one interface —
  `SessionBackend` = `spawn(request, repos)` / `sessions(repos)` / `doctor()`,
  failures as `SpawnFailure` carrying a wire code — so a fork that starts
  sessions some other way keeps the relay, the PWA and the whole daemon
  frontend (relay client, handlers, run, cli, config/state/scan/audit) as
  upstream and rewrites one factory: `createBackend(config)` in
  `backend-default.ts`, the only reader of `config.tmuxSession` and of the
  pane-death budget, and the only mention of tmux above
  `spawn.ts`/`sessions.ts`. Two things sit above the seam on purpose. The
  audit: handlers and the CLI wrap every backend call in the one formatter, so
  a swapped backend cannot make a spawn quiet. `HandlerContext` carries an
  `AuditSink` — the transport, so a test can read the trail without patching
  stdout — but never the `SpawnAudit` itself: the formatter and the
  `origin=relay` tag are applied inside `handlers.ts`, where nothing a caller
  supplies can drop a line or relabel it as the human at the keyboard. And
  repo resolution: the
  frontend hands over the cached scan set, never a path, and the contract is
  that the wire string is only ever matched against it by name. A backend's
  internal names and free-text messages may be tmux-specific — its `doctor()`
  owns the tmux/claude binary checks and the server probe, while `git` stays in
  core `doctor` because it belongs to scanning — but wire codes may not, which
  is why `tmux_error` became `launch_error`. Rejected: injecting `spawnSession`
  itself (three tmux details were already leaking through
  `HandlerContext`/`RunOpts` — session group, pane-death budget, doctor's tmux
  checks), and leaving `SpawnFailure`/`SpawnOutcome` in `spawn.ts`, the one
  file such a fork deletes.
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
- **Session name vs window name** (added 2026-08-21): the name passed to
  `claude -n` and the tmux window name are computed separately. The window
  keeps the request's title verbatim; the session name is the worktree slug
  plus an optional ` (<machineTag>)` suffix, because the Claude UIs (web,
  desktop, mobile) list sessions from every machine in one place and
  otherwise give no clue which box a session is on. Suffix, not prefix: those
  lists are recency-ordered, so a leading tag buys no grouping and only costs
  the left edge you scan for the task. Parenthesised, not `@` (which this was
  until 2026-08-30): Claude Code's cross-session addressing parses `@` in a
  `SendMessage` target as team-qualifier syntax, so an `@` in the session
  name makes the session unaddressable by its peers — and such a session is
  assigned no `[ref]`, so there is no fallback address either. Verified
  empirically across eight live sessions: `@` anywhere in the name fails in
  both directions (a reply cannot use the `from-name` it arrives under),
  while spaces, dots, slashes and parens all round-trip. Brackets round-trip
  too but collide with the `name [ref]` disambiguator and are rejected on
  legibility. The name is only ever an argv value through `shq()`, so the
  spaces and parens cost nothing. Locally the window name stays bare — the
  machine is obvious from the statusline. `machineTag` is never inferred from
  `name`: that field is a display string ("Martin's MacBook Pro") and seeds
  from `hostname()`, so inferring would suffix every existing install with
  something long and ugly on upgrade. Absent means no suffix — though the
  base name still changes for every install on upgrade: pre-2026-08-21 the
  session name was the request title near-verbatim, now it is the slug.
  Rejected: a `{slug} ({machine})`
  template in config (a templating language for a decision made once, and
  machines drift out of sync), and a client-supplied tag on `SpawnRequest`
  (the tag stops identifying the host, which is its whole purpose).
- **Spawn logic is reimplemented natively** in the daemon (structured
  errors, no shell-script templating). The `/spawn` slash command stays
  as-is for in-terminal use; drift between the two implementations is an
  accepted risk. Port the accumulated wisdom from `/spawn`
  (`~/.claude/commands/spawn.md`): worktree/window naming
  (prompt slug; see the naming note below), seed-prompt preamble (worktree setup instructions),
  `--remote-control` always — kept off the argv tail with the seed prompt
  behind a `--` terminator, because the flag takes an _optional_ value and,
  adjacent, it swallows the prompt as the session's name while the session
  starts idle — **opus**/medium defaults (revised from
  sonnet), per-spawn `caffeinate -is`
  unconditionally (a session you asked for stays awake even on battery),
  and the pane-death verification (remain-on-exit, then poll `pane_dead`
  up to a 3s deadline — tmux returning 0 does not mean claude started;
  polling reports a death the moment it happens instead of after the full
  wait, and a window that vanished mid-check counts as a death that beat
  remain-on-exit, not a success). `--here` mode
  spawns at the repo root (no remote "current directory" exists).
  Failures return structured codes (`repo_not_found`, `launch_error`,
  `claude_died` + captured pane output, `internal_error`) plus a non-fatal
  `note` field. `fetch_failed`, `no_default_branch` and `timeout` are still
  wire codes and still rendered by the clients — no path reaches them since
  the bullet below deleted the git preparation, but a daemon a version behind
  emits them and must not degrade to the unknown-code fallback. The `note`
  field has one emitter again — the stuck-spawn detection below — and stays a
  documented `SessionBackend` fork seam besides.
- **Worktree mode does no git preparation** (revised 2026-08-31). This ran a
  fetch and then `git merge --ff-only origin/<default>` in the main checkout,
  ported from `/spawn` on the belief that `claude --worktree` branches off the
  checkout's HEAD. That belief is wrong, and reading Claude Code 2.1.252
  settles it: `worktree.baseRef` is documented as _"Which ref new worktrees
  branch from. 'fresh' (default) branches from origin/&lt;default-branch&gt; for a
  clean tree"_, and the creation path resolves `origin/<default>`, fetches,
  and runs `git worktree add --no-track -B <branch> <path> origin/<default>`.
  So the ff never moved the base — only the machine owner's HEAD, as a side
  effect of a spawn from someone's phone — and the two `note`s it emitted when
  the checkout was dirty or on another branch ("worktree bases on current
  HEAD") told the phone something that was never true. All of it is deleted;
  `--worktree` is passed and claude does the rest. Three costs accepted with
  eyes open. Claude re-fetches only when `FETCH_HEAD` is over 24h old, so a
  spawn can sit on an origin up to a day stale (the daemon's own fetch used to
  close that window incidentally). A machine that sets `baseRef: "head"` opts
  itself out with no CLI flag to override it — the machine owner's call to
  make. And the failure modes go quiet: an unreachable origin or a clone with
  no `origin/HEAD` used to reach the phone as `fetch_failed` /
  `no_default_branch` before anything launched, where claude warns in the pane
  and bases the worktree on the local HEAD, so the spawn reports `ok` and the
  session is quietly on the checkout's commit. Not a hang, at least: claude's
  fetch runs `stdin: "ignore"` with `GIT_TERMINAL_PROMPT=0`,
  `credential.interactive=false` and a 5s timeout, so a repo needing
  credentials fails fast rather than blocking the pane on a prompt. Rejected: creating the worktree in the daemon to name
  the base explicitly (implemented, then reverted — it moves worktree removal
  on failure and a second trust entry per spawn onto the daemon, to buy
  behaviour claude already has); keeping the fetch for freshness alone (a
  second fetch on every spawn to narrow a 24h window claude manages itself).
- **No `--permission-mode` flag by default** (revised from `/spawn`'s `auto`).
  Passing one unconditionally would override the machine's own `settings.json`
  default, so a box configured for `bypassPermissions` still got prompted for
  the things `auto` withholds. Omitting it makes a spawned session behave like
  an in-terminal `claude` on that machine. It is not a tightening: the effective
  mode is now ambient, and on a machine left at the plain `default` mode a spawn
  will sit on permission prompts until answered from the phone.
- **`plan` is the one opt-in exception** (added 2026-08-29). The bullet above
  rejects a _default_ mode flag, not a caller-chosen one: `SpawnRequest.plan`
  is an optional boolean that, when true, emits `--permission-mode plan` and
  nothing else changes. Absent or false, the command string is byte-identical
  to what every client sent before, so the ambient default stands. It exists
  for the MCP tool, where the calling model can read "plan the implementation
  of X" out of a request and set it — a surface with no human picking flags is
  exactly where the intent is legible and a picker is not. Deliberately binary:
  the other five modes either loosen what the machine chose (`bypassPermissions`,
  `acceptEdits`, `auto`, `dontAsk`) or are the ambient default already
  (`manual`), and a remote loosening the machine's own setting is the thing the
  bullet above refuses. Plan only ever constrains. Not exposed in the PWA or
  Raycast — a human at a picker can say "plan this" in the prompt — and
  `seanced spawn` does not take it either; the field is on the wire, so adding
  either later is a client change with no protocol change. Old daemons ignore
  it, exactly as they ignore `client`.
- **Pre-trust on spawn**: Claude Code blocks startup on a per-directory trust
  dialog (`projects[<path>].hasTrustDialogAccepted` in `~/.claude.json`, or
  under `$CLAUDE_CONFIG_DIR` when set — the daemon mirrors claude's own
  lookup) that no remote can answer, so an untrusted repo spawned from the
  phone reports success and sits dead at the prompt. Both spawn paths answer
  it up front (`trust.ts`): read claude's config, set the flag for the repo
  root when missing, write back atomically (tmp + rename, mode preserved).
  The dialog guards less than spawning already grants — a PSK holder starts
  claude in the repo under the machine's permission mode — so pre-answering it
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
  runs only in the self-update path when unresolved (it ran in the spawn path
  too until worktree mode stopped resolving the branch at all). Rejected: explicit repo list
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
- **A spawn that starts but never registers is reported, not swallowed**
  (added 2026-09-04). The two liveness notions disagree in exactly one case: pane
  verification asks `pane_dead`, so a claude blocked on a startup dialog no
  remote can answer is "alive" and the spawn acks `ok`, while session detection
  keys off the version-string retitle, which such a claude has not reached. The
  phone got a success and an empty machine. `handleSpawn` already polled for the
  window and already knew it never arrived (`ACK_SETTLE_MS`); the ack now carries
  `pending: true` plus a `note` holding the pane's visible screen, so the dialog
  itself is readable from the phone — the screen (`SessionBackend.capture`) rides
  the wire only, because the seed prompt renders in that pane and prompt text is
  never logged. `pending` is a separate flag rather than a note the clients
  pattern-match, because it changes what each surface *says*: the PWA verdict
  drops "It's running on X" for "it started, but it's stuck", muted rather than
  green and offering the form back instead of "Start another" (a retry meets the
  same dialog and leaves two stuck windows); Raycast switches the toast to the
  attention style; `seanced mcp` appends "(started, not registered yet)".
  Optional on the wire, so a daemon a version behind omits it and its acks read
  exactly as they did before. The window id reaches the frontend as `SpawnOutcome.handle`, a
  backend-scoped token the response is assembled field by field to exclude.
  Steady state gets the same check in `doctor`, warning on alive-but-untitled
  windows séance started, identified by
  `#{m:*--remote-control*,#{pane_start_command}}` — no daemon state, and the
  match collapses to `0`/`1` inside tmux so wire-supplied values (model, effort)
  in that command line never reach the format output. A tmux too old for `m:`
  renders the format literally, matches nothing, and the check reports nothing.
  Rejected: a tmux user option as the marker (`#{@seance}` resolution across the
  pane/window/session hierarchy is version-dependent, and it is state to set and
  lose); walking `pane_pid`'s process tree with `ps` (precise, but
  platform-specific parsing for what a format string already answers);
  pre-answering more dialogs — `trust.ts` does that for the one gate whose config
  key is known, and detection is what covers the ones that aren't.
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

## Self-update (added 2026-08-02)

Update one machine by hand (`git pull` + restart) and the rest follow. The
restarted daemon sees its sha changed since the last run (`state.lastRunSha`)
and broadcasts `update-available` to `"machines"` once per process; every
other daemon runs the same pipeline it would run anyway. Rejected: polling
(the announce makes it redundant), app/CLI-triggered waves (a human step the
sha comparison already eliminates), relay-buffered or relay-stored "latest"
blobs (see the wire-protocol bullet — the startup convergence below makes
relay state unnecessary).

- **Origin is the arbiter.** The announce carries a sha but receivers never
  trust it: they `git fetch` and `merge --ff-only` against their own upstream.
  A forged or replayed announce — even from a full PSK holder — buys one extra
  fetch, which is why the broadcast path needs no authenticity story beyond
  the envelope it already rides in.
- **The pipeline refuses anything that isn't a clean fast-forward** of the
  default branch: dirty tree, other branch, local commits origin lacks — each
  a distinct `skipped_*` outcome, reported and never forced. A checkout being
  hacked on is someone's work in progress; the dev machine will skip every
  wave by design and says so. After the ff: `bun install --frozen-lockfile`,
  then restart. An install failure keeps the daemon running (memory still
  holds the old code) and deliberately does not rewind HEAD — a rollback would
  fight whoever fixes the checkout by hand.
- **The self-check runs on every register, not just boot** — hooked into
  `onConnect`. A macOS daemon survives sleep (launchd doesn't restart on
  wake), so a boot-only check would miss the lid-close/wake case entirely;
  any sleep past the relay's 90s sweep forces a redial, and the fresh register
  is the moment a woken machine can learn what it missed. Offline machines
  converge the same way — the broadcast is only a nudge. Checks are
  single-flight with one coalesced trailing run (an announce landing mid-check
  is the wave case, not noise). **Only `register` checks are debounced** (30s),
  because only they repeat on their own; debouncing announces would drop them
  silently, and nothing re-fires an announce, so the machine that missed one
  would sit stale until an unrelated later wave. The announce itself is marked
  spent only once it is on the wire — a socket that drops during the seal must
  not burn the single announce a process makes. Accepted gap: an announce
  landing during a sleep shorter than the sweep window (~60–90s, socket
  survives but the buffered frame goes stale past the replay window) is lost
  until the next real reconnect or restart.
- **A run that outlives its daemon reports nothing.** The config-reload
  supervisor swaps the whole handle, so `stop()` marks the updater stopped: a
  pipeline still mid-git finishes (interrupting git is worse) but its report is
  dropped, because the outgoing instance's captured state is stale and writing
  it would clobber what the incoming one already saved.
- **Restart is platform-owned** (`selfRestart` on the `ServiceManager`).
  macOS: exit clean, KeepAlive relaunches — launchd caches job definitions,
  so rewriting the plist would be inert until the next bootstrap. Linux:
  rewrite the unit (so definition drift ships with the code that needs it),
  `daemon-reload`, `restart --no-block`. The unit carries
  **`KillMode=process`**, without which the default control-group kill takes
  down a daemon-cold-booted tmux server and every Claude session in it — the
  one migration that must land before the first automated restart; the first
  rollout wave is still a manual restart under the old unit. Both systemd
  steps check their exit codes and a failure is reported as `restart_failed`:
  the `ok` is already persisted by then, so a silent failure would leave the
  machine serving old code while every later check reads `current` — stranded
  and claiming success. Self-update is enabled only when the supervisor
  actually started this process (`INVOCATION_ID` under systemd,
  `XPC_SERVICE_NAME` under launchd); a manual foreground `seanced` would
  otherwise exit with nothing to relaunch it, or bounce the service while the
  terminal keeps serving old code.
- **Reporting rides the register blob** (`source`, `lastUpdate` —
  `Presence & identity`), `current` excluded: the steady state would rewrite
  state.json and push a registry frame on every reconnect for information
  nobody reads. No PWA rendering by decision; `seanced doctor`/`status` are
  the visibility surface.
- **Rollback is deferred** (the bootstrap paradox: rollback logic would ship
  inside the very version that is broken; a stable shim is v2 if ever). A
  machine bricked by an update shows offline in the app with its last-known
  sha in the registry blob.
- **Threat-model fit**: the PSK already grants code execution via spawn, and
  `git pull`-as-update is already accepted (T1195.001) — the broadcast adds a
  trigger, not a capability, though it does turn "compromise the repo" into
  "compromise every machine within seconds of the first restart" where it
  used to take a manual pull per machine. A bearer-token holder can make the
  relay fan junk to every daemon; non-decrypting frames drop on arrival, and
  the register rate limit's reasoning covers the cost. Group-addressed
  `spawn` is refused at the daemon's transport, keeping "one seal spawns
  everywhere" structurally impossible.

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

V1 surface: machine list (online/offline + last-seen, offline ones removable), per-machine repo
picker, spawn form (prompt optional, worktree/`--here` toggle, model and
effort as first-class tiles, defaults opus/medium), spawn verdict (daemon
relays tmux window name or the captured error), and per-machine counts of running
claude sessions (header total + footer line, enough to avoid spawning duplicates —
a full session list was cut: sessions live in the Claude app).
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
- **The repo selection is remembered per machine, not globally.** Each machine has
  its own repo set and its own habitual project, so one shared "last repo" was
  wrong on every machine but the one just used. `PersistedForm.repos` maps deviceId
  to repo name and is the only place the selection lives — a single global `repo`
  field alongside it could only drift. An unknown or deleted repo still falls back
  to the machine's first, so a stale map degrades rather than blocks.
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
- **An offline machine is forgotten at the relay, not hidden in the browser.**
  A machine retired, renamed or reinstalled would otherwise sit in the picker
  forever with a stale last-seen. The bin on an offline row sends `forget`, the
  relay deletes the entry, and the registry push that follows removes it for
  every open app — a phone and a laptop tab agree, which the per-browser hide
  this replaced never could. It comes back only if that daemon registers again,
  which a retired machine never does and a merely-sleeping one does within a
  beat of waking. No confirm step: the row is offline, the act costs a reconnect
  at worst, and clearing several retired machines in a row is the normal case.
  Connected rows get no bin — the relay would refuse it (`Threat model`).
  The store drops that machine's remembered repo, its session list and the
  selection if it was the one selected: unlike a hide, nothing brings that
  deviceId back. It drops them when the registry push says the entry is gone,
  not when the bin is tapped, and in that same patch — so a `forget` the relay
  refuses or one that never left a closed socket leaves the app exactly as it
  was, and no render ever shows a machine gone while the selection still names
  it. Pruning keys off an authoritative registry only (`registrySettled`);
  while it is unsettled an empty list means "no push yet".
  Rejected: hiding, which is what shipped first. It kept `#hidden` in
  `RelayClient` and a `seance:hidden` key in localStorage, said "not this one,
  for now" where the user meant "this machine is gone", and left the relay's
  registry filling up with entries only a manual purge could reach. The key is
  now cleared on start (`dropLegacyHidden`) so no stale list outlives the change.
- **A lost spawn reply is reconciled, not guessed.** Backgrounding the app
  mid-spawn loses the reply (a blind relay cannot queue it), so the pending
  spawn is persisted and the machine is asked what is running once there is a
  socket again. Reporting a failure there would be a lie: the session may well
  be live. A refused delivery is reported as a known no, separately.
- **A `repo_not_found` retry rescans first.** The verdict's "Rescan and try again"
  awaits a rescan and checks the reply for the repo before spawning again; a repo
  the fresh scan still lacks is reported as conclusively gone (back to the form)
  instead of looping. That wait says "Rescanning…", not "Starting…" — nothing has
  reached the daemon yet — and a rescan that never lands is reported as such
  rather than spawned through: the daemon would resolve the repo against the very
  cache the rescan failed to refresh, so the second failure is known in advance.
  The repo sheet's own rescan row shows scanning/failure inline and keeps the
  sheet open, rather than closing silently; its failure note clears when that
  sheet closes, so one landing while another layer is up is not reset unseen.
- **The success verdict offers "Reuse this prompt", not "Open in Claude".** The
  `claude://code` link opened only the session list, and the Claude app already
  notifies when a remote-control session starts — while spawning the same prompt
  on a second machine meant retyping it. The spawned prompt rides the ok verdict;
  the form itself is still cleared on success, so a reload cannot resurrect a
  draft already acted on.
- **Clearing the prompt is undoable, not confirmed.** CLEAR shows in the prompt
  header only once there is something to clear — an always-present greyed control
  is noise — and empties the field on the first tap. It is replaced in the same
  slot by UNDO for six seconds, which is cheaper than a dialog on an action that
  costs nothing to take back. The stashed text lives in `AppState.promptUndo`,
  outside the persisted form: a draft you discarded should not come back on
  reload, and anything that writes the prompt (typing, a spawn, "Start another",
  "Reuse this prompt") drops the offer, because the stash would no longer be what
  the field lost. CLEAR also blurs the textarea — an empty field is nothing to
  type into, and on a phone the keyboard should go with the text — while UNDO
  focuses it again, caret at the end, so the draft can be picked back up.

## MCP server (`seanced mcp`) — designed 2026-08-03

A local Claude Code session gets Séance's reach: an MCP stdio server that acts
as a **third app-role client** — to the relay it is a PWA tab. It dials
`/app?t=<token>`, seals ops with the PSK as `from="app"`, correlates on `re`,
and receives registry pushes. Zero relay/DO changes; every channel property
(AAD binding, replay window, IV dedup, app-socket fan-out) applies unchanged.

- **Ships inside the daemon** as `seanced mcp`, not a separate package: it
  rides the existing self-update path and its Claude config entry is just the
  `seanced` binary. Rejected: a new workspace package (a second thing to
  install and update per machine), a standalone bin over a shared library
  (same, plus packaging).
- **Credentials come from the daemon's own config** via `loadConfig()` +
  `loadPsk()` — relay URL, bearer token, and the PSK including the
  keychain/DPAPI/TPM stores. No new at-rest copy of the PSK anywhere; the cost
  is that the MCP server requires a machine that carries a daemon config,
  accepted because it is colocated by design. The key is imported
  non-extractable, same as the PWA. One machine class is excluded by this: where
  the key exists only as a credential systemd delivers to the daemon's unit,
  `seanced mcp` — launched by Claude Code, outside that unit — resolves nothing
  and cannot run. Deliberate; see the open item below and docs/psk.md.
- **App-role transport is `shared/src/app-client.ts`** — the `RelayClient`
  extracted verbatim from `pwa/src/relay/` (it was already runtime-agnostic;
  e2e had been importing it from `pwa/` under Bun, a wrong-direction edge this
  removes). pwa, e2e and the MCP server consume one implementation. Rejected:
  daemon importing `pwa/` source (dependency direction), a third
  backoff/heartbeat/correlation implementation (the drift risk the harness
  comment already documents once).
- **Lazy connect, idle disconnect.** The socket dials on the first tool call,
  stays open under the standard 30s heartbeat, and closes after ~5 minutes
  idle; the next call redials. A Claude session can sit open for hours doing
  local work — a permanently open socket per session buys presence freshness
  nobody is looking at. Rejected: connect-per-call (pays connect latency and
  the registry settle on every call), always-on (idle sockets × sessions).
- **Tools**: `list_machines` (registry + presence, works for offline machines
  because repos ride the register blob), `get_sessions { machine }`, and
  `spawn_session { machine, repo, prompt?, title?, mode?, model?, effort?, plan? }`
  mapping 1:1 onto the `sessions`/`spawn` ops with the existing
  `OP_TIMEOUT_MS`. `machine` is the config `name` resolved against the live
  registry; ambiguity or a miss returns candidates, `deviceId` is the
  exact-match escape hatch. No `rescan` tool in v1 — rarely useful from an
  agent, trivial to add. Self-targeting short-circuits to the local op socket
  below rather than looping through the relay: uniformity is not worth an
  internet round trip to reach the machine the server is running on. Rejected:
  routing it through the relay like any other target, which is simpler to
  describe and pays Cloudflare's latency for a process on the same box. The
  local repo pre-check re-reads `state.json` per call and is advisory only: the
  daemon still resolves the repo authoritatively, an MCP process outlives many
  rescans, and an empty set means the first scan has not landed — so it denies
  nothing then rather than rejecting every repo until a restart.
- **Protocol implementation: the official TypeScript MCP SDK v2
  (`@modelcontextprotocol/server`) + zod v4** — the daemon's first runtime
  dependencies. Served via `serveStdio`, whose factory-per-connection model is
  the SDK's stateless shape: the opening exchange picks the protocol era, so
  one registration serves both a 2026-07-28 client and a legacy 2025-era one
  (Claude Code today). Rejected: the v1 `@modelcontextprotocol/sdk` package
  (caps out at the 2025-11-25 revision), hand-rolling the JSON-RPC loop
  (on-brand with the zero-dep ethos and only ~3 methods, but protocol drift
  would be owned here, for a protocol that is actively evolving).
- **Stdout is the protocol channel**, so the MCP path logs to stderr — the
  daemon's stdout logging convention would corrupt frames. The shared client
  takes a `log` sink option (default stdout) for exactly this consumer;
  redirecting `console.log` process-wide would silence stdout for everything.
- **CLI pair for Claude config**: `seanced mcp install` / `seanced mcp uninstall`
  shell out to `claude mcp add` / `claude mcp remove` (argv-array, per the exec
  invariant) rather than editing `~/.claude.json` — Claude Code owns that
  schema. What gets registered is PATH-resolved bun plus this checkout's
  `main.ts`, the same target `link` points at, so the entry survives both a
  `git pull` and a bun upgrade. `doctor` reports whether the entry exists.
  Nothing re-registers on its own — no self-update path touches Claude config —
  so a machine that predates a change to the recorded argv needs
  `seanced mcp install` run again by hand. Which is why `install` clears the name
  before adding it: `claude mcp add` fails with "already exists" otherwise, and
  the machines needing a repoint are exactly the registered ones. Same
  bootout-before-bootstrap shape as the launchd install. Rejected: telling the
  user to run `mcp uninstall` first (an extra step per machine, for a command
  that should be idempotent).

**Spawn attribution.** A spawn from the MCP server reaches the target daemon
as an ordinary relay spawn, and the audit tag exists precisely to separate "me
at my desk" from "something else drove my machines" — so the spawn payload
gains an optional free-text `client` field, and the audit line becomes
`origin=relay client="mcp"`, quoted through the same escaper as every other
wire-supplied string. `SPAWN_CLIENTS` in `shared/src/types.ts` names the
values our own senders stamp ("pwa", "mcp") — sender-side discipline only.
Old daemons ignore the unknown field. Rejected: accepting an
indistinguishable third spawn path (the audit invariant would quietly stop
meaning what it says); validating `client` against a closed union on receive —
daemons update machine-by-machine behind fast-moving clients, so a daemon must
never reject a spawn over a client name minted after it was built, and the
field is display-only, so validation would buy nothing.

**Threat-model addendum.**

- New path in: any local Claude session that loads the server — including
  whatever prompt-injects that session — gains spawn power over every machine,
  which is arbitrary code execution under their permission modes (see "what
  structured payloads only does and does not mean"). Accepted: one human owns
  every device, the PSK is already the sole boundary, and Claude Code's
  per-tool approval is the gate — read-only tools are safe to allowlist,
  `spawn_session` is not. Rejected: a server-side `--allow-spawn` flag
  (friction in the wrong place; the approving human is at the Claude session,
  not the config file), a read-only server (defers the point of the thing).
- No new key at rest, but a new _process_ holding the imported PSK — on a
  machine that already runs one (the daemon). Only when an op is aimed at
  another machine, though: the key is resolved on first _remote_ use, so a
  session that only ever spawns locally never imports it.
- The group address stays out of reach: the MCP server seals only to specific
  `deviceId`s; `spawn` to `"machines"` remains structurally impossible.
- **A delivered credential never leaves the daemon process.** `exec.ts` strips
  `CREDENTIALS_DIRECTORY` from every child's environment, because the daemon
  cold-boots the tmux server when none is running and a pane's environment is
  the server's — so inheriting it would publish the PSK's plaintext path to
  every Claude session on the box, including on the credential-delivered boxes
  where the bullet above says MCP is unsupported. It would otherwise be
  _silently supported there, by accident_: same-uid sessions can read that
  tmpfs, so the exclusion is enforced by this scrub and nothing else. Note
  which boxes: the leak needs the daemon to have booted the server itself,
  which is the normal case on a headless system unit and not the case when a
  login shell got there first — so the accident would also have been
  boot-order dependent.
- Prompt text is never logged on the MCP tier either — the Claude session
  that issued the spawn is its natural transcript.

## Local op socket (`daemon/src/local-socket.ts`) — designed 2026-08-29

The daemon listens on a unix socket, and the MCP server sends `sessions` and
`spawn` straight there when the target resolves to the box it runs on. No relay,
no envelope, no PSK: a spawn on the machine you are sitting at never leaves it.
The alternative is an internet round trip to Cloudflare and back down the
daemon's own websocket, to reach a process a few hundred microseconds away.

This is the op-level proxy the credential-delivered-box problem calls for —
semantic ops with per-op policy and the existing audit trail, never the raw key.

- **A socket into the daemon, not a second spawner.** The alternative was ~50
  lines: the MCP process calling `createBackend(config).spawn()` itself, exactly
  as `seanced spawn` does. Rejected, because it makes a **second executor**. The
  daemon cold-boots the tmux server when none is running, so whichever process
  spawns first decides that server's environment — and a pane's environment is
  the server's. Routing through the daemon keeps one executor, one repo set (its
  live one, not a re-read of `state.json`), one audit sink, and — because
  `machineTag` is read in `backend-default.ts` — a session name byte-identical to
  a relayed spawn's. A local spawn differs from a relayed one in exactly one
  observable way: the origin tag.
- **Semantic ops, never the key.** A peer sends a `Plain` and gets a `Plain`
  back; the ops it may ask for are `sessions` and `spawn` and nothing else.
  `rescan` is out of scope and `update-available` is refused structurally — it is
  fire-and-forget, drives the self-updater, and must not be reachable from a
  surface whose premise is skipping the envelope. Same posture as the broadcast
  allowlist in `relay-client.ts`. Rejected: a crypto oracle (seal/open on
  request), which is what the open item warned against — same-uid peers make it
  unpoliceable, and it hands out the relay's whole reach rather than two ops
  against this box.
- **The 0700 directory is the access control**, not the socket's mode. The
  socket lives at `stateDir()/run/seanced.sock`, in a directory the daemon
  creates 0700 and re-tightens on every start. `Bun.listen({ unix })` creates
  the socket itself 0755, and there is a window before the `chmod 0600` lands;
  socket-mode enforcement on `connect(2)` is also inconsistent across
  BSD-derived kernels. Directory traversal gates connect everywhere, so that is
  what the argument rests on and the socket's own 0600 is belt-and-braces.
  `doctor` checks the directory mode, because a daemon that has not restarted
  since it was loosened would not have tightened it yet.
- **It grants no authority a same-uid process did not already have.** Such a
  process can read `config.json` (0600, same uid) and take the PSK outright, run
  `seanced spawn`, or drive the tmux server directly. The socket is strictly
  less: two named ops, no way to address another machine, no way to reach the
  `"machines"` group address, and every request recorded. What it adds is that
  going through it is the _recorded_ way in — hence `origin=local`, and hence the
  origin on the `audit request` line too.
- **Connection per request; no correlation, no heartbeat, no backoff.** One
  `Plain` per line, one reply, close. This is deliberately not the relay
  protocol: there is no reordering to correlate against and no network to
  survive. Rejected: a long-lived correlated connection (a pending map and a
  heartbeat for a problem that does not exist here). Frames are newline-delimited
  JSON capped at 1 MiB — past it the peer is dropped, since a truncated frame is
  not a request. The newline is matched as a _byte_, which is safe because 0x0a
  never occurs inside a multi-byte UTF-8 sequence and prompts carry non-ASCII.
  **Both ends queue and drain their writes.** Bun's `write` is short under
  backpressure and keeps no remainder, and a spawn is large in both directions —
  a free-text prompt up, a refreshed session list down. A half-written frame has
  no newline, so the far end buffers it and answers nothing until the op times
  out: the symptom is a 90s timeout, never a parse error.
- **Locality is decided from files, not from the socket.** The MCP server
  compares the target against `config.name` and the `deviceId` in `state.json` —
  a deviceId exactly, a name case-insensitively, the same precedence
  `resolveMachine` uses. Deciding this from disk rather than by probing means a
  local target whose daemon is down fails with "the daemon isn't running"
  instead of quietly paying a round trip to be told the same thing. Reading it
  needs `readState`, which — unlike `loadOrInitState` — never mints a `deviceId`
  and never logs, since `log.ts` writes to stdout and that is the MCP server's
  JSON-RPC channel.
- **Local wins a name collision**, and `deviceId` remains the escape hatch to the
  remote twin. `resolveMachine` refuses an ambiguous name; the short circuit
  resolves it toward the box you are on, because that is the case the whole
  feature exists for. Said in the tool description, so the model on the other end
  knows.
- **No fallback to the relay when the local path is unavailable.** A silent
  fallback would make the failure mode invisible, and the daemon being down means
  the relayed spawn would fail anyway — the machine is offline by the same fact.
  Rejected: falling back to an in-process spawn, which reintroduces the second
  executor this design exists to avoid.
- **`list_machines` still needs the relay**, and marks the local entry `local:
true`. When the relay cannot be reached at all it answers with this machine
  alone plus a note. That is not a nicety: on a credential-delivered box the
  relay is unreachable by construction, and a model that can see no machine
  cannot spawn on the one it is sitting on either.
- **The PSK is resolved lazily**, on first remote use rather than at startup,
  memoized, and cleared on failure so a locked keychain can be retried. Local ops
  need no key, which is what makes the credential-delivered box work. It also
  narrows the threat-model addendum above: for local work the MCP process no
  longer holds the PSK at all.
- **The listener never fails the daemon.** An unbindable socket — a run directory
  owned by someone else, a path past the ~104-byte `sun_path` limit — logs and is
  skipped, matching `ensureAuditLog`'s posture: a degraded local surface is not a
  reason to take the machine offline. An `EADDRINUSE` is probed by connecting;
  a corpse is cleared and rebound, a live daemon is left alone. The supervisor's
  reload is `stop()` then start, sequentially, and `stop(true)` unlinks the path,
  so a config swap rebinds cleanly with no race.

Non-goals: routing `seanced spawn` through the socket (it would collapse the
executors further, but `origin=cli` should keep meaning "typed at this machine");
a `rescan` op; the Raycast extension using it — its local-only reach was rejected
on product grounds and that has not changed.

## Raycast extension (`raycast/`) — designed 2026-08-14

A **fourth** relay participant and a **third app-role client**, structurally
identical to `seanced mcp`: it dials `/app?t=<token>`, seals with the PSK as
`from="app"`, correlates on `re`, and takes registry pushes. Zero relay and zero
daemon changes; every channel property applies unchanged. What it adds is a
latency budget — one hotkey to a running session.

- **Scope is spawn, and only spawn.** Ops are `spawn` and `rescan`; there is no
  `sessions` op and no session list. Monitoring stays the PWA's job, which is
  what keeps this surface a form rather than a second app. Rejected: a
  `Detail`/`List` view of running sessions (duplicates the PWA at a fraction of
  the fidelity, and the phone is where you actually watch a session).
- **Reach is every paired machine, through the relay.** Rejected: local-only
  (talking to the daemon on this box directly). It would need no PSK and no
  socket, but "spawn on the machine I am sitting at" is the one case where a
  terminal is already open and `seanced spawn` already works; the value is
  reaching the _other_ machines.
- **Local install only, never the Raycast Store.** Publishing would push the
  source into the `raycast/extensions` monorepo and — because the Store's
  distribution model has no notion of reading another local app's secrets —
  push users toward a preference field holding the PSK, i.e. a second copy at
  rest. Refusing to publish is what keeps the credential story below possible.
  The cost is that `ray lint` (eslint/prettier, which would fight oxfmt) is not
  satisfied and CI cannot run `ray build` at all — it needs macOS and the
  Raycast app. Accepted: `tsc` and `oxlint` cover the workspace in CI, and the
  bundling gate is run by hand.
- **Credentials come from the daemon's own config plus the macOS keychain, and
  nowhere else** — the same decision as the MCP surface, and for the same
  reason: no new copy of the PSK at rest. Raycast preferences hold defaults
  only (machine name, model, effort) and are never a place a secret may go,
  which `options.test.ts` asserts against the manifest. The keychain read goes
  through `/usr/bin/security` by absolute path, because a Raycast-launched
  process inherits the app's minimal environment rather than a login shell's
  PATH, and it passes no `-a`, because the daemon sets the account only on
  write. Verified on real hardware: reading from under Raycast raises **no** GUI
  prompt, because the ACL entry `security` recorded on create is the one it
  presents on read, exactly as for the daemon. The read is bounded at 10s all
  the same, since a _locked_ login keychain does prompt and would otherwise
  hang forever with no explanation.
- **Cache-first rendering.** The last registry projection and the last-used form
  values are persisted to Raycast's `LocalStorage`; the picker renders from them
  before any socket exists, the client dials in the background, and the live
  registry reconciles in when it lands — Toasting once if it had to move the
  selection. A dial costs a TLS handshake plus a registry push, which is plainly
  felt on a surface whose entire premise is speed. Rejected: blocking the form
  on `open` + registry (correct, and slow enough to defeat the point).
  Reconciliation trusts the cached list until the client's
  `RelayState.registrySettled` bit marks the live one authoritative — set by the
  first registry frame after `open`, or by a 1.5s bound if none ever comes, and
  re-armed on every re-dial so a connection flap never reads as "every machine
  vanished". The bit lives in `RelayClient` (and `LazyRelay` waits on the same
  one) because only the client sees an empty registry frame arrive; a subscriber
  cannot await a push that changes no state. An authoritative empty list is
  written to the cache like any other, so a machine removed from the registry
  does not resurrect from LocalStorage on the next launch. Rejected: each
  consumer hand-rolling the non-empty-or-timeout wait (two copies of the same
  1.5s constant, and the Raycast copy's timer once survived a disconnect and
  wiped the cached list).
- **Defaults: last-used wins**, persisted after each successful spawn;
  preferences seed only the first run, or when the remembered machine is gone
  from the registry. The prompt always starts empty. Repos are remembered _per
  machine_, mirroring the PWA's `PersistedForm`, so switching machines restores
  what you last ran there.
- **Refuses rather than fires blind.** Offline machines stay selectable and are
  marked in the dropdown, but submitting names the reason it cannot go (asleep,
  no socket, empty registry, no repos) instead of disabling a button silently.
  On failure the form stays open with state intact — the typed prompt is the
  expensive part of the interaction. A success carrying a `note` also stays open
  so the note is read; a clean success closes the window and shows a HUD.
- **`SPAWN_CLIENTS` gains `"raycast"`**, so the audit line reads
  `origin=relay client="raycast"`. Sender-side discipline only, as before — the
  wire field stays free-text and no daemon changes.
- **Layering: nothing under `raycast/src/lib/` may import `@raycast/api`.** It
  throws outside the Raycast host, so any such module would be unloadable under
  `bun test`. Views are `.tsx` at `src/`, logic is `.ts` at `src/lib/`, and
  platform APIs arrive as injected seams. That is what lets the tests run under
  Bun — and therefore import the daemon's _and_ the PWA's implementations
  alongside the extension's and assert they agree on the keychain service name,
  the config-dir resolution, the PSK precedence, and the offered model/effort
  lists. Those four are duplicated by necessity (different runtimes, plus a
  static manifest that cannot import), so they are guarded instead.
- **`seanced raycast install` drives Raycast's own CLI, exactly as `mcp
install` drives Claude's.** Two steps, in order. `ray build` first, because
  it is the only typecheck in the loop: `ray develop` skips it entirely — its
  output stops at "compiled entry points", where `ray build` also prints
  "checked TypeScript" — so without this gate a `shared/` wire-type change
  would import happily and fail at the user. Then `ray develop`, which is a
  watcher that never exits, so "imported" has to be observed from outside the
  process: poll the imported manifest for an appearance or an mtime change
  (snapshotted first, so a _re_-install is detectable at all), give it a
  moment, then SIGINT. `ray` answers SIGINT by removing `cli.pid` and
  `dev.log`, leaving the bundle imported, and **exiting 1** — a failing exit
  code that is this command's success, so it is not consulted. The stdout
  marker `ready - built extension successfully` only shortens the wait; the
  directory is the proof, and a marker with no directory warns and **exits
  non-zero** rather than claiming success — the outcome carries the observed
  import, so the command cannot print its success line off the marker alone.
  The whole handshake is bounded, and on expiry `ray`'s own tail is what the
  error carries.
  Rejected: **writing Raycast's extensions directory ourselves.** Unsupported,
  and it would not work: the import is recorded in Raycast's encrypted sqlite,
  which would know nothing about a directory that appeared behind it. Rejected:
  **a preflight-and-print-instructions command** — honest, and useless. The
  checks are the cheap part; the sequence is what is worth automating.
- **The import is name-keyed, and the name is read from the manifest.**
  `ray develop` imports to `~/.config/raycast/extensions/<manifest name>/`;
  UUID-named siblings there are Store installs, which this extension
  deliberately never becomes. A constant in the CLI would let a manifest rename
  leave install watching a directory that never appears and uninstall refusing
  to remove the one that did, so the CLI reads `raycast/package.json` for it.
  The workspace is located from `checkoutRoot()`, never from
  `process.execPath` — which is the realpath'd bun binary, and so the wrong
  directory as well as the forbidden one.
- **`raycast uninstall` removes only what it can prove is ours, and names what
  it cannot do.** There is no supported way to un-import a development
  extension — the record is in that same encrypted sqlite — so Raycast keeps
  listing Séance until it is removed in Manage Extensions, which the command
  prints rather than implies. What it does remove: the imported directory, but
  only after its `package.json` names this manifest (never `rm -rf` a path that
  was not positively identified), and never while `cli.pid` names a pid that is
  actually alive — the file is a claim, probed with signal 0, since a crash
  leaves it behind and a trusted stale pid would wedge every uninstall after
  it; plus this checkout's `dist/` and generated `raycast-env.d.ts`. Idempotent
  like the service teardown — removing what is not there is not an error. A
  manifest that is _there but unparseable_ is not "not there": that is a `ray`
  killed mid-write, so it refuses loudly naming the path rather than reporting
  nothing imported and leaving the directory behind forever.
- **Doctor warns when the imported copy is older than `raycast/src` or
  `shared/src`.** The direct analogue of the plist/MCP recorded-bun drift
  warning, and it earns its place for the same reason: nothing rebuilds the
  extension on a `git pull`, so a machine can sit indefinitely running a bundle
  that speaks last week's wire types. Silent off macOS, the way the TPM checks
  are silent off Linux.
- **Node's version matters only as `@raycast/api`'s engine, and the floor is
  read from the installed package's `engines.node`** (`>= 22.22.2` today) — a
  literal in the daemon would go stale on the next dependency bump and quietly
  defeat the fallback below; the literal survives only for a manifest that
  cannot be read.
  When PATH's node is older or missing, install prepends Raycast's own bundled
  runtime (`~/Library/Application Support/com.raycast.macos/NodeJS/runtime/
<version>/bin`) to the child's PATH — resolved at use time and written
  nowhere, since that directory is versioned and disappears on the next app
  update. Dependencies, when the workspace has none, come from `bun install` at
  the repo root and never npm: `workspace:*` is not an npm spec, and npm would
  flatten the isolated linker tree the two-TypeScript arrangement depends on.
  Since PR 1 the workspace also has a real runtime dependency (`ws`), so an
  uninstalled workspace is not merely missing the build tool.

**Runtime surprises, both verified by probing rather than by reading version
numbers.** Raycast runs extensions on Node v22.22.2 but in a sandbox whose
global object is not that Node's: `fetch`, `btoa` and `TextEncoder` are present
while **`crypto` and `WebSocket` are both undefined**. `shared/` consumes both
as globals, so without a shim the extension dies on `crypto is not defined` at
the first `importPsk`. `raycast/src/lib/runtime.ts` installs `webcrypto` and
`ws`'s `WebSocket` onto `globalThis` — `ws` being the one dependency this
forces, since Node's global WebSocket is undici's and has no importable form.
Rejected: widening `shared/` with injectable crypto and socket seams for a third
consumer's sandbox, when the PWA and daemon both have the globals — the
adaptation belongs at the boundary that needs it. Separately, `@types/node` must
stay on `^26` even though the runtime is Node 22: the 22.x types declare
`CryptoKey` only inside the `webcrypto` namespace, so matching the runtime
version breaks the build.

## Accepted trade-offs

- `/spawn` and the daemon duplicate git/tmux logic — drift risk, owned, and on
  its way out: `seanced spawn` now audits like the relay path, so the slash
  command can become a thin wrapper over it and the duplication disappears.
- Key rotation or a new phone touches 4 devices manually, with spawns failing
  closed in between — no `keyId`, no rollover window.
- Battery-powered Macs show offline when asleep.
- No deep link from the spawn verdict into the _specific_ Claude app session. Even
  the coarse `claude://code` (session list) link was removed from the verdict: it
  added nothing over the notification the Claude app itself raises when a
  remote-control session starts; see Problem & scope.
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
- The TPM path stays unverified from CI (no TPM in test runners), but the
  open questions were answered on hardware 2026-08-10 (Proxmox LXC, systemd 257) and folded into the threat-model item above: non-root seal/unseal is
  refused on systemd ≥ 256 (`--user` is not a fix), `has-tpm2` does report
  partial in an LXC guest with a working seal path, and the answer is
  delivery via `LoadCredentialEncrypted=` rather than probe loosening. What
  remained was tooling, not research, and `install --system` has since folded
  the unit half of that runbook into the CLI (2026-08-11). `psk-import
--system` is still open: sealing is a root step by hand (docs/psk.md).
  A delivered key is unreadable outside the unit, so every check that resolves
  one first reported a healthy box as broken and exited 1; `doctor` therefore
  _reads_ the system unit (`systemUnitDeliversPsk`) purely to distinguish "the
  manager holds the key" from "there is no key", and its three remaining
  user-scope misreports (unit active, linger, the bun-path catch-up) are now
  fixed rather than documented — `installedUnits()` picks the scope from which
  unit file exists, linger is reported as irrelevant, and the bun path is
  compared against the unit's _own_ recorded PATH rather than the shell's,
  which would otherwise read two orderings of one PATH as drift.
  Decisions worth keeping: scope is **detected, never persisted** (a recorded
  scope goes stale against a hand-edited unit, which is the box being served)
  — from `/proc/self/cgroup` inside the daemon, where `selfRestart` needs it
  and no flag reaches (the files would answer "system" for a user-manager
  daemon on a box carrying both, and that exit under `on-failure` stays down),
  and from the unit files in the CLI, which asks `is-active` which of the two
  is live rather than trusting file order; a system unit is never rewritten by
  the daemon, so `selfRestart` exits 0 for `Restart=always` and `doctor`
  reports definition drift instead — a reinstall is what applies a new
  definition, and it restarts the unit, because `enable --now` leaves a
  running one on the old one;
  `LoadCredentialEncrypted=` is written only for a blob that decrypts as root,
  since a credential systemd cannot load fails the unit at start, which is
  worse than a unit that comes up keyless and says so; and installing both
  scopes at once is refused in both directions rather than resolved — two
  daemons would share one state dir, log and device id.
  Rejected: shelling out to `sudo` from the CLI (a password prompt through
  `Bun.spawn`, whose tty `exec.ts` deliberately withholds, and a half-root
  command with no coherent recovery point) — `--system` refuses unless euid 0
  and resolves the target from `SUDO_USER`, never from root's own
  environment, since `homedir()`, `stateDir()`, `PATH` and `Bun.which` all
  answer for the wrong user there and every one of those values is written
  into a unit that outlives the install. Also rejected: keeping the runbook as
  printed instructions, which is what the docs already were.
  MCP on a credential-delivered box reaches that machine but not the others
  (docs/psk.md): the local op socket needs no key, and the PSK is resolved only
  when an op is aimed elsewhere. Mediating at op level is what makes that safe —
  a crypto oracle, which same-uid peers make unpoliceable, would not have.
