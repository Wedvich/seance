# Leaving with a reason — spec

**Status: spec, nothing built.** Drafted 2026-11-11 from field evidence gathered on 2026-11-10 on
all three platforms (below). Like docs/scheduler.md, this file is the working record until the
code lands; each part folds into DESIGN.md (Presence & identity, Wire protocol, Self-update,
Session events) as it is built, and its text here goes.

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

## Evidence (2026-11-10)

[V] verified, [I] inferred.

| Platform                      | Supervisor                          | What arrives                                                                                                                                                                                                                                                                                                                           | Budget                                                                   |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| WSL (Ubuntu)                  | systemd **user** unit, `Linger=yes` | [V] Orderly: WSL runs `systemctl poweroff` in the distro, SIGTERM, then `reboot(RB_POWER_OFF)` 10 s later. Network up through it (resolved stops ~1 s after SIGTERM). Cause (a WSL MSI update, a host-side terminate) is not visible inside Linux; Windows logged the MSI start 51 s before.                                           | **10 s**, hard                                                           |
| Thad (Debian 13, Proxmox LXC) | systemd **system** unit             | [V] 32/35 SIGTERMs restarts. [I] Host-driven container stops bypass logind, so `PrepareForShutdown` won't fire; `systemctl is-system-running` = `stopping` and `systemctl list-jobs` (a reboot/poweroff/halt target) do work. logind is readable unprivileged. No `After=network-online.target`: 23 s of failed connects at one start. | 90 s (`TimeoutStopSec`)                                                  |
| macOS                         | launchd agent                       | [V] SIGTERM at reboot with the socket live. Shutdown, logout, `bootout` and self-update look identical from inside. **Sleep sends no signal**: the process freezes, nothing is logged at entry. powerd logs the reason (`Clamshell Sleep`, `Idle Sleep`, `Maintenance Sleep`); `pmset -g log` has it afterwards.                       | 5 s reported by launchd (separate fix in flight: `launchd-exit-timeout`) |

Probe [V]: in Bun on loopback, `send()` then `exit` inside a SIGTERM handler delivered the frame 3/3.
TLS to Cloudflare is untested, so the spec waits for the flush rather than trusting it.

## Decisions

### 1. The frame: `leaving`, sealed, sent first

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
| `d`   | string, ≤ 40 bytes                      | Optional detail: the target short sha for `update`, the powerd class for `sleep`                                      |
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
  1. close the launch gate (as `drain()` does today, synchronously);
  2. decide the reason (§2) — hint file and self-knowledge are synchronous; the Linux probe is
     capped at 300 ms;
  3. seal and send `leaving`; wait for `bufferedAmount` to reach 0, capped at 200 ms;
  4. on `shutdown`/`reboot`, note the doomed launches in the ledger (§4);
  5. drain, with the reason-aware cap (§6);
  6. `close(1001)` and wait for the close event, capped at 500 ms; exit.

  One frame, not `unknown` at once then a refinement: the probe costs at most 300 ms of a 10 s
  budget, and one frame keeps the relay's rule at one per socket.

### 2. Reason vocabulary, and who knows which

```ts
export const LEAVING_REASONS = ["update", "restart", "stop", "reboot", "shutdown", "sleep", "unknown"] as const;
```

| Reason     | Means                                                                                            | Sessions survive?                                   | Who knows it                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `update`   | Self-update restart; `d` = target short sha                                                      | Yes (`KillMode=process`, launchd leaves tmux alone) | The daemon itself (`src: "self"`): the updater sets the process's pending reason before `selfRestart` |
| `restart`  | `seanced restart`, a `seanced install` re-install                                                | Yes                                                 | Hint file (`src: "hint"`), written by the CLI before it signals                                       |
| `stop`     | Service stopped on purpose: `seanced uninstall`, `systemctl stop`, a user manager stopping alone | Yes                                                 | Hint file for our own commands; Linux probe for a user manager stopping while the system runs         |
| `reboot`   | The OS is rebooting                                                                              | No                                                  | Linux probe; macOS post-hoc only (§5)                                                                 |
| `shutdown` | The OS (or WSL, or the LXC host) is powering off                                                 | No                                                  | Linux probe                                                                                           |
| `sleep`    | About to sleep                                                                                   | Frozen, then yes                                    | Phase 2 only: a pre-sleep hook on macOS (§5)                                                          |
| `unknown`  | SIGTERM with no evidence: every macOS SIGTERM a hint does not explain                            | Unknown                                             | —                                                                                                     |

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
- **macOS SIGTERM is `unknown`** unless a hint or the updater explains it. Since restarts are the
  bulk of SIGTERMs, that already names most of them; reboot and shutdown are named after the fact
  (§5).

### 3. Relay: stored like `status`, shown until the next register

- **Live**: the hub keeps the envelope on the socket's attachment (`leaving`), forwards it to every
  open app as `leaving { deviceId, envelope }`, and includes it in the `registry` push. A socket
  with a note is **no nomination candidate**: the hub runs `#renominate` excluding it on receipt, so
  a leader's term moves when it starts leaving instead of after its drain. It stays a route, so the
  drain's replies still reach their leader.
- **Kept**: `#leftBy` keeps it in the entry (`RegistryEntry.leaving?: Envelope`) with the
  `lastSeen` put it already makes, exactly as it keeps `status`; a superseded socket writes nothing,
  as today. A `register` clears it, on the same socket or a new one: a register is "I am here", so a
  daemon that changed its mind (sleep vetoed, a restart that failed) retracts the note by
  re-registering, and no retraction frame is needed.
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
| not connected, `update`/`restart`, under 3 min    | "Restarting: update" / "Restarting"                        |
| not connected, `update`/`restart`, 3 min or more  | "Restarting: update — not back after 7 min" (warning tone) |
| not connected, `stop`/`reboot`/`shutdown`/`sleep` | "Asleep: rebooted 3 h ago", "Asleep: shut down", …         |
| not connected, `unknown`                          | "Asleep: stopped 2 h ago" (no cause claimed)               |
| not connected, no note                            | as today ("last seen")                                     |

A connected socket whose note is past 30 s (longer than any drain cap plus close) renders as
online: the daemon is still there, whatever it said. Copy is the PWA's to settle; the rule that
matters is that `src: "none"` never claims a cause (Decision heuristic 3).

**The leader** reads the note through its registry view, as it reads `drn`:

- routing rejects a machine with a live note (`leaving`, beside `draining`) — `drn` is rate-floored
  and may not have landed before the socket closes;
- `shutdown`/`reboot`/`stop`/`sleep`/`unknown`: the machine's tasks release their slots at once
  instead of after `slotReleaseAfterMs`; `update`/`restart` keep them, since those sessions survive
  and the daemon is back in seconds.

**Tasks interrupted by the machine** get their own outcome instead of `session_closed`:

- At SIGTERM with `shutdown`/`reboot`, the daemon notes every live launch in the launch ledger as
  `stoppedBy: <reason>` (one durable write, before the drain) — its tmux server dies with the box.
- **Post-hoc, for every platform**: the daemon persists its last note with the kernel boot id
  (`/proc/sys/kernel/random/boot_id`; `sysctl kern.bootsessionuuid` on macOS) in `state.json`. At
  start, if the boot id changed, launches harvest finds `vanished` get `stoppedBy`: the note's
  reason when it was `reboot`/`shutdown`/`unknown` (macOS's `unknown` then reads `reboot`), and
  `unclean` when no note was written (power loss, panic, WSL's forced kill). This is what names the
  macOS cases a SIGTERM cannot.
- `TaskProgress.stoppedBy` is additive and only beside `vanished`; a leader that knows it settles
  `machine_stopped` (a new `TASK_FAILURE_CODES` entry, dependents fail as for `session_closed`), and
  the PWA headlines "Interrupted: Thad rebooted" with Continue. An older leader ignores the field
  and settles `session_closed`, as today.

### 5. macOS sleep and DarkWake

**Phase 1: post-hoc.** No new binary. On wake (wall clock jumped past the monotonic clock by more
than a beat), the daemon reads the latest Sleep/Wake entries from `pmset -g log`, off the hot path
and capped, and puts `lastAbsence { k: "sleep", from, to, d: "Clamshell Sleep" }` in the register
blob (`machine-info`). The app shows "Back from sleep (lid closed, 47 min)". While asleep, the
machine reads as today: swept, no note.

**Phase 2: a pre-sleep note, via Bun FFI first.** `kIOMessageSystemWillSleep` is the only true
pre-sleep hook, and it can delay sleep until acknowledged. First spike: `bun:ffi` `dlopen` of
IOKit, `IORegisterForSystemPower` with the notification port on a dispatch queue and a
`threadsafe` `JSCallback`, which sends `leaving { r: "sleep" }` and then calls `IOAllowPowerChange`.
`kIOMessageSystemHasPoweredOn` then re-registers, retracting it. Rejected for now: a native Swift
or C helper. `swiftc` is not on every Mac, and a prebuilt binary is the first artifact in a repo
that updates by `git pull` with no build step (signing, arch, provenance all follow). Revisit only
if FFI fails.

**DarkWake: a maintenance state, not suppression.** During a suspected DarkWake the daemon still
connects (an update or a `sessions` request can land), but registers with no `lead` role and sends
`status` with `dw: true`. The relay then cannot nominate it, which ends the term churn, and routing
rejects it (`dark_wake`) like `draining`. The app shows "Asleep (maintenance wake)", not online.
Rejected: suppressing the register while the lid is closed. A clamshell Mac on an external display
is a real desk machine, and a daemon that never dials misses updates for good.

### 6. The drain shrinks when the box is going down

`SHUTDOWN_DRAIN_MS` stays 15 s for `update`/`restart`/`stop`/`unknown`, where sessions survive and
a finishing spawn's reply is worth waiting for. For `shutdown`/`reboot` the cap drops to
`SHUTDOWN_DRAIN_DOOMED_MS` (4 s): the session being launched dies with the box anyway, and the
whole handler (300 ms probe, 200 ms flush, ledger notes, drain, 500 ms close) must fit inside WSL's
10 s with room to spare. Not shrunk across the board: Thad's restarts are most SIGTERMs and have 90 s.
launchd's 5 s is the `launchd-exit-timeout` fix's to solve, not this spec's.

### 7. Unit file: wait for the network (system scope)

A **system** unit gains `Wants=network-online.target` and `After=network-online.target`
(`unitContent` in `daemon/src/systemd.ts`). Two wins: start waits for the network (Thad's 23 s of
failed connects), and since systemd stops units in reverse order, the network stays up until
seanced has exited, so the `leaving` frame is not racing the interface. A **user** unit cannot
order against a system target (the user manager does not see it), so it keeps the dial backoff; on
WSL the network outlived SIGTERM anyway. The unit change ships through `selfRestart`'s rewrite;
docs/platform-notes.md's service-definition lag applies to the first wave.

### 8. Skew

| Combination           | Behaviour                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| New daemon, old relay | Old relay drops the frame as `malformed-daemon-frame` and logs one line; nothing else changes. No gate.      |
| Old daemon, new relay | No note; the relay behaves as today.                                                                         |
| New relay, old app    | `RegistryView.leaving` and the `leaving` app frame are unknown; the older parser ignores the field (verify). |
| Old leader            | Ignores notes, `dw` and `stoppedBy`; routes and settles as today.                                            |

Deploy order: relay, then app, then daemons. No capability flag: the note is daemon→app data,
nothing asks a daemon for it.

### 9. Phase 2 / out of scope

- **A Windows-side watcher for WSL updates.** Windows knew 51 s ahead (the MsiInstaller event).
  A sibling of the logon pin task (docs/platform-notes.md) could watch for the WSL MSI and run
  `wsl.exe -d <distro> --exec seanced leaving-hint wsl-update`, writing the hint file with a
  5-minute TTL, so the SIGTERM probe's `shutdown` gets `d: "wsl-update"`. Out of scope for phase 1:
  a new Windows-resident component for one detail string.
- **Linux sleep** (logind `PrepareForSleep`): no Linux laptop in the fleet sleeps today.

## Open questions

1. **macOS shutdown at SIGTERM.** Is there a probe cheap enough for a 5 s budget that tells
   shutdown/logout from `bootout`? Until one turns up, macOS says `unknown` live and `reboot`
   post-hoc.
2. **FFI feasibility.** Does a `threadsafe` `JSCallback` survive the run loop IOKit needs, and does
   Bun's event loop get to send the frame before `IOAllowPowerChange` lets the machine sleep? Spike
   before committing to phase 2.
3. **DarkWake detection.** Which signal is reliable and cheap: clamshell state
   (`ioreg -k AppleClamshellState`) combined with display power state, `pmset -g assertions`, or the
   powerd wake reason? It must not misread a clamshell Mac on an external display.
4. **Renominating on `leaving`.** A leader mid-pass loses its term while its drain runs; its
   term-fenced writes then fail on `holdsTerm`, which is the existing fence, but its in-process
   dispatch to itself should also stop at SIGTERM. Confirm nothing else assumes the term outlives
   the socket.
5. **TLS flush.** Is `bufferedAmount` reaching 0 in Bun a meaningful signal over TLS to Cloudflare,
   or should the handler just wait 200 ms? Measure on WSL before choosing.
6. **`machine_stopped` as a failure.** Should a task interrupted by `reboot`/`update` be
   auto-continued when its machine returns, rather than failing to the user? Out of this spec, but
   the outcome code should not foreclose it.
7. **The Windows watcher**: worth building at all, given the evidence is two WSL power-offs?
