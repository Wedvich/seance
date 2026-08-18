# Platform notes

The rough edges of running `seanced` as a service, by platform, plus a one-time
catch-up for machines installed before certain fixes.

## Linux

On a fresh headless box the systemd user instance may not exist until linger is
enabled. If `seanced install`'s preflight says so, run it once and re-run `install`:

```sh
sudo loginctl enable-linger <user>
```

### System unit with a delivered credential (systemd ≥ 256)

Where the PSK lives in a TPM-sealed blob and systemd is ≥ 256, the daemon must run as
a **system** unit so PID 1 can unseal and deliver the key (`LoadCredentialEncrypted=`
— why in docs/psk.md). `seanced install --system` writes and enables it:

```sh
seanced uninstall                                   # if a user unit is installed
sudo --preserve-env=PATH seanced install --system   # or: sudo seanced install --system --path "$PATH"
```

`--preserve-env=PATH` is not decoration. Everything the unit records is written out
literally — a `User=` system unit inherits nothing from your shell — and under a plain
`sudo` the PATH on offer is `secure_path`, which holds no mise shim, no `~/.local/bin`
and so neither bun nor claude. `install --system` refuses rather than write a unit that
starts and then fails every spawn, so if your sudo's `secure_path` wins anyway, pass
`--path "$PATH"`.

What it resolves for you, all from the target user (`SUDO_USER`, or `--user <name>`)
rather than from root: home and uid/gid via `getent`, the state dir
(`<home>/.local/state/seance`, or an absolute `--state-dir`, which is also written into
the unit as `SEANCE_STATE_DIR=` so the daemon resolves the same path) — chowned along
with every parent it has to create, or a fresh account is left a root-owned `~/.local`
it can never put a `~/.local/bin` in — the log file, pre-created and chowned because
systemd's `append:` opens it as root before dropping privileges, and the sealed blob, if
there is one. `%` is doubled in every value, since systemd expands `%` specifiers.

It refuses in four more cases, each naming its remedy: not root; a target user that is
absent or resolves to uid 0 — `root` by name, a second uid-0 account like `toor`, or a
gid of 0, since the daemon must never run as root; a `--state-dir` or `--path` the unit
cannot carry (relative, or holding a quote or newline), refused before anything is
created; and a user unit still installed for that user — two units means two daemons
against one state dir, one log and one relay identity, and the user one is what
`selfRestart` rewrites. `install` refuses the mirror case, and `doctor` warns when both
exist.

Three fields deliberately differ from the user unit, and `systemd.ts` now enforces them
rather than trusting a hand-written file. `User=` is added. `Restart=always` where the
user unit says `on-failure` is load-bearing, not taste: under a system unit the daemon
can neither rewrite `/etc/systemd/system` nor reach the system manager, so `selfRestart`
exits cleanly and leaves the relaunch to the supervisor's policy — under `on-failure` a
clean exit stays down and the first auto-update would take the machine offline for good.
And `WantedBy` is `multi-user.target`, the system-scope counterpart of `default.target`.

The sealed blob and the unit are installed independently, in either order.
`LoadCredentialEncrypted=` is only written for a blob that exists **and** decrypts as
root, because a credential systemd can't load fails the unit at start — worse than a
unit that comes up and reports no key. So installing before sealing is fine: it says so
in a note, and re-running `install --system` after the seal adds the line. `doctor`
warns if a blob is sitting there undelivered.

What the user-unit flow still does that this doesn't:

- The unit definition never self-rewrites — `selfRestart` under a system unit exits for
  `Restart=always` to relaunch it, and it cannot regenerate a root-owned file. So the
  "definitions lag the code" catch-up below is `sudo seanced install --system` here, and
  `doctor` reports the drift by comparing the installed unit against what this checkout
  would write. That replaces the manual `ExecStart=` re-check this section used to ask
  for.
- Linger is irrelevant — system units outlive sessions by nature — and `doctor` says so
  instead of probing user scope.
- `seanced restart` needs root here; it says `sudo systemctl restart seanced.service`
  rather than surfacing systemd's interactive-auth refusal.

`doctor` and `seanced status` both report the system unit correctly now: which scope owns
the daemon, whether it is active, the bun path resolved against the unit's _own_ recorded
PATH, and the key as delivered. `sudo seanced uninstall --system` removes the unit,
leaving the sealed blob (a TPM blob can't be recreated from a backup) and the `seanced`
name on PATH, which belongs to a user whose PATH root can't see.

## WSL

`systemd=true` under `[boot]` in `/etc/wsl.conf` is a prerequisite, not a tweak:
`seanced install` needs a systemd user instance. Flipping it takes a
`wsl.exe --shutdown`, which kills every session on the box — so do it before anything
else.

`install` also registers a `SeanceWslPin` scheduled task via `schtasks.exe`. It starts
the distro at Windows logon and pins the VM so the idle timeout never takes the daemon
offline. If registration is denied, `install` prints the exact command to run from a
Windows shell instead.

The machine is offline while no Windows user is logged in — the same class of
limitation as a launchd agent, which is also per-login.

## The log file's owner, and why it can go wrong

`StandardOutput=append:` is opened by the manager before it drops to `User=`, so under a
**system** unit root creates the log and the daemon's own user is left unable to append
to it. That breaks half the audit trail without breaking the daemon: the daemon keeps
writing through its redirect, while `seanced spawn` — a separate process with no
redirect — fails its append, prints one line to stderr and spawns anyway, unrecorded.

`install --system` pre-creates and chowns the log for exactly this reason, and the daemon
now re-checks it on every start: it creates the file 0600 if it is missing and tightens
the mode if it is loose, in place — never renaming or rotating, which would leave the
daemon's redirect writing to the old inode while the CLI appended to a new one. What an
unprivileged daemon cannot do is take back a file root owns, so there it warns instead,
and `seanced doctor` fails the check naming the fix:

```sh
sudo chown <user> ~/.local/state/seance/seanced.log
sudo chmod 600 ~/.local/state/seance/seanced.log
```

The same shape applies to launchd on macOS — `StandardOutPath` is a redirect the manager
opens — but there the agent is per-login and the opener is already the user, so only the
mode is ever wrong.

`seanced.log`, `state.json` and `runtime.json` are 0600, joining `config.json` and the
sealed PSK blobs: the log records repo paths, device ids and window titles verbatim, and
`state.json` lists every repo the machine scanned. Machines installed earlier keep the old
0644 until each file is next written — the log on the next daemon start, the other two on
the next write of theirs; nothing has to be re-run. The modes are set on the
files themselves rather than with a `UMask=` in the unit, because the daemon may have
cold-booted the tmux server as its child and a unit umask would follow into every file a
Claude session writes.

## Service definitions lag the code

An update restarts the daemon from new code, but the service definition already on
disk is not rewritten in step: launchd caches job definitions, so the plist changes
only when you run `seanced install`, and systemd's unit is rewritten by the update's
own restart — one update cycle behind the code that generates it. A systemd **system**
unit is never rewritten at all, since the daemon lacks the privilege: `doctor` reports
the drift, and `sudo seanced install --system` clears it — rewriting the file _and_
restarting the unit, since `enable --now` leaves an already-running one on its old
definition.

## One-time catch-up for pre-2026-08-04 installs

Before that date the daemon recorded bun by resolved path rather than by PATH name, so
both the service definition and the Claude MCP entry named a specific bun build — one
a runtime upgrade can delete. Machines installed earlier still carry those paths. Run
this once per machine, and before the next `brew upgrade bun`:

```sh
bun daemon/src/main.ts mcp install    # re-record the MCP command
bun daemon/src/main.ts install        # rewrite the plist/unit and reload it
```

`seanced doctor` flags a machine that still needs it. Once every machine you own is
clean, this section can go.
