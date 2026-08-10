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
— why in docs/psk.md). `seanced install` only writes user units today, so this is a
hand-managed bridge until an `install --system` exists:

1. Uninstall any user unit first (`seanced uninstall`) — the self-update's restart
   only knows user scope, and a loaded user unit would be the one it rewrites and
   restarts.
2. Write `/etc/systemd/system/seanced.service`, mirroring the generated user unit
   (run `seanced install` on any box and copy, or start from this):

   ```ini
   [Unit]
   Description=Seance daemon (seanced)

   [Service]
   User=<user>
   ExecStart="<path to bun>" "<checkout>/daemon/src/main.ts"
   LoadCredentialEncrypted=seance-psk:/home/<user>/.local/state/seance/psk.cred
   Restart=always
   RestartSec=5
   KillMode=process
   Environment="PATH=<the user's PATH — a unit's default has no tmux/claude>"
   StandardOutput=append:/home/<user>/.local/state/seance/seanced.log
   StandardError=append:/home/<user>/.local/state/seance/seanced.log

   [Install]
   WantedBy=multi-user.target
   ```

3. `sudo systemctl daemon-reload && sudo systemctl enable --now seanced`.

`Restart=always` where the generated unit says `on-failure` is load-bearing, not
taste: after a self-update the daemon looks for its _user_ unit, finds none, and exits
cleanly expecting its supervisor's policy — under `on-failure` a clean exit stays
down, and the first auto-update would take the machine offline for good. `always`
restarts it into the new code.

Two things the user-unit flow does that this bridge doesn't: the unit definition never
self-rewrites (the "definitions lag the code" catch-up below becomes a manual edit
here), and linger is irrelevant — system units outlive sessions by nature.

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
