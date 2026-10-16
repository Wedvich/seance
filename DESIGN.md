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
  plaintext), per-device asymmetric keypairs _for the payload_ (needless key
  management when one human owns every device), QR pairing (requires being at
  the machine). Each daemon does hold one asymmetric key, but it signs only
  its own `register` and nobody manages it — see "Self-certifying ids" under
  Presence & identity.
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
- **Post-quantum safe by construction**: symmetric crypto for everything
  that carries a payload — no key exchange exists to attack (Grover only
  halves a 256-bit key's strength; ML-KEM solves a problem this design
  doesn't have). The one signature in the system, a daemon's register, is
  ML-DSA-65 for the same reason: an Ed25519 identity would be the single
  thing a quantum adversary could forge.
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
on four dev machines; prompts and repo names; presence and telemetry metadata —
each machine's pressure, sessions per exclave and quota (the `status` beat), the
hourly history in `metrics.sqlite` kept forever, account ids, skill names and
repo origins, sealed in transit and plaintext at rest on the machine. The bearer
token is not an asset in the same sense — see its blast radius above.

**Séance's own footprint.** The daemon is structurally a remote access tool and
reads as one to any EDR:

| Behaviour                                                             | ATT&CK                            |
| --------------------------------------------------------------------- | --------------------------------- |
| launchd agent runs `seanced`                                          | T1543.001 Launch Agent            |
| systemd user unit runs it on Linux/WSL (+ Windows logon task on WSL)  | T1543.002, T1053.005 (WSL)        |
| persistent outbound WSS to the relay                                  | T1071.001, T1102.002              |
| AES-256-GCM under a PSK                                               | T1573.001 Symmetric Cryptography  |
| remotely starting an interactive coding agent                         | **T1219.001 IDE Tunneling**       |
| pre-answering claude's trust dialog in its config                     | T1562.001 Disable or Modify Tools |
| `caffeinate -is` per spawn + the AC-power hold                        | T1653 Power Settings              |
| depth-2 `.git` scan of `repoRoots`                                    | T1083                             |
| host discovery every 30s: `statfs`, `/proc`, `sysctl` on macOS        | T1082                             |
| reading every exclave's `.claude.json` and `skills/` dir              | T1083, T1087-adjacent (ids only)  |
| a local activity history (`metrics.sqlite`, hourly tier kept forever) | T1074.001-adjacent                |
| tmux pane enumeration                                                 | T1057                             |
| `despawn`: keys into a session's pane, `kill-pane`, signals           | T1489-adjacent (stopping work)    |
| `reap`: git fetch/status, worktree removal, branch deletion per repo  | T1070.004-adjacent (deletion)     |
| `git pull` + service kickstart as the update path                     | T1195.001                         |

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
   the blast radius off Cloudflare, so that choice is not free. It also buys a
   passive feed: every `/app` socket receives every machine's `status` every
   30s. The payload is sealed, and padded to one length before sealing
   (Presence & identity, "Encoding"): unpadded, its ciphertext length varied
   with load, session counts and whether quota was present — a coarse activity
   channel per machine. The relay logs no line for an accepted beat,
   only its drops (`status-not-app`, `status-rate`) and failed fan-out sends:
   a `wire status … apps=N` line per beat once made Workers logs a 30s
   timeline of when an app was open, which a Logpush sink would have carried
   off Cloudflare too. The token also
   bought slightly more than stated: `register` overwrote by `deviceId`, so a
   holder could blank a real machine's entry until it re-registered
   (T1565.001) — closed by self-certifying ids below, since a register for an
   id now has to be signed by the key that id hashes — and nothing caps
   registry growth (T1499.003). Bounded in the DO by a
   32-entry cap that turns away only _unknown_ ids — so a full registry locks
   out machines you have not added yet and never knocks a known one offline —
   plus a per-socket register rate limit, which bounds write rate as the entry
   cap does not: re-registering one id is otherwise unbounded puts and a
   registry push to every app each time. Neither cap defends _against_ a token
   holder; rotating the token does. They keep the cost finite. The rate limit
   is per socket, so it bounds one connection's spend, not an attacker's total.
   Wire-level bounds back both: ids are ≤64 safe characters and ciphertext
   ≤64 KiB, so a register can never reach the DO's 128 KiB value limit as an
   unhandled throw. `deviceId` has no shape of its own beyond those bounds —
   it is the base64url SHA-256 of the daemon's public key (43 characters), and
   the hub checks that, not the parser.
   Two sharper reads of the same verb, closed 2026-08-16. **Blob-swap
   misdirection** (T1036): an `/app` socket is handed every machine's `info`
   blob on its first push, and `register` pairs a blob with an id of the
   caller's choosing — so a holder can re-file machine A's blob under machine
   B's id. The picker then renders A's name and A's repos on an entry that
   routes to B, and the tap seals the spawn to B. AAD binding still holds, so
   "a relay compromise cannot spawn anything" survives; "you know which machine
   you are spawning on" does not. Closed by an invariant the daemon has always
   satisfied and nothing verified: `info.from` is AAD-bound to the machine that
   sealed it, so an entry whose blob does not name its own `deviceId` never
   becomes a `Machine`. Checked in `#decryptInfo`, which is what populates the
   only cache `#rebuildMachines` reads, so an unverified entry can miss but
   never render half-built — and that cache is keyed by id _and_ iv, because
   one blob arriving under two ids must not be served from one slot. Such an
   entry is counted as `unbound`, apart from `ignored`: it is not a key
   problem, no PSK rotation clears it, and the UI names the bearer token as
   the thing to rotate rather than sending anyone to check a correct key.
   App-side,
   not relay-side: the relay is blind and untrusted, so a check there is a
   courtesy the app would have to repeat anyway, and a second copy is a second
   thing that can drift. **Socket eviction and squatting** (T1499, T1565.001):
   `register` also moved the route, closing an incumbent socket with
   `superseded` for an id the caller never had to prove — after which
   app→machine envelopes went to the newcomer, undecryptable and so
   blackholed, while the registry still read `connected: true`; and the same
   verb let a holder squat the id of a machine that was offline. Both are the
   same hole: a register proved the bearer token and nothing about which
   machine sent it, so no positional rule (incumbent wins, newest wins, a
   silence threshold between them) could refuse the eviction without making
   the squat sticky or vice versa — the interim threshold rule, kept for one
   release, did exactly that. Closed by making ids self-certifying (Presence &
   identity, below): the hub verifies every register, a verified one always
   takes the route — whatever else holds the id is a zombie this same machine
   left behind, never a stranger — and an unverified one is closed with
   `register unverified`, which the daemon logs and backs off on, since the
   open it got was not an accepted register. Reconnect after a clean drop is
   untouched; a redial that races its own zombie now displaces it at once
   rather than after any silence. What the token still buys here is the two
   things it always did: junk entries under ids nobody will ever sign for,
   bounded by the entry cap, and `forget`.
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
   clock widens the window. A relay can also replay or withhold a `status`: the
   app binds one to its register blob through `scan`, and that stamp can stay
   fixed for hours (it moves only on a re-register), so an old beat replays
   cleanly within one register period. Its freshness rests on the daemon's `at`
   — the age the Machines screen shows — and so on the same clock.
5. **Supply chain** (T1195.001). `git pull` + `launchctl kickstart -k` is
   unsigned; a compromised repo is RCE on every machine, onto boxes that
   already carry launchd persistence. Bounded by 2FA and branch protection
   rather than an update daemon — proportionate to four machines.
6. **Prompt injection into the spawned agent.** Outside ATT&CK Enterprise;
   v19's AI additions (T1682, T1683) model adversaries _using_ AI, not
   compromising an agent — MITRE ATLAS is the companion frame. Two parts: a PSK
   holder's `prompt` reaches Claude under the machine's configured permission
   mode, and the spawned agent then reads repo content Séance does not control.
   A spawned session also runs as the daemon's user and can write what telemetry
   reads — `.claude.json`, `~/.exclaves`, the skills dirs — so it can spoof its
   own exclave's account and quota view. Nothing routes from those figures yet;
   they are claims by the box, not observations of it.

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
  lines, because enumeration is the same signal as spawning. Ending a session
  is the same signal too: every despawn path audits through its own one
  formatter (`despawnAudit`), under the same three origins. Reap destroys
  things — worktrees, branches, windows — and audits each one (`reapAudit`)
  under `cli` or under `schedule`, the fourth origin, which is the daemon's own
  timer: a 3am cleanup must not read as someone at the desk. The daemon writes
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
  unlike the prompt, are logged verbatim). `metrics.sqlite` and its `-wal` and
  `-shm` join them: the database is created as an empty 0600 file before SQLite
  opens it, and SQLite gives the files it spawns the database's mode. All
  created at 0600 rather than
  written and chmod'd, so no umask-mode window exists. Enforced as explicit
  modes and not as a `UMask=` in the unit, deliberately: the daemon may
  cold-boot the tmux server as its child, and a umask there would follow every
  file a Claude session writes.
- **The relay never receives plaintext telemetry.** `status` is sealed to the
  app like `info`, and `relay/test/layering.test.ts` keeps any module under
  `relay/src` from reaching the envelope crypto or a payload parser — the first
  readable payload would make the relay's logs an activity timeline.
- **A blob opened outside the replay guard is bound by its AAD `from` and
  checked for its `op`.** `machine-info` and `status` are data at rest — the
  relay re-sends the same envelope on every push — so no guard sees them, and
  only `from` says which machine a blob describes and only `op` which kind of
  blob it is: payload shape would let a `status` (or M3's `task`) stand in for
  whatever its slot expects. Both go through `openAtRest`
  (`shared/src/crypto.ts`), which throws unless `plain.op` is the one asked for.
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

- `deviceId`: the base64url SHA-256 of the daemon's ML-DSA-65 public key
  (43 characters), derived from a 32-byte seed the daemon mints on first run
  and keeps in `state.json`. Plaintext routing key, and the one thing a
  register has to prove — see "Self-certifying ids" below.
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
- **Self-certifying ids** (2026-10-15). A `register` carries the daemon's
  raw public key, a timestamp, and an ML-DSA-65 signature over
  `seance-register|<deviceId>|<ts>`; the hub (`relay/src/hub.ts`, via
  `shared/src/identity.ts`) accepts it only if the key hashes to the id, the
  signature verifies, and `ts` is within ±60s. The id _is_ the key, so there
  is nothing to enrol and no registry of keys to keep: the relay learns the
  key from the frame it is verifying, and a stranger cannot name an id
  without also holding its seed. Verification runs behind the per-socket rate
  limit (at most ten verifies a minute per socket, ~1ms each in workerd) and
  before the entry cap. A verified register always takes the route and
  closes any other socket holding the id with `superseded`; an unverified one
  closes the claimant with `register unverified`, and a frame whose key or
  signature is not exactly the algorithm's size is malformed and dropped
  before any crypto runs (`relay/src/wire.ts`). The seed lives in
  `state.json` (0600) as `identitySeed`; a state without one is a pre-identity
  install and is upgraded in place — the machine gets a new id, logged as
  `deviceId X becomes Y`, and the app's old entry for it is junk to `forget`.
  A seed that does not derive the stored id is corruption and reinitializes.
  ML-DSA-65 over Ed25519 because the identity is the one asymmetric
  primitive in the system and the only thing a quantum adversary could
  otherwise forge; -65 over -44 for margin at a cost (1952-byte key,
  3309-byte signature, one frame per connect) that is nothing on this wire.
  The relay needs workerd's `webcrypto_modern_algorithms` compatibility flag
  (`relay/wrangler.jsonc`), a draft API, so the shape is pinned by
  `shared/src/identity.test.ts` and the relay suite rather than assumed;
  Bun has it natively. Rejected: a per-register challenge from the relay
  (a round trip on every connect, and a blind relay has no secret to make the
  challenge worth more than a fresh timestamp); the PSK as the identity (one
  key for every machine identifies none of them); keeping the UUID and
  registering the key beside it (two things to keep consistent, and the
  relay would need a first-come enrolment that is the squat all over again).
- **The latest `status` lives on the daemon socket's attachment** (added
  2026-10-15, scheduler M1): the daemon seals its
  telemetry snapshot to the app like the register blob and sends it as its own
  frame every 30s and right after each register; the hub keeps it beside the
  socket's identity (`serializeAttachment`, 2 KiB for both), forwards it to
  every open app as `status { deviceId, envelope }`, and includes each live
  socket's in the `registry` push, so a freshly opened app renders pressure
  from its first push. Never DO storage: no write per sample, and it goes with
  the socket — a disconnected or swept machine's snapshot is stale by
  definition, so the app loses it on the same push that reports the machine
  offline. Bounded at `STATUS_MAX_CT_LENGTH` (1 KiB of ciphertext, checked in
  `relay/src/wire.ts`; the daemon trims its blob to fit, `daemon/src/status.ts`,
  per-model windows first) and floored per socket at `STATUS_MIN_INTERVAL_MS`
  like `register`'s rate limit; under the floor is dropped, not closed. A
  register clears the socket's snapshot — it indexes the blob just replaced —
  and the floor with it, so the status the daemon sends right after every
  register is let through (measured: without this the boot register's status
  stood for the first beat while the rescan's re-register sent one into the
  floor). Accepted only from a registered socket whose envelope's plaintext
  routing names it — `from` its own id (`from-mismatch` otherwise) and `to` the
  app (`status-not-app`); the relay cannot see the seal, so the app's AAD check
  is what proves who sealed it. The relay stays
  blind — ciphertext and routing only, as with `info`; plaintext numbers were
  rejected because pressure over time is an activity timeline — and
  `relay/test/layering.test.ts` keeps it so. The app opens it as it opens
  `machine-info`: no replay guard (the registry re-sends the same envelope on
  every push), bound to its `deviceId` through the AAD `from`, refused unless
  sealed as `op: "status"`, and shown only
  while its `scan` names the register blob this app decrypted — the relay
  already drops a socket's snapshot at each register, so this is the app's own
  guard against a sender stamping the wrong blob. "The register blob" means the
  one last _registered_, not the merged `Machine`: a `rescan` reply moves
  `Machine.scannedAt` without a register, and comparing against it would drop
  every status until the repo set next changed. A status that opened is proof
  of life and clears a timeout's offline mark, as a reply does.
  **Reading** (`shared/src/status-reader.ts`): the parser checks types —
  every wire integer a non-negative safe integer, since `Number.isInteger`
  alone accepts `1e308` — and one set of rules checks ranges and relations, so
  the PWA and the scheduler cannot disagree on one. `RelayClient` applies
  `sanitizeStatus` against the register blob's exclave count before setting
  `Machine.status`. It refuses the whole snapshot for a percent
  over 100, a `sess` that is not one count per exclave, a quota index out of
  range or repeated, or more entries kept plus trimmed (`tr`) than there are
  exclaves. It drops one observation stamped further ahead than clock skew
  (`STATUS_CLOCK_SKEW_MS`, the replay window), which would otherwise read as
  the account's newest until the clock caught up. Freshness is the consumer's
  call, never the client's: `isStatusStale` is true past three beats
  (`STATUS_STALE_MS`, 90s) or for a stamp further ahead than skew. The PWA
  shows a snapshot's age instead. `isQuotaTrimmed` says a trim happened, and
  then an exclave without an observation is unknown, not unobserved.
  **Encoding** (`MachineStatus` in `shared/src/types.ts`): the blob shares a
  2 KiB attachment and base64 costs a third, so every number is an integer
  (whole percent, unix seconds, MiB), keys are short, an unknown field is
  absent rather than `null`, and quota entries name their account by index
  into the register blob's `exclaves` rather than by the 73-char account id —
  which is why `scan` must match. Rejected: a positional tuple or bit-packed
  body (saves ~100 bytes and loses the optional-field skew tolerance every
  other blob relies on). After trimming, the daemon pads the JSON to exactly
  the payload budget with a trailing `_` of spaces, a field the parser drops,
  so every status seals to one `ct` length: every bearer-token holder receives
  every status, and an unpadded length tracked load, session counts and
  whether quota was present (measured 260–384 characters). A trim leaves
  `tr`, the count of quota entries dropped (0 when only detail went, absent
  when nothing did), because a trimmed-away exclave otherwise reads as one
  with no quota observed — and a scheduler filtering on quota would let an
  over-threshold account through. Sent every 30s whether or not an app is watching:
  one DO wake per machine per beat (the sweep alarm already wakes it every
  60s while daemons are connected), and a fresh app never waits for one.
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
    D->>R: register { deviceId, info: envelope, key, ts, sig }
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

| Frame / op                          | Sent from                                                                                | Handled in                                                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`                          | `daemon/src/relay-client.ts` (signed via `shared/src/identity.ts`)                       | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`, verified via `shared/src/identity.ts`)                                                  |
| `msg` (app→daemon)                  | `shared/src/app-client.ts`                                                               | routed by `relay/src/hub.ts`; opened in `daemon/src/relay-client.ts`; op dispatched in `daemon/src/handlers.ts`                                    |
| `msg` (daemon→app)                  | `daemon/src/relay-client.ts`                                                             | broadcast by `relay/src/hub.ts`; correlated on `re` in `shared/src/app-client.ts`                                                                  |
| `msg` (→`"machines"` broadcast)     | any PSK holder                                                                           | fanned by `relay/src/hub.ts` to registered daemons except the sender; receivers allowlist the op                                                   |
| op `update-available`               | `daemon/src/run.ts` via `broadcast()`                                                    | allowlisted in `daemon/src/relay-client.ts`; pipeline in `daemon/src/update.ts`                                                                    |
| `registry`                          | `relay/src/hub.ts`                                                                       | `shared/src/app-client.ts`                                                                                                                         |
| `undeliverable`                     | `relay/src/hub.ts`                                                                       | `shared/src/app-client.ts`                                                                                                                         |
| `forget`                            | `shared/src/app-client.ts`                                                               | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`); the registry push it causes is its only ack                                            |
| `forget-refused`                    | `relay/src/hub.ts`                                                                       | `shared/src/app-client.ts` — logged, never modelled                                                                                                |
| `"ping"` / `"pong"`                 | both socket legs                                                                         | DO auto-response — answered without waking `hub.ts`; sweep reads the timestamps                                                                    |
| envelope `seal`/`open`, AAD, replay | `shared/src/crypto.ts`                                                                   | same file — both ends share it, or nothing decrypts                                                                                                |
| ops `sessions` / `spawn`            | `pwa/src/store.ts` via `shared/src/app-client.ts`                                        | `daemon/src/handlers.ts` → backend in `daemon/src/backend-default.ts`                                                                              |
| op `rescan`                         | `pwa/src/store.ts` via `shared/src/app-client.ts`                                        | `daemon/src/handlers.ts` → the scan closure in `daemon/src/run.ts`; never reaches the backend                                                      |
| op `despawn`                        | `daemon/src/mcp.ts` via `shared/src/app-client.ts`                                       | `daemon/src/handlers.ts` → `daemon/src/despawn.ts` through the backend                                                                             |
| `status` (daemon→relay)             | `daemon/src/run.ts` via `daemon/src/relay-client.ts`: every 30s, and after each register | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`): latest kept on the socket attachment, never stored                                     |
| `status` (relay→app)                | `relay/src/hub.ts`, forwarded as it arrives; latest per daemon also rides `registry`     | `shared/src/app-client.ts` — opened like `machine-info`, bound to its `deviceId`, replay guard skipped                                             |
| op `metrics`                        | `pwa/src/store.ts` via `shared/src/app-client.ts` `metrics()`, gated and parsed          | `daemon/src/handlers.ts` → the metrics store in `daemon/src/metrics-store.ts`; sized at the transport (`#sealReply`, `daemon/src/relay-client.ts`) |

`sessions`, `spawn` and `despawn` have a second, relay-free sender: `daemon/src/local-client.ts`
over the local op socket, arriving at the same `daemon/src/handlers.ts` routing.
The daemon builds one handler per surface over a single context, so the two differ
only in the audit origin they are tagged with — see "Local op socket".

The same three ops have a third sender on a credential-delivered box, and only
there: the daemon's fleet broker (`daemon/src/broker.ts`), an app-role client acting for a keyless
`seanced mcp` that reached it over the local op socket with a broker frame — not a
`Plain`, and not on this wire. To the relay and the target it is one more app.

Layer 1 (plaintext, daemon↔relay): `register { deviceId, info: <envelope>,
key, ts, sig }` — signed afresh each time, since the relay bounds `ts` — on
connect, whenever a rescan changes the repo set or the exclaves (list or info),
and after a self-update report (the blob carries `lastUpdate`); `msg { envelope }` for routed
traffic; `status { envelope }` — the telemetry snapshot sealed to the app,
every 30s and right after each register (see Presence & identity);
literal `"ping"`/`"pong"` strings for heartbeats (bare strings, not
JSON, so DO auto-response can answer without waking — daemon pings every 30s,
expects pong within 10s, else closes and redials with 1→60s jittered
exponential backoff, reset on successful register; the relay in turn sweeps
sockets that stop pinging — see Presence & identity). The daemon authenticates
with an `Authorization: Bearer` header.

Layer 1 (plaintext, PWA↔relay): `msg { envelope }` outbound, plus the same
bare `"ping"`/`"pong"` heartbeat as the daemon leg (30s beat, 10s pong
deadline, a miss re-dials — see Presence & identity). Inbound:
`registry { entries }` pushed on connect **and on every change** (so presence
needs no polling), each connected entry carrying the daemon's latest `status`
envelope; `status { deviceId, envelope }` as each new one arrives, a small
frame rather than a registry re-push; `msg { envelope }` for daemon replies; and
`undeliverable { to, iv, code }` when the target daemon has no open socket —
or has one that is already closing, since a socket stays listed until its close
handler runs and writing to it throws. Both cases report `offline`, which the
app promotes to _proven_ offline; a reconnect blip therefore marks the machine
offline rather than leaving the request hanging, and the relay log carries the
send error that caused it.

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
  attacker can register junk under ids of their own (the PWA ignores
  non-decrypting entries), read registry metadata (machine count, deviceIds,
  last-seen) and delete entries, but cannot spawn, read prompts, or touch a
  real machine's entry or route — a register for an existing id has to be
  signed by that machine's key.
- **`forget` is authorized by the bearer token alone, and that is not a new
  hole.** An earlier revision refused a delete verb on the grounds that it would
  be the one destructive act the token authorizes, with a blind relay unable to
  demand PSK proof. Both halves of that were wrong. A registry entry is derived
  state — the daemon re-registers on its next connect and rebuilds it — so
  deleting a live machine's entry costs a reconnect, and deleting a retired one
  destroys nothing that exists. And at the time the destructive act was
  already reachable: `register` overwrote `device:<id>` for any wire-supplied
  id, so a token holder could blank a real machine's `info` with a blob that
  decrypts for nobody. Signed registers have since closed that, which leaves
  `forget` as the one thing the token lets a holder do to a real entry — and
  it still costs that machine only a reconnect. Rotating the token is still
  the answer to a leaked token; the caps (`MAX_DEVICES`, the register rate
  limit) still bound cost rather than defend.
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
  90s, despawn 20s, metrics 15s) because the right values derive from daemon internals — `exec.ts`'s 60s
  command timeout plus `spawn.ts`'s 3s pane-death check — and would silently
  drift if kept in PWA code. It is a backstop; the daemon returns a structured
  error on its own.
- **An oversized reply becomes `too_large`, for every op.** The relay drops an
  envelope whose `ct` passes `ENVELOPE_MAX_CT_LENGTH` (64 KiB, every envelope
  but `status`) unseen, which the app could only report as a timeout. So the
  daemon's transport (`relay-client.ts`) checks each reply's sealed `ct` and,
  past the bound, seals `{ ok: false, code: "too_large", message }` under the
  same `re` instead. Checked after sealing, not predicted before it, so a reply
  is encoded once and the size rule lives in one place; and at the transport,
  not per handler, because `metrics`, `sessions` and `rescan` all grow with
  data. Rejected: a per-handler check against a predicted sealed length (each
  op re-states the envelope arithmetic, and every reply is encoded twice).
  It and a crashed handler's `internal_error` are `TRANSPORT_ERROR_CODES`:
  any op can answer with that `ErrorResponse`, so every op's own code list
  spreads them, and the app-role `request<T>` resolves to `T | ErrorResponse`
  — a caller reads no field before checking, which the compiler enforces.
  Known edge, accepted: a `spawn` or `despawn` success embeds the session list
  (~200 B per entry), so past ~240 live sessions on one machine a spawn that
  happened would read as `too_large`. Machines run 10–20; trimming the list
  would be a wire change for a case nothing reaches, so the PWA and MCP word
  a spawn's `too_large` as "may be running" rather than as a failure.

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
- `metrics { from, to, step, names?, labels? }` → `{ series }` or `{ ok: false, code, message }`
  — history from the daemon's local store (Telemetry, under Daemon), Prometheus
  series at the tier `step` names, limited to the `METRIC_NAMES` in `names`.
  `labels` is Prometheus's `=`: a series is kept only if it meets every
  matcher, and a label it lacks reads as `""`. Both filters share one bound:
  at most `METRICS_MAX_FILTERS` names or matchers, each name and value
  non-empty (a label value may be `""`) and at most
  `METRICS_MAX_FILTER_LENGTH`. The store filters labels after its fixed SQL, so the
  statement never grows with a request. An account chart sends `{ account }`,
  because otherwise a machine's reply carries every exclave's quota series, and
  at 30 days hourly that is ~17 KB sealed per series. A daemon that predates
  `labels` ignores it and returns everything, and the app's `accountSeries`
  still narrows the reply.
  Advertised as `"metrics"` in the register blob's `capabilities`, and
  `RelayClient.metrics` refuses a machine without it: a daemon that predates
  the op drops it unanswered, and the timeout would mark a live machine
  offline. The one reply that scales with
  stored data, so it is bounded twice: a request spanning more than
  `METRICS_MAX_POINTS` per series is `invalid_request` before the store reads a
  row, and a reply that would seal past `ENVELOPE_MAX_CT_LENGTH` comes back
  `too_large` (the oversized-reply bullet above). Values go out to one decimal: a rollup's
  average otherwise serializes to seventeen digits, a third of the reply. Sized
  against measurement: one machine with two exclaves keeps ~14 series, and all
  of them at a day of 5-min points is ~77 KB, so a chart asks for its panel's
  `names` (the machine chart's pressure is two series, cpu and memory, ~11 KB). Rejected: a points cap alone (the
  series count grows with exclaves, accounts and models, so no cap fits every
  machine); trimming the oldest points to fit (the chart silently shows less
  range than it asked for); positional value arrays with implied timestamps
  (~3.5× smaller, and no longer Prometheus's shape). History lives only on its
  daemon, so an asleep machine's is unavailable until it wakes — accepted.

Repos are **pushed, not pulled**: they ride the encrypted register blob, so
the PWA's repo picker renders from the machine registry alone and works for
offline machines. Rejected: one combined poll op returning repos + sessions
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
  (write config skeleton + mint the identity that is the deviceId), `install`/`uninstall` (launchd plist on
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
  (daemon-owned: deviceId and the `identitySeed` it derives from, repo cache,
  scannedAt). Rejected: single file
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
  read is indistinguishable from corruption, which mints a new identity and
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
  registering as separate repos. Only main clones register: a `.git`
  directory, or a `gitdir:` pointer whose git dir has no `commondir` file (a
  submodule or `--separate-git-dir` clone — its own repo). A linked worktree's
  git dir carries `commondir`, so a sibling worktree (`~/pengefix/<repo>-pr633`,
  `<repo>-pen-2524`) stops the walk and registers nothing — it used to list as a
  repo of its own, one per worktree, in the spawn picker. A root that is itself
  a linked worktree likewise registers nothing, not even its main clone: roots
  bound what a machine exposes, and the main clone sits wherever the pointer
  says, possibly outside every root. Expose it by rooting it (or its parent).
  Any `.git` stops the walk, registered or not: one that is unparsable, names a
  git dir that is gone (a main clone deleted under its worktrees; a Windows
  `C:/…` pointer seen from WSL) or can't be read registers nothing — never
  falls back to main — and isn't descended into either.
  The test is a few file reads, no `git` subprocess per directory. Rejected:
  `git rev-parse --git-common-dir` per candidate (a process per directory
  for an answer `commondir` already holds); registering a worktree under its
  main clone's name (two paths behind one name, and spawn needs one). Measured:
  19ms for 58 repos — the walk is free (2026-10-09, one dev machine: 20ms for 33, down from
  26ms for 46 with the 13 worktrees). Scans run at startup, hourly, and on explicit
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
  Each entry also carries `origin`, the repo's identity _across_ machines
  (docs/scheduler.md keys tasks by it): `remote.origin.url` read from the common
  dir's config — the same file `git remote get-url` reads, no process — with
  scheme, userinfo and `.git` stripped, scp-style `host:path` folded to
  `host/path`, and the whole lowercased (the hosts we route to compare
  case-insensitively; a key that differed by case would split one repo in two).
  Basename when there is no remote, or only a local/`file://` one — some
  machine's mirror is not an identity. Re-read every scan, not carried
  forward: a remote does get repointed, and the read is one file. Not followed:
  `include` directives and `url.<base>.insteadOf`, so a repo that only names its
  remote through those keys by basename. Known split: the same repo over https
  and ssh on different machines keys differently (`dev.azure.com/…` vs
  `ssh.dev.azure.com/v3/…`); fold hosts when it bites.
- **Exclaves** (`daemon/src/exclaves.ts`, added 2026-10-15 for the scheduler):
  an exclave is a tree at `~/<name>` whose Claude Code config dir is
  `~/.claude-<name>`, signed into one account; `default` is `~` with `~/.claude`.
  The daemon reports which exclave each clone sits in (`RepoEntry.exclave`,
  longest named root by path prefix, `default` for the rest of `~` and anything
  outside it) and, per exclave, what its config dir says (`MachineInfo.exclaves`:
  `accountId` = `organizationUuid:accountUuid` and the extra-usage flag from
  `.claude.json`'s `oauthAccount`, `authOk` = that object's presence, `skills` =
  directory names under `skills/`). `.claude.json` sits in the config dir only
  when `CLAUDE_CONFIG_DIR` is set: `default` runs without it, so its file is
  `~/.claude.json`, and a `~/.claude/.claude.json` beside it is a stub that once
  read every `default` as signed out. Every running session rewrites its
  exclave's `.claude.json`, so a read can land mid-write: an unparsable file
  keeps the previous scan's account for that exclave (signed out only on the
  first scan), while a missing one is signed out at once — a retry would narrow
  the window, not close it. Nothing else in that file is read — it holds
  no token — and the daemon never sets a config dir: the owner's shell hook picks
  it by cwd, so location is the whole fact. **The `~/.exclaves` contract**: one
  name per line matching `^[a-z0-9][a-z0-9-]*$`; `default` is implied and a
  line saying it is stray. The daemon validates every line and skips the rest
  with one log line, so a stray line costs one exclave, never the scan; a listed
  tree that doesn't exist yet is still an exclave (signed out, no clones). The
  file has two readers — the owner's dotfiles maintain it, the daemon only reads
  it — and this paragraph is the agreement between them: a format change there
  is a daemon change here. Read with every repo scan (startup, hourly, `rescan`)
  from one reading, so the blob's `exclaves` and each repo's tag never come
  from two versions of the file — `status` quota entries index into that list
  (Presence & identity, "Encoding") — and a change in either re-registers, as a
  new clone does. Rejected: an mtime watch on `~/.exclaves` (the hourly scan is
  the cadence everything else in the blob already has, and a sign-in changes
  `.claude.json`, not the list); reporting the config dir path (derivable, and
  the app has no use for a path it can't open).
- **Telemetry** (`daemon/src/telemetry.ts`, `daemon/src/metrics-store.ts`, added
  2026-10-15 for the scheduler): every `STATUS_INTERVAL_MS` the daemon samples
  cpu, memory and disk pressure as whole percent, disk free and I/O rates,
  running sessions per exclave (by pane path, so a session outside every
  registered repo still counts where it sits) and the newest quota observation
  per exclave — in M1 only what Claude Code itself cached in each exclave's
  `.claude.json` (`cachedUsageUtilization`: the 5h and 7d windows, and the
  per-model weekly caps from its `limits`, keyed by display name since the id
  is not cached; source `cache`, stamped at its fetch time, capped a minute past
  now so one far-future stamp can't stay "newest" for an account). The three pressure
  numbers are smoothed daemon-side over ~2 min with a time-aware weight, so a
  laptop back from sleep resets to its first reading instead of trusting a stale
  average, and no reader keeps a window of its own. Collectors are exec-free
  where the host allows — macOS memory is the one exec, `/usr/sbin/sysctl`
  once a tick: `os.cpus()` deltas, `/proc/meminfo` (`MemAvailable`)
  or, on macOS, `100 − kern.memorystatus_level` (the kernel's free percentage —
  what jetsam acts on and `memory_pressure` prints), `statfs` over the configured
  repo roots reporting the fullest volume, `/proc/diskstats` over whole devices.
  A field the host can't answer is absent — the first tick has no cpu or I/O
  delta, macOS has no exec-free I/O counter, a tmux outage drops `sess` for the
  tick — never a guess: a failed collector drops its field and stores no
  sample rather than repeating its average, and the next reading eases from
  that average over the whole gap since the last good one. Rejected for macOS:
  free + inactive + speculative pages
  from `vm_stat` — file cache and the compressor hold most of an idle Mac's RAM,
  so it read ~70% used on a 48 GB Mac the kernel rated at normal pressure, and
  `machine_pressure` would have steered work away from it. Every sample also
  lands in `stateDir()/metrics.sqlite` (`bun:sqlite`; created as an empty 0600 file before SQLite opens it, so the
  WAL inherits the mode) under `METRIC_NAMES`, Prometheus's data model and
  nothing else — metric, label set, timestamp, number — in three tiers sharing
  `METRICS_STEPS`: raw 30s for 48h, 5-min averages for 30d, hourly forever.
  Each tier is keyed `(ts, series)`, because every rollup, prune and query is a
  time range — keyed series-first, each rollup was a full scan plus a sort, ~3 ms
  and ~150 KiB of WAL a tick. The key is gated on `PRAGMA user_version`: a store
  below it has its tiers dropped and recreated rather than migrated (their
  history began 2026-10-15), since `IF NOT EXISTS` would keep the old key.
  Each write re-rolls every bucket from its oldest new sample onward, across
  all series, from the tier below,
  so a quota observation stamped hours back still lands in its own hour, and the
  same observation re-read every tick is one row and widens no rollup; one
  stamped past the raw tier's 48h is dropped (the same write would prune it,
  and a cached stamp days old would otherwise re-enter and re-roll every tick),
  and a rollup never re-averages a bucket the prune horizon has cut into. The
  config file is re-parsed only when its stat changes. Each sample goes out as the
  `status` frame (Presence & identity), stamped with the `scannedAt` of the
  blob last registered — `state.scannedAt` moves on every hourly
  rescan while a re-register happens only on a changed set, and a reader drops
  a status whose stamp disagrees with the blob it holds — and trimmed to the
  relay's bound when a machine's exclaves outgrow it (`daemon/src/status.ts`:
  per-model windows, then reset stamps, then quota from the last exclave down,
  marking the status with `tr`; pressure and sessions always fit, and the trim
  is logged once) and then padded to one sealed length. Sent after
  each register too, re-arming the beat so the next lands past the relay's
  floor: the register just changed the blob a status indexes, and the registry
  push an app got carries no snapshot until this one. The stamp and the
  exclave list it indexes are one value (`Registered`, `telemetry.ts`),
  committed by `run.ts` once the register frame has left and read once as a
  tick starts, so a register mid-tick can't pair one scan's indexes with
  another's stamp; a tick asked for after a register waits out the one in
  flight rather than sharing it. History is the
  `metrics` op's. Nothing routes from this store — the scheduler reads only the
  latest `status` — so a Prometheus + Grafana stack later is one more consumer
  (an exposition endpoint, or remote write, since daemons dial out and laptops
  roam), not a redesign. Not built: PSI and cgroup v2 views in an LXC, the
  Proxmox node view (docs/scheduler.md, M4), macOS I/O rates. Rejected: the 1-min load average as cpu (counts runnable
  tasks, so it exceeds 100% and on Linux includes I/O wait); `os.freemem()` on
  macOS (free pages only, a fraction of what is reclaimable); a fixed EMA alpha
  (sleep gaps); a positional store schema (a new metric must cost nothing but a
  name).
- **Session detection**: list all tmux panes across all sessions, dedup by
  window id (grouped sessions repeat windows), count a window as a session by
  one predicate, `isRegistered` in `sessions.ts`, which the spawn path shares.
  Registration is the pane title: claude sets its terminal title
  (`✳ <session>`) only once its TUI is up, past every startup gate, and a séance
  pane runs `exec claude` straight from tmux with no shell to set one earlier, so
  until then it carries tmux's default, the hostname. `PANE_TITLED` (`tmux.ts`)
  makes that comparison inside tmux — `#{?pane_title,#{?#{==:#{pane_title},#{host}},0,1},0}` — so
  no title text reaches the format output. A window séance started (the
  `--remote-control` start-command match below) registers on the title alone:
  nothing else ever runs in that pane, and what tmux calls its process is the
  host's business, not claude's — macOS tmux reads the kernel's comm, the
  _resolved_ executable's basename, so the native installer's versioned
  filename (`2.1.267`), or `caffeinate` since the spawn line wraps claude in it
  there; Linux and WSL tmux read argv[0], the symlink name `claude`; an npm
  install is `node`. A pane séance did _not_ start must also show a
  claude-named process (`claude` or a version string) — a title alone would
  count every pane under a title-setting shell, and a pane whose claude exited
  to a shell that never reset the title. `node` is deliberately not on that
  list: a dev server under oh-my-zsh is `node` + titled, and would have been
  listed with a repo mapping; a hand-started npm claude is the cost. Repo
  attribution is one rule (`repoFor` in `sessions.ts`): a pane inside a linked
  worktree — walking up past any non-worktree checkout (a submodule or vendored
  clone inside it) to its `gitdir:` → `commondir` — belongs to the registered
  repo with the same common dir; otherwise the longest registered path prefix.
  The common dir is the match, not a path derived from it: a
  `--separate-git-dir` clone's or a submodule's isn't `<main>/.git`, and nothing
  in it points back to the main working tree. One rule covers both layouts —
  `<repo>/.claude/worktrees/<name>` and the sibling `<root>/<repo>-<name>`,
  which the scan doesn't register so no prefix reaches it — replacing a
  `/.claude/worktrees/` path marker that only knew the first. A
  `.claude/worktrees` pane whose worktree was removed under it, or a worktree
  of an unregistered repo inside a registered one, still maps by prefix. The
  list is rebuilt on every request, so resolution is file reads only and
  memoized — per pane path and per repo path, pruned to the live set each
  listing, holding promises so overlapping listings never prune what another
  is reading. A null an I/O error produced isn't kept. Rejected: a second
  marker for sibling names (`<repo>-*` guesses — `api-v2` is a repo, not a
  worktree of `api`); deriving the main clone as the common dir's parent (fails
  the separate-git-dir and submodule cases above); `git rev-parse` per pane (a
  subprocess per listing per pane). Undocumented conventions; if a release changes them the
  list goes visibly empty and the pattern is a one-line fix. Both formats
  (`#{==:}`, tmux 2.9; `#{m:}`, 3.1) render literally on an older tmux rather
  than failing, which reads as untitled/not-ours: the list is empty and every
  spawn acks `pending` — `doctor` probes both and fails on such a host rather
  than leaving that to be inferred. Superseded (2026-09-10): the
  belief that claude _retitles its process_ to its version string. It never did
  — that was macOS's comm reporting the binary's filename — so on Linux the
  regex matched nothing and every machine read as idle, while on macOS the
  "title" was there from exec and a stuck claude was listed as running. The
  test stub reproduced the macOS shape on every platform (a copy of bun named
  `9.9.9`), which is why the suite was green throughout; it now execs with
  `-a claude` and titles its pane, showing each host its real face. Rejected:
  daemon-tracked window ids (manual `/spawn` windows invisible — defeats
  duplicate avoidance; union variant adds id-reconciliation state for a hedge
  the visible breakage already covers).
- **A spawn that starts but never registers is reported, not swallowed**
  (added 2026-09-04). The two liveness notions disagree in exactly one case: pane
  verification asks `pane_dead`, so a claude blocked on a startup dialog no
  remote can answer is "alive" and the spawn acks `ok`, while session detection
  wants the title such a claude has not set. The phone got a success and an
  empty machine. `spawnSession` polls the pane for _either_ death or the title
  until its deadline (`awaitRegistration`, calling `isRegistered` for a window
  that is ours by construction — the same call the session list makes for it,
  so a `registered` outcome is a window the ack's list contains)
  and returns the moment the title lands; only a pane that reaches the deadline
  alive comes back `registered: false`. The ack then carries `pending: true`
  plus a `note` holding the pane's visible screen, so the dialog itself is
  readable from the phone — the screen (`SessionBackend.capture`) rides the wire
  only, because the seed prompt renders in that pane and prompt text is never
  logged. `pending` is a separate flag rather than a note the clients
  pattern-match, because it changes what each surface _says_: the PWA verdict
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
- **Pane classifier** (added 2026-10-09, `classifyPane` in `sessions.ts`): what a
  pane is _doing_, for the code that acts on sessions rather than lists them —
  closing one window (`despawn`) and cleaning up after many (`reap`). Six states:
  `dead` (`pane_dead`, which exists only while remain-on-exit holds the pane),
  `shell` (a pane séance did not start whose foreground is no longer
  claude-named — claude exited back to the shell that ran it; never one of ours,
  where claude _is_ the pane's process because the spawn line `exec`s it),
  `starting` (alive, untitled — the stuck window above, which `doctor` now finds
  through the same predicate), and three that only the screen can tell:
  `exit-prompt`, `background-prompt` and `live`. The exit prompt is why this
  exists. `/exit` in a worktree removes the worktree and exits silently only for
  an _unnamed_ session with nothing to lose; a named one asks "Keep worktree /
  Remove worktree" and waits, and every séance session is named (`-n`, and
  `/rename` names one too). Claude stays alive on that dialog, so the window
  outlives the exit the phone asked for. The title can't tell it from an idle
  claude, so it is a `capture-pane -p` of the visible screen (the TUI is on the
  alternate screen; no scrollback). Recognised as heading above both options with
  the last option within 3 non-blank lines of the bottom: the dialog replaces the
  input box, leaving only its hint line under the options, plus a line of slack
  for a wrapped option description. Anchoring there is what stops a transcript
  that merely _quotes_ the prompt — a session working on this very code — from
  reading as one, since claude's input box (four lines) always sits under what it
  printed. Wording and layout checked against a real 2.1.295 (2026-10-09), where
  Enter on the preselected Keep exits 0 and leaves the worktree; a release that
  rewords it reads as `live`, which callers only ever report. It counts only
  with the cursor (`❯`) on Keep: Enter takes whatever is highlighted, and a
  prompt someone arrowed to Remove and left must never be answered blind by a
  3am reap. `live` covers idle and mid-turn alike:
  the title glyph that would separate them is kept out of the format output by
  `PANE_TITLED`, deliberately. The capture costs one tmux exec per pane, so the
  classifier is cheap first — the list-panes fields settle `dead`, `shell` and
  `starting` without one — and stays off the session list's path entirely: the
  list runs on every phone refresh and needs none of this. On macOS `pane_pid`
  is `caffeinate`, with claude as its child — whatever kills a pane has to
  account for that.
- **Despawn** (designed 2026-08-21, built 2026-10-09; `despawn.ts`): ends one
  session — the window only; its worktree and branch are `seanced reap`'s. The
  wire op `despawn { id, force?, client? }`, `seanced despawn <id> [--force]`
  and the MCP tool `despawn_session` all reach `SessionBackend.despawn`. No PWA
  or Raycast surface. The target is `SessionEntry.id`, the tmux pane id, which
  the session list now carries (optional on the wire, so an older daemon simply
  omits it). A wire-supplied id must match `^%\d+$` before tmux sees it —
  `-t` would also resolve `main:1.0`, `{marked}` or `=name` — and must name a
  pane the session list's own predicate (`isRegistered`) accepts, so despawn
  reaches exactly what a list offered; `invalid_target` and `session_not_found`
  are security outcomes in the way `repo_not_found` is. Graceful first, then
  force, and the reply says which happened (`outcome: "exited" | "killed"`):
  Esc (interrupts a running turn), Ctrl+C (clears the draft), literal `/exit`,
  Enter, then a ~5s poll through the pane classifier. The Ctrl+C is not in the
  2026-08-21 decision and was added on measurement: one Esc does _not_ clear a
  draft on 2.1.295 — it only arms "Esc again to clear", and a second Esc clears
  only inside a short window — so `/exit` was appended to whatever was typed
  and Enter sent the lot as a prompt. Ctrl+U clears one line of a multi-line
  draft; Ctrl+C clears it all, and on an empty box only arms "press again to
  exit", which typing disarms. A named worktree session then stops on the exit
  prompt, answered with Enter on the preselected Keep (exit 0, worktree kept),
  never Esc, which cancels the exit; a pane already on that prompt gets Enter
  alone for the same reason. A hand-started claude exits back to its shell
  (`shell`), and the pane is closed with it, since closing the window was the
  request. Past the grace, or with `force`, `kill-pane` — the pane, not the
  window, so a split's other panes survive. The pty closing sends SIGHUP, which
  is what normally ends claude; but on macOS the pane's process is `caffeinate`
  and claude its child, so a claude that ignores SIGHUP would outlive its window
  with no parent. The pane's process and its children (`pgrep -P`, absent on a
  minimal Linux image, where only the pane's own process is watched) are
  recorded before the kill and escalated to SIGTERM, then SIGKILL, if they
  outlive it; a test asserts it with a SIGHUP-ignoring stub under real
  `caffeinate`. Audited like spawn (`despawnAudit`): request with the target
  quoted, then outcome with the window. An older daemon ignores the unknown op,
  so a despawn aimed at one rides the 20s `OP_TIMEOUT_MS` backstop. Known
  limits, accepted for now: the "Background work is running" dialog is not
  answered (choosing between stopping the tasks and backgrounding them is not
  despawn's call), so such a session waits out the grace and is `killed`; the
  escalation watches one level of children, so on macOS — where that level is
  claude itself — claude's own children (MCP servers, background shells) are
  left to claude's SIGHUP/SIGTERM handling; and pids are signalled up to ~4s
  after they were recorded, a reuse window that signalling by pid can't close.
  A dead pane (remain-on-exit) reports a long-reaped `pane_pid`, so nothing is
  watched there at all. The grace poll asks tmux about the one pane
  (`paneInfo`), not the whole server. Rejected:
  `kill-window` (takes a split's other panes along); targeting by window name
  (wire text, not unique); answering the exit prompt with "Remove worktree"
  (deletes work — reap removes worktrees under its own rules).
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
- Config file: relay URL, bearer token, PSK, machine name, repo roots; the
  deviceId's seed lives in state.json.

## Reap (`seanced reap`) — designed 2026-10-09

Remote sessions leave residue: linked worktrees, the branches they were on,
and séance windows that never closed (see the exit prompt under "Pane
classifier"). `seanced reap` cleans up all three, by default acting and with
`--dry-run` previewing — a dry run writes nothing, a fetch's refs included, so
it judges by the refs on disk. Code: `reap.ts` (orchestration, report, lock),
`reap-git.ts` (every git call).

- **Scope is the scan set** (`repoRoots`), the same repos the phone can spawn
  in, enumerated per main clone through `git worktree list --porcelain -z` —
  which reaches both layouts in use, `<repo>/.claude/worktrees/<name>` and a
  sibling `<root>/<repo>-<name>` that the scan doesn't register (see "Repo
  discovery"). `git worktree prune` clears entries whose directory is gone.
- **Windows first.** Séance windows only (`OURS`); a hand-started pane is never
  reap's to close. A `dead` pane goes once it has been dead a minute — younger,
  it may be `spawnSession`'s own, held by remain-on-exit while it checks
  registration (a tmux with no `pane_dead_time` leaves it alone). A claude on
  the worktree exit prompt is re-classified right before the key, then
  answered with Enter on Keep: it exits and the window closes, and the
  worktree it kept goes through the rules below on a later run, once it is
  old enough. The background-work prompt, a live claude (idle or working,
  archived from the app or not) and a stuck one are reported with the pane id
  `seanced despawn` takes, never acted on.
- **A worktree is removed only if all hold**: not locked; no tmux pane's cwd
  inside it (any pane, hand-started included); its branch — or detached HEAD —
  merged by the rules below; untouched for `reap.minAgeDays` (default 7); and
  clean — reap's `status` pins `--untracked-files=normal`, because git's own
  clean check honours `status.showUntrackedFiles=no` and would delete
  untracked files unseen. Removal is `git worktree remove` without `--force`,
  so git's own refusal (changes, submodules) is a second gate, reported as a
  failure. Ignored files don't count as dirty and are lost — a copied `.env`
  among them, accepted. Dirty worktrees are reported, never removed.
- **"Untouched"** is the newest mtime among the worktree's git-dir `HEAD`,
  `index` and reflog, the worktree root, and the newest Claude transcript for
  its path (`~/.claude/projects/<path, non-alphanumerics as dashes>`). It is
  read before reap's own `status`, and every reap git call sets
  `GIT_OPTIONAL_LOCKS=0`, so measuring the age doesn't reset it. The transcript
  is the cheap answer to a session outside tmux — an editor's claude, a plain
  terminal — which the pane check can't see: a few `stat`s cover any claude
  wherever it runs. Rejected: a process-cwd sweep (`lsof -d cwd`), which on
  macOS costs a second or more per run and still misses an editor whose cwd is
  elsewhere; the age gate is the backstop for what neither sees.
- **Branches**: every local branch except the default and anything still
  checked out — a worktree removed in this pass frees its branch for the same
  pass. Merged, against `origin/<default>`, means one of: an ancestor; or
  squash-equivalent — `git merge-tree --write-tree` of the tip into the default
  branch yields the default branch's own tree, i.e. the combined diff is
  already there, which is what a squash-merged PR leaves (local, no `gh`; a
  conflict or a git without `--write-tree` reads as not merged, the safe side);
  or upstream gone with every commit's patch upstream (`git cherry` shows no
  `+`), which catches a rebase-merge once the default branch has since edited
  the same lines and the tree check conflicts; or upstream gone and the tip's
  whole diff from its merge-base has the patch id of one non-merge commit on the
  default branch since that merge-base — the squash the tree check misses once
  those lines were edited again. Only commits after the fork count, so a branch
  re-applying a since-reverted change isn't taken for it. Main's patch ids are
  computed once per commit per pass, shared by every tip. Patch ids hash context
  lines too, so a squash is still missed when main edited lines next to the PR's
  hunks before it landed — kept, the safe side. Upstream gone with
  commits whose patch is nowhere upstream is unpushed work: kept and reported —
  a branch stacked on another PR's branch included, since its diff carries the
  parent's changes and matches no one commit. Deletion is
  `update-ref -d <ref> <sha>`, a compare-and-delete that refuses a branch that
  moved since it was judged, then its config section, as `git branch -D` would.
  Every deletion's audit line carries the full tip sha — `git branch <name>
<sha>` is the recovery.
- **Network**: `git fetch --prune origin` only when the newest `FETCH_HEAD` (the
  clone's, or a worktree's own) is over a day old — Claude Code's rule for its
  own `--worktree` fetch. It must not hang on credentials: stdin ignored,
  `GIT_TERMINAL_PROMPT=0`, a 30s timeout; a failure is reported and the run
  judges by stale refs, which only ever makes fewer things look merged. A repo
  with no `origin/HEAD` on disk (about a third) gets `git remote set-head origin
--auto`, bounded the same way, since "merged" needs something to measure
  against; still none, and the repo is skipped and named.
- **Repo-local config executes.** Reap is the first thing to run git in every
  scanned repo, and git runs what a repo's config says. `core.fsmonitor` (a hook,
  or a daemon per worktree) and hooks (`reference-transaction` fires on the
  ref updates reap makes) are off for every call (`-c core.fsmonitor=false -c
core.hooksPath=/dev/null`). What still runs is what a fetch needs —
  credential helpers, `core.sshCommand`, `remote.*.uploadpack`. These are the
  owner's own clones, so the residual risk is low, and recorded here rather
  than defended further.
- **Bounded**: four repos at a time (`mapLimit`, shared with the scan in
  `concurrency.ts`), four panes at a time for the screen captures; nothing
  here is on the session list's path.
- **One at a time**: a lockfile in the 0700 run directory, `link`ed into place
  already holding the pid — an `O_EXCL` create then a write reads empty in
  between, which a contender would take for a dead holder. A holder that is
  gone is a crashed run and is taken over. The CLI exits
  on a live one; the schedule skips and tries again at its next check.
- **Surfaces**: `seanced reap [--dry-run] [--min-age-days <n>]`, audited
  `origin=cli`, and a timer inside the daemon, audited `origin=schedule`, which
  logs its report one `reap:` line at a time. The schedule is off unless
  `reap.intervalHours` is set; it checks every 10 minutes against `lastReapAt`
  in state.json rather than running on an interval from start, which the
  daemon's frequent restarts (updates, config reloads) would keep deferring,
  and a stop aborts it between repos. Not on MCP, deliberately: a local session
  can already run the CLI through Bash, so a tool would add discoverability
  but no authority, and leaving it out keeps the local socket's allowlist at
  the three ops it has. No relay op, no PWA. Rejected: `--force` removal, a
  `gh`-based merge check (network and an auth dependency for what the local
  objects answer), and an MCP tool (above).

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
  verdict, the Settings screen and the Machines screen stacked over it all push on open and are cleared by
  `popstate`, so Android back dismisses the layer instead of exiting the app.
  History outlives the document, though: a reload (a service-worker update, saving
  credentials) or Android restoring a discarded PWA resumes on a layer entry with
  nothing open, and back from the form then lands on an entry the app has nothing
  to close for — no exit, just a blank screen. So each entry carries the pushing
  document's random `owner` id and the layer `depth` it was pushed at. An entry
  some other document pushed is stale by definition: at launch, and whenever back
  lands on one, the store closes everything and `history.go(-depth)`s past it to
  its base. That base is the entry back from the form must leave through. Entries
  can't be deleted, only skipped, and skipping is invisible because they are all
  the same URL. One of this document's own entries reached by Forward after its
  layer closed is skipped the same way, since the entry alone can't reopen it. A
  layer that is already open is replaced in place rather than pushed again, so one
  layer never costs two backs. Retry is the one close that doesn't go back: a
  back is delivered later, and would close whichever verdict had landed by then
  (a rescan with no socket fails at once). It keeps the failed verdict's entry for
  the next layer instead, and gives it back only if the retry ends without one.
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
- **Machines is a layer over Settings, not a route** (scheduler M1). Until the app's
  redesign it is reached from a row at the top of Settings, pushed as a second layer, so back
  returns to Settings; the stage animates between any two depths. Rejected for now: URL routes
  (`/machines`), which would need boot-time path parsing and a rethink of entry depth for deep
  links — a separate change if links are wanted.
- **Machines show load, accounts show quota.** A machine card carries CPU and memory bars and
  its exclaves (account, running sessions); quota is a property of an account, not of any
  machine, so it sits on account cards: one per `accountId` across the fleet, newest
  observation wins, since every daemon hosting one of its exclaves reports it. A window whose `resets_at` has passed shows 0% and
  "reset", however full the reading was — a cache reading can be hours old, and its
  percentage describes a window that no longer exists. Charts follow the split — HISTORY on a machine asks
  that daemon for `cpu_pct`/`mem_pct`; on an account it asks one online host of the account
  (the newest observer when it serves `metrics`) for the quota series and folds its exclaves'
  copies into one line per window. One chart at a time, its window fixed when asked, a reply
  that lands after the chart moved on is dropped. Disk is collected and stored but never
  shown: a fill level is upkeep, not load — it feeds the scheduler's free-space floor and
  M4's health alert instead. The chart is inline SVG geometry (`chart.ts`), no charting
  dependency; gauges break their line at a missed tick, quota holds its level between
  observations, since a sample carries the observation's time, not the tick's.
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
  be live. Never while the request is still in flight: a `status` beat or
  registry push mid-spawn would otherwise spend the record on a question the
  reply is about to answer, flashing a "dropped" verdict over a healthy spawn
  and leaving nothing to reconcile if the reply really is lost. A refused
  delivery is reported as a known no, separately.
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
  non-extractable, same as the PWA. Where the key exists only as a credential
  systemd delivers to the daemon's unit, `seanced mcp` — launched by Claude
  Code, outside that unit — resolves nothing; it then reaches other machines
  through the daemon instead ("Fleet broker", below, 2026-10-14). Before that it
  reached only its own box there.
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
  because repos ride the register blob), `get_sessions { machine }`,
  `spawn_session { machine, repo, prompt?, title?, mode?, model?, effort?, plan? }`
  and `despawn_session { machine, id, force? }` (added 2026-10-09, see
  "Despawn") mapping 1:1 onto the `sessions`/`spawn`/`despawn` ops with the existing
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
  `spawn_session` is not, and nor is `despawn_session`, which can end a
  session mid-turn on any machine. Rejected: a server-side `--allow-spawn` flag
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
  where MCP deliberately goes through the daemon rather than holding the key.
  Without the scrub any session could read that tmpfs and hold the key itself,
  so keeping it in the daemon is enforced by this scrub and nothing else. Note
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
  back; the ops it may ask for are `sessions`, `spawn` and `despawn` and nothing
  else. `despawn` joined on 2026-10-09, deliberately — widening this list is a
  threat-model change, so the reasoning is kept here: without it the
  `despawn_session` tool cannot end a session on the box it runs on whenever the
  relay is out of reach, which on a credential-delivered machine was then always
  (the fleet broker below came later, and self-targets still bypass it); and
  it is the same kind of op as `spawn`, an action on this box's own tmux,
  recorded `origin=local`, granting nothing a same-uid process lacks (it can
  `tmux kill-pane` directly). `rescan` is out of scope and `update-available` is
  refused structurally — it is fire-and-forget, drives the self-updater, and
  must not be reachable from a surface whose premise is skipping the envelope.
  Same posture as the broadcast allowlist in `relay-client.ts`. Rejected: a
  crypto oracle (seal/open on request), which is what the open item warned
  against — same-uid peers make it unpoliceable, and it hands out the relay's
  whole reach rather than three ops against this box.
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
  less: three named ops, no way to address another machine, no way to reach the
  `"machines"` group address, and every request recorded. What it adds is that
  going through it is the _recorded_ way in — hence `origin=local`, and hence the
  origin on the `audit request` line too. True of the three `Plain` ops; the
  fleet broker below is the one deliberate exception, served only by a daemon
  whose key is service-delivered, and says so.
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
  alone plus a note. That is not a nicety: with the relay down, a model that can
  see no machine cannot spawn on the one it is sitting on either. The entry's
  `connected` is probed, not assumed — a connect to the op socket, no op sent,
  nothing audited — because local ops ride that socket: with no key and no
  daemon to broker for it, the daemon being down is often _why_ the fleet is out
  of reach, and then this box cannot spawn either. The note says so rather than
  promising local spawns (2026-10-15, after a manual acceptance on a
  credential-delivered box found both the note and the broker advice claiming
  otherwise). When the broker itself failed, its error already observed the
  daemon on that same socket, so its verdict sets `connected` and the advice
  stands as the note: a second probe could race a restart and contradict it in
  the same answer. Only a connection the daemon took and then never answered
  (`daemon_timeout`) or dropped (`daemon_closed`) leaves it open and is probed —
  and neither promises local spawns, since the peer's deadline outlasts
  everything the daemon waits on, relay included, and silence is the daemon's.
- **The PSK is resolved lazily**, on first remote use rather than at startup.
  A key found is memoized; "no key here" is re-asked after a minute, so a locked
  keychain can be retried without re-running a refused TPM unseal on every call.
  Local ops need no key. It also narrows the threat-model addendum above: for
  local work the MCP process never holds the PSK, and on a credential-delivered
  box it never holds it at all.
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

### Fleet broker (`daemon/src/broker.ts`) — designed 2026-10-14

On a credential-delivered box `seanced mcp` can read no PSK, so on its own it
reaches only the machine it runs on. The broker gives it the rest of the fleet: a
second frame kind on the same socket, through which the server asks the daemon for
the registry or for one of three ops on one other machine, and the daemon makes that
request itself as an app-role relay client with the key it imported at start.

- **Only on a daemon whose key is service-delivered.** `run.ts` builds the broker
  when its own `loadPsk` answered `source: "credential"`, and nowhere else: on
  macOS, WSL and Linux with a config-field or user-unsealed `tpm` key, `seanced mcp`
  reads the key itself and goes direct, so a broker there would add no reach — only
  same-uid authority that skips the key store, and an app-role relay surface in the
  daemon. Those daemons construct no broker and no app-role client at all; a broker
  frame gets `broker_disabled`, its own code rather than `unsupported`, so the MCP
  side can say "read the key here" instead of "update seanced" without matching
  message text. Decided by the source the daemon imported, never by probing: a
  config field beside a credential wins in `loadPsk`, and then MCP reads it too.
  The source means only that `$CREDENTIALS_DIRECTORY/seance-psk` held the key, so a
  hand-set variable or a plain `LoadCredential=` makes a broker where MCP could read
  the key after all — no extra reach, since writing that file takes the PSK.
  Rejected: running it everywhere, as first shipped — it was never needed there.
- **This widens the socket's authority, on purpose, and only there.** A same-uid
  process on a credential-delivered box can now spawn and despawn on every machine,
  which before it could not — it could not read the key. That is the product
  decision: a Claude session on that box is meant to drive the fleet, exactly as it already does on
  macOS and WSL, where it reads the key outright. The gate is the one MCP always had,
  Claude Code's per-tool approval. What the same-uid process still cannot do is
  hold the key: read it, derive it, seal or open anything, address the `"machines"`
  group, or send any op but `sessions`/`spawn`/`despawn`. Strictly less than the key
  it would have on any other platform, and every request recorded.
- **A separate app-role connection, not the daemon's own socket.** The daemon's relay
  leg is daemon-role: it registers and answers, the relay never pushes it the
  registry, and it cannot address another daemon. Being an app is the only way to
  reach one, so the broker is a fourth app-role client (beside the PWA, Raycast and
  `seanced mcp`) over the shared `RelayClient`, built with the daemon's
  already-imported `CryptoKey` — never a second store lookup or TPM touch. Lazy and
  idle-closing like `seanced mcp`'s (`daemon/src/app-relay.ts` holds both), shared by
  every MCP process on the box, stopped with the daemon handle so a reload builds a
  fresh one and leaks none.
- **Semantic, allowlisted, fail-closed.** Two actions: `machines` (the decrypted
  registry) and `request` (`remoteOp` ∈ `sessions`/`spawn`/`despawn`, to an exact
  `deviceId` this daemon's key can read — never a name, `"app"`, `"machines"`, or the
  daemon's own id, which belongs on the local op path). The payload is validated with
  the handler's own checks and rebuilt from the validated fields, so nothing else a
  peer adds reaches the wire. `client` is stamped `"mcp"` by the broker, never copied
  from the peer, so the target audits the spawn as `origin=relay client="mcp"`
  exactly as a direct MCP spawn — and a same-uid process cannot pass as the PWA. Rejected: a crypto
  oracle (seal/open on request) — same-uid peers make it unpoliceable, and it is the
  key's whole reach; raw relay forwarding (`{to, op, plaintext}`), which is the oracle
  by another name; a transient systemd service per MCP call to receive the credential
  (root on every call, and the key in another process); copying the PSK into a store
  the user can read (undoes the sealing).
- **Never a `Plain`, never an `OpName`.** A broker frame is `{v, kind: "broker", id,
action, …}`; the remote op rides in `remoteOp`, there is no `ts`, and the socket
  routes on `kind` before the `Plain` check. So no broker verb can arrive from the
  relay, no relay op can be smuggled in as a broker action, and — the reason for
  `remoteOp` over `op` — a daemon that predates the broker sees a malformed frame and
  drops it, where a `Plain`-shaped one would have run a _local_ spawn for a request
  meant for another machine.
- **Its own audit origin.** `audit broker origin=local-broker` with action, op, target
  and client — never the payload, so never the prompt. Not `local`: a `local` line
  says this box's tmux was touched, and a brokered spawn touches someone else's.
- **Structured failures, and honest ones.** Refusals, relay trouble and shutdown are
  codes, and a `RequestFailure` crosses with its reason so the MCP side renders it
  exactly as the direct path does — a relay timeout still reads "may have landed
  anyway". Losing the daemon mid-request, or its deadline passing, on a spawn or
  despawn says the same; nothing is retried, on either path. Two stop codes keep
  the certainty apart: `shutting_down` is a refusal before anything was sent, so
  the request certainly did not happen; `stopped_in_flight` means it was already
  out and reads as possibly landed. The latter is best effort — the local socket
  closes in the same tick the broker stops, so a peer normally sees the connection
  drop (`daemon_closed`, also read as possibly landed) rather than the reply. A handler that throws
  still answers. The peer's deadline is the daemon's connect and registry-settle
  budget plus the op's own timeout plus margin, so a slow first connect never cuts
  off a spawn still on its way. In flight is capped at 16; past it a request is
  refused as `busy`, not queued.
- **Transport choice in `seanced mcp` (`daemon/src/fleet.ts`).** Direct when this
  process resolves a key, which keeps macOS, WSL and readable-Linux exactly as
  before; the broker only when the lookup returns none — a typed null, never an error
  string. The choice is made before anything is sent. A direct failure (bad token,
  dead relay) is reported as itself and never retried through the daemon, and the
  registry is re-fetched per call, so a session that outlives a daemon restart
  recovers on its own. Self-targeted ops never reach either transport.
- **Compatibility.** No relay, PWA, wire-protocol or MCP-registration change. An old
  daemon drops the frame and closes; the server's `machines` probe — side-effect free
  — is where that is read as "update seanced". `doctor` reports which path MCP takes
  from the shell, probing the broker only when it is the one. A self-update restarts
  the daemon, not a running `seanced mcp`: an MCP older than `broker_disabled` parses
  the unknown code as an unreadable reply ("a mismatched seanced version?"), which a
  new Claude session resolves; on a credential-delivered box nothing changes.

Untested in CI: the systemd-credential arrangement itself (TPM, `LoadCredentialEncrypted=`,
an unprivileged LXC). The e2e suite runs a keyless MCP against two real daemons, but the
"keyless" is a seam, not a sealed blob.

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

## Claude Code mods (`claude-mods/`) — designed 2026-10-09

Function-hook plugins ("mods") for the Claude Code sessions séance spawns. One
today: **tmux-rename**, which keeps a `/rename` tagged and renames the session's
tmux window to the untagged name.

- **Why it lives here, not in dotfiles**: it extends a séance decision ("Session
  name vs window name" above) — the session is named `slug (machineTag)`, the
  window `slug`, and a `/rename` should keep both shapes: tagged for the
  cross-machine lists, bare for the window. Kept in dotfiles it would restate séance's name
  format in a second repo with nothing tying them together, and the format has
  already changed once (`@` → parens). Only séance knows the tag, so only here
  can the mod add exactly it.
- **`/rename abc` and `/rename abc (tag)` mean the same**: session `abc (tag)`,
  window `abc`. The mod rewrites the command's args before Claude Code's own
  `/rename` runs. Changed 2026-10-09: the first version only stripped the tag
  for the window, so a `/rename` without it left the session untagged.
- **The tag reaches the session as `SEANCE_MACHINE_TAG`**, from two places
  (the value is the slugified tag, the same `machineTagSlug` the session name
  uses, empty when untagged). Each daemon start — boot and every config reload —
  sets it in the tmux server's global environment (`set-environment -g`), so a
  `claude` run by hand in any later window carries it too: the mod has to work
  in every session, not only spawned ones. The daemon creates the session group
  first when no server is up, since it starts at login before any terminal and a
  value set on no server is lost. A tmux server started later — the first one
  killed, a reboot's terminal racing the daemon — begins with an empty global
  environment, and tmux has no server-start hook to listen on, so the daemon
  also re-sets it every minute (`republishMachineTag`); that one never creates a
  server, since with none up there is nothing to tag. Each spawn also passes it
  with `tmux new-window -e` (argv, never the shell string), so a spawn never
  depends on the global one having been set.
- **The mod reads the tag from the tmux server at rename time** (`tmux
show-environment -g`), falling back to its own process env only when the
  server has none (another tmux server, a failed query). Claude copies its env
  once at launch, so a process-env-only mod left any session started on an
  untagged server untagged for good — even after the republish — and one open
  across a tag edit kept the old tag. Changed 2026-10-09, after exactly that
  happened: a tmux server restarted hours after the daemon. An empty value on
  the server means untagged and wins over the process's. The mod counts only an exact ` (<tag>)` suffix as
  the tag: one already present isn't doubled or kept in the window, while any
  other trailing parenthetical (`fix login (urgent)`) is the user's and stays in
  both. Empty or unset — an untagged machine, or a session outside séance's
  tmux server — the name passes through whole. Rejected: the mod reading
  `config.json` (restates the config path and slug rules in a second runtime);
  a `seanced tag` command the mod runs (a new command and a process per rename
  for what the tmux server's environment already holds — though, unlike it, it would reach
  a `claude` outside tmux); exporting the tag from shell dotfiles (a second copy
  that drifts from config); stripping any trailing parenthetical as the tag (the
  first draft — eats user text).
- **A background session renames the window it's attached from** (added
  2026-10-14). A `claude --bg` session runs in a pty host its Claude daemon
  starts without `TMUX_PANE` — dropped on purpose, since the daemon inherits
  the pane of whoever first started it — and `claude attach` is only a client,
  whose env never reaches the session; `session.attach` carries no env or tty
  either, and doesn't fire for a terminal attach. So with no `TMUX_PANE` the
  mod looks from outside: `ps -wwAo pid=,ppid=,args=` for each `claude attach
<prefix of its session id>`, walked up its parents to a pane's shell from
  `tmux list-panes -a`. The prefix must be an id-shaped word of 4+ characters:
  ps joins argv with spaces, so a prompt like `claude "attach a debugger"` would
  otherwise match every id starting with `a`. Every window attached gets the name; none found (not
  attached, or attached outside tmux) skips the window step as before. Its own
  `TMUX_PANE`, when set, wins and the lookup never runs. Rejected: a shell
  wrapper around `claude attach` recording the pane per session id (only
  works when everyone attaches through it, and goes stale on re-attach).
- **Fails open**: a tmux error (nonzero exit, or tmux failing to start) costs a
  toast, never the rename; a `.catch` on the hook covers anything else. The name
  goes after `--`, so one led by a dash isn't read as tmux flags. A bare `/rename` (Claude picks the name, which the hook can't see)
  is passed through untouched; outside tmux the name is still tagged, only the
  window step is skipped.
- **Installed as a directory marketplace**: `.claude-plugin/marketplace.json` at
  the repo root lists the mods; `seanced mod install` runs `claude plugin
marketplace add <checkout>` then `claude plugin install <mod>@seance` for each.
  A directory marketplace is read in place, never copied, so unlike the Raycast
  import a `git pull` (or a self-update) reaches the next session with nothing
  re-run. `marketplace add` is idempotent and repoints in place when the name is
  registered from another folder, carrying installed plugins along — so no
  remove-first, unlike `mcp install`: removing a marketplace cascade-uninstalls
  its plugins and deletes their saved options and data. `mod uninstall` is that
  removal, deliberately. The marketplace is named `seance`, not `Séance`: plugin ids
  (`<mod>@<marketplace>`) are ASCII-only, and Claude refuses to install from a
  marketplace whose name breaks that; lowercase matches the repo, the CLI and
  the MCP server name. `doctor` warns when a mod is missing, disabled, or read
  from a different checkout. Rejected: `CLAUDE_CODE_PLUGIN_DIRS` in
  `~/.claude/settings.json` (Claude's development path — hot-reloads on every
  save), installing from GitHub (`<owner>/<repo>`; a copy that only `claude plugin
update` refreshes, and the checkout already on the machine is the version the
  daemon runs).
- **Tested by `claude plugin test`, not `bun:test`** — the one exception to the
  runner rule: a mod's tests import `claude-code/testing`, which only Claude
  Code provides. `scripts/test.ts` runs them as their own shard (the summary
  format matches bun's), and skips that shard, visibly, where `claude` isn't on
  PATH — which today includes CI.

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
  MCP on a credential-delivered box reaches that machine over the local op
  socket, and every other one through the daemon's fleet broker (docs/psk.md,
  "Fleet broker" above), so the key never leaves the unit. Mediating at op level
  is what makes that safe — a crypto oracle, which same-uid peers make
  unpoliceable, would not have.
