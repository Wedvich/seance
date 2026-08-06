# Storing the PSK

The pre-shared key is the trust boundary: the relay never sees it, and anything
holding it can decrypt every envelope and spawn on every machine. It belongs in a
platform key store rather than in `config.json`.

| Platform           | Store                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| macOS              | login keychain                                                             |
| WSL                | DPAPI (CurrentUser) blob under `~/.local/state/seance/`                    |
| Linux with TPM 2.0 | `systemd-creds` blob sealed to the TPM at `~/.local/state/seance/psk.cred` |

In every case a filesystem sweep, a backup, or a stolen disk gets ciphertext.

Linux without a usable TPM has no such store — there the PSK stays in `config.json`,
which `init` creates 0600, and `psk-import` says so and stores nothing.

## Importing it

Run `seanced psk-import` bare and it prompts on the terminal with no echo, or pipe it
straight from a password manager — either way the key never lands in argv or shell
history:

```sh
op item get Séance --fields password --reveal --account my | seanced psk-import
```

Then clear `psk` in `config.json`. The daemon reloads and logs the fingerprint it came
up with, so you can see which store answered. `seanced doctor` prints that fingerprint
too — compare it across machines to confirm they all hold the same key.

## The Linux TPM path

It needs `/dev/tpmrm0` and `systemd-creds` on PATH (systemd ≥ 250 — Debian 12+ /
Ubuntu 24.04+). The blob is sealed to the TPM alone with no PCR binding, so firmware
updates don't invalidate it — but it is machine-bound by design: restore a container
backup or copy the blob to other hardware and it will not decrypt. The daemon fails
closed with "no psk" and `doctor` explains why; re-run `psk-import` on the new
machine.

This protects the key at rest — container backups, ZFS snapshots, stolen disks. It
does not protect against root on the host, or against other processes running as your
user.

### Proxmox LXC

Pass the TPM through once on the host:

```sh
pct set <ctid> --dev0 path=/dev/tpmrm0,uid=<uid>,gid=<gid>,mode=0660
```

In an unprivileged container, `uid=`/`gid=` are the container-side ids the device maps
to — set them to the daemon's user so it can open the device. The daemon never needs
root.
