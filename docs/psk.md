# Storing the PSK

The pre-shared key is the trust boundary: the relay never sees it, and anything
holding it can decrypt every envelope and spawn on every machine. It belongs in a
platform key store rather than in `config.json`.

| Platform                      | Store                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| macOS                         | login keychain                                                                |
| WSL                           | DPAPI (CurrentUser) blob under `~/.local/state/seance/`                       |
| Linux with TPM 2.0            | `systemd-creds` blob sealed to the TPM at `~/.local/state/seance/psk.cred`    |
| Linux, TPM 2.0, systemd ≥ 256 | the same sealed blob, unsealed by PID 1 and delivered to the unit — see below |

The delivered credential is read ahead of all three: where the service manager hands
the daemon a key, it is authoritative.

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

On systemd ≥ 256 this command cannot seal — the sealing is a one-time root step
instead, below. Everywhere else it is the whole story.

Then clear `psk` in `config.json`. The daemon reloads and logs the fingerprint it came
up with, so you can see which store answered. `seanced doctor` prints that fingerprint
too — compare it across machines to confirm they all hold the same key. The one box
where it can't is the credential-delivered one: the key is mounted inside the unit and
nothing outside it can read the key, so `doctor` says where the key comes from and the
daemon's own log carries the fingerprint.

## The Linux TPM path

It needs `/dev/tpmrm0` and `systemd-creds` on PATH (systemd ≥ 250 — Debian 12+ /
Ubuntu 24.04+). The blob is sealed to the TPM alone with no PCR binding, so firmware
updates don't invalidate it — but it is machine-bound by design: restore a container
backup or copy the blob to other hardware and it will not decrypt. The daemon fails
closed with "no psk" and `doctor` explains why; re-run the sealing on the new machine.

This protects the key at rest — container backups, ZFS snapshots, stolen disks. It
does not protect against root on the host, or against other processes running as your
user.

Who performs the unseal depends on the systemd version:

- **systemd < 256**: the daemon unseals the blob itself. `psk-import` seals it as your
  user; the user needs read access to `/dev/tpmrm0`.
- **systemd ≥ 256** (Debian 13+): unprivileged seal/unseal is refused —
  `systemd-creds` delegates the crypto to PID 1 over varlink, and system-scope TPM
  operations are root-only (`org.varlink.service.PermissionDenied`). This is not a
  container quirk; it holds on bare metal. `--user` scope is not a fix: it cannot
  express TPM-only keys, and its default key degrades to a host key file inside the
  rootfs — which travels with backups, exactly the exposure sealing exists to prevent.
  Here the key is _delivered_ instead of unsealed: run `seanced` as a systemd
  **system** unit (`sudo --preserve-env=PATH seanced install --system` writes it) with
  `User=<you>` and

  ```ini
  LoadCredentialEncrypted=seance-psk:/home/<you>/.local/state/seance/psk.cred
  ```

  PID 1 unseals the blob at service start and mounts the plaintext on a
  service-private tmpfs; the daemon reads it from `$CREDENTIALS_DIRECTORY/seance-psk`
  ahead of every platform store. The credential id must be `seance-psk` — it is
  embedded in the blob at encrypt time and systemd refuses a mismatch. The daemon
  still never runs as root, and it never touches the TPM at all; the plaintext exists
  only in the service's tmpfs and the daemon's memory. Service mechanics (the unit
  itself, self-update behavior) are in docs/platform-notes.md.

  Nothing outside the unit is _meant_ to reach the key, and one thing had to be done
  to keep that true: the daemon strips `CREDENTIALS_DIRECTORY` from every process it
  spawns (`exec.ts`). It cold-boots the tmux server where none is running, panes
  inherit that server's environment, and a same-uid session that knows the path can
  read the tmpfs — so without the scrub every Claude session on the box would hold the
  PSK's plaintext path, and the MCP exclusion below would be unenforced.

  A consequence worth expecting: **nothing outside the unit can resolve the key**, so
  `seanced doctor`, `seanced run` and `seanced mcp` in a shell all see no PSK. Doctor
  reads the system unit to tell that arrangement from a genuinely keyless box, and
  reports the key as delivered rather than missing; the other two are simply not
  runnable by hand there. The daemon's log carries the fingerprint, which is the only
  place it can come from here; `seanced status` reports the unit's health.

### Sealing the blob as root

On systemd ≥ 256, `psk-import` cannot seal (it runs as your user), so seal once as
root — piped, so the key stays off argv and shell history, and verified to decrypt
back before it lands, because encrypt can succeed where decrypt fails and a broken
blob must not clobber a working one:

```sh
op item get Séance --fields password --reveal --account my |
  sudo systemd-creds encrypt --with-key=tpm2 --tpm2-pcrs= --name=seance-psk - - \
  > /tmp/psk.cred.new
# both digests must match — compares without printing the key
op item get Séance --fields password --reveal --account my | tr -d '\n' | sha256sum
sudo systemd-creds decrypt --name=seance-psk /tmp/psk.cred.new - | tr -d '\n' | sha256sum
install -m 600 /tmp/psk.cred.new ~/.local/state/seance/psk.cred && rm /tmp/psk.cred.new
```

Then clear `psk` in `config.json` and restart the unit. This is the one half of the
arrangement still done by hand — `install --system` writes the unit but does not seal;
a future `psk-import --system` folds this runbook into the CLI too.

Order doesn't matter. `install --system` only writes the
`LoadCredentialEncrypted=` line for a blob that already decrypts as root — a credential
systemd can't load fails the unit at start — so seal first and install, or install first
and re-run `sudo seanced install --system` after sealing. `seanced doctor` warns while a
blob is sitting there undelivered.

### Proxmox LXC

Pass the TPM through once on the host. Under the `LoadCredentialEncrypted=`
arrangement PID 1 (root in the container) does the unseal, so a bare passthrough
suffices:

```sh
pct set <ctid> --dev0 path=/dev/tpmrm0
```

Only the pre-256 direct-unseal path needs the device mapped to the daemon's user
(`--dev0 path=/dev/tpmrm0,uid=<uid>,gid=<gid>,mode=0660` — container-side ids in an
unprivileged CT).

Two verified LXC sharp edges (Debian 13 guest, systemd 257):

- The Debian template lacks the tss2 runtime — install `libtss2-dev` (the versioned
  runtime package names drift between releases; the dev package is the robust pull).
  `tpm-udev`'s postinst fails noisily in the container; harmless — there is no
  container udev, and device ownership comes from the `--dev0` mapping.
- `systemd-creds has-tpm2` reports `partial` (non-zero exit) even with a fully working
  seal path, because the container masks the sysfs/ACPI firmware info the probe wants.
  `psk-import` therefore says there is no usable TPM here; the _read_ path ignores that
  probe, and `LoadCredentialEncrypted=` unsealing is unaffected. `doctor` sees the blob
  and reports it as the one a system unit is expected to deliver, rather than as a
  missing TPM.

### MCP on a credential-delivered box

`seanced mcp` is its own relay client and resolves the PSK itself — Claude Code
launches it outside the daemon's unit, where no credential is delivered and (on
systemd ≥ 256) direct unseal is refused. So a box whose key exists only as a
TPM-sealed blob behind a system unit has no working MCP path: keep MCP on machines
with a keychain/DPAPI store. Deliberate for now — the box that runs semi-trusted
sessions holds the least authority.
