---
paths:
  - "raycast/**"
  - "daemon/src/{config,keychain}.ts"
---

# The Raycast extension

- **Nothing under `raycast/src/lib/` may import `@raycast/api`.** It throws outside the Raycast host, so
  such a module could not run under `bun test` and would take every test in the directory down at import
  time. Views are `.tsx` at `src/`, logic is `.ts` at `src/lib/`; platform APIs (`LocalStorage`,
  preferences) reach the logic as injected seams. `raycast/src/lib/layering.test.ts` enforces it.
- The extension is a third app-role relay client, exactly as `seance mcp` is — no relay or daemon change.
  Its credentials come only from the local daemon's config plus the macOS keychain; Raycast preferences
  hold defaults, never secrets. `raycast/src/lib/credentials.ts` reimplements what `daemon/src/config.ts`
  and `keychain.ts` do in Bun, so its test imports _both_ and asserts they agree on names and precedence.
  Diverge in mechanism there, never in names.
- Raycast runs extensions on Node 22 but in a sandbox that withholds `crypto` and `WebSocket` (probed
  from inside: `fetch`/`btoa`/`TextEncoder` present, those two undefined — a bare `node` of the same
  version has all four, so the version alone answers nothing). `shared/` uses both as globals, so
  `raycast/src/lib/runtime.ts` installs them and the extension carries a `ws` dependency for it. Don't
  add injectable crypto/socket seams to `shared/` for this.
- It is installed by `bun install` as a workspace member, never npm (CLAUDE.md, "Two TypeScript versions
  on purpose").
