---
paths:
  - "daemon/src/{auth-*,exec*,credential*,psk-store*,keychain,dpapi*,tpmcreds*,usage-refresh}.ts"
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
