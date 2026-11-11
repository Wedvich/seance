# Leaving with a reason — spec

**Status: spec, nothing built.** Drafted 2026-11-11 from field evidence gathered on 2026-11-10 on
all three platforms, and macOS spikes run on 2026-11-11 (below). Like docs/scheduler.md, this file
is the working record until the code lands; each part folds into DESIGN.md (Presence & identity,
Wire protocol, Self-update, Session events) as it is built, and its text here goes.

## Problem

A daemon that goes away tells the relay nothing. On SIGTERM `daemon/src/shutdown.ts` drains task
launches for up to `SHUTDOWN_DRAIN_MS` (15 s) with the socket up, then `relay-client.ts` `stop()`
closes the WebSocket with no code or reason and exits. The hub's `webSocketClose` runs
`#onSocketGone`, `#leftBy` stamps `lastSeen` and keeps the last `status`, and every client shows
the same thing for an update restart, a reboot, a lid close and a power cut: a machine that was
there and is not. Where the socket does not close at all (sleep, power loss, a frozen container),
the sweep takes it after 90 s.

What that costs, from the evidence:

- **Restarts dominate.** Of 35 SIGTERMs in Thad's log, 32 were restarts (self-update,
  `seanced restart`), 3 shutdowns. Each reads as an outage in the app for its few seconds.
- **Tasks die unexplained.** Two orderly WSL power-offs lost three task windows; each settled
  `session_closed` ("vanished"), indistinguishable from a window someone closed by hand.
- **macOS DarkWake flaps.** A lid-closed Mac DarkWakes every 14–18 min; inside a 45 s DarkWake
  seanced reconnects and reads online for ~30 s, which churns the scheduler term.

Scope: a reason the daemon _knows or can cheaply find out_, delivered sealed, shown by every
app-role client, and used by the leader. **Not** in scope: replacing the sweep. Power loss, a
panic, an OOM kill of the daemon, WSL's forced power-off after its 10 s, a frozen LXC and a network
already gone fire no hook anywhere; silence stays the default, and a `leaving` note only refines
it.

## Evidence

[V] verified, [I] inferred. Linux and WSL from logs on 2026-11-10; macOS from logs and spikes on
an M4 Pro MacBook Pro (macOS 26.6.2, Bun 1.4.4) on 2026-11-11.

| Platform                      | Supervisor                          | What arrives                                                                                                                                                                                                                                                                                                                           | Budget                                                  |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| WSL (Ubuntu)                  | systemd **user** unit, `Linger=yes` | [V] Orderly: WSL runs `systemctl poweroff` in the distro, SIGTERM, then `reboot(RB_POWER_OFF)` 10 s later. Network up through it (resolved stops ~1 s after SIGTERM). Cause (a WSL MSI update, a host-side terminate) is not visible inside Linux; Windows logged the MSI start 51 s before.                                           | **10 s**, hard                                          |
| Thad (Debian 13, Proxmox LXC) | systemd **system** unit             | [V] 32/35 SIGTERMs restarts. [I] Host-driven container stops bypass logind, so `PrepareForShutdown` won't fire; `systemctl is-system-running` = `stopping` and `systemctl list-jobs` (a reboot/poweroff/halt target) do work. logind is readable unprivileged. No `After=network-online.target`: 23 s of failed connects at one start. | 90 s (`TimeoutStopSec`)                                 |
| macOS                         | launchd agent                       | [V] SIGTERM at reboot with the socket live. Nothing in `launchctl print` tells shutdown from `bootout`, but loginwindow's notify(3) names do (§2). **Sleep sends no signal**; IOKit's pre-sleep notification does, and works from Bun FFI (§5). powerd logs the sleep reason; `pmset -g log` has it afterwards (~690 ms to read).      | 30 s (`exit timeout = 30`); system shutdown allows 71 s |

**Delivery to the real relay** (macOS → Cloudflare over wss, a SIGTERM 0.3 s after open, one frame,
counted in `wrangler tail`) [V]:

| After `send()`                                 | Delivered |
| ---------------------------------------------- | --------- |
| exit at once                                   | 12/15     |
| wait for `bufferedAmount` 0 (200 ms cap), exit | 3/5       |
| fixed 200 ms wait, exit                        | 14/15     |
| `close(1001)`, await the close event (500 ms)  | 15/15     |

Bun reports `bufferedAmount` 0 straight after `send()` on an open socket, so it says nothing about
delivery. The close handshake is the only proof: close-ack p50 ~30 ms, max 121 ms. (On loopback,
send-then-exit delivered 3/3; loopback is not the path that matters.)

## Decisions

### 1. The frame: `leaving`, sealed, sent first, proven by the close

A new daemon→relay frame, beside `status`:

```ts
| { readonly t: "leaving"; readonly env: Envelope } // op "leaving", from deviceId, to APP_ID
```

The envelope seals a `LeavingNote` (`shared/src/types.ts`), short keys like `MachineStatus`:

| Key   | Type                                    | Meaning                                                                                                               |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `r`   | `LeavingReason`                         | The reason (vocabulary below)                                                                                         |
| `src` | `"self" \| "hint" \| "probe" \| "none"` | How the daemon knows: its own decision, a hint another seanced process left, an OS probe, or nothing (`r: "unknown"`) |
| `at`  | unix ms                                 | When the daemon decided to leave                                                                                      |
| `d`   | string, ≤ 40 bytes                      | Optional detail: the target short sha for `update`, `os-update`, `logout`, the powerd class for `sleep`               |
| `_`   | spaces                                  | Padding, as `status`: every note seals to one `ct` length (`LEAVING_CT_LENGTH`, 512)                                  |

- **Sealed, not plaintext, and not the close frame.** The relay is blind; which machines update,
  reboot or sleep when is an activity timeline beyond the connect/disconnect times it already sees
  (the same reason plaintext status numbers were rejected). The relay learns one bit it would learn
  a few seconds later anyway: this socket is going cleanly. The WebSocket close code/reason was
  rejected for both halves: its reason text is plaintext to the relay, and it goes out _after_ the
  drain, which WSL's 10 s does not wait for.
- **Opened like `status`**: an at-rest blob, no replay guard (the registry re-sends it), through
  `openAtRest` with slot op `leaving` (threat-model invariant), bound to its `deviceId` by the AAD
  `from`. Parser in `shared/src/leaving-reader.ts`; an unknown `r` reads as `unknown`, never as a
  refusal, so a newer daemon's reason degrades on an older app.
- **One per socket.** The relay accepts the first `leaving` a registered, non-superseded socket
  sends and drops the rest (`leaving-repeat`). A daemon that changes its mind re-registers (below).
- **Sent first.** The shutdown handler's order becomes:
  1. close the launch gate (as `drain()` does today, synchronously), and if this daemon leads,
     end its term through the existing resign path, so no scheduler pass starts after SIGTERM;
  2. decide the reason (§2): hint file, self-knowledge and macOS's `notify_check` are synchronous;
     the Linux probe is capped at 300 ms;
  3. seal and send `leaving` at once. No wait: `bufferedAmount` proves nothing (Evidence);
  4. on `shutdown`/`reboot`, note the doomed launches in the ledger (§4);
  5. drain, with the reason-aware cap (§6);
  6. `close(1001)` and await the close event, capped at 500 ms; exit. **Mandatory**: the close-ack
     is what proves the note (and everything before it) reached the relay.

  One frame, not `unknown` at once then a refinement: the probe costs at most 300 ms of a 10 s
  budget, and one frame keeps the relay's rule at one per socket. Accepted: a hard kill during the
  drain may lose the note (send-then-exit lost ~1 in 5 over TLS). The drain caps (§6) keep each
  platform's handler inside its budget, so that takes a kill outside the budget. Rejected: a relay
  ack frame for `leaving` — a new relay→daemon frame to prove what the close already proves, and
  the daemon could do nothing with a missing ack but wait.

### 2. Reason vocabulary, and who knows which

```ts
export const LEAVING_REASONS = ["update", "restart", "stop", "reboot", "shutdown", "sleep", "unknown"] as const;
```

| Reason     | Means                                                                                                      | Sessions survive?                                   | Who knows it                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `update`   | Self-update restart; `d` = target short sha                                                                | Yes (`KillMode=process`, launchd leaves tmux alone) | The daemon itself (`src: "self"`): the updater sets the process's pending reason before `selfRestart` |
| `restart`  | `seanced restart`, a `seanced install` re-install                                                          | Yes                                                 | Hint file (`src: "hint"`), written by the CLI before it signals                                       |
| `stop`     | Service stopped on purpose: `seanced uninstall`, `systemctl stop`, a user manager stopping alone, a logout | Yes, except a macOS logout                          | Hint file for our own commands; Linux probe; macOS notify (`d: "logout"`)                             |
| `reboot`   | The OS is rebooting; `d: "os-update"` for a macOS install restart                                          | No                                                  | Linux probe; macOS notify                                                                             |
| `shutdown` | The OS (or WSL, or the LXC host) is powering off                                                           | No                                                  | Linux probe; macOS notify                                                                             |
| `sleep`    | About to sleep                                                                                             | Frozen, then yes                                    | macOS: IOKit `kIOMessageSystemWillSleep` (§5)                                                         |
| `unknown`  | SIGTERM with no evidence: a macOS `bootout`, a stray `kill`                                                | Unknown                                             | —                                                                                                     |

- **Hint file**: `stateDir()/run/leaving-hint` (the 0700 directory the local op socket already
  relies on), JSON `{ r, pid, at }`, written 0600 by `seanced restart` / `install` / `uninstall`
  just before they signal. The daemon reads and deletes it at SIGTERM and honours it only when `pid`
  is its own and `at` is under 60 s old. Not a local-socket op: widening that allowlist is a
  threat-model change, and a file a same-user process can already write buys nothing a socket op
  would not.
- **Linux probe**, run in parallel, 300 ms cap, argv-array exec:
  `systemctl is-system-running` → `stopping` means the system is going down; then
  `systemctl list-jobs --no-legend --plain` names `reboot.target`/`kexec.target` (→ `reboot`) or
  `poweroff.target`/`halt.target` (→ `shutdown`; `stopping` with neither is `shutdown`). Under a
  user unit, `systemctl --user is-system-running` = `stopping` while the system is `running` →
  `stop`. Covers WSL (its `systemctl poweroff`) and a Proxmox host stop alike, neither of which
  needs logind. Rejected: a long-lived logind subscription (`PrepareForShutdownWithMetadata`):
  a resident child, and it misses the LXC path the probe catches.
- **macOS: loginwindow's notify(3) names, read through `bun:ffi` against libSystem.** At daemon
  start, `notify_register_check` once per name, discarding the first `notify_check` (it always
  reads 1); at SIGTERM, `notify_check` each token (32 µs [V], no child, no run loop):

  | Name                                             | Reason                       |
  | ------------------------------------------------ | ---------------------------- |
  | `com.apple.system.loginwindow.restartinitiated`  | `reboot`                     |
  | `com.apple.system.install.restartinitiated`      | `reboot`, `d: "os-update"`   |
  | `com.apple.system.loginwindow.shutdownInitiated` | `shutdown`                   |
  | `com.apple.system.install.shutdowninitiated`     | `shutdown`, `d: "os-update"` |
  | `com.apple.system.loginwindow.logoutInitiated`   | `stop`, `d: "logout"`        |
  | `com.apple.system.loginwindow.logoutcancelled`   | clears a pending logout      |

  loginwindow holds these names [V]; that it posts them before launchd SIGTERMs agents is [I], so
  one real restart, shutdown and logout must confirm it before this ships. `com.apple.system.*`
  names cannot be posted by a non-root user, so a same-user process cannot fake a reboot this way.
  The plain `com.apple.shutdownInitiated` family are distributed notifications that need a run loop:
  rejected. No flag → `unknown`, unless a hint or the updater explains the SIGTERM.

### 3. Relay: stored like `status`, shown until the next register

- **Live**: the hub keeps the envelope on the socket's attachment (`leaving`), forwards it to every
  open app as `leaving { deviceId, envelope }`, and includes it in the `registry` push. A socket
  with a note is **no nomination candidate**: the hub runs `#renominate` excluding it on receipt.
  The term runs on the leader's own app-role leg, renominating sends the old leader `follow`, and
  late writes fail on the term fence (`StoreRevoked` → demote); nothing assumes the term outlives
  the daemon socket [I, from code]. The leader has resigned locally by then anyway (§1 step 1). The
  socket stays a route, so the drain's replies still reach their leader.
- **Kept**: `#leftBy` keeps it in the entry (`RegistryEntry.leaving?: Envelope`) with the
  `lastSeen` put it already makes, exactly as it keeps `status`; a superseded socket writes nothing,
  as today. A `register` clears it, on the same socket or a new one: a register is "I am here", so a
  daemon that changed its mind (sleep that became a DarkWake, a restart that failed) retracts the
  note by re-registering, and no retraction frame is needed.
- **No relay TTL.** The note holds until the next register, however long. Freshness is the
  consumer's call, as with `status`: the note carries `at`, the app renders its age.
- **The sweep is unchanged and still wins on silence.** A socket that sent `leaving` and then went
  silent (WSL's forced power-off cut the close) is swept at 90 s like any other; the sweep's
  `#leftBy` keeps the note, so the app still says why.
- Bounded at `LEAVING_CT_LENGTH` in `relay/src/wire.ts`; accepted only from a registered socket
  whose envelope names it `from` and the app `to` (`from-mismatch`, `leaving-not-app`, as for
  `status`). No log line per accepted note, only refusals. `relay/test/layering.test.ts` keeps it
  blind.

### 4. Clients and the leader

**Display** (PWA, Raycast, `list_machines`), from the client's own `connected` plus the note:

| State                                             | Shown                                                      |
| ------------------------------------------------- | ---------------------------------------------------------- |
| connected, note present, note under 30 s old      | "Leaving: update" (draining)                               |
| connected, `dw: true` in status                   | "Asleep (maintenance wake)"                                |
| not connected, `update`/`restart`, under 3 min    | "Restarting: update" / "Restarting"                        |
| not connected, `update`/`restart`, 3 min or more  | "Restarting: update — not back after 7 min" (warning tone) |
| not connected, `stop`/`reboot`/`shutdown`/`sleep` | "Asleep: rebooted 3 h ago", "Asleep: shut down", …         |
| not connected, `unknown`                          | "Asleep: stopped 2 h ago" (no cause claimed)               |
| not connected, no note                            | as today ("last seen")                                     |

A connected socket whose note is past 30 s (longer than any drain cap plus close) renders as
online: the daemon is still there, whatever it said. Copy is the PWA's to settle; the rule that
matters is that `src: "none"` never claims a cause (Decision heuristic 3).

**The leader** reads the note through its registry view, as it reads `drn`:

- routing rejects a machine with a live note (`leaving`, beside `draining`), its own machine
  included — `drn` is rate-floored and may not have landed before the socket closes. A task the
  leader reserved to itself in the window before it resigned meets the closed gate, answers
  `internal_error`, and waits out its reservation TTL as today [V, from code];
- `shutdown`/`reboot`/`stop`/`sleep`/`unknown`: the machine's tasks release their slots at once
  instead of after `slotReleaseAfterMs`; `update`/`restart` keep them, since those sessions survive
  and the daemon is back in seconds.

**Tasks interrupted by the machine** get their own outcome instead of `session_closed`:

- At SIGTERM with `shutdown`/`reboot`, the daemon notes every live launch in the launch ledger as
  `stoppedBy: <reason>` (one durable write, before the drain) — its tmux server dies with the box.
- **Post-hoc, for every platform**: the daemon persists its last note with the kernel boot id
  (`/proc/sys/kernel/random/boot_id`; `sysctl kern.bootsessionuuid` on macOS, 6 ms [V]) in
  `state.json`. At start, if the boot id changed, launches harvest finds `vanished` get
  `stoppedBy`: the note's reason when it was `reboot`/`shutdown`/`unknown` (an `unknown` then reads
  `reboot`), and `unclean` when no note was written (power loss, panic, WSL's forced kill).
- `TaskProgress.stoppedBy` is additive and only beside `vanished`. A leader that knows it settles
  the task **interrupted, not failed**: its dependents wait rather than fail, and the PWA headlines
  "Interrupted: Thad rebooted" with Continue. Only `reboot`/`shutdown`/`unclean` get here:
  `update`/`restart` never stop sessions. Auto-continue is opt-in per task and bounded (the machine
  back within, say, 30 min): a long-gone machine's context goes stale, and half-done side effects
  (a push, a PR) make a blind resume risky. Whether "interrupted" is a new task state or a failure
  code that does not cascade is open (question 4). An older leader ignores the field and settles
  `session_closed`, as today.

### 5. macOS sleep and DarkWake

One FFI module (`daemon/src/darwin-power.ts`, macOS only, a no-op elsewhere like `power.ts`)
carries the notify tokens (§2), the IOKit sleep hook and the capability read below. `bun:ffi`
`dlopen` of libSystem and IOKit, no new binary: the spikes made a native helper unnecessary, and it
stays rejected (`swiftc` is not on every Mac, and a prebuilt binary would be the first artifact in
a repo that updates by `git pull` with no build step).

**The pre-sleep note** [V, two `pmset sleepnow` runs]. `IORegisterForSystemPower`, its
notification port on a `dispatch_queue_create` queue (`IONotificationPortSetDispatchQueue`), and a
`threadsafe: true` `JSCallback`. On `kIOMessageSystemWillSleep` the daemon:

1. sends `leaving { r: "sleep" }` on its live socket;
2. `close(1001)` and awaits the close event, capped at 500 ms;
3. calls `IOAllowPowerChange`. Sleep waits for the ack (up to its 30 s timeout), so the note is out
   before the NIC goes down by construction. In the spike the relay logged the frame both times,
   with the close-ack 163–404 ms after the callback (fresh socket and TLS each time).

On `kIOMessageSystemHasPoweredOn` the daemon redials and registers, retracting the note.

**On AC a sleep is often not a sleep** [V]. seanced's own `caffeinate -is` (`power.ts`) turns a
user sleep into `Entering DarkWake state due to 'Software Sleep'`: display off, processes running,
the socket up. `WillSleep` still fires. So the daemon does not trust its own note: if it is still
running a few seconds after the ack, it redials in the maintenance state below, which retracts the
note and shows "Asleep (maintenance wake)" rather than a display-off Mac as online.

**DarkWake is read from IOPMrootDomain's `System Capabilities`, not the lid** [V].
CPU 1 | Graphics 2 | Audio 4 | Network 8: 15 in full wake, 9 within ~0.6 s of entering DarkWake,
with `AppleClamshellState` unchanged throughout; `pmset -g log` agrees over a night of lid-closed
DarkWakes (`[CDNP]` vs full wake `[CDNVA]`). **DarkWake ⇔ `(caps & 2) == 0`.** A closed-lid Mac on
an external display has graphics in full wake, so it reads 15 [I, not yet seen in a log]. Read
through FFI (`IORegistryEntryCreateCFProperty`, µs; `ioreg` is ~17 ms) on reconnect after a
wall-clock jump, on `HasPoweredOn`, and every few seconds while in the maintenance state, to leave
it on full wake. Whether `HasPoweredOn` fires on a DarkWake is [I]; nothing relies on it.

**The maintenance state, not suppression.** In a DarkWake the daemon still connects (an update or a
`sessions` request can land), but registers with no `lead` role and sends `status` with `dw: true`.
The relay cannot nominate it, which ends the term churn, and routing rejects it (`dark_wake`) like
`draining`. Rejected: suppressing the register while the lid is closed. A clamshell Mac on an
external display is a real desk machine, and a daemon that never dials misses updates for good.

**Post-hoc report, as a fallback.** On wake (wall clock jumped past the monotonic clock by more than
a beat) with no note sent before it — the hook missed, or the machine slept with the daemon
frozen — the daemon reads the latest Sleep/Wake entries from `pmset -g log` (~690 ms, so never on a
SIGTERM path, capped and off the hot path) and puts `lastAbsence { k: "sleep", from, to, d }` in the
register blob (`machine-info`). The app shows "Back from sleep (lid closed, 47 min)".

### 6. The drain shrinks when the box is going down

`SHUTDOWN_DRAIN_MS` stays 15 s for `update`/`restart`/`stop`/`unknown`, where sessions survive and
a finishing spawn's reply is worth waiting for; it fits Thad's 90 s and launchd's 30 s. For
`shutdown`/`reboot` the cap drops to `SHUTDOWN_DRAIN_DOOMED_MS` (4 s): the session being launched
dies with the box anyway, and the whole handler (300 ms probe, ledger notes, drain, 500 ms close)
must fit inside WSL's 10 s with room to spare. Not shrunk across the board: restarts are most
SIGTERMs, and their sessions survive.

### 7. Unit file: wait for the network (system scope)

A **system** unit gains `Wants=network-online.target` and `After=network-online.target`
(`unitContent` in `daemon/src/systemd.ts`). Two wins: start waits for the network (Thad's 23 s of
failed connects), and since systemd stops units in reverse order, the network stays up until
seanced has exited, so the `leaving` frame and its close are not racing the interface. A **user**
unit cannot order against a system target (the user manager does not see it), so it keeps the dial
backoff; on WSL the network outlived SIGTERM anyway. The unit change ships through `selfRestart`'s
rewrite; docs/platform-notes.md's service-definition lag applies to the first wave.

### 8. Skew

| Combination           | Behaviour                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| New daemon, old relay | Old relay drops the frame as `malformed-daemon-frame` and logs one line; nothing else changes. No gate.      |
| Old daemon, new relay | No note; the relay behaves as today.                                                                         |
| New relay, old app    | `RegistryView.leaving` and the `leaving` app frame are unknown; the older parser ignores the field (verify). |
| Old leader            | Ignores notes, `dw` and `stoppedBy`; routes and settles as today.                                            |

Deploy order: relay, then app, then daemons. No capability flag: the note is daemon→app data,
nothing asks a daemon for it.

### 9. Out of scope

- **A resident Windows-side watcher for WSL updates: rejected.** Windows knew 51 s ahead (the
  MsiInstaller event), but the Linux probe already says `shutdown`, and the watcher would add only
  a detail string at the cost of a new resident Windows component, on two observed events. If the
  detail is ever wanted, get it after the fact: at start after a boot-id change, the WSL daemon runs
  `powershell.exe Get-WinEvent` once for MsiInstaller events in the minutes before, and tags the
  kept `lastAbsence` `d: "wsl-update"`.
- **Linux sleep** (logind `PrepareForSleep`): no Linux laptop in the fleet sleeps today.

## Open questions

1. **notify(3) ordering.** Does loginwindow post its restart/shutdown/logout names before launchd
   SIGTERMs agents? Confirm with one real restart, shutdown and logout before shipping §2's macOS
   row; until then macOS says `unknown` live and `reboot` from the boot id.
2. **A true suspend on battery** (no assertions) is untested. The close-ack-before-allow order holds
   by construction, but one run should confirm the frame lands.
3. **Closed lid on an external display** should read capabilities 15. Confirm on a real clamshell
   setup before `dw` gates routing.
4. **"Interrupted": a task state or a non-cascading failure code?** A new state is a wider change
   (every leader and PWA parser, the Queue screen); a failure code that holds dependents bends the
   rule that a failure fails them. Settle with the scheduler owner.
5. **Are the 45 s `wifibt` DarkWakes caused by the relay itself?** They may be inbound relay traffic
   (status pushes, heartbeats) through the TCPKeepAlive offload. If so, the maintenance state treats
   the symptom; worth checking whether the daemon socket wakes the Mac.
