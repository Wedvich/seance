# Platform notes

The rough edges of running `seanced` as a service, by platform, plus a one-time
catch-up for machines installed before certain fixes.

## Linux

On a fresh headless box the systemd user instance may not exist until linger is
enabled. If `seanced install`'s preflight says so, run it once and re-run `install`:

```sh
sudo loginctl enable-linger <user>
```

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

## Service definitions lag the code

An update restarts the daemon from new code, but the service definition already on
disk is not rewritten in step: launchd caches job definitions, so the plist changes
only when you run `seanced install`, and systemd's unit is rewritten by the update's
own restart — one update cycle behind the code that generates it.

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
