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
  makes "relay compromise cannot redirect a spawn" literally true. Both ends
  build the AAD via one shared helper (byte-identical or nothing decrypts).
  One exception, by design: the role address `scheduler` (Scheduler,
  "Leadership") names whichever daemon the relay nominates, so the AAD binds
  that envelope to the role, not to a machine — one envelope, more than one
  possible recipient. Each daemon checks every `to: "scheduler"` envelope
  against one guard that outlives its terms, so the relay cannot replay an
  app's `cancel` into a second term on one daemon. It can still deliver it to
  daemon A, move the role, and deliver it to daemon B inside the 60s window:
  two guards, one request run twice. A `cancel` or `mark-done` whose second run
  reads `finished` changes nothing; a `pause` or `resume` does not settle that
  way, so a `resume` run again after a later `pause` lifts that pause. A prompt
  no longer rides these ops at all: an enqueue is a `store-put` at `expect: 0`,
  which the relay's version check makes happen once — under an honest relay. A
  compromised one can serve an old version of a record back and have its task run
  again (Threat model, item 4). Accepted residual for the role address: it needs
  the relay itself, which can already make any daemon lead (Threat model, item 4),
  and the duplicate is that app's own request, not a new one.
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
- **The relay is blind**: it routes opaque blobs and stores what it cannot
  read — each machine's sealed info and, since M3, the scheduler's sealed task
  records and pause (_Scheduler_, "The store"). Relay compromise cannot read
  prompts or repo names, or spawn anything no PSK holder ever asked for. The
  rollback M3 opened — re-running a task a PSK holder once enqueued, lifting a
  pause — is closed by the leader's version floor and the launch ledger's
  refusal, bar a narrow residual (Threat model, item 4). Tests cannot prove a
  universal like this, so the structural half is enforced instead of
  remembered: `relay/test/layering.test.ts` fails if `relay/src` imports
  anything from shared beyond routing, bounds and the register verify, decodes
  or decrypts anything, reads `ct` except to bound it, or grows a binding a key
  could arrive in. The behavioural half is witnesses: the relay and store suites
  grep a sentinel ciphertext out of every routing and store path's log line
  (Workers Logs keeps those lines; a careless debug log is the realistic leak),
  and the e2e suite sends a re-addressed and a byte-flipped envelope through
  the shipped relay to the real daemon and watches both die there while an
  honest frame is answered. "Blind" means payloads and forgery, not traffic
  analysis: routing ids, IVs, timing, presence and the length of any blob not
  padded as `status` is stay visible (Threat model, item 3).
- **Structured payloads only**: daemons accept the `SpawnRequest` fields
  (`shared/src/types.ts` is the schema of record) and build shell commands
  themselves. Raw command strings never cross the wire.
- **Relay-level bearer token** (shared, in daemon config + PWA) gates
  registration and, since M3, the app leg of the store: a holder can list and
  read every record and create a `task:` one (`STORE_PREFIXES`), never
  overwrite or delete. Anti-junk hygiene only — the PSK is the trust boundary;
  readers skip registry entries and records that don't decrypt or bind
  (`bindTaskRecord`).

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
repo origins, sealed in transit and plaintext at rest on the machine. Since M3,
repo names and prompts also sit at rest in the relay's Durable Object, sealed in
each `task:` record. A repo name stays for as long as the record does: the
leader deletes only a finished task, and only once the store holds `pruneAt`
(96) records, then down to `keepFinished` (50), so below `pruneAt` a finished
record stays indefinitely. A prompt stays only while its task is unfinished
(2026-10-18, owner): the leader drops it on the write that finishes the task
(done, failed or cancelled), and the first passes of a leader on this build strip
any finished record that still holds one, so a record finished earlier, or by an
older leader, does not keep it. No clock bounds an unfinished task's prompt as a
whole. `queued` is bounded by `queue_expired` (`STORE_TOMBSTONE_MS`), and `lost`
and `awaiting-merge` by 7-day expiry (`lost_expired`, `merge_expired`). `ready`,
`blocked`, `running` and `needs-input` have no clock, and `reserved` only the
reservation TTL, which returns it to `ready`, never finishes it: the prompt
stays while the task waits, or while its session lives. What a finished record
may still carry is the prompt's slug (at most 40 characters) — the session
window, branch and worktree names built from it (`<slug>-<n>`, `worktree-<slug>-<n>`),
and a `failure.message` that names one (`too many worktrees named <slug>-*`) —
as labels, not the prompt. A finished prompt is not kept anywhere by Séance:
the Claude transcript on the machine is the copy from when the task ran, and a
task that never ran (cancelled or marked done while waiting, `queue_expired`,
`dependency_failed`, a spawn refused before launch) has no copy at all. A deleted
record's tombstone keeps its key and version for `STORE_TOMBSTONE_MS` (30 days)
but no envelope. Residual: Cloudflare's point-in-time recovery can restore an
earlier store state for up to 30 days, so a stripped prompt stays recoverable
that long — still sealed under the PSK. The bearer
token is not an asset in the same sense — see its blast radius above.

**Séance's own footprint.** The daemon is structurally a remote access tool and
reads as one to any EDR:

| Behaviour                                                                                      | ATT&CK                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| launchd agent runs `seanced`                                                                   | T1543.001 Launch Agent                                      |
| systemd user unit runs it on Linux/WSL (+ Windows logon task on WSL)                           | T1543.002, T1053.005 (WSL)                                  |
| persistent outbound WSS to the relay                                                           | T1071.001, T1102.002                                        |
| AES-256-GCM under a PSK                                                                        | T1573.001 Symmetric Cryptography                            |
| remotely starting an interactive coding agent                                                  | **T1219.001 IDE Tunneling**                                 |
| pre-answering claude's trust dialog in its config                                              | T1562.001 Disable or Modify Tools                           |
| `caffeinate -is` per spawn + the AC-power hold                                                 | T1653 Power Settings                                        |
| depth-2 `.git` scan of `repoRoots`                                                             | T1083                                                       |
| host discovery every 30s: `statfs`, `/proc`, `sysctl` on macOS                                 | T1082                                                       |
| reading every exclave's `.claude.json` and `skills/` dir                                       | T1083, T1087-adjacent (ids only)                            |
| a local activity history (`metrics.sqlite`, hourly tier kept forever)                          | T1074.001-adjacent                                          |
| tmux pane enumeration                                                                          | T1057                                                       |
| a local socket client's pid via `getsockopt`, walked up its parents                            | T1057                                                       |
| `despawn`: keys into a session's pane, `kill-pane`, signals                                    | T1489-adjacent (stopping work)                              |
| `reap`: git fetch/status, worktree removal, branch deletion per repo                           | T1070.004-adjacent (deletion)                               |
| branch-state: periodic `git fetch --prune origin` and ref reads in repos holding a task branch | T1070.004-adjacent (fetch prunes refs; no deletion of work) |
| `git pull` + service kickstart as the update path                                              | T1195.001                                                   |

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
   above holds for Cloudflare itself, but the token also reached Workers Trace
   Events and would reach any Logpush sink — enabling Logpush to a third party
   later moves the blast radius off Cloudflare, so that choice is not free. The
   relay's `observability` sets `redact_query_string` (2026-10-18, M3 review S7),
   so the upgrade's URL is stored without its query string. Checked 2026-10-19 over
   the 7 days Cloudflare still held: every stored `/app` URL already read
   `t=REDACTED` before the flag, and a daemon's `Authorization` header is stored as
   `********`, so no rotation followed. The flag stays for the trace a latency hunt
   turns on (item 3, further down). It also buys a
   passive feed: every `/app` socket receives every machine's `status` every
   30s. The payload is sealed, and padded to one length before sealing
   (Presence & identity, "Encoding"): unpadded, its ciphertext length varied
   with load, session counts and whether quota was present — a coarse activity
   channel per machine. The relay logs no line for an accepted beat,
   only its drops (`status-not-app`, `status-rate`) and failed fan-out sends:
   a `wire status … apps=N` line per beat once made Workers logs a 30s
   timeline of when an app was open, which a Logpush sink would have carried
   off Cloudflare too. Daemon→scheduler traffic follows the same rule (M2
   review, 2026-10-17): it is mostly `session-event`s, one per busy, idle or
   needs-input turn, so a `wire deliver` line each was a per-machine timeline
   of when every session worked. Only a failed send is logged; the drop with
   no leader nominated is the steady state and is not logged either. The leader's
   `queue-changed` nudge to apps (M3 item 6) follows the rule: an accepted
   `from: "scheduler"` → `"app"` envelope logs no `wire fanout` line (a failed send
   still does). A line per
   nudge would be the queue's activity timeline, with the nudge's own timing. The
   nudge is still a feed on the wire: every `/app` socket receives one when the queue
   changes, so a token holder sees when the queue was worked, at most one per 500 ms,
   and its sealed size is fixed by the ids it carries (at most `QUEUE_MAX_TASKS`) —
   the metadata class `store-list` already gives, recorded so it is not mistaken for
   something the seal hides. A nudge also makes every following app ask `queue`, and
   the leader's dispatch to a machine is one envelope per task start or cancel, so a
   line for either would be the same timeline: an app's delivered request to the
   scheduler and the term leg's `from: "scheduler"` dispatch log no `wire deliver`
   line (a failed send, and an app's `undeliverable` notice, still do). The leader's
   reply is the hard part — sealed `to: "app"` on its daemon socket, it is
   wire-identical to that machine's replies to its own `sessions` or `spawn`, and a
   blind relay cannot read `re`. So the relay pairs each delivered app request with
   one quiet reply from the leader's device, by count (a credit bank; Scheduler,
   "Leadership", "Scheduler replies"), and every miss fails toward a line. These rules
   govern the relay's own console lines. Cloudflare's invocation logs and traces
   are **off** (`observability` in `relay/wrangler.jsonc`; M3 review S7, closed
   2026-10-19), because every WebSocket message and alarm is an invocation and
   both kept that same timeline for 7 days. What the stored entries held, read
   through the Workers Observability API: a `webSocketMessage` entry carried the time, event
   type, Durable Object, outcome, CPU and wall time and a request and trace id,
   with no message content, size or socket id; a fetch entry added the client's
   IP, city, postal code, coordinates, ASN and TLS fingerprint. Storage spans
   carried no keys (no `cloudflare.durable_object.kv.query.keys` on any of them,
   against what Cloudflare's span reference led us to expect), so traces were
   the timeline without the task and device ids. Uncaught exceptions should
   survive the switch: each one was a separate `cf-worker` line with the error,
   while its invocation entry carried only the event type. Cloudflare does not
   document it either way, so the first exception after the deploy is the
   check. Sampling was rejected: a
   sampled timeline is still one, and `logs.head_sampling_rate` would sample
   these failure lines too. Rates and latency remain in Workers Metrics as
   aggregates; to chase one slow op, turn traces on for one deploy, then off
   again. Two more
   things ride the same feed in plaintext. Every push carries the leader's
   `deviceId` and `term` beside its sealed proof (Scheduler, "Leadership"): which
   machine leads, and — since every leader reconnect bumps the term — a counter
   of how often the leader's socket dropped, which tracks when that machine
   slept and woke. And `store-list` hands a
   holder every task key, its version and so its write count; polled, the
   versions' movement is a timeline of when the queue was worked, and a
   record's ciphertext length varies with its state and prompt unless it is
   padded as `status` is. Both are the metadata class the relay already sees
   (docs/scheduler.md, "Storing the queue"); recorded so neither is mistaken
   for something the seal hides. The token also
   bought slightly more than stated: `register` overwrote by `deviceId`, so a
   holder could blank a real machine's entry until it re-registered
   (T1565.001) — closed by self-certifying ids below, since a register for an
   id now has to be signed by the key that id hashes — and nothing caps
   registry growth (T1499.003). The store adds one act to the token: list the
   queue's sealed records and create junk tasks, bounded by `MAX_TASKS`, the
   per-socket create floor and `too_large`, never overwrite or delete one.
   Bounded is not cleared on its own: junk never opens (`unopenable`), and the
   leader never deletes a record it cannot read unasked. Until 2026-10-18 no
   client could delete one either, so it stayed until someone edited the DO's
   storage by hand; now a person clears it (M3 review S2): the Queue screen shows
   the unreadable records a `queue` reply lists, and **Clear** sends `discard`
   for each, at the version listed (`discard` in the op table). Until then, about
   a minute of creates (60 per socket per minute, three sockets) fills `task:`
   to `MAX_TASKS` (128), and every enqueue after that is `store_full`, naming the
   unreadable records. Pruning counts unreadable records toward `pruneAt` but
   deletes only readable finished ones, so meanwhile it deletes real finished
   tasks down to `keepFinished`, and the junk refills those slots. Rotating the
   token stops new junk and removes none; Clear removes it. A PSK rotation does
   the same with no attacker: every record sealed under the old key reads
   `unopenable` and holds its slot (up to about 96, below `pruneAt`) until
   cleared. The per-socket create floor bounds one connection's rate, not the
   total. Listing cost the holder nothing until 2026-10-18 (M3 review S4): one
   full listing reads 128 rows, and past the free plan's 5M rows read a day every
   storage op fails until 00:00 UTC, registers and routing included — minutes of
   looping (an estimate from Cloudflare's published limits). Lists now meet a
   per-socket window and a DO-wide bucket that hold a day's listings to about
   half that limit, and only the term holder's socket is exempt (Scheduler, "The
   store", _List floors_). Rotating the token is still the remedy; the floors
   keep a holder from taking the relay down before it. `store-get` is unrated,
   one row a request, so a holder looping it fast enough still reaches the limit
   — a residual. The
   relay also refuses every delete under `queue:`, the leader's included (why:
   Scheduler, "The store", "Who may write"). A term holder can still overwrite the
   pause with junk, which readers handle as an unreadable record (the
   scheduler's concern, not the relay's): the leader reads it as the whole
   queue held until a resume, so junk can stop dispatch — which a term holder
   could do anyway — but never lift a pause (Scheduler, "Pause"). Store rules v2
   (2026-10-20, M4) add two prefixes the token reaches. `account:` is app-writable,
   create and overwrite by `expect`, and so is every registered `/daemon` socket
   (owner decision #14): a register needs a signature on top of the token, so that
   leg is harder to open than the app leg that already has the rights. `quota:` is
   every registered daemon's and no app's. Neither is term-fenced, so creates there
   meet the write floor on either leg (overwrites too, where the term fence does not
   bound them), and nobody deletes under either (#8): their
   keys are deterministic (an HMAC, a singleton), where a tombstone would block the
   one key that names the thing for 30 days, so they are cleared by overwrite. A
   holder can therefore overwrite an alias or the quota record with junk readers
   skip — never read, forge or roll one back — and, the residual, create junk keys
   under `account:` up to its cap of 64, which nothing in the product removes, since
   deletes are refused. The singleton prefixes take one key (`StorePrefixRule.key`:
   `queue:pause`, `quota:fleet`) and refuse any other `invalid_request`, so a holder
   cannot squat their only slot; what it can still do is overwrite the real key with
   junk, which the next honest compare-and-set overwrite replaces (the readers skip
   what does not open). Rotating the token stops more and clears none. Registry growth is bounded in the DO by a
   32-entry cap that turns away only _unknown_ ids — so a full registry locks
   out machines you have not added yet and never knocks a known one offline —
   plus a per-socket register rate limit, which bounds write rate as the entry
   cap does not: re-registering one id is otherwise unbounded puts and a
   registry push to every app each time. Neither cap defends _against_ a token
   holder; rotating the token does. They keep the cost finite. The rate limit
   is per socket, so it bounds one connection's spend, not an attacker's total.
   Wire-level bounds back both, measured in UTF-8 bytes rather than string
   units (2026-10-19; counted as units, a ciphertext at a cap could encode to
   three times it, and a `status` at its cap past the 2 KiB socket attachment
   that holds it): ids are ≤64 safe bytes and ciphertext ≤64 KiB, so a register
   can never reach the DO's value limit as an unhandled throw (2 MB per value on the SQLite backend this DO is declared with —
   `new_sqlite_classes`; this was first written against the KV backend's 128
   KiB). `deviceId` has no shape of its own beyond those bounds — it is the
   base64url SHA-256 of the daemon's public key (43 characters), and the hub
   checks that, not the parser.
   Two sharper reads of the same verb, closed 2026-08-16. **Blob-swap
   misdirection** (T1036): an `/app` socket is handed every machine's `info`
   blob on its first push, and `register` pairs a blob with an id of the
   caller's choosing — so a holder can re-file machine A's blob under machine
   B's id. The picker then renders A's name and A's repos on an entry that
   routes to B, and the tap seals the spawn to B. AAD binding still holds, so
   a spawn still reaches only the machine it was sealed to; "you know which
   machine you are spawning on" does not. Closed by an invariant the daemon has always
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
   **Leader capture** (added 2026-10-16, scheduler M2; closed 2026-10-16, M3
   gate). `roles` is plaintext but signed (v2), so a holder cannot add the role
   to a real machine's register — but it can mint an id of its own, sign
   `roles`, and hold one socket open; a real leader's socket resets its
   `connectedAt` on every sleep or network change, the squatter's never does,
   so under M2 it became leader as a matter of routine. The relay now nominates
   only ids on `SCHEDULER_LEADERS`, a deploy-time allowlist (Scheduler,
   "Leadership"), so a self-minted id is never nominated however long it holds
   its socket, and M3's term-fenced store cannot be reached through the term.
   What remains is the allowlist's own trust: anyone who can deploy to the
   Cloudflare account or put a Worker secret on it can list an id of their
   choosing — the same party who could already replace the relay outright, so
   no new principal — and a seed copied out of a listed machine's `state.json`
   signs as that machine. Neither yields the PSK. The lead proof is the
   tripwire for that case (Scheduler, "Leadership"): apps believe a nominee only
   when its entry opens and it sealed a `lead-proof` for the pushed term, so a
   stolen seed without the PSK reads "leader unverified", the PWA greys `auto`,
   and the app-role client refuses to send it anything. Until 2026-10-17 the
   check was only that the entry opened, and the thief could pass it by
   registering the machine's own `info` blob, read off any push. What the thief
   still holds is the term, so it can keep `auto` unavailable — and act on the
   queue as the leader may: the relay fences the store's writes on the term and
   the socket it was issued to, not on the proof it cannot read. Decided (owner,
   2026-10-17): a listed machine's seed copied without the PSK holds the term, so
   it can delete or overwrite tasks — in any state, not only queued ones. A
   delete's tombstone keeps no env, so the task cannot be put back. An overwrite
   with junk fails `openTaskRecord` (`unopenable`: the thief holds no PSK), and only
   a replayed authentic blob even reaches `bindTaskRecord`, which refuses it under
   another key or version; either way the record is held apart and never read,
   which loses the task the same way — and, as junk, holds its slot (item 3).
   Until 2026-10-18 it could also grow storage: tombstones counted toward no cap
   and the daemon leg met no create floor, so a create-and-delete loop left two
   rows for 30 days a cycle, about 2,800 cycles a second measured locally, against
   the free plan's 100,000 rows written a day. Now the daemon leg creates no task,
   and `MAX_TOMBSTONES` (4,096) refuses the delete past it (M3 review S4;
   Scheduler, "The store"), so the thief's deletes stop at 4,096 tombstones and its
   creates at none. Its overwrites stay unrated, a row each — the term's to spend,
   like dispatch, and ended the same way. **Accepted:** what is lost is a
   pointer to work, never the work or the repo. Remedy: take the id off
   `SCHEDULER_LEADERS` and re-init that machine's identity (a new seed and
   deviceId, list the new one); rotate the bearer token and the PSK too if the
   config went with the seed. Why no env in the tombstone: an overwrite destroys
   the env anyway; restoring one would need shape changes; and 4,096 tombstones
   holding 28–40 KiB envs would be 160 MB of DO storage. It lasts until the thief's socket goes or its id leaves the list. The same
   registration also re-files the machine's own older `status` beats, which
   open and bind as the machine's (item 4). Daemons cannot check the proof — they never
   see the registry — but all they send the scheduler is fire-and-forget
   `session-event`s, sealed under the PSK, so such a leader learns their timing
   and nothing else.
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
   cleanly within one register period. For a machine that is offline that
   period has no end — the relay keeps its last beat until the next register
   (Presence & identity), days for a laptop left shut — so any beat it ever
   sent under its current blob replays as its kept status indefinitely. Its
   freshness rests on the daemon's `at` — the age the Machines screen shows —
   and so on the same clock.
   The scheduler adds three things a compromised relay can do that a token
   holder cannot (added 2026-10-17, M2 review). **It can make any daemon
   lead**: `SCHEDULER_LEADERS` is enforced only by the relay, so a relay that
   ignores it can nominate any connected daemon, and the lead proof — which
   binds a term to a PSK holder, not to the list — then verifies. Every daemon
   holds the PSK and runs the same code, so what it buys is a choice of which
   machine dispatches, not a new principal. **It decides which daemon an
   envelope `to: "scheduler"` reaches**, so it can hand one app request to two
   leaders in turn, inside the replay window, and each runs it once (Security
   model, "Routing fields bound as AAD"). **It can roll back or resurrect M3's
   store records**: the sealed version binding and the tombstones stop a token
   holder writing through the relay's own checks, not the relay, which holds
   every version it ever stored and decides what `store-list` and `store-get`
   return. A reader binds a record's sealed `version` to the one the relay
   reports, so a relay that serves an old blob with its old version passes;
   and a relay that ignores its tombstones can re-create a deleted task from
   its own authentic version-1 blob, which the 30-day admit rule bounds only
   by age. The first two are availability and integrity of the queue's
   _order_, inside the accepted "replay or withhold" class. Rollback alone
   would not be: a task settled `done` at version 5, served back as its
   version-1 create, reads `queued` and is dispatched again, and a pause
   served older or missing reads as no holds. Two checks close it (M3 review
   S1, 2026-10-18). **The leader's version floor** (`daemon/src/version-floor.ts`;
   Scheduler, "The queue store"): the highest version this process has seen
   or written at each key, kept across terms and restarts, below which a task
   record reads `version_regressed` and is never admitted or dispatched, a
   pause below it or missing holds the whole queue, and a task record that
   vanishes without the leader's delete is kept as held. **The ledger
   refusal**: a daemon refuses a scheduler spawn for a task id its launch
   ledger holds as launched with `task_launched`, audited (Session events), so
   a task that ran on a machine does not run there again. **Residual,
   accepted:** a leader that never saw the task's later versions — a daemon
   leading for the first time, or one whose floor forgot the key (30 days
   unseen) or lost its file — routing it to a machine whose ledger never ran
   it or no longer holds it (a week, 128 launches). It needs the relay
   itself, the task is one a PSK holder once enqueued, and nothing here forges
   a task or reads a prompt.
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
   own exclave's account and quota view. Through the session-events mod it can
   also report its own state and PR. That too is a claim about itself, bound to
   its own pane (Local op socket, "Session events"); its only other effect is
   asking for its exclave's `/usage` refresh, which runs only on a stale reading
   (Daemon, "Usage refresh"). Decided for M4, not built (#21): it will also report its
   own task `done`, which settles a `until: "reported"` task and releases `after: "done"`
   dependents. A session that lies about being done can do no more than one that exits. The
   scheduler routes on the quota figures, so a session that lies about its
   account's usage steers where the next task lands. It cannot reach past what
   that one account's reading decides.
   It can also write its clone's shared `.git/config` (`git config` in a
   worktree) and `.git/info/attributes`, where the daemon runs git on its own:
   reap, the base fetch before every later spawn, the branch-state emitter's
   fetch and `merge-tree` every minute, self-update in its own checkout. A
   `core.sshCommand`, credential helper, `uploadpack`, URL rewrite or merge
   driver there would run in the daemon, outliving the session, outside any
   transcript and any permission mode. So those calls refuse a repo whose local
   or worktree config sets such a family, or whose `info/attributes` names a
   merge driver, and name the family in their failure (Reap, "Repo-local
   config"). The owner's global and system config still apply.

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
  to quote. A future flag carrying wire _text_ is back under the rule. `taskId`
  never enters the shell string at all: it is an argv value to `tmux set-option`,
  and bounded to `TASK_ID_PATTERN` before it gets that far. The `/usage` refresh's
  claude run takes no wire or frame value at all: fixed argv, and an env built from
  the exclave scan alone (Daemon, "Usage refresh").
- Every spawn is **logged at start and outcome** with repo, mode, title, model,
  effort, plan mode when on, task id when present (and, on `task_running`, the
  session it collided with), prompt length and prompt SHA-256 prefix — never the
  prompt text, which would make `seanced.log` a transcript of everything ever
  asked. With a stolen PSK this log is the only thing that says someone else
  used your machines. The process table was the matching exposure and is closed
  (2026-10-19): the seed prompt used to reach claude as an argv operand, so the
  text the log reduces to a hash stood in `ps` output for the session's whole
  life — readable by every local process, path 6's injected agent included, for
  every session on the box. It is delivered on stdin now; mechanics and
  rejected alternatives under Daemon.
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
  formatter (`despawnAudit`), under the same origins. Reap destroys
  things — worktrees, branches, windows — and audits each one (`reapAudit`)
  under `cli` or under `schedule`, the fourth origin, which is the daemon's own
  timer: a 3am cleanup must not read as someone at the desk. `harvest` is the daemon
  closing a dead task pane once its exit status is noted (Daemon, "Exit status"), on the
  same `closed-pane` line as reap's; it covers both triggers, a `sessions` read and the reap
  timer, and the line does not say which. `leader` is the
  daemon's scheduler loop dispatching to its own machine in process (_Scheduler_,
  "The leader") — distinct from `local`, which says a peer on the op socket asked,
  and from the `client=scheduler` other machines log under `relay`; the leader's
  `op=admit` line is under it too. `mcp` is `seanced mcp` enqueuing on `auto` with the
  key itself: a store write the relay answers, which no daemon sees, so that process
  appends its own `audit enqueue` line to the log, as the CLI does (added 2026-10-18,
  M3 review S5). The daemon writes
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
  unlike the prompt, are logged verbatim). `launched.json`, the launch ledger
  (task ids and launch times, plus each worktree task's progress: clone and
  worktree paths, branch, PR URL; Local op socket, "Session events", Scheduler,
  "Branch state"), is written 0600 the same way, temp file first, and so is `version-floor.json` (the
  leader's version per store key, Scheduler, "The queue store"). `metrics.sqlite` and its `-wal` and
  `-shm` join them: the database is created as an empty 0600 file before SQLite
  opens it, and SQLite gives the files it spawns the database's mode. (A retired
  `session-quota.json` may remain from older versions, unread.) All
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
  checked for its `op`.** `machine-info`, `status` and the leader's
  `lead-proof` are data at rest — the relay re-sends the same envelope on every
  push — so no guard sees them, and only `from` says which machine a blob
  describes and only `op` which kind of blob it is: payload shape would let a
  `status` (or a stored `task`) stand in for whatever its slot expects. All go
  through `openAtRest`
  (`shared/src/crypto.ts`), which throws unless `plain.op` is the one asked for
  and takes only an `AT_REST_OPS` op. A `task` record is the store's, so its
  `from` names a writer (an app or the leader), not a machine; what binds it is
  its sealed `version` and `task.id` against the relay's (`openTaskRecord`,
  then `bindTaskRecord`), and one that fails either is skipped and reported.
  `pause-state` is the leader's alone: sealed `to` and `from` `"scheduler"`, opened
  through `openAtRest` with its op, refused unless it came under `queue:pause` and
  sealed `to: "scheduler"`, and bound by its sealed `version` against the relay's
  (`getPause` in `daemon/src/queue-store.ts`); one that fails any of it fails
  closed, as a whole-queue hold (Scheduler, "Pause"). Both bindings hold against a
  token holder, not the relay, which can serve an older version at its own
  version (Threat model, item 4). M4's `account`, `quota` (the fleet quota record) and
  `settings` are `AT_REST_OPS` ops too, each with its own parser, so one cannot stand in
  for another or for a `task`; no store prefix accepts them yet (store rules v2).
- **A session event is bound by the daemon, never by the event.** On the local
  socket's `session-event` frame, the pane is the one the kernel-reported peer pid
  runs under; the frame's own `pane` decides only on a host that can name no peer
  at all, never for one connection whose pid the kernel did not give. The session, task and exclave come from that pane, never from the
  frame, and a PR URL survives only as `https:`. The handler stores and forwards
  and nothing else: no spawn, despawn or command shaped by a frame. The residual,
  one same-uid process mislabelling another session's state on its own machine, is
  recorded under "Session events" (Local op socket). This frame kind widens the
  socket. A new kind, or a new act for this one, is a threat-model change like the
  broker's. One is decided, not built: a `done` report finishing the sender's own task
  (#21, "Session events"). Until it lands, ingest refuses the state.
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
{ deviceId, info, lastSeen, status? }
```

- `deviceId`: the base64url SHA-256 of the daemon's ML-DSA-65 public key
  (43 characters), derived from a 32-byte seed the daemon mints on first run
  and keeps in `state.json`. Plaintext routing key, and the one thing a
  register has to prove — see "Self-certifying ids" below.
- `info`: name, platform, repo list — encrypted "hello" blob only the PWA can
  decrypt. Re-sent on reconnect and repo rescan; DO overwrites. It also carries
  the daemon checkout's git identity (`source {sha, commitTs, branch}`) and the
  last self-update report (`lastUpdate`), both optional on the wire — older
  blobs lack them. `source` is read once per daemon process, so it names the
  build running, not the checkout on disk. Rendered on the Machines screen and
  in MCP `list_machines` since 2026-10-18 (each card's build, plus a note when
  the last update attempt was a skip or failure, with its age — the first
  `current` check after one replaces it, so a fixed machine stops showing it,
  except that an install or restart failure clears only once a later process
  finds itself current; `list_machines` omits its raw
  `detail`, and the parser caps it), reversing an earlier "not
  rendered — converged is the steady state" decision: a dev check found a
  scheduler leader still on an older build, and nothing an app could see said
  so. `seanced doctor`/`status` print both too. No wire change was needed.
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
  `seance-register|<deviceId>|<ts>` — or, when it carries `roles`, over
  `seance-register-v2|<deviceId>|<ts>|<roles>` (Scheduler, "Leadership"); the hub (`relay/src/hub.ts`, via
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
- **The status bound is 1.5 KiB** (2026-10-20, raised from 1 KiB). The 1 KiB came from
  Cloudflare's 2 KiB attachment cap, shared with the identity; that cap is now 16 KiB.
  What bounds it instead is cost: every status is padded to the bound, sent every 30s to
  every app and carried once per live machine in the `registry` push. 1.5 KiB holds six
  exclaves' quota with every field, seven without the per-model windows.
  Rejected: 2 KiB (eight exclaves) — headroom no machine needs, paid on every frame. The
  relay must deploy before any daemon built with the new bound, or that daemon's statuses
  over 1 KiB are refused until it does.
- **The latest `status` lives on the daemon socket's attachment** (added
  2026-10-15, scheduler M1): the daemon seals its
  telemetry snapshot to the app like the register blob and sends it as its own
  frame every 30s and right after each register; the hub keeps it beside the
  socket's identity (`serializeAttachment`, 16 KiB for both; 2 KiB when this landed), forwards it to
  every open app as `status { deviceId, envelope }`, and includes each live
  socket's in the `registry` push, so a freshly opened app renders pressure
  from its first push. Never a write per sample. **The last one is kept** (added
  2026-10-16, scheduler M2; M1 had it go with the socket): when a daemon socket
  closes or is swept, the put that already writes the entry's `lastSeen` also
  keeps that socket's last `status` envelope in the entry (`#leftBy` in
  `relay/src/hub.ts`), and the registry push carries it for the offline machine
  as for a live one. A socket a newer register superseded writes nothing back,
  whichever closes first: the register marks it `superseded` on its attachment
  and drops its snapshot, and from then on it keeps no status, sends none, and
  is no route, presence or nomination candidate (M2 review, 2026-10-17). The
  rule used to be "keep unless a newer socket for the id is listed", which a
  zombie defeated — a slept machine never completes the supersede's close, so
  its sweep can run after its successor has come and gone, and it wrote its
  older snapshot over the one the successor kept. No new write, op or signature: the envelope is the one the
  verified socket sent, sealed `from` its own id, so a bearer-token holder
  cannot plant one. A `register` clears it, since it
  indexes the blob that register replaces. Kept means quota, never pressure: an
  observation carries its own `at` and describes an account other machines
  share, so `newestQuotaByAccount` folds kept statuses like live ones and an
  account last used on a laptop that has since slept keeps that reading; pressure
  describes a machine now, so every pressure reader goes through `liveStatus`
  (`shared/src/status-reader.ts`), which answers only for a `connected` machine
  — a kept status reads as unknown pressure, whatever its age. `connected` is
  the discriminator on the wire: a view carries the live socket's status while
  connected and the entry's otherwise, so no extra field says which. Rejected:
  keeping only the quota half (the relay is blind and cannot split a sealed
  blob) and a separate per-account store (a new write, and an account record
  is M4's). Bounded at `STATUS_MAX_CT_LENGTH` (1.5 KiB of ciphertext, checked in
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
  shows a connected machine's snapshot with its age instead, and draws no
  pressure or session counts on an asleep card (`liveStatus`): the status is
  then the one the relay kept, or the app holds the machine asleep (a timed-out
  request) while the relay still lists its socket, and either beat would read as
  current load beside "last seen". Its quota still counts, since an observation
  carries its own stamp. `isQuotaTrimmed` says a trim happened, and
  then an exclave without an observation is unknown, not unobserved.
  **Encoding** (`MachineStatus` in `shared/src/types.ts`): every status is padded
  to the bound and base64 costs a third, so every number is an integer
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
  over-threshold account through. `ax` (M4, auth health; nothing sends it yet) lists the
  exclave indices whose login has expired, at most `STATUS_MAX_AUTH_EXPIRED`. The trim
  never touches it — it touches only quota detail, quota and `sess` — since an exclave whose
  expired login went unreported would read as signed in. Sent every 30s whether or not an app is watching:
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

| Frame / op                                                          | Sent from                                                                                                                                                                                             | Handled in                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register`                                                          | `daemon/src/relay-client.ts` (signed via `shared/src/identity.ts`, v2 over `roles`)                                                                                                                   | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`, verified via `shared/src/identity.ts`)                                                                                                                                                                                                                                        |
| `lead` / `follow`                                                   | `relay/src/hub.ts` `#renominate`, on the answer of `relay/src/leadership.ts`                                                                                                                          | `daemon/src/relay-client.ts` → `daemon/src/leader.ts`, which starts or ends a term                                                                                                                                                                                                                                                       |
| `lead-proof` (daemon→relay, op `lead-proof` at rest)                | `daemon/src/relay-client.ts` `#proveLead`, on every `lead`                                                                                                                                            | `relay/src/hub.ts` `#leadProof` (bounded in `relay/src/wire.ts`): the first from the leader's socket under the current term, kept on the leader record and carried in `registry`; opened by `shared/src/app-client.ts` `#decryptLeadProof`                                                                                               |
| `msg` (→`"scheduler"`)                                              | any app or daemon                                                                                                                                                                                     | routed by `relay/src/hub.ts` to the nominated leader's daemon socket (no leader → `undeliverable` (app) or dropped (daemon)); `daemon/src/relay-client.ts` hands it unopened to `daemon/src/leader.ts`, whose leg opens and correlates it — with no term running, `relay-client.ts` opens it and answers an app's request `not_leader`   |
| ops `queue` / `route-preview` / `cancel`                            | an app via `shared/src/app-client.ts`, sealed `to: "scheduler"`: `pwa/src/scheduler-store.ts`, and `daemon/src/mcp.ts` for `queue` and `cancel`                                                       | `daemon/src/leader-requests.ts` (`answer`, each op through its own parser: `parseQueueRequest`, `parseTaskRequest` for `route-preview`, `parseTaskRef`); the reply leaves on the daemon socket via `RelayClient.reply` in `daemon/src/relay-client.ts`                                                                                   |
| `msg` (`from: "scheduler"`, `term`)                                 | the leader's app-role leg, built per term in `daemon/src/leader.ts` and sent on by `termFleet` in `daemon/src/leader-adapters.ts`, over `shared/src/app-client.ts` built with `scheduler: { term }`   | fenced by `relay/src/hub.ts` `#isCurrentTerm` (term only: an app socket has no identity to check) — a stale term is `undeliverable { code: "not_leader" }`, which ends the term; then routed as any app `msg`                                                                                                                            |
| `msg` (app→daemon)                                                  | `shared/src/app-client.ts`                                                                                                                                                                            | routed by `relay/src/hub.ts`; opened in `daemon/src/relay-client.ts`; op dispatched in `daemon/src/handlers.ts`                                                                                                                                                                                                                          |
| `msg` (daemon→app)                                                  | `daemon/src/relay-client.ts`                                                                                                                                                                          | broadcast by `relay/src/hub.ts`; correlated on `re` in `shared/src/app-client.ts`                                                                                                                                                                                                                                                        |
| `msg` (→`"machines"` broadcast)                                     | any PSK holder                                                                                                                                                                                        | fanned by `relay/src/hub.ts` to registered daemons except the sender; receivers allowlist the op                                                                                                                                                                                                                                         |
| op `update-available`                                               | `daemon/src/run.ts` via `broadcast()`                                                                                                                                                                 | allowlisted in `daemon/src/relay-client.ts`; pipeline in `daemon/src/update.ts`                                                                                                                                                                                                                                                          |
| `registry`                                                          | `relay/src/hub.ts` (with `scheduler: { deviceId, term, proof? } \| null`)                                                                                                                             | `shared/src/app-client.ts` — `scheduler` read as `RelayState.scheduler`, `ready` only when the nominee's own entry opened and its `proof` opens as its `lead-proof` for this term                                                                                                                                                        |
| `undeliverable`                                                     | `relay/src/hub.ts`                                                                                                                                                                                    | `shared/src/app-client.ts`                                                                                                                                                                                                                                                                                                               |
| `forget`                                                            | `shared/src/app-client.ts`                                                                                                                                                                            | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`); the registry push it causes is its only ack                                                                                                                                                                                                                                  |
| `forget-refused`                                                    | `relay/src/hub.ts`                                                                                                                                                                                    | `shared/src/app-client.ts` — logged, never modelled                                                                                                                                                                                                                                                                                      |
| `"ping"` / `"pong"`                                                 | both socket legs                                                                                                                                                                                      | DO auto-response — answered without waking `hub.ts`; sweep reads the timestamps                                                                                                                                                                                                                                                          |
| envelope `seal`/`open`, AAD, replay                                 | `shared/src/crypto.ts`                                                                                                                                                                                | same file — both ends share it, or nothing decrypts                                                                                                                                                                                                                                                                                      |
| ops `sessions` / `spawn`                                            | `pwa/src/store.ts` via `shared/src/app-client.ts`                                                                                                                                                     | `daemon/src/handlers.ts` → backend in `daemon/src/backend-default.ts`                                                                                                                                                                                                                                                                    |
| op `rescan`                                                         | `pwa/src/store.ts` via `shared/src/app-client.ts`                                                                                                                                                     | `daemon/src/handlers.ts` → the scan closure in `daemon/src/run.ts`; never reaches the backend                                                                                                                                                                                                                                            |
| op `despawn`                                                        | `daemon/src/mcp.ts` via `shared/src/app-client.ts`                                                                                                                                                    | `daemon/src/handlers.ts` → `daemon/src/despawn.ts` through the backend                                                                                                                                                                                                                                                                   |
| `status` (daemon→relay)                                             | `daemon/src/run-collectors.ts` via `daemon/src/relay-client.ts`: every 30s, and after each register                                                                                                   | `relay/src/hub.ts` (bounds-checked in `relay/src/wire.ts`): latest on the socket attachment, kept in the entry on close/sweep until the next register                                                                                                                                                                                    |
| `status` (relay→app)                                                | `relay/src/hub.ts`, forwarded as it arrives; latest per daemon also rides `registry`                                                                                                                  | `shared/src/app-client.ts` — opened like `machine-info`, bound to its `deviceId`, replay guard skipped                                                                                                                                                                                                                                   |
| op `metrics`                                                        | `pwa/src/store.ts` via `shared/src/app-client.ts` `metrics()`, gated and parsed                                                                                                                       | `daemon/src/handlers.ts` → the metrics store in `daemon/src/metrics-store.ts`; sized at the transport (`#sealReply`, `daemon/src/relay-client.ts`)                                                                                                                                                                                       |
| op `session-event` (→`"scheduler"`)                                 | `daemon/src/session-events.ts` via `sendToScheduler()` in `daemon/src/relay-client.ts`; on the leader's own machine, `Leader.onSession` in process                                                    | `daemon/src/leader.ts`: opened by the term's leg (`onEvent` in `shared/src/app-client.ts`, under the daemon's one scheduler `ReplayGuard`), validated by `parseSessionEvent`, applied by `Scheduler.onSession`                                                                                                                           |
| `store-list` / `store-get` / `store-put` / `store-delete`           | apps via `shared/src/app-client.ts` (list/get/create); the leader's daemon socket via `daemon/src/queue-store.ts`, with `term` on writes                                                              | parsed and bounded in `relay/src/wire.ts`, rules in `relay/src/store.ts`, dispatched by `relay/src/hub.ts` `#onStoreFrame`                                                                                                                                                                                                               |
| `store-listed` / `store-record` / `store-written` / `store-refused` | `relay/src/hub.ts` `#onStoreFrame`, answering from `relay/src/store.ts`                                                                                                                               | `parseStoreReply` in `shared/src/parse.ts`; correlated on `re` by the app-client, which settles a reply it cannot read as `null` at once, and by the queue store                                                                                                                                                                         |
| `store-changed`                                                     | `relay/src/hub.ts` `#nudgeLeader`, to the leader's term socket after a write it did not make; `#nudgeApps`, to other apps after an `account:` write                                                   | `daemon/src/relay-client.ts` `onStoreChanged` → `daemon/src/leader.ts` `Leader.onStoreChanged`, via `parseStoreChanged` (`task:` keys only); apps drop it until account records handle it                                                                                                                                                |
| records `task` / `pause-state` (at rest)                            | `task`: `sealTaskRecord` (`shared/src/task-record.ts`), by the app-client's `createTask` and the queue store; `pause-state`: `sealAtRest`, by the queue store                                         | `task`: `openTaskRecord` (`shared/src/task-record.ts`) — `openAtRest`, no replay guard, sealed `to: "scheduler"`, then `bindTaskRecord`; `pause-state`: `openAtRest` and `parsePauseRecord` in the queue store, held by `Scheduler.load`                                                                                                 |
| ops `mark-done` / `pause` / `resume` / `discard`                    | an app via `shared/src/app-client.ts`: `pwa/src/scheduler-store.ts` (the Queue screen)                                                                                                                | `daemon/src/leader-requests.ts` `answer`, parsed by `parsePauseRequest` / `parseResumeRequest` / `parseDiscardRequest`, run by `Scheduler.pause` / `resume`, `Scheduler.markDone` and `Scheduler.discard`                                                                                                                                |
| op `queue-changed` (→`"app"`)                                       | `daemon/src/leader.ts` on the term's leg, as `from: "scheduler"`, coalesced to one per 500 ms                                                                                                         | `shared/src/app-client.ts`, via `parseQueueChanged`: heard only by an app client (one with no term) and only `from: "scheduler"`, handed to `onQueueChanged` listeners — `pwa/src/scheduler-store.ts` re-reads on it                                                                                                                     |
| op `branch-state` (→`"scheduler"`)                                  | `daemon/src/branch-state.ts` via `RelayClient.sendBranchState()`; on the leader's own machine `run-capabilities.ts` hands it in process to `leader.onBranchState` instead (Scheduler, "Branch state") | `daemon/src/leader.ts` `onEvent`, via `parseBranchState`, into the one `onBranchState` sink, which feeds the library                                                                                                                                                                                                                     |
| records `account` / `quota` / `settings` (at rest)                  | not yet written: each is its M4 item's (account records, fleet quota record, settings)                                                                                                                | `openAtRest` with its op, then `parseAccountRecord` / `parseFleetQuotaRecord` / `parseSettingsRecord` (`shared/src/parse.ts`); stored under `account:`, `quota:fleet` and `settings:` (_Scheduler_, "The store")                                                                                                                         |
| op `push-subscribe` (→`"scheduler"`)                                | not yet sent (M4, Web Push)                                                                                                                                                                           | not in `SCHEDULER_OPS`: `daemon/src/leader.ts` answers it `invalid_request` as any op it does not handle, and a non-leading daemon drops it (`daemon/src/relay-client.ts`: not a scheduler op), so the app sees a timeout, not `not_leader`, until the op joins `SCHEDULER_OPS`; its handler will parse with `parsePushSubscribeRequest` |

`sessions`, `spawn` and `despawn` have a second, relay-free sender: `daemon/src/local-client.ts`
over the local op socket, arriving at the same `daemon/src/handlers.ts` routing.
The daemon builds one handler per surface over a single context, so the two differ
only in the audit origin they are tagged with — see "Local op socket".

The same three ops have a third sender on a credential-delivered box, and only
there: the daemon's fleet broker (`daemon/src/broker.ts`), an app-role client acting for a keyless
`seanced mcp` that reached it over the local op socket with a broker frame — not a
`Plain`, and not on this wire. To the relay and the target it is one more app.

A fourth is the scheduler leader, which dispatches the same three ops to the machines it
places on: sealed `from: "scheduler"` with its `term` on its app-role leg (`termFleet` in
`daemon/src/leader-adapters.ts`), or, to its own machine, in process through `createLocalOps(…,
"leader")`, which never touches this wire (Scheduler, "The leader").

`session-event` starts on that socket too, as a third frame kind the session-events
mod sends through `seanced session-event` (see "Session events"). What crosses the
relay is the daemon's own event, built from its pane map, never the mod's frame.

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
sockets that stop pinging — see Presence & identity); `store-list`, `store-get`,
`store-put` and `store-delete`, answered `store-listed`, `store-record`,
`store-written` or `store-refused` and correlated on `re`, the writes carrying
the leader's `term` (Scheduler, "The store"). The relay sends the leader's
socket `store-changed { key, version }` after an app writes. The daemon
authenticates with an `Authorization: Bearer` header.

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
send error that caused it. An app also sends the four store requests, with no
`term` field — the parser drops one — and gets the four store replies, to the
requesting socket only.

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
  last-seen) and delete entries, list the queue's sealed records and create
  task records within the caps (never overwrite or delete one) — junk that then
  stays, so filling the caps stops every enqueue (Threat model, item 3) — but cannot spawn, read prompts, or touch a
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
  limit) still bound cost rather than defend. Queued tasks are not rebuilt the
  way registry entries are, so this reasoning does not extend to them: the token
  cannot delete one, only add junk within the caps (Scheduler, "The store"). Nor
  to `account:` and `quota:` records, which it can overwrite but nobody can
  delete (Threat model, item 3).
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
- **A request that never left is told from one that did** (`FailureReason`,
  `shared/src/app-client.ts`; split 2026-10-17). `disconnected` is a request
  refused before the send — no open socket, or the socket died while it was
  being sealed — so it certainly did not land. `dropped` is one already on the
  wire when the socket closed or the client stopped: like `timeout`, it may have
  landed. They shared `disconnected` before, worded "before the request went
  out" for both, so a submit lost after the send read as never sent while the
  PWA still called it may-have-queued. Every surface words the pair through
  `failureReasonText`, and the leader's `Fleet` reads `disconnected` as never
  delivered (Scheduler, "The leader").
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

- `sessions {}` → running claude tmux windows, each `{ id?, window, repo, path,
  taskId? }`, plus `ended?`, `ledgerSince?`, `progress?` and `progressTrimmed?` for
  the scheduler alone: a request sealed `from: "scheduler"`, or the leader's
  in-process call (Local op socket, "Session events"; `progress`, Scheduler,
  "Branch state"). The one live pull — session state is inherently fresh-only.
- `spawn { repo, prompt?, title?, mode: "worktree"|"here", model?, effort?, plan?, client?, taskId?, baseBranch? }`
  → `{ ok, window, path, sessions }` or `{ ok: false, code, message, id? }`. `id`
  rides only on `task_running`: the `SessionEntry.id` already running the
  request's `taskId` (Daemon, "Task ids"). Advertised as `"taskId"` in
  `capabilities`, since an old daemon ignores the field and spawns a duplicate.
  `baseBranch` (M4, stacking; in the schema, not acted on yet) is the branch a stacked
  worktree starts from, refused `base_not_found` when origin has no such branch. It is
  held to `isBranchName` (`shared/src/parse.ts`: `git check-ref-format` on
  `refs/heads/<b>`, no leading `-`, not `HEAD`) at every hop: the daemon's
  `isSpawnRequest` rejects a spawn carrying any `baseBranch` today (fail closed: starting from the default branch silently is the hazard the capability exists for; stacking lifts the refusal), and the leader is to check the predecessor's
  `Task.branch` before sending it (stacking), since a task record's branch is only
  length-checked. Advertised as
  `"baseBranch"`, and required: an old daemon drops the field and starts from the
  default branch. The
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
  `names` (the machine chart is three series, cpu, memory and disk, ~17 KB). Rejected: a points cap alone (the
  series count grows with exclaves, accounts and models, so no cap fits every
  machine); trimming the oldest points to fit (the chart silently shows less
  range than it asked for); positional value arrays with implied timestamps
  (~3.5× smaller, and no longer Prometheus's shape). History lives only on its
  daemon, so an asleep machine's is unavailable until it wakes — accepted.

Layer 2 also carries the app → scheduler ops, sealed `to: "scheduler"` and answered by the
leader (Scheduler, "The leader"), each `T | SchedulerError`:

- `queue { tasks? }` → `{ tasks, holds, at, unreadable? }` — the leader's `QUEUE_MAX_TASKS` most relevant tasks (unfinished first, an escalated
  `needs-input` leading, newest first within each) with their latest
  decisions, prompts cut to `QUEUE_PROMPT_PREVIEW` (none on a finished task); a decision past the reply's budget carries
  only its winner, counted in `trimmed` (Scheduler, "The leader"). `tasks` asks for those ids
  only (at most `QUEUE_MAX_TASKS`): what a `queue-changed` named, or the one task a verdict
  follows. An unreadable filter is `invalid_request`, never "everything"; an older leader
  ignores it and answers its own listing, so a reader filters the reply again. `unreadable`
  lists every `task:` record the leader cannot read, whatever the filter, as `{ taskId,
  version, reason }` (at most `MAX_TASKS`, taken off the reply's budget before any task, as
  the holds are): what fills the store without ever running.
- `route-preview { repo, mode, prompt?, title?, model?, effort?, plan?, skill? }` (`TaskRequest`: a
  spawn's fields minus the machine, `repo` the repo's `origin`) → `{ decision }`, reserving
  nothing.
- **There is no `submit`** (removed in M3 item 6; M2's op took a `TaskRequest` and answered the
  task as queued). An app enqueues by sealing the task itself and `store-put`ting it at
  `expect: 0` (`createTask`; Scheduler, "Task records and the app's store leg", is the one
  record of how), so a task is queued with no leader up, and the next one to lead runs it.
  The leader reads the create on `store-changed`, admits and places it.
- `cancel { taskId }` (`TaskRef`) → `{ task }` (`TaskResponse`), the task as it now stands:
  `Scheduler.cancel`, so a running one is despawned on its machine first (Scheduler, "The
  leader").
- `mark-done { taskId }` (`TaskRef`) → `{ task }`, `done` with `doneBy: "manual"`:
  `Scheduler.markDone`. A `running` or `needs-input` task, or a `lost` one whose machine is
  connected, has its session ended first, exactly as `cancel` does: caps count task states only, so a `done` task frees its slot, and a session
  left running past that would work beyond them. A `lost` one whose machine is gone,
  `awaiting-merge` and the waiting states settle as they stand (nothing to end, or nothing
  reachable). It is how a `here` task,
  or a PR merged after its session was evicted, leaves `awaiting-merge`, and it releases an
  `after: "merged"` dependent. Refused `task_not_found`, `dispatching` (`reserved`: its spawn
  is in flight), `finished`, `conflict`, and, for a live session, `despawn_failed` (its
  machine refused; the task is unchanged), as `cancel` is.
- `pause { until, account? }` (`PauseRequest`) and `resume { account? }` (`ResumeRequest`) →
  `{ holds }` (`PauseResponse`), every hold in force after the change (M3 item 5; Scheduler,
  "Pause"). `queue` replies carry the same `holds`.
- `discard { taskId, version }` (`DiscardRequest`) → `{ taskId }` (`DiscardResponse`): deletes a
  record the leader holds unreadable, at the version a `queue` reply's `unreadable` listed it
  under (`Scheduler.discard`; added 2026-10-18, M3 review S2). Never a readable task
  (`task_not_found`), nor a record that changed since (`conflict`). Audited as
  `op=discard … task=… version=… ok`, or with its refusal. The person's remedy for junk a
  bearer-token holder planted and for records sealed under an old PSK, which no reader deletes
  on its own and which hold the store's slots until someone does.
- `push-subscribe { endpoint, keys: { p256dh, auth } }` (`PushSubscribeRequest`, a Web Push
  subscription) → `{ endpoint }`, or `subscriptions_full` past `PUSH_MAX_SUBSCRIPTIONS`
  (M4, Web Push; in the schema, not in `SCHEDULER_OPS`, so a leader answers it
  `invalid_request` until its handler lands). The endpoint is `https:` on the default port,
  on a `PUSH_SERVICE_HOSTS` host (a `*.` entry is a subdomain, never the bare host), checked
  where the request is parsed (`pushEndpoint`), so a PSK holder cannot aim the leader's
  sends at an arbitrary URL. Subscriptions live in the `settings` record.
- `queue-changed { at, tasks? }` runs the other way: the leader's term leg sends it `to: "app"`,
  fire-and-forget, when something an app would show changed (Scheduler, "The leader"). It is
  not a request and has no reply; an app re-reads `queue` on it.

**M4's shapes landed ahead of their items** (2026-10-20, the schema PR): every field and
record below parses today, and nothing acts on one until its item does. All are optional, so
an old peer's frames parse as before. Mixed versions:

- `TaskRequest.skill` (a declared skill, `isSkillName`) and `TaskSpec.until` (`"merged"`,
  the default, or `"reported"`, #21): an older leader's `parseTaskSpec` rebuilds the spec
  without them, and every write it makes (reserve, place, settle) seals the stripped spec
  back, so both are lost from the record, not merely ignored while it leads: a `reported` task
  under one settles at its merge, and routing ignores its skill. The authoring item must not
  write `until` or `skill` until leaders are upgraded.
- `after: "done"` (#21, released only by a `done` predecessor) and `doneBy: "linear"`: an
  older leader reads a task carrying either as malformed, and holds it unreadable, never
  running it, until a leader that knows them takes over (Scheduler, "The queue store").
- `RepoEntry.skills` (a clone's project skills, at most `REPO_MAX_SKILLS`): lenient, so a bad
  list costs the field, never the entry or the machine. `MachineStatus.ax` (the exclave
  indices whose login has expired) is strict and capped. An old app ignores both.
- `TaskProgress.exit` (a session's exit status, 0–255), in the `sessions` reply's `progress`
  and the launch ledger: an older leader drops it. Acted on since 2026-10-21 (Daemon, "Exit
  status"), with two shapes of its own: the `exitStatus` capability, which an older leader
  ignores (it settles a PR-less `ended` on the event, as before), and the `session_failed`
  failure code, which an older leader or app reads leniently (`parseTaskRecord` takes any
  bounded code); an older PWA words it as a spawn refusal.
- Reasons `skill_absent { skill }`, `auth_expired` and `base_unpushed`: an older app or
  leader drops an unknown reason from a decision and keeps the candidate.
- `session-event` `done` is refused at ingest and ignored by the leader (Local op socket,
  "Session events"), as a daemon that predates it refuses any unknown state.

Repos are **pushed, not pulled**: they ride the encrypted register blob, so
the PWA's repo picker renders from the machine registry alone and works for
offline machines. Rejected: one combined poll op returning repos + sessions
together (re-sends registry data on every poll, useless offline).

## Scheduler

The scheduler (docs/scheduler.md is the plan; this section takes over each part as it lands) runs
on one daemon at a time, the one the relay nominates. Nothing else about that daemon changes: it
is an ordinary daemon with extra legs. M2 — routing, leadership and the PWA's `auto` — is complete
(2026-10-16), and so is M3 — the durable queue in the relay's store, deps, batches, caps, pause and
the PWA's Queue screen (2026-10-18); what they leave for M4 is docs/scheduler.md's M2 and M3
"Gaps". Two reviews are cited by name. The **M2 review** (2026-10-17) reviewed M2 and was fixed
in #132–#149; its findings are labelled Q, S, P and M. The **M3 review** (2026-10-18) reviewed
#132–#188, and its fixes are tracked outside the repo; its labels are Q, S, P, D and R.

### Leadership (`relay/src/leadership.ts`) — landed 2026-10-16, M2

- **Capable is signed `roles`.** `register` carries a plaintext `roles` list — today only
  `"scheduler"` (`DAEMON_ROLES`) — because the relay must read it to nominate on it. Since the
  relay acts on it, the signature covers it: a register with `roles` is signed over
  `seance-register-v2|<deviceId>|<ts>|<roles joined by ",">` and verified against that message
  only (`shared/src/identity.ts`). A register without `roles` is v1 and verifies as before, as a
  daemon with no roles, which is never nominated. A frame whose `roles` its signature does not
  cover — a v1 signature with roles spliced on — is refused `register unverified`, not demoted to
  roleless: the relay never guesses which half of a frame to believe. Roles stay raw strings on
  the wire, bounded like ids (≤8, id charset, so neither separator can appear), because the
  signature covers the list as sent and a role minted later must still verify; the hub keeps only
  the roles it knows on the socket attachment (`knownRoles`). Every daemon advertises the role.
  A daemon whose v2 register is refused signs its next one v1 and alternates from there
  (`#signV1` in `daemon/src/relay-client.ts`), so a daemon that self-updated ahead of its relay's
  deploy gets in roleless instead of being locked out; any other refusal cause fails both alike.
  Any drop that was not a refusal resets it to v2, so the role comes back once the relay catches up.
- **Nomination is a pure function**, `nominate(candidates, current, leaders)`: the connected,
  registered daemons' `{ deviceId, roles, connectedAt }` — one per id, its newest socket's — the
  current leader and the allowlist in, the next leader (or null) out. Eligible is capable _and_
  listed. A current leader that is still eligible keeps the role, even across its own reconnect;
  otherwise the earliest `connectedAt` wins, ties to the lowest `deviceId`. Stickiness matters only in the race where a leader's new socket registers
  before its old one's close is processed — without it the role would move to whoever has sat
  connected longest on every redial. Its suite (`relay/test/leadership.test.ts`) needs no workerd, and
  covers the term's record and checks below too.
  `hub.ts` calls it from exactly three places — after a register, a socket close and a sweep — in
  `#renominate`, and nowhere decides leadership itself.
- **`scheduler:term`** is one DO storage record, `{ term, deviceId, connectedAt, proof? }`; its type
  and its transition (`nextLeaderRecord`) live in `leadership.ts` beside the checks below, and the
  hub only reads and writes the row. Every
  change bumps `term` and writes once, with no `proof`: a new leader, no leader, or the same leader on a new socket (the
  daemon behind it may have restarted, and whatever its old socket still had in flight belongs to
  the old term). A close or sweep that changes nothing costs one read. The term is monotonic for
  the life of the DO, so a term a demoted leader holds can never come round again. On a change
  the relay sends `lead { term }` to the new leader's socket and `follow` to the old leader's, if
  it is still connected under a different id (a superseded socket is closing and gets nothing).
  Both are plaintext relay assertions; the daemon starts or ends a term on them ("The leader",
  below).
- **`SCHEDULER_ID = "scheduler"`** is a reserved wire address, refused by `register` like `"app"`
  and `"machines"`. An envelope `to: "scheduler"` routes to the leader's newest socket, the AAD
  still naming `"scheduler"`; with no leader an app gets `undeliverable { code: "offline" }` (never
  `unknown`: the address is real) and a daemon's is dropped, as any daemon-origin envelope nobody
  can take. A daemon running no term answers an app's scheduler request `not_leader` and drops
  anything else (`reason=not-leading`) — "The leader", below.
- **The term is a fence, not a credential.** The leader speaks on its app-role leg as
  `from: "scheduler"`, and that `msg` carries `term`. The relay delivers it only when the term is
  the connected leader's, and otherwise answers the sender `undeliverable { code: "not_leader" }`
  by `iv`, like any refusal — so a leader demoted while partitioned fails fast instead of acting on
  a role it lost. Every registry push carries the term, so this stops a stale leader, never a
  stranger; `from: "app"` envelopes are untouched and ignore `term`. Two checks, both in
  `leadership.ts` over plain inputs. `isCurrentTerm` is the term only, and fences that `msg`: the
  leader sends it on its app-role leg, an app socket with no identity, so a socket check there would
  refuse every dispatch. `holdsTerm` is the term **and** the socket it was issued to (`deviceId` +
  `connectedAt`), and fences the daemon-leg store writes and `lead-proof`, so a token holder who
  copied the public term gets `not_leader`. `lead-proof` gained one tightening with it (M3 item 1,
  2026-10-17): a superseded socket can no longer pass, even where the record still names its
  `connectedAt` — which happens only after a failed `#renominate` put.
- **The registry push carries `scheduler: { deviceId, term, proof? } | null`**, frame-level beside
  `entries`, so an app can grey out `auto` without a round trip. Null unless the recorded leader is
  connected: a record a relay restart left behind names nobody routable until the next register
  re-nominates.
- **A nominee proves its term; apps believe nothing else** (M2 review, 2026-10-17). The reader
  check this replaced asked only whether the nominee's registry entry opened into a `Machine`.
  That is no proof of the PSK: the entry's `info` blob is the machine's own, readable off any push
  by a bearer-token holder, so a thief with a listed machine's seed (`state.json`) and the token
  could register under that id carrying it — the relay supersedes the live socket — and read as
  `ready`. Now every daemon answers `lead { term }` by sealing `{ term }` as op `lead-proof`,
  `from` its own id `to: "app"`, and sending it as a `lead-proof` frame on the socket that heard
  `lead` (`#proveLead` in `daemon/src/relay-client.ts`). The relay, which cannot read it, keeps the
  first one the leader's own socket (`connectedAt` matching the record) sends under the current
  term on the `scheduler:term` record — one write and one push per term, however often a socket
  sends — and carries it as `scheduler.proof`; a new term starts without one. The app opens it at
  rest (`openAtRest`, op `lead-proof`), and reads the nominee as `ready` only when its entry opened
  _and_ the proof was sealed `from` the nominee for exactly the pushed term. Taking a socket mints a
  term the machine was never told, so no proof for it exists; the last one it did seal, replayed,
  names the wrong term. Between a `lead` and its proof an app reads the new leader as `unverified`
  for one round trip; the PWA's Queue screen holds its catch-up read until the proof lands rather
  than asking into that gap, whose unsent refusal used to strand a notice on every takeover. Cost: a daemon or relay that predates the proof leaves every nominee
  `unverified`, so `auto` waits for both to update — fail closed. Rejected: a challenge the app
  sends the nominee (a round trip per app per term, and a timeout where the proof is a push);
  carrying the term in the `status` beat (the beat is floored per socket, so the proof would lag a
  `lead` by up to 30s, and a thief can replay an older beat — Threat model, item 3).
- **Only allowlisted ids lead** (M3 gate, owner, 2026-10-16). Anyone with the bearer token can
  mint an id, sign `roles` and hold a socket, and connected-longest would win; under M2 only the
  reader check stood against that. `SCHEDULER_LEADERS` — comma-separated device ids, a Worker
  secret — names the daemons the relay may nominate. A secret rather than a `wrangler.jsonc` var
  only for deploy mechanics: CI deploys never overwrite it and no ids sit in git; ids are not
  secret. **Unset or empty nominates nobody** — fail closed, never "everyone". The hub parses it
  once per wake (`parseLeaders`: trimmed, blanks dropped, each entry held to the register's
  deviceId bounds; an invalid one is logged and ignored, never fatal) and hands the set to
  `nominate` as a required input rather than filtering candidates before the call, so no caller
  can nominate without stating it and the pure suite covers the gate with stickiness. That keeps
  the gate where the term is decided — before anything acts on one — and register verification
  is what makes it sound: a socket registered under a listed id proved it holds that id's key. A
  current leader taken off the list loses the role at the next re-nomination; since putting a
  secret rolls a new relay version, every socket reconnects then anyway. A register that is
  capable but unlisted logs as such, the operator's one hint for "auto queues but nothing runs
  the queue" — since M3 an enqueue needs no leader, so `auto` never reads unavailable. The
  lead proof (above) is the tripwire for a listed seed stolen without the PSK (Threat model,
  item 3). Cost: a new leader-capable machine is a `wrangler secret put` with its id read off
  `seanced doctor`, which rolls the relay and drops every socket once. No relay op exposes the
  list. Rejected: a wildcard entry (it would reopen capture by configuration), a committed var
  (CI would overwrite it), and the reader check alone (it changes what readers believe, not who
  holds the term).
- **Scheduler replies log no line, paired by credit** (M2 review; the rule is Threat model,
  item 3). The leader's reply to an app is sealed `to: "app"` on its daemon socket, wire-identical
  to that machine's replies to its own `sessions` or `spawn`, and a blind relay cannot read `re`.
  So the relay credits a daemon socket, on its attachment, for each app request it delivers to a
  socket of the leader's device (newest first, falling through failures — not necessarily the
  term-holding socket), and that socket's next routed `to: "app"` `msg` spends one credit and logs
  no `wire fanout` line (a failed send, or a reply that reaches no app, still does; `status` and
  `lead-proof` frames spend nothing). A credit bank lasts the app's deadline for the slowest
  scheduler op (`OP_TIMEOUT_MS`), counted from the bank's first credit — a later request adds to
  the bank but does not extend it. At most 16 are banked, a re-register on the socket drops them,
  and an expired, missing or capped credit logs: every miss fails toward a line. It pairs by
  count, not identity — a reply to the leader machine's own ops inside a window can take the
  quiet slot, and the scheduler reply then logs instead. The count of lines is right only when
  every delivered request is answered: an unanswered one (a dropped or replayed envelope, an app
  session event the leader drops) leaves its credit, which can quiet one later ordinary reply
  until the bank's window lapses. Rejected: quieting every `to: "app"` from the term holder's
  socket (hides that machine's ordinary replies, a per-machine hole); the request's `iv` in
  plaintext on the reply frame (precise, but a frame change across the client, the leader and
  the wire spec, and still nothing the relay can verify); sampling (a sampled timeline is still
  one) or aggregate counters (they need a DO flush timer).

### The store (`relay/src/store.ts`) — landed 2026-10-17, M3 item 1

The queue's durable home: sealed records at keys in the relay's DO storage, which the leader and
apps read and write with plaintext Layer 1 frames. The relay never opens a record, so what it
enforces is what it can see: who is asking, the key, a version and a size.

- **Four requests, four replies, on both legs.** `store-list { id, prefix }` answers
  `store-listed { re, records }`: every live record under the prefix, ascending by key, as
  one frame (checked in production 2026-10-18, sized in _Send size_ below; paging stays
  open — an `after` is ignored and answered whole, and `parseStoreReply` refuses a reply carrying
  `next`). `store-get { id, key }` answers
  `store-record { re, record }`, `null` for an absent or tombstoned key. `store-put` and
  `store-delete` answer `store-written { re, version }` — the new version, or the version a delete
  removed — or `store-refused { re, code }`. Parsed and bounded in `relay/src/wire.ts`, ruled in
  `relay/src/store.ts`, dispatched by `#onStoreFrame` in `hub.ts`. Reads are any app's and any
  registered daemon socket's, though a list meets floors (_List floors_, below). On `/daemon`, a
  store frame is handled only once that socket's register has been accepted — one sent right
  behind the register waits for its outcome, as other frames do — and before that every store
  frame, a read included, is answered `store-refused { code: "forbidden" }` (a superseded socket
  counts as unregistered, and so does one whose register failed verify: the earlier identity is
  cleared before the close, so a frame queued behind the failure is refused): under a prefix that is not term-fenced, registration is the daemon
  leg's whole authority, and a refusal settles the client where a drop would leave it to ride
  `STORE_TIMEOUT_MS` (2026-10-20, store rules v2; until then reads were anyone's and an
  unregistered socket's write read `not_leader`). A put's `env.from` is not compared with the
  socket's id: the relay is blind and the seal's addressing is the clients' to decide. Store
  frames also wait behind an in-flight (re-)register on the same socket, so a write sent right
  after `resign`'s roleless register reads `not_leader` — the register has
  already taken the term away — never a write on the old role.
- **Storage namespaces**, none starting `device:` or equal to `scheduler:term`, so no store key
  — which `STORE_KEY_PATTERN` confines to a known prefix and a routing id — can alias the registry
  or the leader record. Records never reach the registry push and never count toward
  `MAX_DEVICES`.

  | Key                                 | Value                                                  | Why                                                                                  |
  | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
  | `store:<key>`                       | `{ version, env }`                                     | a live record                                                                        |
  | `store-tomb:<key>`                  | `{ version, at }`                                      | a tombstone: no env                                                                  |
  | `store-tomb-at:<16-digit at>:<key>` | the store key                                          | age index: tombstone keys sort by key, so a bounded purge needs one by age           |
  | `store-meta:counts`                 | `{ total, prefixes: { "task:": n, ... }, tombstones }` | kept counts: every DO `list` reads values, and a full `task:` is large (_Send size_) |

- **Who may write**, per `STORE_PREFIXES` and the leg. Each prefix's rule carries every policy
  the relay applies — `appCreate`, `appWrite`, `termFenced`, `daemonCreate`, `deletes`,
  `tombstone`, `cap` — and `relay/src/store.ts` names no prefix (store rules v2, 2026-10-20). A
  daemon here is a registered socket; "leader" is the socket the current term was issued to,
  with that term on the frame (`holdsTerm`).

  | Prefix      | Leg    | create (`expect: 0`)                        | overwrite (`expect > 0`)  | delete                    | Tombstone | Cap |
  | ----------- | ------ | ------------------------------------------- | ------------------------- | ------------------------- | --------- | --- |
  | `task:`     | app    | allowed                                     | `forbidden`               | `forbidden`               | yes       | 128 |
  | `task:`     | daemon | `not_leader`, or `forbidden` for the leader | leader, else `not_leader` | leader, else `not_leader` |           |     |
  | `queue:`    | app    | `forbidden`                                 | `forbidden`               | `forbidden`               | no        | 1   |
  | `queue:`    | daemon | leader, else `not_leader`                   | leader, else `not_leader` | `forbidden`               |           |     |
  | `settings:` | app    | `forbidden`                                 | `forbidden`               | `forbidden`               | no        | 8   |
  | `settings:` | daemon | leader, else `not_leader`                   | leader, else `not_leader` | `forbidden`               |           |     |
  | `account:`  | app    | allowed, write floor                        | allowed, write floor      | `forbidden`               | no        | 64  |
  | `account:`  | daemon | allowed, write floor                        | allowed, write floor      | `forbidden`               |           |     |
  | `quota:`    | app    | `forbidden`                                 | `forbidden`               | `forbidden`               | no        | 1   |
  | `quota:`    | daemon | allowed, write floor                        | allowed, write floor      | `forbidden`               |           |     |

  A `term` on an app frame is dropped by the parser, so it authorizes nothing: an app overwrite
  carrying the current term is still `forbidden`; on a prefix that is not term-fenced a daemon's
  term is ignored the same way. The delete policy is checked first, so `deletes: "never"`
  refuses the leader too. On `queue:` no client deletes the pause (resume overwrites it), and
  with no tombstone a delete could only be a term holder silently erasing a person's pause, or
  re-creating it from its own version-1 blob (Threat model, item 3). `settings:`, `account:` and
  `quota:` are the same (owner decision #8): deterministic keys, where a tombstone would block
  the one key that names the thing for 30 days, so they are cleared by overwrite. `settings:` is
  a leader op's to write and every PSK holder's to read (#9); `account:` gives every registered
  daemon socket an app's rights (#14: that leg needs a signed register on top of the token, so it
  is harder to open than the app leg), and `quota:` is the daemons' alone — any daemon's, since
  the fleet quota record is written by each machine on its own cadence. A singleton prefix
  accepts one key: `queue:` only `queue:pause`, `quota:` only `quota:fleet` (`StorePrefixRule.key`,
  enforced by `ruleFor` and `STORE_KEY_PATTERN` together), any other `invalid_request`; a cap of
  one alone let a token holder take the slot with junk and, deletes being refused, keep it. And no daemon creates
  under `task:`, the leader included (2026-10-18, M3 review S4): since `submit` went only apps
  enqueue, and the leader meets no create floor on a fenced prefix, so a create it could make was
  only ever a create-and-delete loop (Threat model, item 3, the seed thief).

- **The order of checks is the contract:** parse (`invalid_request`, `too_large`), then the rule
  (`forbidden`, `not_leader`), then the tombstone and the version (`version_conflict`), then the
  write floor (`rate_limited`), then the caps (`store_full`: records on a create, tombstones
  on a delete), then the write. The version check precedes the floor and the caps so an enqueue
  retried after it landed always reads `version_conflict` — never `rate_limited` or `store_full`
  — and an idempotent retry is recognizable as such even against a full store; a retried delete
  likewise. A list meets only its floors (_List floors_).
- **Versions.** A create lands at 1 and each put adds 1. `expect` must equal the stored version
  (0 for nothing stored). A delete of a missing key is `version_conflict` whatever `expect` is, as
  in `MemoryQueueStore`, and a delete answers the version it removed. A put's size: a create's
  ciphertext past `STORE_CREATE_MAX_CT_LENGTH` is `too_large`, as is any put past
  `STORE_MAX_CT_LENGTH`; the bound is exact. The `ct` is parsed unbounded and measured after, so a
  1 MiB one reads `too_large` rather than malformed; the WebSocket message cap bounds it at the
  transport. Why a create gets 28 KiB of the 40: measured, a create with every field at its bound
  and the prompt in two-byte characters fits the create cap, and all a leader adds at every bound
  fits beside it with a 10-candidate decision; past that the leader cuts the stored decision. The
  cap was 32 KiB until 2026-10-17 (M2 review), when a full create left the leader no room for its
  own fields and its first write would have been `too_large`, leaving the task `queued` for good.
- **Tombstones**, under `task:` only — `tombstone` on its rule, the one prefix both creatable by
  apps and deletable, so the one where a delete could otherwise be undone by re-creating from an
  old authentic blob. The other prefixes refuse deletes, so have nothing to guard. A delete leaves
  `{ version, at }` and no env, for `STORE_TOMBSTONE_MS`: a put there is `version_conflict` at any
  `expect`, `get` reads `null`, `list` leaves the key out, and it counts toward neither record cap
  (it has one of its own, below). A put
  past the expiry clears the tombstone and its age entry and lands at version 1. Each delete purges
  up to `PURGE_BATCH` (32) expired ones, oldest first, through the age index, so storage stays
  bounded by a window of deletes with no alarm: the one alarm is the sweep's, armed only while
  daemons are connected. 32 because Cloudflare's KV-style storage API caps a `get`/`put`/`delete`
  at 128 keys per call (local workerd does not enforce it on `delete`): the delete call
  carries 1 + 2 × 32 keys (the counts row goes in the `put`). The relay logs nothing for a purge:
  after the expiry nearly every leader delete purges, so a line would be a timeline of the
  leader's deletes. The tombstone keeps no env on purpose; the cost is on Threat model item 3.
  Sizing: since each delete purges expired ones, what stands is about the last 30 days of
  deletes — a few finished tasks pruned a day in normal use, a few hundred rows. `MAX_TOMBSTONES`
  (4,096) caps the count: the counts row carries `tombstones`, and a delete that would leave more
  standing after its purge is `store_full` and leaves the record (2026-10-18, M3 review S4). That
  is about 136 deletes a day held for the full 30 days, several times what pruning a busy queue
  does, and two rows each with the age entry, so 8,192 rows and well under a megabyte. A counts
  row from before the cap has no `tombstones`: the next delete counts the age index once and
  writes it. A refused prune is the library's to report (`store refused delete …`), and the
  record holds its slot until a delete fits.
- **The write floor** binds every app-leg create, and every create and overwrite under a prefix
  the term fence does not cover (`floorsWrite`), on either leg: 60 writes per socket per 60 s
  (`MAX_STORE_CREATES_PER_WINDOW`, `STORE_CREATE_WINDOW_MS`), the window on the socket's
  attachment (written on its first counted write, so it survives hibernation; a re-register keeps a
  daemon socket's) and a fresh socket starting a fresh window — the register limit's
  counterpart, bounding one connection's spend. Overwrites count where nothing else bounds them:
  under `account:` and `quota:` a socket looping overwrites would otherwise burn a DO row write
  each and fan `store-changed` to every app. A daemon writing `quota:` every ~5 minutes and a
  person renaming an alias sit at a few writes a minute at most, far below it. Only a write that
  lands counts: the window is written back after the put returns `ok`, so a `version_conflict`,
  `store_full` or `rate_limited` leaves it untouched and a refusal cannot reset it (the floor
  sits behind the version check, so a retried write reads `version_conflict`). On a fenced prefix
  the daemon leg meets no floor: only the term holder writes there, and its writes are its own
  singletons (`queue:`, `settings:`), bounded by their caps and the term. Under `account:` and
  `quota:` any registered daemon socket writes, and `/daemon` accepts any bearer token plus a
  self-minted signed register, so the floor binds there as on the app leg (store rules v2,
  2026-10-20; the overwrite half added in its review). Enqueue needs no leader: an app create
  lands with no daemon connected.
- **Store caps**: a create past its prefix's `cap`, or past `MAX_RECORDS` in all, is
  `store_full` on either leg. The caps (table above) sum to 202 of `MAX_RECORDS`' 256, checked in
  `relay/test/store-rules.test.ts`, so no prefix's fill can starve another's and the 54 left are
  room for a prefix M4 has yet to name (push subscriptions). Why each: `task:` is `MAX_TASKS`;
  `queue:` holds the pause and nothing else; `settings:` a handful of leader-held singletons (the
  VAPID keypair, the Linear key); `account:` one per Claude account the fleet signs into, far past
  a personal fleet's handful; `quota:` the one fleet record (one per account would tell the relay
  when each is in use). A delete past `MAX_TOMBSTONES` is `store_full` too (_Tombstones_).
- **List floors** (2026-10-18, M3 review S4). A `store-list` reads every row under its prefix,
  128 for a full `task:`, and Durable Object reads are billed per row against a daily limit: 5M
  on the free plan, past which every storage op fails until 00:00 UTC, registers and routing
  included. Unrated, that was minutes of one looping token holder or a buggy client. So every
  socket but the term holder's spends two floors, and past either the list is `rate_limited`: a
  per-socket window of 4 lists a minute per prefix (`MAX_LISTS_PER_WINDOW`, on the attachment as
  the create floor's is, kept across a re-register), and a DO-wide token bucket per prefix
  holding 16 and refilling one per 8 s (`LIST_BURST`, `LIST_REFILL_MS`). Both are per prefix so
  that M4's `account:`, which apps list on open, never spends what a `task:` list needs, and the
  reverse. The bucket sets the bound: 10,800 lists a day per prefix, and every prefix listed full
  at that rate reads at most 10,800 × `MAX_RECORDS` (the caps' bound), 2.8M rows, about half the
  free limit. The refill was 4 s until 2026-10-20, which held that bound for `task:` alone; with
  five prefixes it would have read 4.4M (store rules v2). Exempt is the socket the current term
  was issued to — a list carries no term — so a takeover is never refused. The bucket is in
  memory, since storing it would write a row per list to guard the rows a list reads; eviction
  resets it, which needs an idle spell no looping client allows. A refusal spends neither floor
  and logs `store refused t=store-list leg=… code=rate_limited`.
  `store-get` stays unrated: one row each, so its bound is the socket's message rate, which
  nothing caps — a residual (Threat model, item 3).
- **`store-changed { key, version }`** goes to the leader's daemon socket — the one its term was
  issued to, found among the non-superseded daemon sockets — after every successful write that
  socket did not make: an app's, or under a prefix that is not term-fenced another daemon's (a
  follower's `quota:` write). Until store rules v2 every daemon-leg write was the leader's by
  construction, so only app-leg writes nudged; `quota:` and `account:` ended that premise, so the
  rule is now the writing socket, not the leg. Nothing goes to followers, nothing for the term
  socket's own writes, and nothing with no leader connected: the next leader reconciles from
  `store-list` at takeover. The leader acts only on `task:` keys (`Leader.onStoreChanged`).
  `#nudgeLeader` in `hub.ts` sends it. After a write under an `appWrite` prefix (`account:`), on
  either leg, it also goes to every app socket but the writer (`#nudgeApps`), so an alias set in
  one client shows in another; `task:` is creatable by apps but not app-writable, and its changes
  reach apps as the leader's `queue-changed`. Only send failures are logged — a line per fan-out
  would be a timeline of edits. An app-client from before this drops the frame
  (`wire dropped reason=frame`): it has no `re`, so it is no reply; handling it is the account
  records' item.
- **Logging.** One line per refusal — `store refused t=… key=… leg=… code=…`, with no `key=` on
  `version_conflict` (the normal answer to an enqueue retry and to leader races, so a key with a
  time would link task ids to retries) — and none for an accepted read or write: per-write lines would be the queue's activity timeline (Threat model,
  item 3). Never an `env`, a `ct` or its length.
- **Two causes get no reply, and no code** (owner's call, 2026-10-17). A storage throw: a read's
  escapes the handler, as does `#holdsTerm`'s on the daemon leg (it reads outside the try); a
  `put` or `delete` throw is caught and logged. And a reply the socket refused: `#storeReply`
  logs `store reply not sent` and sends nothing. Either way the client's `STORE_TIMEOUT_MS`
  (`STORE_LIST_TIMEOUT_MS` for a list) reads
  it as indeterminate, which is the honest answer: a rejected storage write does not prove it
  never committed. (`#nudgeLeader`'s read can throw too, but only after the reply went out.) A code would change
  nothing for the client, which recovers the same way either way: retry the same put at the
  original `expect`. `version_conflict` then means it landed or another writer moved the key, and
  a re-read tells which — except for an enqueue, whose key no other writer can create (the app
  minted the id), so `createTask` reads the conflict as landed without one (`landedEarlier`,
  below). Re-reading first and
  putting at the new version would apply the write twice. In production a failed storage write
  is expected to reset the object and close the socket, so the client would see a dropped
  connection, not a reply; unverified (Cloudflare's docs say nothing on it).
- **Send size, checked in production 2026-10-18.** Cloudflare's Durable Objects limits page lists
  "WebSocket message size: 32 MiB (only for received messages)" for both SQLite- and KV-backed
  objects; the Workers limits page lists no WebSocket message limit; and the 2025-10-31 changelog
  that raised it from 1 MiB to 32 MiB names no direction. No limit on a message a DO _sends_ is
  documented, and the relay suite lists a full prefix through local workerd, which says nothing
  about the deployed limit. So a full `store-listed` (`MAX_TASKS` 128 × `STORE_MAX_CT_LENGTH`
  40 KiB, about 5 MiB — the one place the arithmetic lives) was sent by a deployed relay: a
  throwaway Worker on workers.dev from `relay/wrangler.jsonc` as it stands (only the `HUB` DO
  binding), 128 `task:` records at 40 KiB ciphertext, each created at 28 KiB and overwritten at
  40 KiB through the daemon leg's `store-put` as the nominated leader. `store-list task:` returned
  one 5,262,028-byte `store-listed` frame, intact (count, keys, lengths, content, versions), on the
  daemon leg (Bun relay client, 103–182 ms over 3 runs) and on the app leg from Bun (a raw `/app`
  socket, 214–241 ms over 3 runs, and `RelayClient.listTasks`, 174 ms). `wrangler tail` showed no
  `store reply not sent` and no error-level line, and no socket closed. **Checked in a browser (2026-10-18):** the PWA's app client (`shared/src/index.ts` bundled for the
  browser, native `WebSocket`) in headless Chromium 156 and Firefox 157, against a throwaway production
  Worker (`seance-relay-sizecheck`, deleted afterwards) holding 128 `task:` records of 39,968-byte ct
  each: a 5,134,668-byte `store-listed` frame arrived intact on 3 runs per browser (every record's ct
  byte-identical, `listTasks` 128 tasks / 0 unreadable, ~320–355 ms, no close code). That is ~2.5% under
  a listing at the full 40,960-byte ct cap. The iOS WKWebView app leg stays open. If an app leg
  refuses it, the fix is the reserved `after`/`next` paging; a listing the adapter cannot read is
  a failed, retried takeover, never a short queue. A refused send looks like a client timeout plus
  a `store reply not sent` line on the relay, or a closed socket.
- **Older and newer clients.** Unknown fields are ignored (`after` on a list); an unknown `t`
  parses to null and is dropped; a store frame with no usable `id` is dropped and logged, the
  socket stays usable (the relay cannot answer what it cannot correlate); one with an `id` and a
  bad field is answered `invalid_request`, as is an unknown prefix. An older client's
  `STORE_KEY_PATTERN` knows only the prefixes it was built with, so it rejects a newer prefix's
  key locally; the relay accepts what its own `STORE_PREFIXES` lists.
- **Atomicity.** `RelayStore` reads, then writes with storage-only awaits: DO input gates deliver
  no other event while a storage operation is pending, and writes issued with no `await` between
  them commit together — the rule `#register`'s count-then-put relies on. The put's record and
  counts, and an expired tombstone's removal, are one coalesced batch. **No non-storage await
  (crypto, fetch, a timer) may be added inside those methods, or between `#holdsTerm` and the
  write in `#onStoreFrame`.** `RelayStore` holds only the storage handle and the tombstone age, so
  hibernation loses nothing.

### The leader (`daemon/src/leader.ts`) — landed 2026-10-16, M2 item 3

Three modules since M3's split (2026-10-17): `leader.ts` runs the term and is the daemon's
entry to it, `leader-adapters.ts` holds the fenced store and the term's `Fleet`, and
`leader-requests.ts` answers apps' requests (`requestHandler`, `answer`, `boundedQueue`).

- **One term is one run.** `lead { term }` builds the term's app-role leg, the `Fleet` over it, a
  `Scheduler` and its 30s tick timer; the same term again is a no-op, a different one ends the
  running term first. A term ends on `follow`, on the daemon's own relay socket dropping, on a
  `not_leader` answer to anything it sent, on a `StoreRevoked` out of any store write (the tick,
  a session event, a branch state, an app's request — one met in a request is answered
  `not_leader`, so the app asks the next leader, except where an
  effect had already run: a revoked `cancelled` write after its despawn is `internal_error` —
  the session may already have ended, and asking again is safe), on its leg's token being rejected (which also hands the
  role back to the relay, below), and with the daemon
  handle — and ending it stops the timer, drops the listener and stops the leg, so nothing of a
  term outlives it (the broker's discipline; the daemon suite counts timers back to baseline under
  a fake clock). The socket drop ends it because the term is that socket's: the relay bumps the
  term for every new leader socket and routes every reply to it. The _leg_ dropping does not: the
  shared client redials and re-reads the registry under the same term.
- **Its own leg, persistent, sent as the scheduler.** The shared app-role `RelayClient`, built per
  term with `scheduler: { term }` over the key the daemon imported at start, seals every request
  `from: "scheduler"` and puts `term` on the frame. Not `LazyRelay`, which hangs up after five idle
  minutes — the loop must hear every registry and `status` push between its own calls — and not
  the broker's, so neither lifecycle can end the other's socket. Rejected: one client re-termed in
  place, since a request sealed under the old term could then leave under the new one.
- **Replies come back on the daemon socket.** A daemon answers `env.from`, so a reply to the
  leader is `to: "scheduler"`, and the relay routes that to the leader's _daemon_ socket, not its
  app leg. `relay-client.ts` hands such an envelope over unopened, and the leg's `deliver` opens,
  replay-checks (the scheduler guard, below) and correlates it on `re` as if it had arrived on the leg.
  Daemon-side only. A `not_leader`
  still arrives on the leg, by `iv`, as for any app.
- **This machine only in process.** A dispatch to the leader's own `deviceId` never leaves it:
  `createLocalOps(…, "leader")` in `handlers.ts` runs the same validation, backend and audit lines
  the op handlers do, under the new origin `leader`, and takes no `Plain`, so only `sessions`,
  `spawn` and `despawn` can be asked for. Every other machine audits a scheduler dispatch as
  `origin=relay client=scheduler`. Its `sessions` gets a remote's deadline,
  `OP_TIMEOUT_MS.sessions`, past which it is `unreachable` as a silent remote is: it waits for
  every launch in flight, ones that start while it waits included, and the pass waits for it
  (added 2026-10-18, M3 review P1).
- **Takeover before any dispatch.** The term waits for its leg's first authoritative registry, then
  runs `Scheduler.takeover()` — what it reads and settles is _The library_'s, "What takeover settles", below. A
  takeover that throws is retried every tick
  interval rather than left as a term that holds the role and runs nothing. Only then do the first tick and the timer run;
  after it, every change to the leg's machine list ticks, and ticks coalesce in the library.
- **The term rides every write and dispatch.** Dispatches carry it on the frame, where the relay
  fences them. Writes go through a store wrapper that refuses once the term has ended (throwing
  `StoreRevoked`, as the queue store does on `not_leader`), so a verdict landing after its term
  cannot write into the store the next term reads; the relay's term-fenced `store-put` is the
  fence behind it. The store outlives terms: since M3 item 3 it is the relay's, reached through
  `createQueueStore` (_The queue store_, below), built per term over the daemon's relay client
  and never shared, so a late pass of an ended term cannot write under its successor's term. A
  leader change across machines, a config reload (`supervise.ts`) and a daemon demoted and
  re-promoted all reconcile what the last term left. `LeaderOpts` takes a `store` (tests) or a
  `storeLeg` with the PSK `key` (production); neither is a type error, never a memory fallback.
- **`store-changed` wakes the term; the term's own writes do not.** The relay nudges the leader's
  daemon socket after an _app-leg_ write, so an enqueue is placed at once rather than at the next
  30s tick; the leader's own writes (its daemon socket, under the term) raise none.
  `Leader.onStoreChanged` re-reads the one key (`Scheduler.refresh`) and ticks. A nudge that
  arrives while takeover runs is buffered, since takeover's `load` replaces the held view, and
  applied right after it; one whose refresh fails is kept and retried at the start of the next
  tick, before the pass reads the held view. A nudge with no running term is ignored: takeover
  reads the same state. A record held unreadable as `created_ahead` — a create from a client
  whose clock runs more than the replay window fast — binds once the leader's clock passes its
  stamp, and nothing nudges then, so the term's timer (not every push's tick) re-reads each such
  record, one `store-get` apiece (added 2026-10-18, M3 review Q5).
- **Session events reach the term two ways** (item 5; Local op socket, "Session events").
  Another daemon's `session-event` comes through the relay to this daemon's socket. That socket
  hands it unopened to the term's leg, which opens and replay-checks it under the scheduler guard
  like a reply, then passes it to the leg's `onEvent` (the scheduler leg alone has one), because it
  answers nothing. `leader.ts` re-validates it (`parseSessionEvent`) and applies it with the
  sealer's AAD-bound id as `from`. This machine's own events call `Leader.onSession` in process
  (`run-capabilities.ts`), as the leader reaches itself only locally. Both are dropped outside a running term,
  since takeover reads the same state from `sessions`, whose `ended` the term's `Fleet` passes
  through.
- **Apps ask the term; the daemon socket answers** (M2 item 6). An app's request `to: "scheduler"`
  (`SCHEDULER_OPS` in `shared/src/types.ts`) reaches the leg like an event — no `re` — and the leg
  opens and replay-checks it under the scheduler guard. `leader.ts` routes a scheduler op to `leader-requests.ts`,
  which takes it as a request only when it was sealed `from: "app"`; a scheduler op from anyone else is
  dropped and logged. Any other op is an event: a daemon's `branch-state` ("Branch state") or a
  valid `session-event`, else dropped — except that an op this leader does not know, from an app
  that wants an answer, is answered `invalid_request` and acts on nothing, which is how an older
  build's `submit` is refused.
  The payload is parsed into a fresh value before anything reads it, each op by its own parser
  (`parseQueueRequest`, `parseTaskRequest` for `route-preview`, bounded by `TASK_REQUEST_LIMITS`,
  `parseTaskRef` for `cancel` and `mark-done`, `parsePauseRequest`, `parseResumeRequest`): the
  leader is a PSK holder that reserves, holds and spawns from it.
  The answer is sealed from this machine to `env.from` and goes out on the daemon socket
  (`RelayClient.reply`, sized like every daemon reply, so an oversized one is `too_large`), not on
  the term's leg: it has to go out while the leg is still dialling, and an answer about this
  daemon's own state writes nothing the term fence exists to stop. Every reply is
  `T | SchedulerError` (`SCHEDULER_ERROR_CODES`): `invalid_request`, `not_ready` while takeover
  runs (the queue is the store's unreconciled view until then), `cancel`'s and `mark-done`'s own (`task_not_found`, `dispatching`, `finished`,
  `despawn_failed`, `conflict`), `internal_error` when the handler throws or a cancel's despawn
  ran and the `cancelled` write was then revoked (`unrecorded` in the library: the session may
  already have ended, the term ends, and MCP shows that message, which says so), and
  `not_leader` (below). `queue`
  replies with the `QUEUE_MAX_TASKS` most relevant tasks, unfinished first (or the ids a `tasks` filter names), prompts cut to `QUEUE_PROMPT_PREVIEW` (none on a finished task), each with
  its latest decision — placed or not. A decision grows with the fleet (about 5 KB at 3 machines ×
  3 exclaves, 20 KB at 10 × 5) and the reply must fit one envelope, so whole decisions are filled
  against a plaintext budget (`REPLY_JSON_BUDGET`, 44 000 bytes, about 59 000 sealed against
  65 536): `ready` and `reserved` tasks first, whose decision says why they wait or where they are
  going, then the rest newest first. A decision past the budget goes out as `chosen` plus the
  winner's candidate alone, its cut added to `Decision.trimmed` — still "placed on X, and why",
  and the readers say the losers were left out: the PWA's decision card counts them among its
  other candidates and closes the list with "N more not shown", MCP's decision line ends with
  "N more candidates not shown", and a record cut to no candidates at all never reads as an
  empty fleet. Where even the winner-only records overrun the budget (twenty tasks with every
  bounded field near its cap), the oldest tasks are left out, finished ones before live ones, so
  the reply holds fewer than `QUEUE_MAX_TASKS` rather than none. Without the budget twenty
  finished tasks sealed past the bound on a 3 × 2 fleet, and `queue` answered `too_large` for
  good. `route-preview` is `Scheduler.preview`: the same `route` over the same snapshot,
  reserving and writing nothing. `cancel` (`TaskRef`) is `Scheduler.cancel` (_The library_, below),
  answered with the task as it now stands (`TaskResponse`), and ticks, since a cancelled task
  frees its slot. `mark-done` is `Scheduler.markDone`, answered with the
  task as it now stands and ticking, since what waited on a merged dependency is released by it;
  its refusals are `task_not_found`, `dispatching`, `finished`, `conflict` and, where
  it ends a live session first, `despawn_failed`, with a revoked write after the despawn `unrecorded`, as
  for `cancel`. `pause` and `resume` (M3 item 5) are `Scheduler.pause` and
  `resume` (_The library_, "Pause"), answered with every hold in force after the change;
  `resume` ticks, so what the hold kept waiting is placed at once. Their refusals:
  `reset_unknown` (a reset hold on an account no reading gives a reset for), `conflict` (the
  record kept changing under the write), and `invalid_request` past `MAX_PAUSE_HOLDS - 1` account holds. `queue`
  carries the holds in force (`QueueResponse.holds`, absent only from M2's leaders); they come
  off `REPLY_JSON_BUDGET` before any task, since a reader refuses a reply whose holds do not
  parse — 32 at every bound still seal under the envelope. **All four are audited** (`queueAudit`
  in `audit.ts`) as `audit queue origin=relay op=cancel|mark-done|pause|resume id=<request>`, with
  `task=<task>` or `account=<account>` where one applies, and `ok` or `refused
  code=…`: the request id finds the app's side, and the task id joins the line to the
  `task=` on the spawn it leads to, on whichever machine runs it. The prompt is never on it —
  the spawn line fingerprints that. `origin=relay` because apps reach the leader only through
  the relay; the despawn a cancel sends audits on its target as any scheduler dispatch does.
  An enqueue is no request — an app's create is a store write the relay answers — so the
  leader's record of one is its admission, the first write after the version-1 create:
  `audit queue origin=leader op=admit task=<task> client=<client> createdAt=<ms>
  state=ready|blocked|failed`, `client` the record's own `TaskSpec.client` (the PWA's `pwa`,
  MCP's `mcp`; absent from older clients), never the prompt (added 2026-10-18, M3 review S5).

- **`queue-changed` tells apps to re-read** (M3 item 6). Every write the term makes to a
  `task:` record (the `watched` store wrapper), an app's create it refreshes on `store-changed`,
  a pause or resume, and the end of takeover each note a change; one nudge goes out per 500 ms
  (`NUDGE_COALESCE_MS`), naming the task ids that changed, or none when more than
  `QUEUE_MAX_TASKS` did or the holds did, which reads "re-fetch the whole queue". It is sealed
  `from: "scheduler"`, `to: "app"` on the term's leg, so a demoted leader's is fenced like any
  of its writes, and an app believes it only `from: "scheduler"` — an envelope any PSK holder
  seals `from: "app"` is not heard. It carries no task data: an app asks `queue` for it, so
  the reply stays the leader's, bounded and sealed to the asker. It is a hint, not a stream:
  a lost one costs a poll's delay, which is why the PWA keeps a bounded poll and a re-read on
  every reconnect and leader change (PWA, "The Queue screen"). The relay logs no line for
  an accepted one (Threat model, item 3).
- **What never arrived is told from what may have.** The term's `Fleet` maps a request the
  relay provably did not deliver — `offline`, `unknown`, `refused`, or `disconnected`, which
  never left the leg — to the library's `undelivered`, so a spawn the relay could not route
  goes back to `ready` and is placed elsewhere by the next pass, instead of sitting out its
  TTL and then `lost` until a machine that never received it returns. A timeout, or the
  socket closing after the send (`dropped`), is `unreachable`: it may have landed. `not_leader`
  never arrived either, but it ends the term, whose fenced store refuses the verdict.
- **No term is a `not_leader` answer, never silence.** The relay routes `to: "scheduler"` on its
  record, which can still name a daemon whose term ended (after a relay restart, or while a
  resign below is in flight), and a request left to time out reads as a dead machine. So
  `Leader.deliver` says whether a term took the envelope — a running one, or one still taking
  over, which answers `not_ready` — and when none did, `relay-client.ts` opens it under the
  same scheduler guard and answers an app's scheduler request `{ ok: false, code:
  "not_leader" }`. Anything else — a late reply or event for an ended term — is dropped
  (`reason=not-leading`). That makes a follower
  open what is sent the scheduler, where it used to drop it unopened; it acts on none of it beyond
  that one answer.
- **A term the daemon ends on its own goes back to the relay** (M2 item 3's gap A, closed in item
  6). A `follow`, a `not_leader` answer and the socket dropping are all things the relay already
  knows. The leg's token being rejected is not: the relay still names this daemon, so `auto` would
  look available while nothing answered, until the daemon's socket next dropped. On that one cause
  the leader calls `resign`, and the daemon sends a fresh v2 register over `roles: []` on its own
  socket; the relay re-nominates at once, under a new term, and sends this daemon `follow`. Chosen
  over a new signed frame because the register already is one: signed by the key the id hashes,
  refused `register unverified` otherwise, and applied only to the socket it arrived on — so a
  bearer-token holder cannot demote another machine's leader (it cannot sign for that id), and
  nothing new is added to the relay's surface. The cost is a registry push to every app and the
  live `status` cleared until the next beat, as for any re-register. **The role comes back on the
  next dial**: the resign lasts for the socket it was sent on, and the next connection's register
  asks for the role again. No timer: the token whose rejection caused it is the daemon socket's
  too, and a redial is where that token is proven again — a timed retry on a socket that still
  holds its old authorization would only flap the role and push the registry each time.
- **One replay guard for every scheduler envelope, outliving terms** (M2 review, 2026-10-17).
  Each term's leg used to build its own `ReplayGuard`, and the `not_leader` answer used the daemon
  leg's. The relay decides which term an envelope reaches, so it could hand an app's `cancel` to
  term _t_, then — after a `lead { t+1 }`, or a `follow` and a `lead` — to the next term, or to
  the follower, inside the 60s window: one request run once per term. Now one guard per daemon
  process (`schedulerGuard` in `daemon/src/run.ts`, module-level so a config reload keeps it) is
  injected into every term's leg (`scheduler.guard` on the shared `RelayClient`) and into the
  `not_leader` path (`schedulerGuard` on the daemon's `RelayClient`), so whichever sees an envelope
  first is the only one that acts on it. What it cannot reach is another daemon: the role address
  is the one envelope with more than one possible recipient (Security model, "Routing fields bound
  as AAD"), and the residual cross-daemon duplicate is recorded there.
- **Alerts are log lines until M4** (M3 item 5). The term's `Scheduler` takes `onAlert`, which
  `startTerm` logs as `warn scheduler: <message>`: a dispatch spending credits, and a wait for
  input past 30 minutes (_The library_, "Credits spill" and "Needs input"). The line names task
  and account ids, never a prompt or title. M4's Web Push takes the same alerts.
- **A task on a machine that never answers again** becomes `lost` — after 15 minutes absent
  once running; while still reserved, at its TTL with its `sessions` check unanswered and its
  machine not connected, or 15 minutes past its TTL with every check failing on a machine that
  is — and is never dispatched again on that evidence
  alone (_The library_, below, "`lost`"). Lost for `lostExpiryMs` (7 days) while its machine is
  disconnected it is `failed` `lost_expired`, and an `awaiting-merge` task past `mergeExpiryMs` (7 days) is `failed`
  `merge_expired` (_The library_, "Expiry").

### The library (`scheduler/`) — landed 2026-10-16, M2 item 1

M3's states landed 2026-10-17 (M3 item 4a), and caps, pause and alerts the same day (M3 item
5). What the leader runs. The plan and what is still ahead live in docs/scheduler.md; this
section records what exists. `daemon/src/leader.ts` hosts it ("The leader", above); tasks reach
it through the store: an app's `store-put` create, read by the leader on `store-changed` ("The leader").

- **A pure library behind two interfaces** (`scheduler/src/ports.ts`). `QueueStore`
  (`list`, `get(id)`, `put(id, expect, body)`, `delete(id, expect)`, and `getPause`/`putPause`
  for `queue:pause`) holds plain task bodies — sealing, opening and the reader rules
  (`bindTaskRecord`) are the adapter's. A record the adapter cannot read comes back as
  `{ id, version, reason }`: the library holds it apart (`Scheduler.unreadable()`), never acts
  on it and never deletes it unasked, since after a PSK rotation every record reads that way.
  `discard(id, version)` (M3 review S2, 2026-10-18) deletes one when a person asks: only a record
  held unreadable, only at the version it was read at (`conflict` otherwise, `not_found` for a
  readable task or none), so junk and old-PSK records can leave a store they would otherwise
  fill for good. A lost reply or a conflict is read back, as prune reads one. A failed
  write is a value (store port, 2026-10-17), handled as "One write at a time per task" (below)
  says. Losing the right to write is a throw, `StoreRevoked`, which unwinds the pass.
  `refresh(id)` re-reads one record, for a host told that key changed.
  `Fleet` is the registry with each machine's newest status, live or kept, plus
  `spawn`/`sessions`/`despawn` to a `deviceId`, with two codes of the library's own
  beside the daemon's: `unreachable` (no answer, so it may have run) and `undelivered`
  (provably never reached the machine, so it did not). It owns no timer, socket or clock:
  the host calls `tick()` on each registry or `status` push and on a 30s timer, so a host
  that stops calling leaves nothing running but the spawns already sent. `MemoryQueueStore`
  is the library's reference store and its tests' store, never the daemon's (_The queue store_,
  below). It keeps the relay store's rules, tombstones
  included, and fault hooks (`failNext`, `replay`, `plant`) that let the suite
  (`scheduler/test/store.test.ts`) play the relay and an attacker. The suite's `Fleet` double is `scheduler/test/fixtures.ts`.
- **Layering is enforced** (`scheduler/test/layering.test.ts`): nothing in `scheduler/`
  imports `daemon/`, and nothing in `daemon/` imports `scheduler/` but the leader's modules
  (the test's `LEADER_MODULES`, an exact-path set), by
  package name or by relative path, static or dynamic. The test also proves the
  detector catches each forbidden direction, so a regex that silently matches nothing
  fails too. Moving the scheduler to a fixed box is then two adapters, no library change.
- **One routing function** (`route.ts`): a task and a snapshot in, a `Decision` out —
  every (machine, exclave) pair is a candidate, either rejected with _every_ reason that
  applies or scored with every component, so the record explains the choice and each
  loser. A decision holds at most `DECISION_MAX_CANDIDATES` (64: the relay's 32 machines with
  two exclaves each) and a candidate at most `CANDIDATE_MAX_REASONS` (32), and a reader refuses
  more; past 64 the leader cuts from the end, the rejected first, and counts the cut in
  `Decision.trimmed`. Reasons are structured codes: `offline`, `status_stale`, `task_id_unsupported`,
  `exclaves_unknown` (a daemon predating exclaves cannot say which account a spawn
  bills; an empty list reads the same, since a real daemon always lists `default`, and
  stays in the record as one exclave-less candidate), `disk_low`, `pressure_unknown`, `pin_mismatch`, `repo_absent` (matched on
  `RepoEntry.origin`, never the machine-local name), `auth_missing`, `quota_unknown`,
  `quota_over_line`, `model_not_included` (the task's model is a gated one its seat bills
  to credits — "Seats" below), `cap_reached` (global; `scope: "account"`, "Routing caps" below; or `scope:
  "batch"`, "Batches" below), `batch_order` ("Batches"), `paused` ("Pause"). M4's
  `skill_absent` (naming the skill), `base_unpushed` and `auth_expired` are read and worded
  already; no filter emits them yet. Pressure
  comes only through `liveStatus` (a connected machine's) and then only if `isStatusStale`
  passes it; a kept status never answers pressure. Quota comes from
  every status alike, through `newestQuotaByAccount` and `effectivePct` — the
  library restates neither rule. An observation describes an account, not the machine that
  sent it, and carries its own `at`, so an account last used on a laptop that has since slept
  keeps that reading rather than an older one; no age cap beyond the reset rule
  (docs/scheduler.md, Settled defaults 7). An absent `free` is not `disk_low`: the floor guards a
  disk known to be full, and a host with no statfs answer would otherwise never get work.
- **Missing quota is unknown, never 0%.** `quota_unknown` when no status carries the
  account, when its newest observation has no window in it, or when a trimmed status
  (`isQuotaTrimmed`) from a host of the account does not carry it and nothing newer than
  that status does. A candidate rejected so has no score at all, rather than one
  computed at zero — the case where 0% would have won is in the suite.
- **Score** (lower wins, weights in `SchedulerConfig`): `accountPressure` is
  `(u/(1-u))²` at projected usage, worst window (5h, 7d, and the per-model weekly of the
  task's own model — "Seats" below), multiplied by the share of the window still to run; `machinePressure` is
  `max(cpu, mem)` as a fraction (disk never scores); `dependencyDistance` 0 / 0.25 /
  0.5 from `TaskSpec.base` (absent until M4's stacking fills it); `queuePressure` the
  in-flight scheduler tasks on the machine. Stickiness subtracts a fixed bonus from the
  `TaskSpec.lineage` owner's total, never overrides a filter. Projected usage is the
  effective reading plus a fixed estimate for this task and each in-flight one billed to
  the same account, per window span (`taskEstimatePct`: 5% of a 5h window, 1% of a weekly —
  a task's share of a week is a fraction of its share of five hours); the filter additionally treats a window resetting within 15 min as
  empty. An exclave with extra usage on is scored past the line and its candidate
  carries `spill` ("Credits spill" below); `extraUsageEnabled: null` reads as off. Credits
  spent to the cap (`cu` reaching `cl` on the account's reading; `c` at 100 only from a daemon
  that predates the amounts — `c` rounds for the card, so it alone can say 100 with credits
  left) can't take a spill, so that exclave is
  `quota_over_line` with `creditsSpent` instead. A reading without `c` (a daemon that predates
  it, or a trimmed status), or one from before this UTC month (credits reset then), still spills: refusing it would stop every spill until the fleet
  upgrades, and the spill alert still says credits are being spent.
  Exact ties go to the lowest `deviceId`, then exclave, so a decision reproduces.
- **Seats** (2026-10-18, docs/scheduler.md Settled defaults 17). `SchedulerConfig.seats`
  maps `ExclaveInfo.seatTier` to a `capacity` (quota relative to the largest seat) and the
  `gatedModels` families its quota covers. A task whose model names a gated family
  (case-insensitive substring: `fable`, `claude-fable-5-1[1m]`) rejects every exclave whose
  seat doesn't include it with `model_not_included`, never a spill — the point is that it
  would bill credits. The per-task estimate is `taskEstimatePct[span] / capacity`, for this task
  and each in-flight one on the account, in the filter, the score and `accountResetAt`
  alike. A tier missing from the table, or no tier, is `unknownSeat`: capacity 1, no gated
  model, so an older daemon's exclave routes as before except that it gets no Fable task.
  Tiers are looked up by own key only (`Object.hasOwn`), since the string is daemon-reported.
  A per-model weekly (`7d Fable`) binds only a task on that model, matched on its display
  name's first word in the task's model: until 2026-10-18 every window bound every task, so a
  full Fable week refused Opus work on an account with room. A task whose account's newest
  reading holds only other models' weeklies is `quota_unknown` (`unobserved`), never 0%.
- **Routing caps** (M2's global, M3 item 5's per account). Both count `IN_FLIGHT` — reserved, running
  and `needs-input`, which keeps its slot — and neither counts `lost` ("`lost`" below).
  `globalMax` (8) puts `cap_reached` with no `scope` on every candidate, as M2's leaders sent
  it. `accountMax` (4, docs/scheduler.md Settled defaults 8) puts `cap_reached` with `scope:
  "account"` on each candidate whose exclave's account already holds that many, counted by
  the account of each task's reservation or assignment exactly as projected usage counts
  "each in-flight one billed to the same account" — one count, `accountInFlight` in
  `route.ts`. A task whose machine has left the registry has no account to read and counts
  toward neither; its machine's absence makes it `lost` anyway.
- **Pause** (`pause.ts`, M3 item 5). `queue:pause` holds the holds (`PauseHold`): one on the
  whole queue, one per account, at most `MAX_PAUSE_HOLDS` — account holds stop one short of
  it, so a whole-queue pause always fits. The library reads it on `load()` —
  so takeover, and a pause outlives the leader that took it — and writes it through
  `putPause` by CAS, serialized like a task's writes; a conflict or lost reply re-reads and
  applies the change again (after a lost reply the one version past ours is ours, the record
  being the leader's alone), and three lost races answer `conflict`. A change that leaves the
  holds as they were writes nothing. A whole-queue hold puts `paused { scope: "queue" }` on
  every candidate, an account hold `paused { scope: "account" }` on that account's, so the
  decision says why a task waits, and `route-preview` says it too; running sessions are never
  touched. `until: "reset"` needs an account and stores `resumeAt`, resolved at the pause from
  the account's newest reading (`accountResetAt`): over the line in any all-models window
  (judged as routing judges it, in-flight tasks and reset grace included; a full per-model
  weekly holds only that model's tasks, through routing, never the account), the latest
  reset among those windows — an earlier one would lift the hold into a window still full —
  else the earliest reset still ahead; with no such reading, `reset_unknown`. A reset hold past
  its `resumeAt` lifts with no write and no resume; the next pause or resume drops it from the
  record. **An unreadable `queue:pause` fails closed** (decided 2026-10-17): it reads as one
  whole-queue `until: "resume"` hold, reported through `onError`, and the next pause or resume
  overwrites it at its version. The hold is synthetic — its `at` is the time of the read, not of
  any pause — and the next write persists it: an account pause made meanwhile writes it back as
  a real whole-queue hold, which then stays until a `resume`. A pause is usually about spending, and a term holder can put
  junk there (Threat model, item 3): failing open would let junk lift a pause, failing closed
  lets it stop dispatch, which holding the term already could. After a PSK rotation the cost is
  one resume.
- **Needs input** (`alerts.ts`, M3 item 5; docs/scheduler.md Settled defaults 5). The clock
  rides the write that moves the state: `#update`, the one write path, stamps
  `needsInputSince` on a task entering `needs-input` and clears it and `escalated` on leaving
  it for any state but `lost` (a machine's absence is not an answer: the stay resumes where it
  was, and an escalated one is not alerted twice), so no transition can skip it and it costs no
  write of its own. On the record, so a new leader does not restart it. A `lost` task
  its machine's `sessions` shows alive again returns to `needs-input` when it holds
  `needsInputSince` — only one lost from `needs-input` does — since no event re-sends the wait
  on reconnect (M3 review Q2, 2026-10-18); before, it read `running` and never escalated. A pass marks a task waiting past `needsInputEscalateMs` (30 min)
  `escalated: true` — one write per stay — and alerts once that write lands, so neither the
  next pass nor the next leader alerts it again; the task keeps its slot and is never killed.
  A `needs-input` record no leader stamped (one written before this) has its clock started by
  one write. The check is inside the pass, which runs at least every 30s: no timer of its own.
- **Credits spill** (M3 item 5). A reservation on a candidate carrying `spill` is recorded in
  the decision the reservation writes — the PWA's verdict shows it on the chosen line, "would
  spend credits (5h at 93%)" — and alerted through `onAlert` once its spawn is confirmed (a
  refused spawn spent nothing, and must not burn the window's one alert), once per account per
  quota window, not per task: the record is the per-task trace. A window is told apart by its
  reset, and two readings of one reset differ by seconds, so a later reset is a new window only
  by more than `resetGraceMs` (or once the alerted one has passed); a reading with no reset
  never is one. An `onAlert` that throws goes to `onError`, never into the pass.
  The de-dupe is in memory (`SpillAlerts`, `alerts.ts`), so a new leader alerts an ongoing
  spill once more; accepted for a log line, M4's push decides whether it needs more.
- **Reserve, then dispatch** (`scheduler.ts`). Ready tasks are routed oldest first and
  reserved one at a time — each route sees the reservations before it. A reservation is
  one store write carrying the decision; an unplaceable task's decision stays in memory
  (`lastDecision`), so the store sees one write per transition and none per tick. **The
  pass never awaits a spawn** (M2 review, 2026-10-17): each is launched and tracked, so one
  machine slow to answer (a spawn's 90s timeout) holds no other placement, TTL or absence
  check behind it, and one that throws cuts no pass short — its fault goes to the host's
  `onError`. A verdict applies only to the reservation it answers (same machine, same
  expiry), and a reservation whose spawn is still out skips the TTL check below, its
  verdict being the better answer; `drain()` waits for ticks, spawns and checks alike. A spawn
  resolves its reservation once, never with a second spawn: started or `task_running` →
  `running` on the reported pane; `undelivered` → `ready` at once, routed afresh by the
  next pass, since nothing can have run; a daemon refusal → `failed`; `unreachable` or a
  transport error (which may come after the spawn ran) → stays reserved. Past the 120s TTL the machine's `sessions` decide: a
  session carrying the task id is the spawn that landed; the task id in the reply's
  `ended` is one that landed and already finished, settled by its PR ("Done detection":
  `awaiting-merge` with one, else `done`); neither releases the task to
  `ready` **only on the machine's proof** — its `ledgerSince` at least the replay window
  (60s) before the reservation was made (`reservedAt`), the window standing in for clock
  skew, since a daemon further behind refuses this leader's every envelope as from the
  future. Without proof (a daemon with no ledger, or one pruned past the reservation) the
  task is `failed` `dispatch_unconfirmed`: terminal, because a re-dispatch could be a twin
  on another machine, where `task_running` cannot see it. An unanswered check waits while
  the machine is connected, and once it is not the task is `lost` on that machine (below),
  never `ready`. So does a connected machine whose checks have all failed for `lostAfterMs`
  past the TTL (M3 review Q3, 2026-10-18): one answering only errors held the reservation's
  slot for good, and `cancel` and `mark-done` refuse a reservation. The clock is per machine,
  in memory, reset by any answer. **Why the TTL check cannot race a late spawn:** a daemon drops a request
  envelope stamped more than 60s before its own clock (`ReplayGuard`,
  `shared/src/crypto.ts`; `daemon/src/relay-client.ts` checks every inbound request), and
  the dispatch is sealed just after the reservation is written, so a spawn that ever runs
  has begun — and been recorded, write-ahead — by about the 60s mark, half the 120s TTL;
  a `sessions` reply then waits out any launch still in flight. A session event resolves a
  reservation before any of that. It is proof the spawn landed even when the reply
  never came: `busy`/`idle` → `running`, `needs-input` → `needs-input`, `ended` →
  settled by its PR as above. The assignment is the reservation's target plus the reporting pane. The
  event is honoured only when the machine that sealed it is the one the task was
  placed on (`onSession`'s `from`). Without both of these, a spawn whose reply was
  lost and whose session ended inside the TTL would be routed a second time, and
  the daemon's `task_running` could not catch it, the first session being gone
  already (Local op socket, "Session events"). The spawn audits as
  `client=scheduler`. Ticks coalesce: one asked for mid-pass runs once after it.
- **One write at a time per task** (M2 review, 2026-10-17). Every change goes through one
  path, serialized per task id and computed from the copy held when its turn comes, so two
  writers never race one version: an `ended` event landing while the verdict's write is out
  applies after it, to what it wrote — with the relay store that window is a round trip. A version conflict is then a write this process
  did not make — apps cannot overwrite a task, so it is a term that ended without hearing its
  own write land, or a create racing its own; the held copy is refreshed through `get` and the
  change applied again to what it finds, up to three tries. A lost reply (`indeterminate`) is
  read the same way, except that the one version past ours is ours, every task overwrite being
  the leader's. `too_large` writes again with the decision cut to its winner; any other refusal
  goes to `onError`. Each change re-checks the state it acts on, so one that no
  longer applies (a reservation routed from a snapshot taken before a cancel) declines.
  The transitions themselves are pure functions of the task and what was observed.
- **The sweep** (M2 review, 2026-10-17). A running task whose `ended` event never arrived
  would read `running` forever and hold its slot; after `globalMax` of them `auto` places
  nothing (`cap_reached`). So once per `sweepIntervalMs` (120s, docs/scheduler.md Settled
  defaults 12) a pass also reads `sessions` from each connected machine holding a running,
  `needs-input` or `awaiting-merge` task, settled as takeover settles one: no session carrying
  its id has ended, and `progress` is applied to a live one ("Done detection" below). The
  `awaiting-merge` read is the backstop for a `branch-state` merge that never arrived, which
  would otherwise leave its `after: "merged"` dependents blocked for good; it shares the one
  cadence, since a merge is no more urgent than a freed slot.
  It shares one `sessions` call per machine with the TTL and `lost` checks. **The pass does
  not wait for it** (M3 review P1, 2026-10-18): at most one check per machine is out, and its
  answer is settled when it comes and ticks again, so a slot it frees is used in that tick and
  one slow machine — the leader's own waits out every launch in flight — holds no admission or
  dispatch. A machine whose check came back `unreachable` (a timeout) is not asked again until
  the next sweep or a change in its connection, or a hung peer costs a timed-out call every
  pass. Expiry leaves a task alone while its machine's check is out. An answer is applied
  only to a task still where it was when its machine was asked, since one read before an
  event landed could undo it. Rejected: a sweep every pass, which is one `sessions` per busy
  machine per status beat; and trusting events alone, which is what left the slot held.
- **What takeover settles** (`takeover()`; hosted by "The leader", above) is `load()` plus one
  `sessions` read per machine with a task
  that read can move (`answerable`: in flight, `lost`, or `awaiting-merge` on a task branch —
  what a pass checks), settled before the host's first tick: a
  reservation as the TTL check settles one, except that a session or an `ended` entry
  carrying its id counts at any age, so one inside its TTL with neither waits it out; a
  running task with no session left has ended while nobody led, and is settled by its PR
  ("Done detection") — unless a trimmed reply leaves that unknown, when it stays as it was;
  a `lost` task as below. An unanswered machine
  changes nothing, with the TTL check's one exception: a reservation past its TTL on a
  machine no longer connected becomes `lost`. It does not prune (M3 review P2, 2026-10-18):
  pruning ("Pruning") and expiry ("Expiry") run in the first pass, which the host ticks right
  after takeover, so the term answers after one list and one round of `sessions`.
- **States** (`task.ts`; M2 item 1, M3's added in M3 item 4a, 2026-10-17): `queued →
  blocked → ready → reserved → running ⇄ needs-input → awaiting-merge → done`, with
  `failed`, `cancelled` and `lost` off-path, one transition table, an illegal move a thrown
  bug. `awaiting-merge → failed` is merge expiry, and `lost → failed` covers `lost_expired` beside
  `dispatch_unconfirmed` ("Expiry"). An app creates `queued`; only admission moves it ("Admission and dependencies").
  `reserved` also reaches `needs-input`, `awaiting-merge` and `done` directly. The
  alternative was a two-step through `running`. An event for a reserved task is one
  observed transition, so it costs one store write, and a `running` written first would
  record a state nobody observed. A reserved task refuses `cancel` (`dispatching`) rather
  than racing its spawn; a finished one is `finished`; `queued`, `blocked` and
  `awaiting-merge` have no session, so they are cancelled with no despawn. A task that
  finishes while its despawn is out (its `ended` outran the reply) is answered as the task
  it now is, not `conflict`. Which states are placed, finished, still waiting and so on is
  one table shared with the apps (`TASK_PHASES`, `shared/src/task-phase.ts`); `task.ts`
  derives `PLACED` and `FINISHED` from it.
- **Admission and dependencies** (`deps.ts`, M3 item 4a). Every pass, after its
  `sessions` checks and before routing, moves each `queued` or `blocked` task to where its
  `deps` put it: `ready` when every edge has released, `blocked` while one waits, `failed`
  when one never can. An edge releases when its predecessor is `done`, whatever settled
  it (`mark-done` always wins); `after: "opened"` also when it has a PR and its branch is
  `pushed` — a `here` predecessor has no task branch, so its PR alone — and `after:
  "merged"` only at `done`, a merge being what makes a task done. `after: "done"` (#21,
  M4; no client writes it yet) releases only at `done` too, the same as `merged` until a
  `until: "reported"` task has a merged-but-open state of its own. A `failed` or
  `cancelled` predecessor fails its dependents, checked before the release, so a cancelled
  predecessor with a PR and a pushed branch fails `opened` too. A dependent already
  released has left `blocked` and is not judged again, so an outcome can depend on whether a
  pass saw the predecessor fail before the release; accepted. A `lost` predecessor is waited on, since it may still finish — until it expires
  (`lost_expired`), which fails its dependents `dependency_failed`. Three ways an edge
  never releases, each a
  `TaskFailureCode`: `dependency_failed`, a `failed` or `cancelled` predecessor — computed
  to a fixpoint in one call, so a chain fails in one pass rather than one link per pass;
  `dependency_missing`, an id the store does not hold once `DEP_MISSING_GRACE_MS` has
  passed since the dependent's own `createdAt` (a client puts a batch one record at a
  time), where an id held as an unreadable record waits, being in the store; and
  `dependency_cycle`, every `queued` or `blocked` member of a strongly connected component
  over every held task, a self-edge included, and a `sequential` member's wait on the
  nearest lower `index` not over counted as an edge (a lower index depending on a higher
  one of its batch would otherwise deadlock silently), so a loop a later create closes fails the
  member already blocked too — leaving out the edges of a finished task, whose dependents
  its outcome has already released or failed, so a `cancelled` member's dependent fails
  `dependency_failed`, not `dependency_cycle`. A `queued` task whose `createdAt` is more than
  `ADMIT_MAX_AGE_MS` old — `STORE_TOMBSTONE_MS` less a day (M3 review S6, 2026-10-18) — is
  never admitted: its key's tombstone may be gone, so it may be
  a pruned task's authentic version-1 blob put back (`createdAt` is app-sealed, so an app clock
  29 days behind fails a fresh task: accepted, skew of that size is out of scope, as for
  `DEP_MISSING_GRACE_MS`). The day is there because the tombstone runs from the delete on the
  relay's clock and the age from a `createdAt` that may be `REPLAY_WINDOW_MS` ahead: a task
  pruned soon after its create would read young enough once its tombstone lapsed. It fails `queue_expired`, first in the
  call, so its dependents fail `dependency_failed` with it and pruning can take it — held
  `queued` instead, it would wait forever and hold its dependents with it. A release lands at the next pass, not on
  the event: the host ticks at least every 30s.
- **Batches** (`batch.ts`, M3 item 4a). No batch record exists: a batch is the tasks that
  name its id, and its strategy is the earliest-created member's (ties to the lower id).
  `sequential` bounds it at one member in flight, `parallel` at `max`, `auto` not at all;
  at the bound every candidate carries `cap_reached` with `scope: "batch"`. The bound
  counts `IN_FLIGHT` and `lost`, so an `awaiting-merge` member frees its place but a lost
  one does not: the global cap leaves `lost` out so a forgotten machine cannot pin it, a
  reason a batch's own serialization lacks, and its session may still run on a machine
  that only sleeps, so the next `sequential` member would run beside it. `sequential` also
  enforces `index` order, which routing order alone cannot (a member whose predecessor is
  unroutable this pass would go first): a member is held until every held lower index is
  over — finished in any state, `failed` and `cancelled` included, or `awaiting-merge` —
  with `batch_order`, naming the nearest lower index not over (the one cycle detection
  counts as its edge). Its own reason, not `cap_reached`: the earlier member may be in
  flight, but as often `blocked` or unroutable, and "1 of 1 in flight" would misstate that;
  at the bound `cap_reached` comes first. One still `blocked` or unroutable holds it.
  `parseBatch` bounds `index` at `MAX_TASKS` (`TASK_SPEC_LIMITS.batchIndex`): the store holds
  no more task records, so no batch held at once has more members. Order is enforced among held
  members only: a lower index not in the store (never put, not yet refreshed, or pruned)
  holds nothing, so gaps, 1-based numbering and pruning never wedge a batch, and the check
  costs the members, not the `index`. One client puts a batch together, so the window is a
  refresh. A pass routes ready tasks
  oldest first, except that one batch's members go in `index` order from where its oldest
  ready member would have gone.
- **Done detection** (`done.ts`, M3 item 4a). A failed session read is no answer, never an empty
  list: `listClaudeSessions` and `listPanes` read empty only when no tmux server runs (tmux's
  "no server running", or a socket path that does not exist), and throw on any other failure —
  the exec timeout, a permission error, a server from another tmux version — so `sessions`
  answers `internal_error` and the library leaves the tasks as they were. Read as empty, every
  task the machine launched would be in `ended` and settle (added 2026-10-18, M3 review Q1;
  reap's in-use check and a spawn's `task_running` check read panes the same way).
  A session that ends with a PR known — the
  event's `prUrl`, the one its record holds, or its machine's `progress` — is
  `awaiting-merge`: it holds no slot, and `after: "merged"` dependents wait on. With none
  it is `done`, `doneBy: "session"` — unless its machine reports a nonzero exit status
  (`TaskProgress.exit`), when it is `failed`, `session_failed`, and its dependents fail
  `dependency_failed` rather than start on a branch with nothing pushed (M4, `failed` from exit
  status, M3 review R3; Daemon, "Exit status"). A live session's newer PR URL is recorded even when
  its state stands, since `after: "opened"` reads it. `onBranchState`, from the machine
  the task was placed on only, records `branch` and `pushed` — `pushed` never goes back
  within one branch, so the first pushed report with a PR releases `opened` for good — and
  a merge makes the task `done`, `doneBy: "merged"`, a session still running included. A
  report naming a different branch than the one recorded starts it unpushed. A `merged`
  verdict is believed only of a branch seen pushed (`pushed` is per branch, sticky within
  one, so a remote branch deleted after its merge still reports pushed on takeover; a PR URL
  is no evidence, being tied to no branch, so it is the old branch's after a switch; a
  first report naming a branch has no prior to compare): reap's `Merged` reads a branch with no commits past the default
  branch as an ancestor, which is every task branch before its first commit, and a task
  that switched branches would otherwise be `done` with its PR unmerged. A `here` task
  ignores `pushed` and `merged` altogether: its branch is the checkout's, often the
  default branch, pushed and trivially merged; its `opened` comes from its PR and its
  `merged` only at `done`: an `awaiting-merge` `here` task is left out of the sweep, since no
  reply can change it, and reaches `done` only by mark-done before it expires (`merge_expired`, below), so
  its `after: "merged"` dependents wait for that until then. What `branch-state` carried while no leader
  listened is read back from `SessionsResponse.progress` (`TaskSessionsReply.progress`):
  on takeover, on the sweep, and when a machine holding a placed or `awaiting-merge`
  task is connected again after a pass saw it away. In a reply the daemon trimmed
  (`progressTrimmed`) a session-less task with no entry settles by the PR its record
  already holds (`awaiting-merge`, slot freed — a later read still settles a merge the
  trimmed one hid); with none on the record it is unknown and waits for a later read,
  never settled as PR-less. That residual can keep a slot while every read trims the
  task's entry; accepted (decided 2026-10-17, over accepting the whole leak): the daemon
  trims only to fit one envelope, oldest first, from at most `SESSIONS_MAX_PROGRESS`
  entries, so it takes an old, PR-less task on a machine with a long history, and a held
  slot is no twin risk — the task is never re-dispatched, only late to free its place. The
  one wider case is version skew: an adapter whose `progress` did not parse (`parseTaskProgressList`
  nulls the whole list on one bad entry) sets `progressTrimmed` too, so every PR-less
  session-less task on that machine holds its slot until the daemon and leader agree on the shape
  (an update); accepted on the same ground. A daemon that sends no `progress` settles by
  the PR the record holds. The leader passes `prUrl`, `progress` and `branch-state` on since M3
  item 3: `sessionsOf` in `leader-adapters.ts` parses the machine's `progress` list at takeover
  and on every check, and an unparsable one sets `progressTrimmed`. `endedAt` (2026-10-18) is stamped by `#update`
  on a task entering `awaiting-merge` — the one write path, as the needs-input clock is — and
  never on a record already there, so one an older leader left has none and ages from
  `createdAt`; "Expiry" is what ages from it.
- **Pruning** (`prune.ts`, M3 item 4a). The store caps `task:` at `MAX_TASKS`, and an
  app's create past it is `store_full` — which the leader never sees. So `prune()`
  deletes the oldest finished tasks past `keepFinished` (50, docs/scheduler.md Settled
  defaults 13) at the end of a pass, only once the store holds `pruneAt` records (96, held plus unreadable;
  under `MAX_TASKS` so creates still fit): pruning every time would delete a finished task
  an app is naming in a create still on its way to us, and the dependent would fail
  `dependency_missing`. `pruneAt` narrows that race, it does not close it. It
  writes only when something is over the keep; never a task an unfinished one names in
  `deps`, whose dependent would otherwise fail `dependency_missing` on work that was
  there. Equally old tasks go in id order, so two leaders prune the same ones. The deletes go
  out together, each its own CAS on its task's chain, so crossing `pruneAt` costs a round trip,
  not one per record; a delete whose reply was lost, or that met another write, is read back,
  so one that landed leaves no ghost taking a slot of every later prune (M3 review P2 and Q4,
  2026-10-18). `lost` and `awaiting-merge` tasks are
  never pruned, so they expire instead ("Expiry", below). `MemoryQueueStore` refuses
  creates past `maxTasks` (`MAX_TASKS`) as the relay does, tombstones counting toward
  nothing.
- **A finished task keeps no prompt** (2026-10-18, owner), **and only its decision's winner**
  (M3 review P4, 2026-10-18). `lean` — `forgetPrompt` (`task.ts`) plus the cut to the winner
  `too_large` already made — runs in `#update`, the one write path, as for the clocks, so the
  write that moves a task to `done`, `failed` or `cancelled` carries `spec` without `prompt`
  and a winner-only decision, at no extra version, whatever built the record (`advance`,
  expiry, cancel, mark-done, admission, a verdict). Nothing re-routes a finished task, and the
  losers made a 10 × 5 fleet's record 19 KB against 1 KB, carried by every listing and
  re-seal until pruned. Records finished before this, or by an older leader, are made lean by
  `#leanFinished` at the end of
  a pass: oldest first, at most 8 a pass (an uncapped sweep of up to `pruneAt` − 1 records would
  delay the next admission and dispatch, and nudge every app per write), sequential, one fenced
  CAS'd put each; a write that did not land is reported through `onError` and the record is left
  alone for the rest of the term (`#leanFailed`: a record the store refuses every time would
  otherwise take a slot of every pass and log every time), tried again by the next leader,
  `StoreRevoked` ends the pass. It is not in `takeover`, where a throw would fail the takeover.
  Mixed versions are safe: `parseTaskRequest` has made `prompt` optional since M2 item 6, so every
  reader parses a finished record without one; an older leader still writes a finished record with its
  prompt, and the next leader on this build strips it. Apps cannot write a finished record
  (`bindTaskRecord` refuses a version-1 record that is not `queued`; apps create `task:`
  records, only overwrites and deletes are the leader's), and no transition leaves a finished state, so nothing re-adds one. The surfaces:
  the PWA titles a finished task with neither title nor prompt by its session's window name, else
  its repo; MCP `get_queue` lists it without a `prompt` key, `placement.window` still naming it.
  The slugs (`assignment.window`, `branch`) stay as labels; git and the launch ledger hold the
  same slug anyway. **Rejected: a separate `prompt:<id>` record**, dropped when its task
  finishes. The app's create is a single `expect: 0` put and the store has no multi-key atomicity,
  so a task could exist with no prompt, or a prompt with no task; an older leader in a mixed fleet
  would read a new unfinished task with no inline prompt and spawn it empty; and a new prefix is a
  relay change (`STORE_PREFIXES`, the store's namespaces and its authorization rules), where the
  relay stays blind to records.
- **`lost`: a task whose machine stopped answering for it** (M2 item 3's gap B, closed in item
  6; the reservation half added 2026-10-16). A `running` or `needs-input` task whose machine has
  been absent — not connected, or gone from the registry — for `lostAfterMs` (15 min, Settled
  defaults 10) moves to `lost`, with `absentSince` on the record. So does a `reserved` one whose
  TTL passes with its `sessions` check unanswered and its machine not connected, or whose
  connected machine's checks keep failing for `lostAfterMs` past the TTL: it keeps the
  reservation's target as its assignment, with no pane, and `reservedAt`, which marks it as never
  confirmed. The rule it keeps: **never dispatched again without proof it is not running.** A
  machine that sleeps keeps its tmux session, so re-routing would leave a twin on wake, and
  `task_running` cannot catch a twin placed on another machine. Only its own machine moves it:
  once connected, its `sessions` reply decides — a session carrying the task id is `running`
  again, on the pane listed now (`needs-input` if it was waiting when lost: "Needs input") — or
  a `session-event` sealed by that machine does, as for any
  placed task (the event names the pane a never-confirmed task lacks). With no session, a task
  that ran has ended — `awaiting-merge` or `done` by its PR — whether or not `ended` still
  remembers it, as takeover settles a running task whose session is gone; a never-confirmed
  one settles as its reservation would have — ended if `ended` lists it, `ready` on the
  ledger's proof, `failed` `dispatch_unconfirmed`
  without. `lost → ready` exists for that task alone, and `advance` throws for any other. An
  unanswered check keeps it `lost`. The absence clock is the scheduler's own, in memory, started the first
  pass that sees the machine away, not `Machine.lastSeen`: a request timeout's offline mark can
  make a machine read disconnected beside a `lastSeen` hours old, which would lose its tasks at
  once. A new leader restarts the clock, which can only delay `lost`. It is held, not terminal,
  and holds no slot (`IN_FLIGHT` leaves it out), so a forgotten machine cannot pin the global cap.
  `cancel` takes it (gap 4, 2026-10-16): with its machine connected it is despawned as a
  running task is, its pane read from `sessions` when the record has none; with its machine
  away nothing can be despawned, so it is `cancelled` as it stands with `leftRunning` on the
  record, and the PWA says the session may still be running there. `mark-done` of a `lost`
  task whose machine is away records `leftRunning` the same way (M3 review Q8, 2026-10-18).
  Both take the one step `#byHand`: refuse a reservation or a finished task, end a live
  session, write. Apps reach it through the
  leader's `cancel` op and MCP's `cancel_task` (the PWA's Queue screen has the button). Cancelled is terminal: a
  later event or `sessions` reply for it changes nothing. The earlier refusal (`unreachable`)
  left a task the owner had given up on holding its place indefinitely, to protect a session
  the cancel could not reach anyway. Takeover settles `lost` tasks with the running ones.
- **Expiry** (`expiry.ts`, 2026-10-18). A `lost` task whose machine went away more than
  `lostExpiryMs` ago (`absentSince`, else `createdAt`) fails `lost_expired`; an `awaiting-merge`
  one more than `mergeExpiryMs` past `endedAt` (else `createdAt`) fails `merge_expired`. Both
  are 7 days (docs/scheduler.md, Settled defaults 14 and 15), the owner's decision. Why: neither
  is ever pruned, both count toward the store's `MAX_TASKS` (pruning frees only finished tasks) and
  both outlive every term, so a machine that never returns would pin queue room for good. Where:
  `#expire`, in the pass after the `sessions` checks, so a machine back in time settles its task
  first, and before admission, so dependents fail `dependency_failed` in the same pass, for
  `merged` and `opened` edges alike; a dependent already released has left `blocked` and is not
  judged again. A `lost` task whose machine is connected at that moment is skipped, left to its
  own check next pass (it may have reconnected while this pass's check waited on a slower
  peer); so a connected machine whose `sessions` never answers keeps its task `lost`, and only a
  disconnected one expires it; the same check repeats inside the write, since the machine may
  reconnect between the two. The write goes through `#update`, serialized and CAS'd, so a racing
  `cancel` that reaches its own write second answers the task as it now stands, `failed`, with
  `ok: true`, as it does for any task that finished meanwhile. A machine that returns after expiry: its session keeps running
  there, untracked — nothing resurrects it or despawns it (`sessionChange`, `branchChange` and
  `settle` decline for a `failed` task), `cancel` answers `finished`, and it is ended by hand.
  No alert and no audit line: nothing spawns or despawns, and the record is the trace.
  Accepted: a `sequential` batch counts a `lost` member toward its bound because its session may
  still run ("Batches"), so past 7 days the next member may run beside one still alive on a
  machine that slept that long. Mixed versions: a leader older than this change reads `endedAt` as
  an unknown field and drops it on its next write of that record, so the new leader ages that task
  from `createdAt`, which is never later, so expiry only comes earlier; an older leader never
  expires anything.

### Task records and the app's store leg — landed 2026-10-17, M3 item 2

The relay's store (M3 item 1) holds ciphertext; what a record is, and who reads it how, is
`shared/src/task-record.ts` and the app-client. The PWA and MCP enqueue through them
(item 6, `RelayClient.createTask`), and the leader's adapter (item 3, _The queue store_, below)
reuses the record helpers.

- **One sealer, one reader.** `sealTaskRecord` seals `{ version, task }` as op `task` to
  `"scheduler"`, from its writer. `openTaskRecord` opens with `openAtRest` — never the replay
  guard, since a record is days old by design — refuses one sealed to anyone else, and keeps it
  only through `bindTaskRecord`. A blob that does not decrypt, is another op or is addressed
  elsewhere is `unopenable`; the binding gives the rest of `RecordUnreadable`.
- **The reader's rules are one function**, `bindTaskRecord` in `shared/src/parse.ts`, each a
  `RecordUnreadable` reason. Its sealed `version` must be the relay's (`version_mismatch`): a
  token holder can list the queue, keep a task's old blob and put it back — authentic bytes,
  stale state, a cancelled task back to `ready` — and the version makes it fail like a forged
  one. Its `task.id` must be the key's own (`key_mismatch`), or a token holder could create a
  fresh key holding another task's version-1 blob and have it run twice. A version-1 record must
  be `queued` (`created_unqueued`): a create is an app's enqueue and only the leader moves a task
  on, so no client can create one running. Its `createdAt` may be at most `REPLAY_WINDOW_MS`
  ahead of the reader's clock (`created_ahead`), or a far-future stamp would let a blob outlive
  the admit rule — a leader admits no `queued` task more than `STORE_TOMBSTONE_MS` old, since its
  key's tombstone may be gone by then ("Admission and dependencies"). That age is admission's
  rule, not the reader's: such a record still reads, to be failed `queue_expired` and pruned.
  Every one of these holds against a token holder writing through the relay's checks, not
  against the relay itself (Threat model, item 4).
- **Unreadable is reported, never fatal, never deleted.** `RelayClient.listTasks` returns the
  tasks that bound beside `{ key, version, reason }` for each that did not; `getTask` returns
  either. The app leg has no delete at all (the relay forbids it), so clearing junk stays a
  person's act. A `get` answered with another key's record reads as no answer: the binding
  checks a record against the key it came with, so that key must be the one asked for.
- **A create is checked before it is sent.** `createTask` takes a task whose id the app
  minted, and refuses locally — `invalid_request` — a record every reader would skip (not
  `queued`, a malformed id), and — `too_large` — one whose sealed `ct` passes
  `STORE_CREATE_MAX_CT_LENGTH`. It puts at `expect: 0`; `version_conflict` there is the
  answer to a retry whose first put landed, so it reads as queued (`landedEarlier`), never a
  failure. Any other refusal comes back raw.
- **Store frames correlate on their own `id`**, in a pending map apart from sealed requests:
  they are Layer 1 plaintext the relay answers itself, so no envelope, leader or guard is
  involved. A store reply that does not parse (a `next` page included) still names its request
  and settles it as `null` at once rather than at `STORE_TIMEOUT_MS`; a close fails it
  `dropped`, as it does a sealed request. So does a reconnect, which fails the store requests
  sent on the replaced socket: the relay answers a store frame only on the socket that sent
  it (a sealed reply fans out to every app socket), so a reply counts only from that socket.
  A listing is checked too: a key outside `task:`, or listed twice, reads `key_mismatch` for
  every copy (`openTaskListing`).

### The queue store (`daemon/src/queue-store.ts`) — landed 2026-10-18, M3 item 3

The leader's `QueueStore` over the relay's store ops, so a task waiting for capacity survives a
leader change and an app can enqueue with no leader at all. It is the adapter the library's port
assumes: sealing, opening and the reader rules are its job, the record shapes are item 2's.

- **One adapter per term, on the daemon's socket.** `createQueueStore({ leg, key, term, now })`
  sends `store-*` frames through `RelayClient.store` on the daemon's own socket, with `term` on
  writes: the relay fences a write on the term and the socket it was issued to, so the leader's
  writes cannot leave on the app leg. Records are sealed `to` and `from` `"scheduler"` — op
  `task`, or `pause-state` for `queue:pause` — and every read goes through `openAtRest` with its
  slot's op, which refuses any other op. `from` is checked nowhere: `openTaskRecord` and `getPause`
  check `to`, so a task an app created, sealed `from: "app"`, reads the same.
- **Reads reject, never shorten.** `list` is one unpaged `store-list` of `task:` through
  `openTaskListing`; a `next` page, a refusal or an unreadable reply throws, so a takeover that
  cannot read the whole queue is retried instead of running on a short one. Entries that do not
  bind come back as `{ id, version, reason }` (the library holds them apart and never deletes
  them). `get` throws on a record answered under another key.
- **Writes map to the port's failures, the doubtful ones to `indeterminate`.** `put` runs
  `bindTaskRecord` on what it is about to seal and seals the parsed copy, then checks the cap
  (`STORE_CREATE_MAX_CT_LENGTH` for `expect: 0`, else `STORE_MAX_CT_LENGTH`) before sending.
  `version_conflict`, `too_large`, `rate_limited` and `store_full` pass through; any other refusal
  is `refused`. A `store-written` whose version is not the one expected, a timeout and a dropped
  socket are `indeterminate` — the write may have landed — which the library settles by reading
  the key again. `not_leader` and a disconnected daemon socket throw `StoreRevoked`, ending the
  term wherever it surfaces — `leader.ts`'s one `fail` takes it from the tick, the event paths,
  takeover and an app's request alike: the relay no longer thinks it leads, or no reply can ever
  come. `delete` maps the same
  way; the relay refuses a `queue:` delete, which the adapter never sends.
- **The pause slot.** `getPause`/`putPause` seal and open `queue:pause` as op `pause-state`
  (`openAtRest` plus `parsePauseRecord`); an unreadable record reads as `key_mismatch`,
  `unopenable`, `malformed` or `version_mismatch`, and a hold list `parsePauseRecord` refuses
  is `refused` before sealing. Item 5 drives it through the port only.
- **The version floor** (`daemon/src/version-floor.ts`, `flooredStore`; added 2026-10-18, M3
  review S1). Binding checks a record's sealed version against the one the relay reports, so it
  cannot see the relay itself serving an authentic old blob at that blob's own version. The
  floor can: the highest version seen or written at each `task:` key and at `queue:pause`. A
  readable task record below it reads `version_regressed`, held apart like any unreadable one;
  a pause below it, or missing once one was seen, reads the same and so holds the whole queue
  until a `resume` or `pause` overwrites it — the leader's own pause write sets the floor, even
  lower, which is how a relay that lost its storage is recovered from; a task record that
  vanishes without the leader having deleted it (a `get` answered null) rejects, so the
  library keeps the task as held. A listing that leaves a key out is not a vanish — a new term
  holds only what it lists, and runs nothing it does not hold. One floor per process, like
  `schedulerGuard` and for its reason: the relay chooses which term sees a read. It is a file,
  `version-floor.json` in `stateDir()`, 0600, ids and versions only, written temp-fsync-rename
  and the directory synced before the leader acts on a read that raised it; a missing or
  corrupt one is an empty floor, never a crash. Bounded to keys seen within
  `STORE_TOMBSTONE_MS` and to 4,096 of them, least recently seen first: each takeover's listing
  sees again what the store still holds, and a deleted key's tombstone lasts no longer. A
  confirmed delete sets the floor one past the deleted version, so any record there reads
  regressed; a delete whose answer was lost lets the next null read count as it landing.
- **The relay client's store leg** (`RelayClient.store`). Store frames correlate on their own
  `id` in a pending map apart from sealed requests, as the app-client's do, and a reply counts
  only from the socket the request left on. A reply that does not parse settles `null`; a timeout
  (`STORE_TIMEOUT_MS`, or `STORE_LIST_TIMEOUT_MS` for a `store-list`, whose full reply is about
  5.2 MB; logged by id and `t` only — never a key, `env` or `ct`), a drop or `stop()` fails the
  pending request, as does a send that throws (`disconnected`: nothing left, so the adapter ends
  the term; the socket is closed too, since it may still read open and only a redial
  re-registers, which is what stops the relay naming this daemon leader); a reply with nothing pending is dropped. `store-changed` goes to
  `onStoreChanged` (`parseStoreChanged`). No line is logged per accepted store read or write.
- **Rejected: `MemoryQueueStore` as a fallback.** A leader that cannot reach the store must not
  run on a queue the next leader will not see; the option is a type error. The daemon suites run
  on a store double in `daemon/test/harness.ts` (term fence, tombstones, `store-changed`); the
  e2e suite runs on the real store.

### Branch state (`daemon/src/branch-state.ts`) — added 2026-10-17, scheduler M3 item 4b

The scheduler settles a task as `done` when its PR merges, and a merge happens on a remote
the scheduler cannot see. The daemon that launched the task can: it owns the worktree. So
each daemon watches the task branches it launched and sends the leader a `branch-state` when
a branch's name, pushed state or merged state changes, and answers a scheduler `sessions`
with `progress`, the same facts as a sum, for a leader that missed the sends.

- **What is tracked.** A spawn with a `taskId` in `mode: "worktree"` that lands notes two paths
  in the launch ledger (Session events, "`sessions` carries `ended`…"): the main clone
  (`RepoEntry.path`) and the worktree (`SpawnOutcome.path`). A `here` spawn has no branch of
  its own and records neither; a refused spawn records nothing. A launch that lands starts the
  task's note afresh (`LaunchLedger.startNote`): a worktree launch with just those two paths, a
  `here` one with none, whatever an earlier launch of the same id left. A relaunch to the same
  path would otherwise inherit the first attempt's sticky `ahead`, `pushed` and PR URL and read
  a workless branch as merged. Only a spawn that succeeded does it: a `task_running` refusal (its
  session is the earlier launch) or a crash during spawn settles the id as launched, so it is not
  retracted, but leaves the note alone, since the mod reports a PR URL once and a wiped note
  would lose it for good. A PR URL a session reports while the new spawn is still in flight is
  the new launch's and survives the fresh note. The note also records `siteAt`, when its site
  was set, which a later change never moves (a note from before it counts as the oldest).
  Every ledger task with both
  paths and not yet merged is checked once a minute (`BRANCH_CHECK_INTERVAL_MS`); a merged one
  never again. Tasks launched before this landed have no site and are not watched. They are M2
  tasks with no `after:` dependents, so nothing waits on them.
- **Quiet tasks stop being checked an hour after their session ends** (added 2026-10-17). A
  task still costs its own-work check (up to three git runs) whenever the default branch moves,
  slow ones on WSL's `/mnt/c`, and most tasks never leave
  their fresh branch. So a task never seen ahead, never pushed and with no PR URL is skipped,
  before any git, once no live session has carried it for `BRANCH_ENDED_GRACE_MS` (an hour).
  "Live" is the rule the `sessions` reply's `ended` uses: a task id some listed session carries
  (`backend.sessions`, read every pass while a quiet task exists), which also covers a
  crash that sent no `ended` event and a daemon restart, where the in-memory `ended` events
  (`EndedTasks`, 30-minute TTL) would not. Why an hour: the work a session leaves is local, so a
  commit made just before it ended, pushed or not, is read by the next pass a minute later; the
  rest is for a person who finishes the worktree by hand straight after. Work added later than
  that is missed, a manual mark-done, against checking every such task for the ledger's week.
  A session that has not registered yet (no title, no claude: a trust dialog, a startup hang)
  reads as ended too, the same rule as `sessions.ended`; it resets the clock if it registers
  within the grace. The clock is an unbroken run of judged checks, not wall time: it starts at the
  first check after the session was seen ended that judged the task (a default branch to compare
  with, and the own-work question answered), and the task is cut off once a grace has elapsed
  since then. Any later check that does not judge it resets the clock, to restart at the next
  judged one: a repo with no `origin/HEAD`, one the repo list no longer names, a checkout that is
  not the main one, a failing ref read, a pass that threw, or an own-work read that failed
  (`holdsOwnWork` answers null: a corrupt or missing object, a git failure) never judge, so such
  a task is never cut off blind. A failed own-work read still counts as no work for the verdicts
  (no `merged` gate weakens) and is never memoized. The state is in memory and keyed by the launch
  (`siteAt`): a restart or a relaunch starts it over. Nothing is sticky: a cut-off task whose id
  appears among the live sessions again (one that registers late, past the grace) drops its entry
  and is checked again with a fresh clock, so the error is always toward checking more, and
  `backend.sessions` is read every pass while any quiet task exists. That read is raced
  against a 5 s timeout (`BRANCH_LIVE_READ_TIMEOUT_MS`): a hung tmux, like a failed read, cuts
  nothing new off that pass and does not hold the pass up. A task ever seen ahead or pushed, or
  with a PR URL, is checked as before, whatever its session does: a missed `merged` costs a
  manual mark-done. None of the gates below change.
- **The branch is read live, once per repo.** Each pass asks the clone what every worktree has
  checked out (one `git worktree list --porcelain -z`, by canonical path), so a `git branch -m`
  shows up on the next pass. It is not a read of each worktree's `HEAD` file: a reftable clone's
  names no branch (`ref: refs/heads/.invalid`), and git is then the only reader anyway. A
  detached `HEAD`, or one on a ref outside `refs/heads/`, reads as no branch, and the task is
  not judged that pass. The last-seen name is used only once the worktree no longer belongs
  to the repo (removed, or its directory reused by another repo). Every task's branch, local
  and `origin/`, is then read in one `for-each-ref` naming all of them, and the default branch's
  commit and tree in one `rev-parse`: a steady pass costs three git runs per repo however many
  tasks it holds (40 pushed tasks: 3 runs and about 9 ms against 82 runs and 130 ms before,
  measured on Linux), and a task's own runs are only what its changed inputs call for. When several tasks share a worktree path, the
  newest site (`siteAt`) owns the live read, merged ones counted: `freeWorktreeName` frees a slug
  only when the directory and the branch `worktree-<slug>` are both gone, so a reused path is a
  reused branch name, and a newer launch's fresh local ref would otherwise be read as the older
  task's. By `siteAt`, not ledger order: a re-dispatch of an old id that is then refused is
  re-recorded at the end of the ledger, and would take the path from the launch that holds it.
  A tie goes to the later in the ledger. A non-owner never reads the local ref by name: it is
  judged by its recorded tip alone, and the remote ref counts only if it holds that tip or
  descends from it. Nor does the owner trust the local ref blindly: with a tip recorded, the local
  ref is used only if it equals it or descends from it. Otherwise something else made a branch of
  that name once the task's own was removed (a spawn with no task id on the freed path), and
  reading it would overwrite the recorded tip and read that spawn's merge as the task's; the
  recorded tip is judged instead. The price is a branch rewritten to different work (a rebase, a
  reset then new commits) is judged by its last recorded tip, so its new work is not reported
  pushed or merged; a missed `merged` costs a manual mark-done, a false one settles a task
  `done` with its PR open. A detached head, or no branch at all, is skipped.
- **`pushed` is the remote ref, never an upstream.** `claude --worktree` branches `--no-track`,
  so `%(upstream:track)` says nothing for them. `pushed` is true when
  `refs/remotes/origin/<branch>` exists and holds the work tip (or the work tip is its ancestor),
  which `git push origin <b>` with no `-u` satisfies. With no `origin/HEAD` nothing can be judged
  ahead, so the ancestor test is off: `pushed` then needs the remote ref to equal the tip exactly,
  and a stale ref from an earlier attempt that happens to be ahead of a fresh tip does not pass.
  There the own-work gate below cannot apply either, so such a `pushed` can be reported for a tip
  with no work of its own (a fresh branch pushed as it is). That is kept on purpose: it is what
  lets `after: opened` work in a clone with no `origin/HEAD`, and it cannot make `merged`, which
  needs a recorded own-work tip that only a pass with a default branch writes. In `BranchState` it is live (it reads false once
  a merge deletes the remote branch); in `progress` it is sticky, as `TaskProgress` says none of
  its flags goes back.
- **`merged` is reap's verdict, with two gates.** `classifyTip` (`ancestor`, `squash` or `gone`,
  `reap-git.ts`) against `refs/remotes/origin/<default>`. Reap's own comment says a fresh branch
  reads as merged (it is an ancestor of the default, and an empty diff is an empty "squash"), and
  reap can afford that because it acts only on branches idle for days. A scheduler cannot: a
  workless branch reading merged settles a running task as `done`. So (1) **own work**: nothing
  is reported pushed or merged until the branch was seen holding own work (`ahead`, sticky): a tip
  that is not an ancestor of the default branch **and** whose tree differs from the tree of the
  commit it forked at (`merge-base`). The second half matters: an empty commit, pushed under a
  draft PR, or a revert of the branch's only change is not an ancestor either, and its net change
  is empty, which `classifyTip` reads as a squash of the default. The commit judged is the **work
  tip**: the current tip while it holds own work now, otherwise the last tip recorded (the note
  keeps a tip only while it held own work). A session that pushes work and then
  `git reset --hard origin/main`, or reverts it, is thus still judged on the pushed commit, never
  on a main it merely points at; a fast-forward merge still reads merged, since the unchanged tip
  is then an ancestor. The own-work answer is memoized per task on tip and default sha. With no recorded work tip nothing is judged. That also stops a fresh branch reusing a stale
  `refs/remotes/origin/<b>` from an earlier attempt from reading as pushed. And (2) **pushed
  evidence**: merged needs the branch seen pushed, or a recorded PR URL, which proves a push even
  when push, merge and prune all happened while the daemon was down. The same evidence is the
  gate for `classifyTip`'s `cherry` and patch-id checks, where reap's is a `[gone]` upstream: there
  is no upstream to be gone under `--no-track`, and a merge need not delete the remote branch
  (GitHub keeps head branches by default). Gated on the remote ref being pruned, a squash whose
  branch survived was caught only by the tree check, which conflicts once the default branch
  edits the same lines, and the task sat `awaiting-merge` until `merge_expired`. A branch
  whose local ref was deleted (claude's worktree-exit "remove") before the PR merged is still
  judged, by its last-seen tip: the commit outlives the ref until gc. The verdict is memoized per
  task on its inputs, so an idle branch costs no classification per pass. It is computed against
  the default branch's resolved sha, not the moving ref name, so the verdict and its memo key are
  one snapshot.
- **The fetch.** `git fetch --prune origin` runs only for a repo that holds a task branch with
  work seen pushed (or with a PR URL) and not yet merged, and only when this emitter's own last
  successful fetch of that clone, kept in memory, is over five minutes old (`BRANCH_FETCH_STALE_MS`;
  not `FETCH_HEAD`'s mtime, which every worktree spawn refreshes without pruning, "Worktree spawns
  fetch first"), through reap's guarded git (hooks and fsmonitor
  off, no prompt, 30 s timeout) with `GCM_INTERACTIVE=never` added unless the environment sets it,
  because Git Credential Manager ignores `GIT_TERMINAL_PROMPT` and can raise a GUI on WSL or
  Windows, and with ssh in `BatchMode` as reap's fetch has it (Reap, **Network**). A failed
  fetch is quiet: the pass judges by the refs on disk, which only makes fewer things look
  merged, and one warning is logged when a repo goes from fetching to failing: the repo name
  and the exit code or "timed out", never git's stderr, which can carry a remote URL with
  credentials (reap prints its own, to the operator's terminal). Because
  a failed fetch leaves that record alone, the repo then backs off in memory (the window, doubling
  to an hour) instead of retrying every 60 s pass. Concurrent fetches from reap and the emitter can
  collide on a ref lock; that fails quietly and the next pass retries. The emitter takes no reap
  lock: it never deletes, and the lock would make reap fail with `ReapBusy`. A repo with no
  `origin/HEAD` on disk gets `pushed` but never `merged`; there is no `git remote set-head` here.
- **Sent on change only, from the ledger.** A state goes out when the branch name differs from the
  one last recorded, or `pushed` or `merged` turns true for the first time; `ahead` and a moving tip
  are recorded without a send. The last state is on disk, so a restart re-sends nothing that did not
  change. The first pass after a restart runs before the relay registers, so an undelivered state
  (`RelayClient.sendBranchState` resolves `false` when the socket is not up and registered) is kept in
  memory and re-sent, with its original `at` (the observation time), at the start of each pass until
  it is delivered. That memory is kept per ledger object at module scope, so an emitter that is
  stopped and replaced on the same ledger (a config reload) hands its backlog on, and a send that
  finds the emitter stopped after the note was written keeps its state there instead of losing it.
  An entry whose task has left the ledger is dropped, and so is one computed under an earlier launch
  of a relaunched id: it carries the `siteAt` it was computed under and is dropped when the note's
  differs, or a stale `pushed` would reach the leader after the relaunch. A pass's own note write
  is pinned the same way: `note()` refuses a patch whose `siteAt` is no longer the note's, so a
  pass that judged the old launch cannot seed the relaunch's fresh note. The memory dies with the process: a state
  noted but never sent when the process exits is recovered only through `progress`, which the
  leader reads on takeover and when the machine comes back.
- **`progress` in the scheduler's `sessions` reply.** One `TaskProgress` per ledger task with any of
  PR URL, branch, pushed, merged or exit status (since 2026-10-21, Daemon, "Exit status"), without
  paths or tips; an entry that would not pass
  `parseTaskProgressList` is left out, since one bad entry nulls the leader's whole list.
  `at` is the last change, never refreshed by an unchanged pass, so an idle branch costs no ledger
  write per minute. The reply is held to 44 000 bytes of JSON (`REPLY_JSON_BUDGET`, the queue
  reply's 4/3 sealing headroom against the 64 KiB envelope), because a reply that seals past it
  becomes `too_large` and loses `ended` and `ledgerSince` too. Over it, entries are dropped and
  `progressTrimmed` says how many: merged ones first, oldest `at` first, then the rest by ascending
  `at`. Merged first because `at` is the last _change_: an open PR untouched for days has the oldest
  `at` and is what a takeover needs most. A reader treats a trimmed reply's missing task as unknown,
  not progress-free, and so must an absent `progress` from an older daemon (items 3 and 4a).
- **Who receives it.** On a daemon that is not leading, sealed `to: "scheduler"`,
  `op: "branch-state"`. On the leader's own machine nothing crosses the relay: `run-capabilities.ts` hands it in
  process to `leader.onBranchState`, as it does session events to `onSession`. The leader's relay
  event handler parses a relayed `branch-state` (`parseBranchState`) into the same sink, so there is
  one place to wire. Only a daemon observes a branch: one sealed `from: "app"` is dropped and
  logged like a malformed one, since a PSK holder's app could otherwise settle a task `done`. Since M3 item 3 that sink feeds `Scheduler.onBranchState`, so the library learns
  of a merge on the leader's own machine from the in-process event as well as from `progress`.
- **Decided tails.**
  - A PR closed without merging keeps its repo fetched every five minutes until the ledger evicts the
    task (7 days or 128 launches): it has a PR URL, so the quiet-task cut-off above never applies,
    and nothing the daemon sees tells a closed PR from one awaiting review. Merge expiry (7 days,
    matched to the ledger's age — `mergeExpiryMs` is derived from `LAUNCH_LEDGER_MAX_AGE_MS` in `shared/`, which the daemon's `LEDGER_MAX_AGE_MS` re-exports — because past it no merge can be reported; 128 launches can evict
    sooner) now fails such a task `merge_expired`, and its `after: "merged"` dependents with it, so a
    `here` task, or a PR merged after eviction, needs mark-done before then. Owner's
    decision 2026-10-18, made knowing this.
  - A task whose work landed without ever being pushed to `origin` (a fork remote, a cherry-pick by
    hand) never reads as merged and needs a manual mark-done. Without the gate a fresh branch reads
    as merged and settles `done` wrongly, which is far worse.
  - A branch made, pushed and fast-forward-merged entirely while the daemon was down was never seen
    ahead and is not reported merged. A squash or rebase merge is still caught, by the pushed evidence.
  - An SSH remote whose key needs a passphrase and is not in an agent fails the fetch (BatchMode)
    rather than prompting, so a foreground `seanced run` judges by stale refs until the key is
    loaded. A service, which has no terminal, is left as it was. Under a user's own
    `core.sshCommand`, `GIT_SSH_COMMAND`, `GIT_SSH` or a non-OpenSSH `ssh.variant` no BatchMode is
    added, and a prompt there is theirs to configure away. The terminal check is once per process
    (memoized): a backgrounded `seanced run &` whose terminal later closes keeps BatchMode, which
    fails a prompting fetch instead of hanging it; a service never reads a terminal at all.
  - A repo on `/mnt/c` under WSL makes each git call slow; the pass is bounded by the tracked tasks
    that are not cut off: those that ever held work, and quiet ones within their hour (or never
    judged, which keeps them checked).
- **Rejected.** Re-sending every task's state on a cadence (decided 2026-10-17):
  it is load for a state the ledger and `progress` already carry, and a leader that missed one reads it
  back anyway. Reading an upstream (`%(upstream:track)`, `branch.<b>.merge`): `--no-track` branches
  have none, so it would say nothing for the branches this exists for.

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
  re-registers the machine as a stranger. runtime.json takes the same tmp +
  rename: small as it is, an in-place write truncates first, and a reader in
  between gets an empty file — `livePid` then says no daemon runs (measured at
  ~13% of reads racing a rewrite, 2026-10-17). One accepted gap, found 2026-07-31 while
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
  restart`; under a system unit, non-root: SIGTERM to the unit's `MainPID` and
  let `Restart=always` relaunch it — no sudoers or polkit rule to provision).
  Rejected: daemon-inside-tmux (reboot silently takes
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
- **Seams** (M4 readiness, R6): `startDaemon` takes `now`, `httpFetch` and `probe` (`RunOpts`), and
  hands the clock and `httpFetch` to the leader and telemetry, `probe` to telemetry; defaults are
  `Date.now`, the global `fetch` and `hostProbe`. They are what lets a daemon-tier test
  (`daemon/test/seams.test.ts`) drive what the daemon reports — and M4's push, Linear
  and Proxmox readers be tested there rather than only at the unit tier. The clock is wiring time
  (scan stamps, runtime.json, the reap schedule, telemetry's sample time, the leader's); a sealed
  envelope's `ts` stays on the wall clock, since replay windows judge it. The leader's clock also
  judges records peers stamped with their wall clocks — a task's `created_ahead` check against the
  replay window and admission's age limit, which must agree with the relay's wall-clock tombstone —
  so an injected clock must track wall time (an offset of seconds, or wall time plus control) in
  any test that queues tasks. Three readers stay on the wall clock on purpose: session events and
  branch states keep their own `now` (branch state compares against git's fetch times), and Claude
  Code's quota `fetchedAtMs` is wall time written by another process. The option is `httpFetch`,
  not `fetch`, so it is not mistaken for `BranchStateDeps.fetch`, a git fetch. `Fetch`
  (`daemon/src/seams.ts`) is its own type rather than `typeof fetch`, whose Bun type carries
  `preconnect`, which no stand-in satisfies without a cast. Nothing reads `httpFetch` yet.
- **Wiring** (`run.ts`, R6): `startDaemon` builds what everything shares — config, state, the
  register blob, the handler context, the leader, the relay client, the updater — and hands the
  rest to two modules, as `leader.ts` hands its adapters and request handlers off. The
  **capabilities list** (`DAEMON_CAPABILITIES` in `run-capabilities.ts`) is the optional
  subsystems started once the relay client exists — the fleet broker, session events, the
  `/usage` refresh's timer, branch states, the rescan and reap schedules — each a function of one context returning its `stop`
  and, for the broker and session events, the handler it serves on the local op socket. They
  start in list order and stop in reverse; the local op socket starts after all of them, over
  the handlers they brought, and its allowlist is unchanged. `run-collectors.ts` is the one place
  telemetry's dependencies are named — disk paths, the registered blob, sessions,
  the probe, the clock and `httpFetch` — together with the beat that sends each sample as `status`.
  The **collector registry** they feed is `TELEMETRY_COLLECTORS` (`telemetry-collectors.ts`), as
  `leader.ts` hands its adapters and request handlers to their own modules: one entry per source
  (cpu, memory, disk, disk I/O, sessions, quota), each a function of the sources returning its
  per-tick read, and owning its read's failure, its state across ticks (the cpu baseline, the
  previous I/O reading, the quota file memo) and the fields and samples it contributes.
  `createTelemetry` keeps only what they share: the tick queue, the `at` stamp, the time-aware
  smoothing (one average per entry and key, so entries never share one), the merge in list order —
  the status's field order; entries own disjoint field keys, which the registry test asserts — and
  the one store write. An entry that rejects drops its own contribution, never the tick, and so now
  does one that throws synchronously (before the registry, a sync throw rejected the whole tick).
  The failure surfaces through `TelemetrySources.onCollectorError`, which `run-collectors.ts` turns
  into one `log.warn` line per collector per process. The list
  lives beside `createTelemetry`, which defaults to it, rather than in `run-collectors.ts`: tests
  build the full set without the daemon's wiring, and `telemetry.ts` importing the wiring would be
  a cycle. An M4
  subsystem (push) is one more capability, as the `/usage` refresh was; an M4 status source
  (auth health, a Proxmox cgroup/PSI view) is one more registry entry, plus a
  `TelemetrySources` field if it needs a dependency not yet passed. What stays
  in `run.ts` on purpose: `schedulerGuard` and the ledger and version-floor memos, module-level
  so a config reload's second `startDaemon` shares them.
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
  `--remote-control` always — ahead of the other flags and with a `--`
  terminator closing the command, because the flag takes an _optional_ value
  and, adjacent to the seed, it swallowed the prompt as the session's name
  while the session started idle — **opus**/medium defaults (revised from
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
  field has two emitters — the pre-launch fetch below (a failed fetch, a
  `here` checkout behind origin) and the stuck-spawn detection — joined by a
  blank line in `handleSpawn`, and stays a documented `SessionBackend` fork
  seam besides.
- **The seed prompt is delivered on stdin, never argv** (revised 2026-10-19).
  It used to be an operand produced by a command substitution
  (`… -- "$(cat <seedfile>)"`), which the shell expands _before_ `exec`: the
  rendered preamble and prompt were then claude's argv — and `caffeinate`'s —
  for the session's lifetime, i.e. plaintext in `ps` for anything running as
  the user, which is precisely the text the audit trail reduces to a length and
  a hash. The seed file is redirected onto stdin instead
  (`… -- < <seedfile>`): claude takes non-tty stdin as its opening prompt and
  reopens `/dev/tty` for the UI, so the pane stays attachable and typeable, and
  macOS's `caffeinate -is` passes the fd through untouched. The shell opens the
  fd before `exec`, so the unlink after the pane-alive check drops the name and
  never the read — the cleanup ordering is unchanged. Residual, and unchanged
  by this: the 0700 seed file is same-user readable until that unlink, seconds
  against a whole session in `ps`.
  `--` no longer guards a value, only the absence of one, and stays as the
  standing guarantee that nothing appended later becomes a flag's optional
  argument. Probed live on claude 2.1.303 (2026-10-19): argv ends at `--`, fd 0
  is the unlinked seed, the session answers the seed, takes typed keys after it,
  and `--remote-control` attaches. Rejected: a prompt-from-file flag (none in
  2.1.234 or 2.1.303 — checked against `--help`, not assumed); an environment variable
  (`/proc/<pid>/environ` is same-uid readable and lives exactly as long as argv
  did); a heredoc (tmux keeps `pane_start_command` for the pane's life, so the
  text would move from `ps` to the tmux server rather than disappear); and
  typing it in with `send-keys` or `load-buffer`+`paste-buffer` (send-keys puts
  the prompt in a client's argv, and both race the TUI being ready for input,
  trading a leak for a session that silently starts idle).
- **Worktree spawns fetch first** (revised 2026-10-17; supersedes the "keeping
  the fetch" rejection in the next bullet). Before launch, `base-fetch.ts`
  runs `git fetch origin +refs/heads/<default>:refs/remotes/origin/<default>`
  in the clone: 5s timeout, through `git-hardened.ts` (reap's runner: hooks
  and fsmonitor off, no prompt, ignored stdin), with ssh in BatchMode on reap's
  terms (Reap, **Network**: a terminal only, so a service spawn pays no probe).
  The process group is what times
  out (`exec`'s `killGroup`). Killing git alone left its `ssh` or
  `git-remote-https` holding the output pipes, so the result waited out the
  transport's own connect timeout, whatever the cap said. Evidence: four spawns on one
  Mac started 23 commits behind `main`, branched from an `origin/main` fetched
  12h earlier. Claude Code 2.1.302 fetches only when `FETCH_HEAD` is over 24h
  old, and exclave clones (below) sit unfetched for hours because only the tree
  you work in gets pulled. The old rejection called this a _second_ fetch per
  spawn; it isn't one. Claude keys its fetch on `FETCH_HEAD`'s mtime, which
  this fetch writes, so claude skips its own, and a spawn still makes at most
  one. What it still doesn't do is create the worktree, move HEAD, or touch
  the checkout — only the tracking ref moves. The default branch comes from
  the clone's `origin/HEAD` (`readDefaultBranch`), never the wire, and goes to
  git as one argv element. None on disk → no fetch: claude forces its own
  when the tracking ref is missing. Parallel spawns into one clone share one
  in-flight fetch per common dir, since two racing for the ref lock would
  make the loser report a failure for a fetch that landed. **Fail-open**: a
  timeout or error never fails the spawn (unlike the old `fetch_failed`). The
  spawn proceeds on the refs on disk and `note` says the fetch failed and how
  old the last one is — the only place that staleness surfaces. `here` mode
  runs the same fetch only when the checkout is on the default branch, then
  notes "N commits behind origin/<default>" if it is. It never pulls or
  fast-forwards: a remote spawn still has no business moving a local HEAD.
  Every origin gets this, the scheduler's `leader` included, because they all
  reach `spawnSession`; no wire or capability change, so an older daemon keeps
  the 24h window. Costs: up to 5s per spawn (typically about a second, before
  `new-window`, so outside the registration wait), and a wasted fetch on a
  `baseRef: "head"` machine. Rejected: a periodic fetch (network on every
  scanned clone in every exclave, most never spawned in, and it still leaves a
  window); "behind by N" for worktree mode (after the fetch the base _is_ the
  tip); a base parameter now (that is M4's `baseBranch`, docs/scheduler.md,
  which will reuse this fetch for its branch).
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
  eyes open. ~~Claude re-fetches only when `FETCH_HEAD` is over 24h old, so a
  spawn can sit on an origin up to a day stale~~ — no longer accepted, see
  "Worktree spawns fetch first" above. A machine that sets `baseRef: "head"` opts
  itself out with no CLI flag to override it — the machine owner's call to
  make. And the failure modes go quiet: an unreachable origin or a clone with
  no `origin/HEAD` used to reach the phone as `fetch_failed` /
  `no_default_branch` before anything launched, where claude warns in the pane
  and bases the worktree on the local HEAD, so the spawn reports `ok` and the
  session is quietly on the checkout's commit. (Narrower than this reads:
  claude falls back to HEAD only when `origin/<default>` is missing, and with
  the tracking ref present it branches from that, however old. The daemon's
  fetch note now covers the unreachable-origin case.) Not a hang, at least: claude's
  fetch runs `stdin: "ignore"` with `GIT_TERMINAL_PROMPT=0`,
  `credential.interactive=false` and a 5s timeout, so a repo needing
  credentials fails fast rather than blocking the pane on a prompt. Rejected: creating the worktree in the daemon to name
  the base explicitly (implemented, then reverted — it moves worktree removal
  on failure and a second trust entry per spawn onto the daemon, to buy
  behaviour claude already has, and still rejected); keeping the fetch for
  freshness alone (a second fetch on every spawn to narrow a 24h window claude
  manages itself — reversed 2026-10-17: it is not a second fetch, and the
  window is what left spawns a day behind).
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
- **Task ids** (added 2026-10-16, scheduler M2). `SpawnRequest.taskId` is the
  scheduler's dispatch idempotency key: a spawn naming a task some live pane
  already carries is refused `task_running` with that pane's id, before the repo
  lookup and before any window opens; `sessions` reports it per entry. Live, not
  registered: a pane still on a startup dialog is running the task, and a dead
  one held by remain-on-exit is not. Bounded to `TASK_ID_PATTERN` (1–64 of
  `[A-Za-z0-9._-]`, the routing-id bound `ROUTING_ID_PATTERN` that `deviceId`s
  and store keys share, so a task id is a `task:` key's id part as it stands;
  `:` was allowed until 2026-10-17, and nothing minted one) by `isSpawnRequest`,
  so an out-of-bounds id is a malformed request. **The record is a tmux pane
  user option, `@seance-task`**, set by argv right after `new-window` and read
  back as a field of the `list-panes`
  formats `sessions.ts` already runs. It lives exactly as long as the session:
  a restarted daemon reads the same answer, and nothing can outlive the pane it
  names, so there is no reconciliation and no stale entry to sweep. Two spawns
  for one task in one process are serialized per id (`taskSpawns` in
  `spawn.ts`) — the relay and the local socket share the process and neither
  queues — so both never pass the check before either has tagged its pane. A
  pane that can't be tagged is killed and the spawn fails `launch_error`:
  untagged, it is the duplicate the tag exists to prevent. The pane → task
  lookup, for anything that must attribute by pane (M2's `session-event`)
  rather than by what an event claims, is the same option, read in the
  binding's own `list-panes` (`session-events.ts`). Rejected: a file in
  `stateDir()` (outlives the pane on a crash, and a tmux server restart leaves
  it naming sessions that are gone, so it needs a sweep the pane option gets
  free); the window name (user-renamable, and the tmux-rename mod renames it);
  `-e` env on the window (not readable through a format); a marker in the start
  command (atomic with creation and immutable, but `pane_start_command` carries
  wire text, so reading one value back means parsing the whole command line); chaining `; set-option -p` onto `new-window` to make the tag atomic (with no `-t` it lands on whichever pane tmux calls current — measured on 3.7, a `-d` window tagged another window's pane — and no target names the window just created).
  Two gaps, both accepted. A daemon that dies between `new-window` and the tag
  leaves an untagged pane its successor can't refuse a duplicate for — a window
  of one tmux exec. And any same-uid process can rewrite the option, which is
  why the read revalidates it against the pattern; a session relabelling itself
  is the same residual the threat model accepts for the session-event path.
  `seanced spawn` takes no task id: only the scheduler mints them.
- **Pre-trust on spawn**: Claude Code blocks startup on a per-directory trust
  dialog (`projects[<path>].hasTrustDialogAccepted` in the `.claude.json` of
  the exclave the repo sits in — `~/.claude.json` for `default`,
  `~/.claude-<name>/.claude.json` for a named one, never the daemon's own
  `$CLAUDE_CONFIG_DIR`, since the owner's shell hook picks the session's config
  dir by cwd; until 2026-10-16 it used the daemon's, so a named exclave's spawn
  still met the dialog) that no remote can answer, so an untrusted repo spawned from the
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
  `rescan` — never implicitly from PWA activity — and one at a time: a
  `rescan` arriving mid-scan waits, then scans afresh. Two in flight committed
  in finish order, so the older could drop a clone the newer had found (and
  had already answered the app with). Results cached in
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
  `host/path`, and the whole lowercased (GitHub and Azure DevOps compare
  case-insensitively; a key that differed by case would split one repo in two).
  A typed origin is keyed the same way: `auto`'s `repo` in `seanced mcp` goes
  through `originQuery` (`scan.ts`), so the remote URL as `git remote -v`
  prints it, a repo's root page URL, or the key in another case finds the key
  — a deeper page (`/tree/main`) does not, and a key with a port is tried as
  itself first, since scp parsing would read the port as path (added 2026-10-18 after
  `github.com/Wedvich/seance` was refused beside a listed
  `github.com/wedvich/seance`). Clone names still match exactly, since they are
  directory names. The leader matches keys exactly and never normalizes:
  apps send keys (the PWA picks from `RepoEntry.origin`), and its request parser
  stays a bounds check. The key is never a git URL — dispatch spawns by clone
  name, PR links come from the session — so folding costs only display case.
  Accepted collision: on a case-sensitive host (self-hosted git over ssh, like
  `venus.lan/srv/git/…`) two repos differing only by case share one key, and
  the scheduler could route one's task to the other's clone. Rejected until such
  a pair exists: folding only for known case-insensitive hosts (an allow-list,
  and a key change that splits repos across a mixed-version fleet and strands
  queued tasks under the old key), and case-insensitive matching that refuses
  case-only twins (lowercased keys cannot have twins, so the refusal is dead
  without the former).
  Basename when there is no remote, or only a local, `file://` or drive-letter
  one (a Windows `C:\…` or UNC `\\…` path, which the scp rule would otherwise
  key as host `c`) — some machine's mirror is not an identity. Re-read every scan, not carried
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
  `accountId` = `organizationUuid:accountUuid`, `email`, the extra-usage flag and
  `seatTier` (what the scheduler's seat table reads; _Scheduler_, "Seats") from
  `.claude.json`'s `oauthAccount`, `authOk` = that object's presence, `skills` =
  the entries under `skills/` that hold a `SKILL.md` — directories, or symlinks
  resolving to one, dotfiles skipped; tightened 2026-10-17, since a sync folder or
  a dangling dotfiles link otherwise went out as a name nothing answers to). `.claude.json` sits in the config dir only
  when `CLAUDE_CONFIG_DIR` is set: `default` runs without it, so its file is
  `~/.claude.json`, and a `~/.claude/.claude.json` beside it is a stub that once
  read every `default` as signed out. Every running session rewrites its
  exclave's `.claude.json`, so a read can land mid-write: an unparsable file
  keeps the previous scan's account for that exclave (signed out only on the
  first scan), while a missing one is signed out at once — a retry would narrow
  the window, not close it. `email` is display only — what the PWA names the
  account by — and never a key: the blob is sealed under the PSK, which is the
  owner's, so carrying it costs nothing the owner has not chosen. Nothing else in
  that file is read — it holds
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
  per exclave — what Claude Code itself cached in each exclave's
  `.claude.json`, kept fresh by the `/usage` refresh (below) (`cachedUsageUtilization`: the 5h and 7d windows, and the
  per-model weekly caps from its `limits`, keyed by display name since the id
  is not cached, and `c`, usage credits spent as a percent of the monthly cap from
  `extra_usage`'s amounts and rounded for the card — absent when credits are off or uncapped —
  with `cu`/`cl`, spent and cap in cents (credits are USD, so the cache's `currency` goes
  unread; the daemon rescales from its exponent, so readers always divide by 100), when the
  cache names the exponent; source `cache`, stamped at its fetch time, capped a minute past
  now so one far-future stamp can't stay "newest" for an account). The three pressure
  numbers are smoothed daemon-side over ~2 min with a time-aware weight, so a
  laptop back from sleep resets to its first reading instead of trusting a stale
  average, and no reader keeps a window of its own. Each source is one entry in the collector
  registry (`daemon/src/telemetry-collectors.ts`; Daemon, "Wiring"). Collectors are exec-free
  where the host allows — macOS memory is the one exec, `/usr/sbin/sysctl`
  once a tick: `os.cpus()` deltas, `/proc/meminfo` (`MemAvailable`)
  or, on macOS, `100 − kern.memorystatus_level` (the kernel's free percentage —
  what jetsam acts on and `memory_pressure` prints), `statfs` over the configured
  repo roots reporting the fullest volume, `/proc/diskstats` over whole devices.
  A field the host can't answer is absent — the first tick has no cpu or I/O
  delta, macOS has no exec-free I/O counter, a tmux outage drops `sess` for the
  tick — never a guess. A cpu delta is no reading in two more cases. One spans a sleep:
  neither macOS nor Linux counts suspended time, so it holds only the seconds awake,
  which is wake-up work (measured at 38–94% busy at each dark wake of a Mac whose steady load
  was ~20%, and with the long gap that reading became the average outright). It is caught by the
  counted time per core falling short of half the wall time, and its baseline restarts. The
  other is shorter than `MIN_CPU_WINDOW_MS` (5s), like the tick a register forces a second
  after the last; its baseline stays, so the next tick measures across both. A failed collector drops its field and stores no
  sample rather than repeating its average, and the next reading eases from
  that average over the whole gap since the last good one. Rejected for macOS:
  free + inactive + speculative pages
  from `vm_stat` — file cache and the compressor hold most of an idle Mac's RAM,
  so it read ~70% used on a 48 GB Mac the kernel rated at normal pressure, and
  `machine_pressure` would have steered work away from it. Every sample also
  lands in `stateDir()/metrics.sqlite` (`bun:sqlite`; created as an empty 0600 file before SQLite opens it, so the
  WAL inherits the mode) under `METRIC_NAMES`, Prometheus's data model and
  nothing else — metric, label set, timestamp, number — in three tiers sharing
  `METRICS_STEPS`. No sample carries the machine's name: the store is its
  machine's alone, so the label said nothing, and a rename split every series in
  two. Tiers are raw 30s for 48h, 5-min averages for 30d, hourly forever.
  Each tier is keyed `(ts, series)`, because every rollup, prune and query is a
  time range — keyed series-first, each rollup was a full scan plus a sort, ~3 ms
  and ~150 KiB of WAL a tick. A schema change is an entry in `MIGRATIONS`,
  gated on `PRAGMA user_version` and run in the transaction that opens the
  store, and it migrates history rather than dropping it: the hourly tier is
  kept forever, so each drop would cost all of it. The one exception is the
  first, the time-first key, which dropped the tiers (their history began
  2026-10-15, and `IF NOT EXISTS` would keep the old key). The second folds the
  `machine` label every series carried until 2026-10-16 into the unlabelled
  series, then re-rolls each tier from the one below, so the bucket the change
  fell in holds its true average rather than the mean of two partial ones.
  Rejected: folding in the app (every reader would carry the workaround forever,
  and every 30-day reply the duplicate series).
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
  per-model windows, then reset stamps, then quota from the last exclave down — never the
  credits alone, which routing reads —
  marking the status with `tr`; pressure and sessions always fit, and the trim
  is logged once) and then padded to one sealed length. Sent after
  each register too, re-arming the beat so the next lands past the relay's
  floor: the register just changed the blob a status indexes, and the registry
  push an app got carries no snapshot until this one. The stamp and the
  exclave list it indexes are one value (`Registered`, `telemetry.ts`),
  committed by `run.ts` once the register frame has left and read once as a
  tick starts, so a register mid-tick can't pair one scan's indexes with
  another's stamp; a tick asked for after a register waits out the one in
  flight rather than sharing it. The one in flight is then not sent at all: its
  stamp names the blob before (at boot, none), every reader would drop it, and
  sent first it would take the relay's floor from the status that matters. The
  check runs again after the seal, in the turn that sends, since a register can
  leave while the seal is awaited. History is the
  `metrics` op's. Nothing routes from this store — the scheduler reads only the
  latest `status` — so a Prometheus + Grafana stack later is one more consumer
  (an exposition endpoint, or remote write, since daemons dial out and laptops
  roam), not a redesign. Not built: PSI and cgroup v2 views in an LXC, the
  Proxmox node view (docs/scheduler.md, M4), macOS I/O rates. Rejected: the 1-min load average as cpu (counts runnable
  tasks, so it exceeds 100% and on Linux includes I/O wait); `os.freemem()` on
  macOS (free pages only, a fraction of what is reclaimable); a fixed EMA alpha
  (sleep gaps); a positional store schema (a new metric must cost nothing but a
  name).
- **Usage refresh** (`daemon/src/usage-refresh.ts`, added 2026-10-20 for scheduler M4): the
  daemon keeps each signed-in exclave's `cachedUsageUtilization` fresh by having Claude Code
  rewrite it: `claude --safe-mode --output-format json -p /usage` with `HOME` and, for a named
  exclave, `CLAUDE_CONFIG_DIR` set. The daemon holds no token, calls no endpoint and never
  refreshes a login; Claude Code does all three under its own rules, and the `cache` collector
  reads the result as before. A run is a whole Claude Code process (~350 MiB, 5–8 s) even when
  Claude Code answers from its cache, so it runs only for a reading older than `staleAfter`
  (config `quota.staleAfterMinutes`, default 10, read at each daemon start so a config reload
  takes a change; a value under 1 minute, Claude Code's own debounce, inside which a run moves
  nothing, is refused like any out-of-range key rather than clamped, and the refresh floors at
  60 s besides), judged on the wall clock against `fetchedAtMs`, which is the debounce marker:
  the daemon keeps none of its own. What asks: every bound session event pokes its exclave
  (Local op socket, "Session events"), and a timer pokes every exclave each minute, so one with
  no session running is still refreshed. So a healthy exclave's reading is at most `staleAfter`
  plus a minute plus a run old, plus the runs queued ahead of it on the shared lane (each up to
  the timeout), and unbounded while its runs fail. Signed out (`authOk` false) never runs. A failure's backoff is process-wide and survives a reload, its retry time fixed from the old `staleAfter`, so lowering the value does not shorten a backoff already running. One run at a time in the process, across a
  config reload's two daemons too, so a small LXC never carries two. A run is killed with its
  process group after 60 s (SIGTERM, then SIGKILL after 5 s for a child that traps it), and
  abandoned a second past that even if a detached grandchild still holds its pipes, so a
  wedged run cannot hold the lane; the group is signalled only while its leader is unreaped
  (afterwards its id may be reused), and a run's output is capped at 64 KiB. `stop()` sends
  a run in flight the same TERM-then-KILL, so a restart never leaves one beside the next
  daemon's and a mid-write kill does not truncate `.claude.json`; a process exiting right
  after `stop()` leaves a TERM-trapping run to the orphan's own devices. Success is the cache's stamp (`fetchedAtMs`, read on its own,
  whether or not a window parses) moving, not the exit code or stdout; a failure backs that
  exclave off for `staleAfter` (state process-wide, like the lane), warns once per streak, with a
  bounded one-line excerpt of the run's JSON `result`, else stderr (for a non-zero exit, a timeout
  or an exit 0 that left the cache unmoved), and says when it recovers. The
  refresh is not a spawn — no session, no pane, no prompt, fixed argv — so it carries no audit
  origin; failures are logged once per streak. Exec rules (threat model): fixed argv, `exec.ts`'s `bareEnv` so the child gets only
  `HOME`, `PATH`, `USER`/`LOGNAME` (from the passwd entry: without them Claude Code's macOS
  keychain read fails and `/usage` prints the `/cost` view) and `CLAUDE_CONFIG_DIR`, never the
  daemon's environment or a service-delivered credential; `--safe-mode` always, so no user hook,
  plugin or mod — the session-events mod included — runs in it. Limitation: the built env
  carries no proxy or CA variables (`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`), so a
  host that reaches the API only through a proxy gets no refresh; widening the env is a
  threat-model change. On only through
  `RunOpts.usageRefresh`, which `main.ts` always passes: tests run against a real home and must
  not spawn claude by surprise.
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
- **Exit status** (2026-10-21, M4; `daemon/src/exit-status.ts`, `ended` in `done.ts`). Once
  claude registers, a task spawn's window keeps `remain-on-exit failed`, so a clean exit closes
  it exactly as before and any other leaves the pane dead with tmux's `pane_dead_status`. Every
  `sessions` reply, after it lists panes and before it reads `progress`, notes each dead,
  registered task pane's status in the launch ledger and then closes the pane (`harvestExits`),
  so the status outlives the pane and a restart, and `progress` carries it. A dead pane drops out
  of the list (tmux gives it no cwd), so the order matters: one dying before the listing is
  harvested and in `progress`, one dying after was listed alive (its task running) — harvested
  first, a pane dying between the two reads would be in neither. A pane whose task is not in this
  daemon's ledger (evicted, retracted, replaced) is closed without a note: its status has
  nowhere to go, and reap skips a pane holding one (`owesExit`), so leaving it would be for good.
  Each close is audited (`origin=harvest`), after a re-read of the pane that it is still dead and
  still the same window and task, since pane ids restart with the tmux server. A pane dead before its title went up is `spawnSession`'s, as before, and so
  is a window whose spawn is still polling for registration (`whileRegistering`), which harvest
  skips so it cannot steal the `claude_died` capture. Reap skips a dead task pane holding a status
  (`owesExit`), since closing it first would lose the status, and the daemon's reap timer, when
  enabled (`REAP_DEFAULTS.intervalHours` is 0, so it is not by default), runs `harvestExits`
  before it; with the defaults a dead task pane closes on the next `sessions` read, which the
  leader's sweep makes of every machine holding placed tasks. The CLI's
  reap, in a process that does not own the ledger, leaves them. The tmux calls are injected where
  `EndedTasks` is built (`tmuxHarvestPanes`), so only the daemon's wiring touches tmux. The live `ended` event cannot carry the status: the mod's
  `session.end` hook runs before the process exits. So a leader settles a PR-less `ended` from a
  machine advertising `CAPABILITIES.exitStatus` by nothing but that machine's next answer — a
  reservation it resolves is `running` on the reporting pane meanwhile — and checks the machine
  at once, then every pass (`#ending`) until a reply no longer lists the session, since a check
  landing while claude is still shutting down does. That makes the event path and the sweep one path.
  Only the machine the task is on defers (`waitsForExit`): a foreign sender's `ended` changes
  and waits for nothing. The wait is bounded by `endingTimeoutMs` (5 min, well past
  `sweepIntervalMs` plus the `sessions` op's 10s): past it the task settles as the event would
  have without an exit, so a claude that stays alive after its `session.end` hook does not hold its
  slot and get asked about for good. The deadline spares a machine whose check is out, and waits
  for a read begun after it that still lists the session (`#awaited`), or a late answer would
  be dropped for a task already `done` and its dependents would run on a failed predecessor. A
  disconnected machine answers nothing (`#due` skips it), so the deadline alone settles its task
  (`lostAfterMs`, 15 min, is longer, so the `lost` path's own settle is not reached at the
  defaults; kept for a config that sets it shorter, where it too settles instead of marking
  `lost`, which would fail dependents at `lost_expired` for a session that is over). An end
  with a PR known settles on the event as before; the status counts only when neither a PR nor a
  believed merge does (merged → `done` by `merged`, PR → `awaiting-merge`). A signal death (an OOM
  SIGKILL, a segfault) leaves `pane_dead_status` empty and `pane_dead_signal` set (tmux 3.3 and
  later; a number on Linux, a name on macOS, resolved through `os.constants.signals`), read as `128 + signal`, the shell's convention and inside 0–255, so it fails like any
  nonzero exit. No status — 0, which
  under `failed` closes the window and is never seen, a signal death on a tmux without
  `pane_dead_signal` (the field reads empty), a tmux older than 3.2 (which refuses `failed`, so the window gets `off`), a pane someone closed by
  hand, an older daemon — settles `done` as before. A despawn is not told apart: its `/exit` exits
  0 (measured on 2.1.295) and its kill destroys the pane, leaving no status, and `cancel` and
  `mark-done` write their own state. Rejected: holding the `ended` forward in the daemon until the
  pane died (the leader would still need the answer to read the status, and a hold cannot be
  awaited in the ingest handler — the hook's process is claude's child, so claude would not exit
  until it timed out); the status on `ended` or the session event (an older leader reads
  `ended` entries as bare ids, and the hook has no status to give); a shell wrapper recording
  `$?` (séance `exec`s claude, which the pane classifier and `OURS` rely on).
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
  registration (a tmux with no `pane_dead_time` leaves it alone). A dead task
  pane still holding an exit status is left to the daemon, which notes it
  before closing the pane (Daemon, "Exit status"). A claude on
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
- **Network**: `git fetch --prune origin` only when reap's own last prune of
  that clone is over a day old. That time is kept in `reap-fetch.json` in the
  state dir, keyed by canonical common dir, and written once per run for the
  clones whose fetch succeeded. Missing or unparsable reads as never pruned.
  This was the newest `FETCH_HEAD` until 2026-10-17. Worktree spawns now
  refresh that file with a one-branch fetch that prunes nothing ("Worktree
  spawns fetch first"), so on a machine that spawns daily it never aged. A
  deleted remote branch then never read `[gone]` and was never reaped. A
  separate file, not `state.json`, because a CLI reap and the daemon would both
  rewrite the identity file. It must not hang on credentials: stdin ignored,
  `GIT_TERMINAL_PROMPT=0`, a 30s timeout; a failure is reported and the run
  judges by stale refs, which only ever makes fewer things look merged. ssh
  ignores `GIT_TERMINAL_PROMPT` and would ask for a key's passphrase on the
  terminal of a foreground run, so the network calls add
  `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` (`sshBatchEnv` in `git-hardened.ts`,
  which every network fetch opts into: reap's, the branch-state emitter's and
  the spawn's base fetch; plumbing calls never pay its probe): it fails instead,
  and a key in an agent still works. Terminal-only: a launchd or systemd
  service has no controlling terminal (`/dev/tty` cannot be opened, checked
  once per process) and cannot prompt anyway, and Apple's OpenSSH may read a
  `UseKeychain` passphrase inside the very prompt loop BatchMode disables, so
  adding it there could break fetches that work today. Only when the user
  chose no ssh: git takes `GIT_SSH_COMMAND` over `core.sshCommand` over
  `GIT_SSH`, so setting it, or passing `-c core.sshCommand`, would silently
  replace theirs. It is added only when the environment has neither
  `GIT_SSH_COMMAND` nor `GIT_SSH`, `GIT_SSH_VARIANT` is unset, `ssh` or `auto`,
  and one `git config --get-regexp '^(core\.sshcommand|ssh\.variant)$'`, run
  in the repo with the fetch's own env so includes and config overrides count,
  finds no `core.sshCommand` (any value, empty included) and no `ssh.variant`
  other than `ssh` or `auto` (a putty or plink variant would read `-o` as
  something else; `GIT_SSH_VARIANT` outranks `ssh.variant`, so the config is read only
  when the environment sets none): exit 1 is none set; any other answer leaves the env alone.
  That probe is one more spawn, run only when a fetch really goes to the
  network (past the staleness check) and a terminal is attached. It runs for
  an HTTPS remote too: skipping by URL would be unsound, since
  `url.<base>.insteadOf` can rewrite one to ssh. Windows has no `/dev/tty`,
  so it reads as no terminal there. A repo
  with no `origin/HEAD` on disk (about a third) gets `git remote set-head origin
  --auto`, bounded the same way, since "merged" needs something to measure
  against; still none, and the repo is skipped and named. The branch-state
  emitter (Scheduler, "Branch state") is the other fetcher, through the same guarded
  `fetchIfStale` with a 5-minute window, its own in-memory record of its
  last prune, and `GCM_INTERACTIVE=never`, BatchMode included.
- **Repo-local config executes, and sessions write it.** Reap is the first thing to run git in every
  scanned repo, and git runs what a repo's config says; a session in any of its
  worktrees can set that config with `git config`. `core.fsmonitor` (a hook,
  or a daemon per worktree), hooks (`reference-transaction` fires on the
  ref updates reap makes) and the `ext::` transport (it runs its URL) are off for every call (`-c core.fsmonitor=false -c
  core.hooksPath=/dev/null -c protocol.ext.allow=never`). Every network call —
  reap's fetch and `set-head`, the base fetch, the emitter's fetch, self-update's
  `set-head` and fetch — goes through `networkGit` (`git-hardened.ts`), and
  `classifyTip`'s `merge-tree` checks the same thing first: `repoConfigRefusal`
  reads `git config --list --show-scope` and `info/attributes`, and refuses the
  call when local or worktree config sets `core.sshCommand`, `core.gitProxy`,
  `core.askPass`, `core.attributesFile`, `credential.*`, `remote.*.uploadpack` or
  `receivepack`, `protocol.allow` or `protocol.*.allow`, `url.*.insteadOf`,
  `include.*` / `includeIf.*`, `merge.*.driver` or `filter.*`, or
  `info/attributes` has a `merge=` line. Config it cannot read refuses too. The
  failure names the family, never the key, whose subsection can be a URL with
  credentials in it: reap reports it, the base fetch's note carries it to the
  phone, the emitter warns once per run of failures, self-update reports
  `fetch_failed`. A refused `merge-tree` reads as a conflict, the safe side. The
  same keys in global or system config are the owner's and still apply. A clone
  that sets its own `credential.helper` is no longer fetched by the daemon (owner
  decision R8 #2 is still open; dropping `credential.*` from `REFUSED_FAMILIES`
  is one line). `networkGit` is also the one environment for the network:
  `hardenedGit`'s process-group kill and overrides, `GCM_INTERACTIVE=never`
  unless the user set their own (Git Credential Manager ignores
  `GIT_TERMINAL_PROMPT` and may raise a GUI on WSL/Windows) and `sshBatchEnv`'s
  BatchMode. Not covered: a submodule's own config (reap's fetch no longer
  recurses), and claude's own `--worktree` fetch, which runs in the session it
  starts. Its `FETCH_HEAD` goes stale once the base fetch is refused, so claude
  fetches with that config itself.
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
  not burn the single announce a process makes — and it leaves only after
  that socket's register: the relay drops a msg from a socket with no identity
  yet, and signing a register is slower than sealing the announce, so an
  announce fired on `open` overtook it and reached no machine (lost from
  signed registers, 2026-10-15, until 2026-10-18). The relay in turn holds a
  socket's frames behind its pending register, whose verify awaits WebCrypto
  that no input gate covers. A register the relay refuses takes the announce
  behind it down too, so a refusal re-arms it for the redial. Accepted gap: an announce
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
  nobody reads. The one exception is the first `current` after a skip or
  failure (seeded from state.json at startup), reported once so a fixed
  problem stops being shown; not for an install or restart failure this
  process recorded, since HEAD is already at target while old code serves. The Machines screen and `list_machines` render both (since
  2026-10-18; Presence & identity says why), beside `seanced doctor`/`status`.
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
Models offered: `fable`/`opus`/`sonnet`/`haiku`; efforts: all five the CLI accepts.

- **Preact, not React, and without `preact/compat`.** The whole app is two screens,
  four sheets and a verdict; React's runtime cost 70 kB gzip against Preact's 16 kB,
  all of it also precached onto a phone. `compat` was rejected because it re-adds the
  layer whose size was the reason to switch. Going native costs the three things
  compat papers over: no `StrictMode` (nothing here relies on double-invoked effects),
  no `useSyncExternalStore` (`app.tsx` has a small stand-in — Preact defers a `setState`
  render to a microtask but never renders concurrently, so there is no torn read to
  guard, only the render-to-effect gap the resync closes), and `onChange` means the _native_ change event, so every text input
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
  verdict, the Settings dialog and the phone's Queue and Machines screens all push on open and are cleared by
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
- **On a phone the pill's face is a menu.** Below the desktop breakpoint the raised face is a
  hamburger opening Queue, Machines and Settings — the screens a desk shows as columns, plus
  the one it doesn't — each with a feather-weight icon (list, server, the cog). The track and
  its dot are unchanged; an escalated task puts the queue's attention dot on the closed face
  and on the Queue row. A native `popover="auto"`, not a layer: outside taps, Escape and
  Android back (Chrome routes back to an open popover before history) all close it, so it
  pushes no history entry. Pinned under the pill from its rect on open, since CSS anchor
  positioning is not in every browser the app runs in. Rejected: a bottom tab bar, which
  would spend a phone's height on three destinations visited far less than the form.
- **Settings is one screen, reached from the header's relay pill** (on a phone, through its menu). It absorbed
  what used to be a bottom-sheet drawer plus a separate Relay & keys screen:
  credentials, connection status and theme in one place. The drawer's
  entry-replacing history special case went with it, and its "Reconnect now" row
  is folded into the screen's single bottom action, which reads "Reconnect"
  while the relay is down, saves-then-reconnects when credentials were edited,
  and otherwise just returns.
- **Settings is a native modal `<dialog>`, shaped by width.** Below the 1200px desktop
  breakpoint it fills the screen and slides in exactly as a pushed screen does — the form
  still gives way and dims beneath it — with a back chevron; at and above it, it is a
  centred modal over the three columns, closed by an × at the header's right, Escape or a
  backdrop click. The top layer makes the page behind it inert for free, and Chrome on
  Android routes back to an open modal's `cancel` before history; that event is
  cancelled and sent through the store as a history pop, so every way out takes the
  one path and the layer's history entry never strands. Both motions are view
  transitions (next bullet): the phone's panel `main` is the layer, as a pushed screen's
  is; on a desk the `<dialog>` itself is, so its border and shadow scale with the panel.
  The dialog unmounts the moment it closes — the old snapshot plays its exit.
- **Screen and layer motion is the View Transition API, started at the store boundary.**
  Phone push/pop (Queue, Machines, Settings), form ↔ verdict, and the desk's Settings
  modal run through `document.startViewTransition({ update, types })`; the old screen is
  a snapshot, so the outgoing one never stays mounted, and the browser composites the
  motion. Every store change reaches `useStoreState` — clicks, `popstate` (closing is
  `history.back()`) and network replies alike — so that is where one `TransitionRunner`
  (`pwa/src/transition.ts`) is offered each new state. It is keyed on screen identity
  only (depth, layer, and the verdict by the same key `VerdictView` mounts on: a queued
  task's id, any other verdict's object), never content, so a poll or a keystroke never
  starts one; a depth change outranks a verdict change, a verdict replacing a verdict is
  none, and on a desk only Settings moves. A started transition holds the state back
  until its update callback, which runs after the browser captures the old screen; the
  latest offer in that frame wins. The callback's promise resolves once Preact has
  committed the DOM (a `useLayoutEffect` on a render sequence number, children's layout
  effects such as `showModal()` running first), with a 100ms backstop so a dropped render
  never leaves the screen frozen until the browser's own timeout. Transition types
  (`push`, `pop`, `verdict-in`, `verdict-out`, `modal-in`, `modal-out`) are the CSS
  vocabulary; `view-transition-name`s and `-class`es are set only under
  `:root:active-view-transition`, so no idle element is a stacking context because of
  one and a duplicate name, which aborts a transition, can come only from the two host
  classes. Reduced motion, a hidden page, or a browser without typed transitions
  (feature-tested by `CSS.supports("selector(:active-view-transition-type(x))")`, which
  proves the object form and the type selectors together) gets the state at once — an
  instant swap. `base.css`'s `*` reduced-motion clamp does not reach the
  `::view-transition-*` pseudos, so they carry their own clamp beside it. Rejected:
  keeping the hand-rolled mounted pair (timers, `animationend` filtering on name
  prefixes, lingering mounts); starting transitions in click handlers (closes arrive by
  `popstate`, verdicts by the network); applying state before the callback (it lands in
  the old snapshot); view transitions for the bottom sheets (only one runs at a time, so
  a sheet would cut a push short, and each one freezes the page a frame and swallows
  taps the sheet's exit deliberately leaves to the form); for the verdict's poll-driven
  swaps (owner's call, and the same freeze); a `data-vt` attribute on `<html>` instead
  of types (set before capture, cleared on `finished`, and a token so overlapping
  transitions cannot clear each other's — types are scoped to their transition by the
  browser); Level 1 only, for reach (the target Firefox, 158 on the owner's phone, and
  Chrome ship Level 2, and a callback-only browser should swap, not run unstyled
  crossfades); keeping the old CSS as the fallback (two motion systems); unconditional
  names (duplicate-name aborts, permanent stacking contexts). Not a gain: a back during a
  push snaps the push to its end and then pops, as the old code restarted; and a
  finger-following swipe-back would need its own design, since there is no scrubbable
  timeline to rely on in Firefox. The planned shared decision card from the form's
  preview into the verdict was dropped with the verdict's card itself (2026-10-19).
- **Machines is a screen, not a route** (scheduler M1). On a desk it is a column (below).
  Settings no longer links to it: Machines is meant to be always on screen, not a layer reached
  through Settings; on a phone it is a layer straight over the form, opened from the header
  menu (`openMachines`). Rejected for now: URL routes (`/machines`),
  which would need boot-time path parsing and a rethink of entry depth for deep links — a
  separate change if links are wanted.
- **Machines show load, accounts show quota.** A machine card carries CPU and memory bars and
  its exclaves (account, running sessions), while connected; quota is a property of an account, not of any
  machine, so it sits on account cards: one per `accountId` across the fleet, named by the
  email any of its exclaves reports (the short account id from a daemon that predates it), newest
  observation wins, since every daemon hosting one of its exclaves reports it, each window
  it lacks filled from the next newest that has one (`mergeQuota`) — per-model caps reach
  the cache only through `/usage`, so a machine whose newer cache never saw one must not
  erase another's; a window with no reset fills only from a reading under one window length
  older, since nothing else would ever expire it; credits `c` carry no reset (the cache
  doesn't say when the month turns), so they are taken to reset at 00:00 UTC on the 1st
  (`sameCreditMonth`): they fill only from a reading in the same UTC month, and routing
  and the card read last month's as unknown, never as spent.
  A Credits bar (percent of the cap like every row, "$42 of $50" in whole units where
  a reset goes) shows only while one of the card's windows, per-model weeklies included, reads
  100% after the reset floor — that is when use spills into credits, and until then the
  monthly figure is noise on a card about windows. Not charted: the series (`quota_credits_pct`) is kept
  daemon-side for when a chart wants it. Every machine counts, an asleep
  machine's included, from the status the relay kept, with "asleep" and its age on the
  observed line. A window whose `resets_at` has passed shows 0% and
  "reset", however full the reading was — a cache reading can be hours old, and its
  percentage describes a window that no longer exists. Both rules are one shared copy,
  `newestQuotaByAccount` and `effectivePct` in `shared/src/quota.ts`, so M2's scheduler
  filter and score read quota exactly as the cards do. Charts follow the split — History on a machine asks
  that daemon for `cpu_pct`/`mem_pct`/`disk_pct`; on an account it asks one online host of the account
  (the newest observer when it serves `metrics`) for the quota series and folds its exclaves'
  copies into one line per window. One chart at a time, its window fixed when asked, a reply
  that lands after the chart moved on is dropped. Disk shows as a third gauge, percent
  used on the fullest watched path (2026-10-19 — an LXC's small root fills quietly, and an
  earlier cut hid it as upkeep rather than load); it never scores. The floor reads `free`, not
  the percent (docs/scheduler.md, Settled defaults 6); the gauge turns red under that same
  floor (`MIN_FREE_MIB`) whatever its percent, so a card never shows amber for a machine
  routing has dropped. `disk_pct` also feeds M4's health alert. The chart is inline SVG geometry (`chart.ts`), no charting
  dependency; gauges break their line at a missed tick and bridge the break with a faint
  dotted run (nothing was measured there, but a sleep should read as one gap, not as
  missing ink), and a point alone between two breaks is a dot — a laptop in clamshell
  sleep leaves exactly that, one tick per dark wake. Quota holds its level between
  observations, since a sample carries the observation's time, not the tick's.
- **Machines say who leads and what each runs** (2026-10-18). A line above the cards names
  the scheduler leader, an unverified nominee (by registry name, or a short id when its entry
  did not open), or that nobody leads; the leader's card carries a SCHEDULER badge and an
  unverified nominee's an UNVERIFIED one — read through `schedulerRole` in
  `shared/src/app-client.ts`, the rule `list_machines` uses too, so an unproven nominee is
  never drawn as leading. Each card shows its daemon's build (short sha, commit age, branch)
  and, when its last update attempt was a skip or failure, a note saying which and how long ago.
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
- **`auto` is a machine-picker row, and the scheduler is asked only through it** (scheduler M2
  item 6). The row sits above the machines, laid out like them, with a blue dot where a machine
  has its green one (on the MACHINE tile too, once picked). It is greyed with its reason, its dot
  grey like an offline machine's — on the tile as on the row — only when the relay socket is not open
  ("Not connected to the relay"). With a socket open it is available whatever the leader's state
  (owner's call, M3 item 6): the queue is the relay's, so an enqueue needs no leader. Where
  `RelayState.scheduler` is not `ready` the row carries a note instead of a reason — `none`
  reads "No scheduler is leading right now — it waits in the queue until one does", `unverified`
  the same with "Leader unverified — it hasn't shown it holds this key". Unverified is a nominee
  whose registry entry did not open into a `Machine` — the rule that already decides which
  entries render, here deciding who is believed to hold the PSK (Scheduler, "Leadership"). The
  preview, a scheduler request, still needs a verified leader. The client enforces the check at
  the source: `routePreview`, `queue`, `cancel`, `markDone`, `pause` and `resume` throw `leader_unverified` or `no_leader`
  without sending, so nothing reaches an unverified nominee however the UI is driven; the relay's `offline`
  for the scheduler address (no leader socket) comes back as `no_leader` too, and marks no
  machine offline. On `auto` the repo
  picker lists repos by `origin` across the fleet (a clone's name is machine-local), remembered
  as `PersistedForm.autoRepo` beside `auto` rather than as a sentinel in `machineId`, so leaving
  auto restores the machine picked last. A **placement preview** card asks `route-preview`
  whenever auto is chosen, its repo changes, the leader changes or is verified, or the socket
  comes back from a drop (which can fail a preview in flight while leaving the leader as it was);
  and, 500ms after a burst settles, whenever a machine connects or drops or its repo set changes
  (2026-10-17) — a status beat moves neither, so it asks nothing. The card's label says how old
  the decision is ("decided 2m ago"): load and quota move under it between asks.
  A preview answered `not_ready` — a term still taking over — is asked again every second, at
  most 10 times, rather than shown as a failure. The card shows the
  decision as "chose X because …, rejected Y because …", one row per candidate, losers behind a
  disclosure (`decision-view.ts` lays it out; each reason's clause, and each scheduler
  refusal's, is `shared/src/scheduler-text.ts`, which `seanced mcp` words from too). The preview leaves out the quota reading
  each candidate was judged on (the task record keeps it). **Queue on auto** is an enqueue
  (M3 item 6): the form builds a `queued` task (`queuedTask`, id minted here) and `createTask`
  `store-put`s it, so it needs an open relay socket and nothing else. The verdict shows the task
  and follows it (2026-10-19: as one screen that moves, not three — it is keyed on the task id so
  refreshes update it in place; three tiles, Queued · Placed · Running, each the direct spawn's
  glyph squircle, stand in for the glyph until the task settles, since an outcome is a glyph and
  a stage is not, and `lost` is a `?` not a third tile; the waiting tile pulses and a tile that
  stops waiting lets its pulse finish; the headline and body slide and crossfade on change. The
  decision card is not on the verdict at all — the owner's call: the form's preview says where
  it would go and the verdict says only that it is running; `verdict-view.ts` derives the rest.
  The Queue screen's rows once carried it too, behind a "Why there" disclosure, removed
  2026-10-22 as unread — the task record still holds the decision): a `queue-changed` nudge that names the task (or
  none) re-reads
  `queue {tasks: [id]}` at once, a reconnect or a new leader re-reads it, and a poll every 2s, at
  most 30 times, is the fallback while the task has not settled (`isSettled`,
  `shared/src/task-phase.ts`). A read answered `not_ready` is a missed
  poll that keeps what was shown. A reply without the task decides nothing: the reply's byte
  budget can drop a named task, and a leader lists a create only once it has read it. So the
  app asks the store (`getTask`; 2026-10-18, M3 review Q7). If the store holds no such task,
  the follow ends with "no longer in the queue", even on a nudge's read. If it holds the task,
  the follow goes on, and polls that run out on such answers say the scheduler's answers leave
  it out, not that it stopped answering. If the store cannot say, it is a missed poll. The Queue
  screen applies the same rule. A read the leader
  refuses, or whose reply cannot be read, ends the follow and says why. With no leader or an
  unverified one the read is "waiting", and spends no poll: the verdict says the task waits in the
  queue until one leads, and it follows the task as soon as one does. Polls that run out on a miss
  say the screen may be out of date and point at the Queue screen. A lost create (`timeout`,
  `dropped`, a transport error) says it may have queued anyway, once: the reason it gives never
  says so too, nor names the store frame. It offers **Try again**, which
  re-sends the same task: a repeat create answers `version_conflict`, read as "already stored"
  (`landedEarlier`), so it cannot queue twice. One that never left (`disconnected`) says it was
  not queued, with the same retry. A `store_full` refusal names the unreadable records the last
  queue read listed, when there are any, since no prune frees those (M3 review S2). No
  `queue-changed` is read while the tab is hidden (M3 review P5): showing it re-dials, and the
  reopen reads the queue and the followed task whole. A pending enqueue is not persisted across a reload: a lost
  reply there leaves the task queued and visible on the Queue screen, which is the way back to it.
  Picking a machine is unchanged — a direct `spawn` to its daemon, which needs no
  leader.
- **The Queue screen** (M3 item 6) is the app's view of the relay's queue, opened from the
  phone's header menu (an attention dot on it while a task is escalated). It reads `queue` from the leader
  and so shows nothing while none leads — it says why ("No scheduler is leading right now") and
  keeps a list it had already read, marked possibly stale; there is deliberately no fallback that
  lists the store directly, since the leader's reply is where decisions, holds and the bounded,
  prompt-cut view come from. It re-reads on every `queue-changed` (the named tasks only, merged
  into what it holds), on a reconnect and on a leader change. A named task the reply leaves out
  is dropped only if the store holds no record of it, the same rule as the verdict's. Tasks group by what each needs from
  the owner: Needs you (escalated first, then `needs-input`, then `lost`), Running, Waiting,
  Awaiting merge, Finished, in the leader's order within each (`queue-view.ts`). A row shows the
  task's title (its own, else its prompt's first line cut to 80, else its session's window name, else its repo), where it is and
  why, with the decision's record on tap — in the past tense once the task was placed ("spending
  credits", not "would spend"). **Cancel** and **Mark done** are offered where the leader allows
  them. Mark done sets the task `done` by hand, ending its session first when it is running,
  `needs-input` or `lost`. Either one that ends a live session takes a second tap within four
  seconds. A `done` or `cancelled` task with `leftRunning` says its session may still be running
  on its machine (M3 review Q8). Records the leader cannot read (`QueueResponse.unreadable`:
  junk, or sealed under an earlier PSK) show as one line, "N unreadable records hold queue
  slots", with **Clear** (M3 review S2). Clear takes a second tap, then sends `discard` for each
  record at its listed version. A record already gone counts as cleared; any other refusal stops
  there and becomes the notice. The queue is then read whole. Holds show whole or per account, by the account's
  own name, with a reset's time, each with **Resume**; the footer pauses or resumes the whole
  queue. The same cap applies as in the leader's reply: a full reply says it shows the most
  relevant `QUEUE_MAX_TASKS`. Authoring a batch or a dependency from the PWA has no UI yet
  (docs/scheduler.md, M4, _Authoring surface_): the app client enforces the batch-index bound at
  `createTask`, which is the only place an app could set it.
- **Desktop shows three columns instead of a stack** (2026-10-18). From 1200px wide — room for
  three phone-width columns, the one breakpoint, in `app.tsx` — the form, the Machines screen and
  the Queue screen sit side by side, each scrolling on its own; below it the app is the phone stack
  unchanged. The queue is the rightmost column, so the settings pill moves to its header, and the
  form header loses its queue chip (nothing left to open). Settings stays a layer, a centred
  modal over the columns. The queue's pause button drops to an outline: spawn stays the one filled call to action
  on screen. Columns are not layers, so they carry no back button and push no history entry. The
  store keeps the queue read while it is on screen without its layer (`AppState.wide`), since the
  column is never opened.
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
- **A `/name` token in the prompt opens a skill picker** (scheduler M4, _Skills_, 2026-10-17). It
  lists the union of skill names across every machine and exclave — `MachineInfo.exclaves[].skills`
  from the register blobs the app already holds, offline machines included — so it needs no
  leader and works on a direct pick as on `auto`. Names only, no descriptions and no
  machine list: the blob carries every name to every app, and descriptions would grow it per
  skill; placement is the M4 routing filter's job, so the list stays a plain union. It
  completes the token ending at the caret (2026-10-20; first token only before): a `/` at the start
  or after whitespace, no whitespace or second `/` up to the caret, and the caret at the token's
  end with no selection — so `… /sh` mid-prompt opens it, a slash in a word, URL or path
  (`and/or`, `https://a/b`, `/tmp/x`) never does. The caret is read from the field's `input`, `keyup`,
  `click`, `pointerup`, `select` and `selectionchange` events; text written from elsewhere counts as caret-at-end, where
  the browser puts it. Matching is prefix first then substring, and picking splices `/name ` in
  place of the token (reusing a space already there) with the caret after it. It sits inline under
  the textarea, which collapses to one line meanwhile — scrolled to the token's line, measured
  off the mirror below, since a collapse alone leaves the last line in view — rather than in an overlay the on-screen
  keyboard could cover; it opens from the prompt text, never focus, and its rows take
  `pointerdown` without default so a tap neither blurs the field nor drops the keyboard. With
  matches, Enter and Tab pick and never spawn; with none it says the name goes as typed and the
  keys behave as without it — an unknown name is not an error (M4's routing filter, still open, will let it pass).
  Every known `/name` token (at the start or after whitespace) is painted in the accent colour, as Claude Code marks one; a
  textarea can't style its own text, so a mirror behind it with the same metrics draws the
  glyphs and follows its scroll, and the field keeps only caret, selection and input.

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
  because repos ride the register blob; each entry's `source` build and
  `lastUpdate` from the same blob, and `scheduler: "leader"` on the nominee
  whose lead proof verified or `"unverified"` on one whose did not — never a
  leader on the relay's word alone, and no mark at all through the fleet
  broker, which has no scheduler view; still a bare array, so the field is
  per entry rather than a wrapper), `get_sessions { machine }`,
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
- **`machine: "auto"` and `get_queue`** (added 2026-10-17). `auto` enqueues: it builds a `queued` task from the request (`queuedTask`) and `createTask`s it
  through the same app client (reached via `FleetLease.scheduler`), up to three tries a second
  apart that re-send the same task, so a lost reply is never a second task. It answers at once
  with the task id and "queued" — it no longer holds the call to follow the task, since a task
  may wait for capacity or for a leader — and the agent reads where it went with `get_queue`
  (M2's follow, `autoFollow`, is gone). With no leader, or an unverified one, it still queues and
  adds "No scheduler is leading right now (or its leader is unverified); the task waits in the
  relay's queue until one does." `get_queue` is the
  `queue` op, read-only, each task with its placement and its decision's line, and now the
  `holds` in force and, per task, `escalated` and `doneBy`. Behaviour
  follows the PWA wherever the PWA already decides: a field over `TASK_REQUEST_LIMITS`
  is refused before the relay is dialled, worded as the PWA words it — an enqueue never reaches
  the leader, and `createTask` would refuse the same task locally as `invalid_request` — except
  the origin a clone name resolves to, which
  only the fleet can say, so it is bounds-checked once `withFleet` has the registry; every store refusal has its wording (`storeErrorText`); and an enqueue with no answer
  after its three tries is "may have queued — check get_queue before retrying". A retry of the
  same task that finds it stored says so (`landedEarlier`). `disconnected` never left this
  process, so it is a plain failure. `cancel_task` is the one scheduler call left here that has
  a leader's own refusals (`no_leader`/`leader_unverified` read as unavailable; a transport
  code like `too_large` or `internal_error` shows the leader's message). **`cancel_task`** (added 2026-10-17, with the
  leader's `cancel`) is the `cancel` op by the task id `get_queue` shows: it answers the task
  as it now stands, says so when it had already finished, and says a `lost` task cancelled
  with its machine away (`leftRunning`) may still have a session there to end by hand. Its
  lost reply is "the cancel may have landed anyway — check get_queue"; its transport codes
  (2026-10-18): `too_large` means the cancel ran (the task may still have
  finished first, so MCP points at `get_queue`), and `internal_error` shows the leader's message
  on one line, pointing at `get_queue` when it does not say whether the cancel landed. `"auto"` is matched
  in any case before the local short circuit, so a machine named "auto" is reached by
  `deviceId`. **`repo` on auto** is the `TaskRequest`'s origin, but an agent holds clone
  names from `list_machines`, so either is accepted: an origin exactly, or a clone name
  whose clones across the fleet all share one origin. A name behind two origins is an
  error listing each origin with its machines, never a guess — a guess runs the task in
  the wrong repo. `list_machines` does not show origins: the clone name serves the
  common case, the ambiguity error names the origins when it doesn't, and its output
  keeps its shape. **The limits are in both tool descriptions**, since an agent would
  otherwise take the queue for a backlog: a task waiting for capacity is held by the relay
  and survives a leader change (every relay deploy, every daemon self-update), the next leader
  taking it over; a placed session is ordinary; no deps or ordering. **Not
  through the broker**: a keyless `seanced mcp` gets "auto needs this machine's own
  key; unavailable through the broker", and nothing falls back. A scheduler action
  would be a new broker action, which is a threat-model change ("Fleet broker"), so
  `brokerFleet` leases carry `scheduler: null`. The enqueue is a `store-put` through the
  app client, as the PWA's is.
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
  `git pull` and a bun upgrade. A user-scope entry reaches one `.claude.json`, so
  both commands run once per exclave (`userScopeTargets` in `daemon/src/exclaves.ts`,
  shared with `mod install`):
  `default` with `CLAUDE_CONFIG_DIR` unset, each named one with it set, plus the
  ambient dir when no exclave owns it. One that has no config dir yet is skipped,
  because `claude mcp add` would create it. `doctor` reports the entry per exclave,
  and warns when its script is not this checkout's `main.ts` (realpath on both
  sides, so a symlinked checkout path still matches): an entry left on another
  clone runs that clone's code, and once observed failing in every session
  because that clone had never had `bun install` run — while doctor, checking
  only the registration and the bun path, said all was well.
  Rejected: registering only in the invoking shell's config dir, which is what
  left the exclaves without it.
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

An `auto` spawn is not an MCP spawn at its target: the leader dispatches with its own
`client` (`client="scheduler"`, audited `origin=relay` at another machine and
`origin=leader` on its own). The session is the scheduler's, which is what its audit line
says. That an agent asked for it is in that agent's transcript, in the MCP box's own
`audit enqueue origin=mcp` line, and on the leader's `op=admit` line, which reads the
task record's `client` (`TaskSpec.client`, bounded to 64; added 2026-10-18, M3 review S5).

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
  whose key is service-delivered, and says so. The `session-event` kind below
  grants no act at all. It is ingest, and what it ingests is bound to the
  sender's own pane. Its first act, a `done` report for the sender's own task, is
  decided and not built ("Session events").
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

- **Only on a daemon whose key is service-delivered.** `run-capabilities.ts` builds the broker
  when the daemon's `loadPsk` answered `source: "credential"`, and nowhere else: on
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

### Session events (`daemon/src/session-events.ts`) — added 2026-10-16, scheduler M2 item 5

The scheduler needs to hear what a session is doing when it happens: busy, idle,
waiting on a person, ended, the PR it opened. The `claude-mods/session-events` mod reports these to the
local daemon, and the daemon forwards task sessions' states to the leader. This is
a third frame kind on the op socket, and a widening of what the socket takes in.

- **Its own frame kind, never a `Plain` or an `OpName`.** `{v, kind: "session-event",
  state?, prUrl?, pane?}`, routed on `kind` before the `Plain` check, as
  broker frames are. A frame with `rateLimits` and no state, from a mod that predates
  2026-10-20 (below), is still taken as activity; its numbers go unread. It has no `op`, `id` or `ts`, so it cannot arrive from the relay
  and no op rides in as one. A daemon that predates it drops it as malformed. The mod
  reaches the socket through `seanced session-event` (JSON on stdin). A hooks module
  runs with no Node and no sockets of its own, so it runs that command through
  `$.process.run`. The command is silent, always exits 0, and waits for the daemon's
  one-line answer before exiting: the binding below needs the sender alive. It runs
  two or three times a turn in every session on the machine, so `main.ts` dispatches it
  before loading anything else of the CLI (`cli.ts` pulls in the MCP SDK and zod), and the
  command imports the frame constants from `session-event-frame.ts`, not the daemon side:
  11 ms a run on macOS where loading the whole CLI took 47 ms, against 5 ms for a bare
  `bun -e 0`. Fire-and-forget from the mod's side, and skipped there when `TMUX_PANE`
  is unset: such a session is in no pane the daemon could bind it to, so every report
  would be `unbound` (below) at the cost of a Bun start and the daemon's tmux and
  parent-walk reads. The daemon still binds every report that does arrive.
- **Where the states come from: engine events, never `classic.*`** (changed 2026-10-22,
  mod 0.2.0). On Team/Enterprise orgs Claude Code 2.1.308's built-in
  `cc-plugin-sec-default` sits first on the classic chain and passes every classic event
  past the plugins a person installs, so the first mod's `classic.*` hooks never ran there.
  Now: `session.start` is idle (not raised for `/clear` or a compaction, so no `source`
  check); `turn.start` busy and `turn.complete` idle, main loop only (`agentId` unset —
  a subagent's turns run inside the main loop's); a `tool.check` that settles on `ask`
  with `approver: "person"` on a real call (a `$.tool.check` query has no `tool_use_id`)
  is needs-input, from any loop, as the old permission notification was, and that call's
  `tool.call` settling is busy again; an `AskUserQuestion` call is needs-input until it
  settles; a Bash `gh pr create` that printed an `https:` `/pull/<n>` URL is busy plus
  `prUrl`; `session.end` is ended unless its reason is `clear` or `resume`. A `tool.call`
  that rejects reports nothing: the turn is ending and `turn.complete` says so. Reports
  go out one at a time in the order raised (one promise chain, still never awaited by a
  hook), since an Esc on a prompt raises busy then idle within a millisecond and two
  Bun starts race. **Auto mode reports needs-input then busy for each call its
  classifier settles**: core answers `ask` there too, and no engine event says a dialog
  was shown, nor does `$` read the permission mode. Accepted: the leader escalates only
  a needs-input that lasts (`escalation`), so the flicker alerts nobody; it costs two
  task-record writes per such call in a task's session. **Not covered**: an MCP server's elicitation, which
  has no engine event (only the skipped `classic.Elicitation`).
- **Ingest-only.** The handler stores (the ended-task memory) and forwards (to the
  leader). Its one other effect is a poke at the `/usage` refresh for the bound
  pane's exclave (Daemon, "Usage refresh"), which spawns only when that exclave's
  cached reading is stale, with a fixed argv and an env built from the scan — no
  frame field reaches either. It never despawns or runs a command shaped by
  a frame. Its own only subprocesses are fixed-argv reads: `tmux list-panes`, and on
  macOS, where the parent walk below cannot read a hop itself, `ps -Ao pid=,ppid=`.
  No frame field reaches any argv. The one indirect run is the `/usage` refresh above:
  poked, staleness-gated, fixed argv, built env.
- **`done`: decided, not built** (#21, decided 2026-10-20; in the schema since the M4 schema
  PR). A session reports that its task is finished, so a task can stay open past its merge
  ("after X is in prod" is X's session merging, watching the deploy, then reporting). The
  state is in `SESSION_STATES`, but `parseSessionEventFrame` refuses it, as it refused it
  when the state was unknown, and the leader's `sessionChange` leaves a task as it is on
  one. The decided act, landing with the authoring surface: the leader settles the
  sender's task `done`, bound by peer pid like every event, so a session can finish only its
  own task. Under `until: "reported"` it is the one settle beside `mark-done` and Linear
  Done; `after: "done"` dependents release on it. It is the first act beyond ingest, so a
  threat-model change (Threat model, item 6). A session that lies about being done can do
  no more than one that exits, and `mark-done` stays the manual override.
- **Every field is untrusted; the pane is the kernel's answer.** The 0700 run
  directory admits any process of this user, and every session is this user, so a
  frame could name any pane or task. The daemon asks the kernel who connected. Bun
  surfaces no peer credentials (probed on 1.4.3: no `peerCredentials`,
  `remoteAddress` undefined), but its sockets carry the accepted `fd` (untyped,
  read through `socketFd`). `daemon/src/peer.ts` therefore calls libc through
  `bun:ffi`: `getsockopt(SOL_SOCKET, SO_PEERCRED)` on Linux and WSL (tested: the
  peer pid matched the connecting child's), and `getsockopt(SOL_LOCAL, LOCAL_PEERPID)`
  on macOS. The macOS path is documented in `<sys/un.h>` since 10.8 but not
  tested by hand; CI's macOS leg runs the suite that exercises it. Both record the
  pid at `connect(2)`. The daemon walks that pid's parents (`/proc/<pid>/stat` on
  Linux, `proc_pidinfo(PROC_PIDTBSDINFO)` through `bun:ffi` on macOS, at most 32 hops)
  to the first `pane_pid` of a live pane. On macOS that is 0.3 µs a hop where the one
  `ps` it replaced took 20 ms and grew with the process count; `ps` stays the fallback
  where the symbol will not load, and for a hop `proc_pidinfo` refuses (another user's
  process, such as a `sudo` between pane and peer), which `ps` can read.
  The session (the pane id), the task (the pane's `@seance-task`, the tag spawn writes
  and `task_running` reads) and the exclave (the pane's path through `exclaveOf`) all
  come from that pane. The `taskId`, `session` and `exclave` a frame might carry are
  not even parsed. A sender in no pane (outside tmux, a `claude --bg` session) is
  answered `unbound` and dropped.
- **The fallback binding, and why it is the next best.** Where the host cannot name
  a peer at all (another platform, or libc will not load), the frame's own `pane`
  (`$TMUX_PANE`, which the CLI adds) decides, provided a live pane has that id. The
  daemon logs once at start that it is binding this way. Any binding without the
  kernel is a claim. A claimed pid would be no better: it is just as forgeable and
  costs a walk. The pane id is the narrowest claim, one session, and it is
  checkable against the live pane list. Dropping every event instead would
  silently remove the feature on exactly the host nobody tested. When the kernel
  did name a peer and the walk finds no pane, the event is dropped. It never falls
  back to the claim.
- **The fallback is per host, never per connection** (M2 review, 2026-10-17). It used
  to apply whenever one connection's pid came back null, on any host — and macOS's
  `LOCAL_PEERPID` fails once the peer has closed (reproduced: 2 of 20 fast
  clients), so a sender that wrote its frame and exited at once reached the fallback
  on a host that names every other connection, and picked any pane it liked. Now the
  frame's `pane` is consulted only where `peerPidSupported()` says the host can name
  no peer at all; where it can, a connection the kernel named no pid for is answered
  `unbound`. A real session's CLI waits for its reply, so it is never that sender.
  The binding also rests on `socket.fd`, a field Bun leaves undocumented: an upgrade
  that dropped it would refuse every event. So the daemon probes at start
  (`peerBindingProblem`: a self-connect over a throwaway unix socket must yield an
  accepted fd and the kernel must name this process on it) and warns if it fails.
- **What this leaves (threat model).** A same-uid process can still move another
  session's scheduler state on its own machine. It can `tmux send-keys` into that
  pane and have the session report whatever it likes. It can also set
  `@seance-task` on its own pane to another task's id (pane options are same-uid
  writable). On a host with no peer pids at all, it can simply name the pane. Each of these needs
  what already controls that session outright (it can `kill-pane` it), and none
  reaches another machine. The leader also takes an event only for a task placed
  on the machine that sealed it (below). So the residual is one same-uid process
  mislabelling the state of a session on its own machine. Accepted: it is strictly
  less than the same-uid reach "It grants no authority…" already concedes.
- **A PR URL is kept only as `https:`** (`httpsUrl`, `shared/src/parse.ts`). It must
  parse, carry no credentials, and stay under 2 KiB. Anything else is dropped from
  the event, never echoed. The check runs before the URL can become an `href` in the
  PWA or text in a push, and the leader re-checks it in `parseSessionEvent`, then passes it to
  `Scheduler.onSession` (done detection: a session that ends with a PR is `awaiting-merge`). The daemon also
  records the checked URL in the launch ledger (`EndedTasks.notePr`, for a task launched here
  only), where `progress` carries it to a leader that missed the event.
- **Forwarded only for task sessions, at most one per session per 5 s.** An event
  for a pane with no task id goes nowhere; like every bound event, it still pokes the refresh. The first event in a
  window leaves at once. A burst after it folds into one trailing send, carrying the
  newest state and a PR URL seen earlier in the window. The daemon seals the event
  to `"scheduler"` (`sendToScheduler`). With no leader the relay drops it. On the
  leader's own machine nothing crosses the relay: `run-capabilities.ts` hands the event to
  `Leader.onSession` in process, while a term runs (Scheduler, "The leader", "Session
  events reach the term two ways"). A leader
  change loses nothing that matters, because `sessions` carries the same facts,
  below.
- **Rate limits are no longer reported** (retired 2026-10-20). From M2 the mod hooked
  `session.measure` and sent the status line's `rateLimits`, which the daemon kept per
  exclave as a `session` quota observation (`SessionQuota`, persisted to
  `session-quota.json` in `stateDir()` from 2026-10-17) and merged with the cache. It
  gave a reading only while a session ran, and the `/usage` refresh (Daemon, "Usage
  refresh") now keeps the cache itself fresh for every signed-in exclave, so the one
  source is Claude Code's own. A `session-quota.json` left by an older daemon is never
  read again and is left in place, not deleted; readers still parse a `session`
  observation from a daemon that predates the change (`QUOTA_SOURCES`). Rejected then,
  and still: wrapping each exclave's `statusLine.command` in `settings.json`, which
  rewrites the user's config in every exclave and reports only when the status line
  renders (docs/scheduler.md, Risks).
- **`sessions` carries `ended` and `ledgerSince`, the double-spawn backstop and its
  proof.** Suppose a spawn lands, its reply is lost, and the session ends inside the
  120 s reservation, with its `ended` event lost too. The TTL check would then find no
  session with the task id and route it again. So the daemon remembers task ids from
  two sources and reports in `SessionsResponse.ended` those no session in the same
  reply carries: `ended` events (in memory, 30 min, capped at 128), and every task it
  launched, from a **launch ledger** (`daemon/src/launch-ledger.ts`, added 2026-10-16).
  The ledger is a small file in `stateDir()` (`launched.json`: task id and launch time,
  never prompt text), written temp-fsync-rename and its directory synced (`writeDurable`, since
  2026-10-18: without that a power cut could bring back the file before the rename) **before**
  the spawn runs. On macOS `fsync` stops at the drive's cache (`F_FULLFSYNC`, which Node does not
  expose), so there it outlasts a crash, not every power cut. A spawn whose
  id cannot be recorded is refused `launch_error`, since launched unrecorded a lost reply
  could later read as proof it never ran. A spawn refused for any reason but
  `task_running` launched nothing and leaves the ledger again. A scheduler spawn
  (`client: "scheduler"`) for an id the ledger holds, with no launch of it in flight, is
  refused `task_launched` and audited, and nothing runs (added 2026-10-18, M3 review S1): a
  leader re-dispatches a task only on this ledger's proof that it never landed, so such a
  spawn comes from a record a relay rolled back (Threat model, item 4). One whose session
  still runs is answered `task_running` with its pane, as the spawn itself would. It survives restarts, so
  `ended` does too, and it is what makes `ledgerSince` a proof: from that time (this
  daemon's clock) every task launched here is in `sessions` or in `ended`, so a task in
  neither, reserved after it, never landed (_Scheduler_, "The library", "Reserve, then
  dispatch").
  Three rules keep that true. `ended` is reckoned against the reply's own `sessions`, not
  a second tmux read a session could end between — which also lists a tagged pane still
  on a startup dialog, which `sessions` does not, as ended: `done` is a wrong label, a
  re-dispatch would be a twin. A `sessions` reply to the scheduler waits for any launch
  in flight; two launches of one id in flight together (a duplicate dispatch) are counted
  per id, so the one that failed never retracts the one that ran, and a failed write
  never drops an id a concurrent record of it is about to write. Only the scheduler's
  reply waits: a spawn can run for a minute, and a PWA refresh or an MCP `get_sessions`
  queued behind one timed out at `OP_TIMEOUT_MS.sessions` (10 s) for fields it never
  reads. So the two fields and the wait go only to a request whose AAD-bound sealer is
  `scheduler` (`RelayClient` hands the handler `env.from`) or to the leader's in-process
  `createLocalOps`; every other caller, the local socket included, gets the list at once
  and neither field. Any PSK holder can seal `from: "scheduler"`, and all it buys is the
  wait and a list of task ids it could already read. And the
  ledger is bounded with `since` moving past each entry it drops: at most 128 entries
  (eviction comes only from this machine's own launches, while the task awaiting proof
  is one whose machine was away, so the count outlasts any absence and the reply stays a
  few KiB) and a week of age (a laptop shut for one). A fresh install starts `since` at
  the file's creation; a missing or corrupt file is a fresh one, never a crash. A fresh
  ledger's `since` is never earlier than the state directory's mtime: every write
  renames into it, so the mtime is at or after the last launch a lost ledger held, and a
  clock still behind at boot (no RTC, NTP not yet synced) would otherwise date the fresh
  ledger before launches it never saw — and prove them never landed. One
  ledger per file per process (`run.ts`), so a config reload's overlapping daemon cannot
  overwrite the other's launches. Not the `@seance-task` record, which "Task ids"
  rejected keeping in a file: that one must die with its pane; this is history, read only
  to say what ran. Old readers ignore both fields; a reply from an older daemon carries
  no `ledgerSince` and proves nothing.
  Since 2026-10-17 (M3 item 4b) the same file also keeps per-task **progress** for a
  worktree-mode launch that landed: the main clone's path, the worktree's path, the
  last-seen branch and tip, sticky `pushed`/`merged`, the `https:` PR URL (Scheduler,
  "Branch state"). Unlike the ids it is **not write-ahead**: noted after the fact,
  best-effort, a failed write costs the note and never throws into a launch, and memory
  keeps it for the next write. It is v1 plus an optional top-level `progress` array, so
  `v` is still 1 and `tasks` are still `[id, at]` pairs. A daemon from before this reads
  `since` and `tasks` unchanged and ignores `progress` (a downgrade keeps the proof); its
  next write drops it. A malformed `progress` entry is skipped on load and never makes
  the file "corrupt, start afresh", which would reset `since` — the one thing a bad note
  must not do. Notes live and die with their launch, so the 128-entry and 7-day bounds
  bound progress too. Paths and branch names carry the spawn's slug (the title, or the
  first 40 characters of the prompt, slugified), as the worktree directory and window name
  already do and as `SpawnResponse.path` already reports; the prompt itself never reaches
  the file, which is 0600 in the state dir.

Untested by hand: the macOS peer-pid call itself (documented constant; CI's macOS
leg covers it) and a real Claude Code session driving the mod end to end. The mod's
own tests drive its hooks through `claude plugin test`, and the daemon suite drives
the binding with real panes.

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

Function-hook plugins ("mods") for the Claude Code sessions séance spawns. Two
today: **tmux-rename**, which keeps a `/rename` tagged and renames the session's
tmux window to the untagged name; and **session-events** (scheduler M2), which
reports the session's state and the PR it opened to the local
daemon. Its design is under Local op socket, "Session events". The bullets below
are tmux-rename's, except where they say mods.

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
  A directory marketplace's plugins are read in place: Claude also records a copy
  under `plugins/cache/<marketplace>/<mod>/<version>` and names it `installPath`, but
  loads the folder (`readFromFolder` in `claude plugin list --json`; checked on
  2.1.308, where `claude plugin update` on one says "read from its folder: nothing to
  update"), so the copy goes stale harmlessly. A mod's version still moves with its
  behaviour, so `list`'s `folderVersion` says which one a machine runs. So unlike the Raycast
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
- **Per exclave**: plugins live per config dir (`<configDir>/plugins/`, enabled in
  that dir's `settings.json`), so `mod install`, `mod uninstall` and doctor's mod
  lines run once per exclave over the same targets as `mcp install`
  (`userScopeTargets`): each Claude invocation gets the target's
  `CLAUDE_CONFIG_DIR` (unset for `default`), a dir never set up is skipped rather
  than created, and every line names the exclave. Serialized, since each call
  rewrites its dir's settings file; a failing exclave doesn't stop the rest, and
  the run fails with all of them listed. Rejected: the invoking shell's config dir
  only — what it did first, which left every named exclave without
  session-events, so their sessions sent the leader no events and no rate limits.
- **Tested by `claude plugin test`, not `bun:test`** — the one exception to the
  runner rule: a mod's tests import `claude-code/testing`, which only Claude
  Code provides. `scripts/test.ts` runs each mod as a shard of its own —
  `claude plugin test` takes one folder and silently ignores any after it, which
  once left session-events' tests unrun behind tmux-rename's — (the summary
  format matches bun's), and skips those shards, visibly, where `claude` isn't on
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
- Relay tracing (`observability.traces`) and invocation logs are **off**
  (2026-10-19, M3 review S7; threat-model item 3): every frame is an invocation,
  so both kept the per-frame timeline the console refuses. The cost is the
  retroactive view: an incident that happened while traces were off cannot be
  replayed, only the next one caught by turning them on for a deploy. Still
  **no OTLP destination**: Cloudflare can export traces and correlated logs to
  Honeycomb, Grafana or Sentry, which would move that timeline off Cloudflare,
  and the app still authenticates with `?t=<bearer>` (a browser cannot set a
  header on a WebSocket). `redact_query_string` keeps the token out of the URLs
  Cloudflare stores; an export would rest on that one flag.
- True distributed tracing across daemon→relay→pwa is not available and was not
  faked. Trace context rides `traceparent` on an HTTP request, but both tiers
  hold one long-lived WebSocket whose only header exchange is the upgrade; every
  frame after it is a separate hibernation-wake invocation with its own trace.
  Cloudflare's external W3C context propagation is unreleased. `iv`-keyed logs
  cover the cross-tier question traces could not answer.
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
