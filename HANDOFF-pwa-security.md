# Handoff → PWA session: security work split

Written 2026-07-27 from `main`, after an ATT&CK review of DESIGN.md added a
`## Threat model` section. This file is the part of that review that belongs to
whoever is building the PWA.

Two sessions are live: `main` (daemon + relay + shared) and the PWA worktree
`worktree-cosmic-wishing-grove` (at the vite/react scaffold plus uncommitted
`pwa/src/relay/`). The split below is drawn so neither session edits the same
file.

---

## Yours — `main` will not touch any of these

### 1. Never persist the PSK as a string — highest-value item in the review

The PWA holds the only copy of the key outside four 0600 config files, and it
is the only copy reachable without touching a machine. One XSS on the Pages
origin currently yields the PSK, and the PSK is arbitrary code execution on
every registered machine — `spawn` launches Claude with `--permission-mode
auto`. Every crypto control in DESIGN.md defends the _channel_; none of them
touch this path.

`shared/src/crypto.ts:importPsk()` already imports with `extractable: false`,
so use it — do not reimplement `crypto.subtle.importKey`.

- Take the base64 PSK from the setup form, pass it straight to `importPsk()`.
- Persist the returned `CryptoKey` in **IndexedDB**. `CryptoKey` is
  structured-clonable; a non-extractable one survives the round trip and still
  cannot be read back as bytes.
- Never write the base64 string to `localStorage`, `sessionStorage`, IndexedDB,
  or any persisted store. Drop the string as soon as `importPsk` resolves.
- If IndexedDB has no key, show the paste form. That is also the rotation UX —
  see the rotation runbook in DESIGN.md.
- The bearer token can stay in `localStorage`; the threat model already treats
  it as low value.

Effect: XSS can _use_ the key while a tab is open, but cannot exfiltrate it.
Permanent silent compromise of all machines becomes a transient one.

If `pwa/src/relay/` already has key handling, this is a change to it rather
than new code.

### 2. Content-Security-Policy on the Pages / Workers-assets response

DESIGN.md said nothing about CSP; without one, item 1 carries the whole load.

```
default-src 'self';
script-src 'self';
style-src 'self';
connect-src 'self' wss://<relay-host>;
img-src 'self' data:;
font-src 'self';
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
form-action 'none'
```

- No `'unsafe-inline'` in `script-src`. If Vite emits an inline bootstrap, hash
  it rather than opening the directive.
- Keep the scaffold's fonts self-hosted so `font-src 'self'` holds.
- Send `Referrer-Policy: no-referrer` too — the relay URL carries `?t=<token>`.

### 3. Keep the bearer token out of anything that can leak a URL

`?t=` on the WebSocket URL is an accepted design decision. Keep it to the
WebSocket URL only: never in a document URL, an `<img>`/`fetch` URL, or
anything that can reach a `Referer` header, an error report, or history.

### 4. Render daemon-supplied strings as text

Repo names, tmux window names, spawn `note`/`message`, and captured pane output
originate on the machine but arrive over the wire. Text nodes only — no
`innerHTML` / `dangerouslySetInnerHTML`. React's default escaping is enough as
long as nothing opts out.

---

## Ours — landing in `main`

| Change                                                         | Files                                                                       | Affects you?          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------- |
| Threat-model section                                           | `DESIGN.md`                                                                 | doc only              |
| Registry entry cap, UUID `deviceId` check, register rate limit | `relay/src/hub.ts`, `relay/src/wire.ts`                                     | no wire-format change |
| Spawn audit logging                                            | `daemon/src/handlers.ts`, `daemon/src/log.ts`                               | no                    |
| Keychain-backed PSK on macOS behind `loadPsk()`                | `daemon/src/config.ts`, `daemon/src/keychain.ts` (new), `daemon/src/cli.ts` | no                    |
| PSK fingerprint in `doctor`                                    | `daemon/src/config.ts`, `daemon/src/cli.ts`                                 | no                    |
| Regression tests for the two spawn invariants                  | `daemon/src/spawn.test.ts`                                                  | no                    |

**No change to `shared/src/types.ts`, `shared/src/crypto.ts`, the `Envelope`
shape, the AAD input `` `${v}|${to}|${from}` ``, or `PROTOCOL_VERSION`.** A
`keyId` field was considered and rejected: for four devices owned by one person,
rotation is a config edit rather than a rollover, so the field buys nothing and
would have broken your crypto mid-build.

`relay/src/index.ts` is yours by recent history (`f4acca4`, the 4401/4400 app
close codes). `main` stays out of it — the relay source work lands in `hub.ts`
and `wire.ts` only. Say so if you need `index.ts` and `hub.ts` in one change.

**One known collision.** You have uncommitted edits to `relay/test/harness.ts`,
and the relay-cap tests need `relay/test/relay.test.ts` (and possibly
`harness.ts`) too. `main` will hold off on the relay tests until you have
committed or landed yours — ping when `relay/test/` is free, or land your
harness change first and `main` will build on it.

## Merge order

`main`'s changes are additive and unflagged; rebase whenever convenient.
Rebasing before the relay caps land breaks nothing — the caps only reject
frames a correct client never sends.
