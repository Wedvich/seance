---
paths:
  - "daemon/src/{auth-*,exec*,credential*,psk-store*,keychain,dpapi*,tpmcreds*,usage-refresh}.ts"
  - "daemon/src/codex/**"
---

# Credentials in the daemon

Requirements, not observations (DESIGN.md, Threat model). docs/psk.md holds the PSK store and import
constraints.

- A service-delivered credential never leaves the daemon process: `exec.ts` strips
  `CREDENTIALS_DIRECTORY`, or the tmux server it boots hands the PSK's path to every session.
- The daemon process never holds a Claude credential. Auth health (`daemon/src/auth-health.ts`) reads each
  exclave's credential store only through a short-lived `bun -e` child running the one constant script,
  with the file handed over as a file descriptor (or, on macOS, `security -w` run by the child), a bare
  env and a timeout, and keeps only the child's `{lapsed, refreshExpiresAt}` after an exact-shape check —
  never the child's stdout or stderr in a log, and nothing on the wire but `ax`/`ae`/`au` indices, an
  expiry time and `CAPABILITIES.authHealth`.
- The daemon never opens, reads or copies Codex's `auth.json` (DESIGN.md, Daemon, "Codex login"):
  identity, quota and login health come only over `codex app-server` in Séance's own home
  (`stateDir()/codex/home`, 0700, its `config.toml` generated 0600 with the file store), under the bare
  `childEnv` plus `CODEX_HOME`; the file is only `lstat`ed for a reprobe signature. `CODEX_HOME` never
  points at the owner's `~/.codex`, and no answer's text reaches a log or an audit line.
- A Codex session's pane (DESIGN.md, Daemon, "Codex sessions") gets `CODEX_HOME` only from its own `run.sh`, set to
  Séance's home through `shq()`, with `OPENAI_API_KEY` and `CODEX_API_KEY` unset; the daemon dials its server only
  after `socketState` and accepts it only when `initialize` answers that home's realpath.
