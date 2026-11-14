# The custodian — what is left

**Status: built and folded into DESIGN.md; item 4b's drill pending.** The custodian is a cheap agent, one seat per
machine, that walks the machine's sessions on a timer, closes the finished ones, nudges the stuck ones and
flags what it cannot settle. Every decision (C1–C49), its rejected alternatives and its threat model are
recorded in DESIGN.md (index below). Rounds are live since item 4b (2026-11-14), which built the round's containment
(its own socket, the masks, the built environment, no network, and the `capture` and `pr` verbs: DESIGN.md, "The
custodian's seat"). Its drill has not run, so the docs say the round's sandbox is _built_, not _contained_. What is
left here is what only the drill can settle and the open build-time details. Decided with the owner on 2026-11-12,
2026-11-13 and 2026-11-14.

## Where each decision is recorded

Code cites the decisions by number; each is now in DESIGN.md.

| Decisions                        | DESIGN.md                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| C1–C4, C8–C14, C16–C21           | "The custodian's seat"                                                                                               |
| C5–C7, C22–C34, C37–C40, C42     | "The custodian frame kind"                                                                                           |
| C15                              | "Session events", "Per-pane retention and the screen sampler"                                                        |
| C32, C35, C36                    | Reap, "Nothing lost" and "Surfaces"; Threat model, "A daemon reads a forge only for reap's …"                        |
| C40, C41, C43, C45, C47 (app op) | "The custodian's status and the Machines row"                                                                        |
| C44, C47 (flags and events)      | "The custodian frame kind" (its leader's-side bullet)                                                                |
| C46                              | "The custodian's seat" (the config)                                                                                  |
| C48, C49                         | "The custodian's seat" (audit lines) and "The custodian frame kind"                                                  |
| 4b (the round's containment)     | "The custodian's seat" ("Contained", the fence, the round's socket) and "The custodian frame kind" (`capture`, `pr`) |

## Item 4b's drill (pending)

Item 4b is built (2026-11-14): the round's own socket (`daemon/src/custodian-socket.ts`), the masks, the built
environment and `allowedDomains: []` (`custodian-launch.ts`, `custodian-fence.ts`), and the `capture` and `pr` verbs
(`custodian-verbs.ts`, `custodian-pr.ts`) that replace the round's `tmux capture-pane` and `gh`. Every round verb,
`flag`, `nudge` and `interrupt` included, is served only on that socket; the owner's verbs work from files under the
masked `stateDir()`, and the app op comes over the relay, which the round cannot reach. The claim the drill must
prove: **from inside the sandbox the round reaches one socket that acts, the round's own, which serves the `custodian`
verbs and nothing else; and reads nothing but its own directories and the read-only toolchain.** Until the drill
passes, the doctor, the docs and the threat model say _built_, never _contained_.

- **The drill.** A real round on Linux (a VM or bare metal, and an LXC container) and macOS: the `--agents` tools
  shape, the peer pid under bwrap and Seatbelt, and Bun running the round's own `seanced` inside the sandbox, plus an
  **injected-round drill that tries every row of DESIGN.md's per-reach table and every read the masks close, and is
  refused**, each by the route a hostile model would take and not only the plain one: `tmux new-window` and
  `send-keys`; a `Plain` `despawn` frame written straight to the main socket, **and from a process the round
  re-parented away (`setsid -f`, `nohup … &`, a double fork) so its parent is init or launchd**; `bash -c 'systemd-run
  --user …'`, `docker ps`, an `ssh-add -l` against the owner's agent, `launchctl submit`; a `kill` of another pane's
  `claude`; and `state.json`, `~/.ssh/id_*`, `~/.config/gh/hosts.yml` and the Keychain items of `gh` and Claude Code
  read through `cat`, through `bash -c`, and through the `Read` tool, then sent through `curl` to github.com.
- **Custodian 5's surfaces.** An owner verb typed in a round (`seanced custodian pause`, through `bash -c` and through
  tmux `send-keys`) and a write of `custodian/state.json`, `round-request` or `sessions.json` are refused; and the rc
  check on a live round written under the sandbox, and on macOS through the `caffeinate -is` child (`roundRemoteId`
  binds to the pane's pid or its direct child only).
- **Custodian 8's.** A nudge from a live round lands through a real `inbox` mod, and an `interrupt` of a session hung
  in a `sleep` ends its turn; with them, the queued-nudge and Escape measurements under "Open details" below.
- **What only the drill can settle.** Each is built as the safest reading and unverified: (1) the E2 walk tries
  `/System/Volumes/Data/...` aliases of `/Users`, `/opt`, `/usr/local` and `/private/*`, every one of which the fence
  masks and re-allows in both forms (whether Seatbelt needs the alias form, and that srt writes it as given, are
  unshown), and reports `/Library`, `/private/etc`, `/private/var/log` and `/private/var/db` (unmasked on macOS);
  (2) whether the macOS masks added after the spike (`/private/var/tmp`, `/Library/Keychains`, the Data-volume
  aliases) break a round's start, to be narrowed and never dropped; (3) which paths the Read tool auto-allows under
  Claude Code's config dir and tmp dir (the denies cover `projects/` and the tmp dir in both its `/tmp` and
  `/private/tmp` forms) and whether the permission matcher resolves a link before matching, for a link planted in the
  tmp dir's `claude-<uid>` or the round dir (a symlink or hardlink anywhere in the round dir already makes the exclave
  skip at the pick; a plant after the pick is not checked, and only a same-uid process outside the round can make
  one); (4) Seatbelt's handling of `denyRead` over a path that `allowRead` re-adds beneath it; (5) a version-manager
  shim bun that is a copy, not a script or a differently named file, which `toolchainProblem` cannot see; (6) a
  `default-shell` of fish under tmux (the window runs `exec /bin/sh '<script>'`, which holds nothing fish parses
  differently; a test runs it under fish where installed, the drill has not); (7) the `start_failed` heuristic against
  a real protected-name failure, and what else ends a round inside two minutes (a rejected `model`, a refused
  sign-in); (8) the owner's rc files and aliases reaching the round's Bash (S18/S19), with an rc-less shell as the
  cheap fix if so.

## Open details (build time)

- **`unobserved` sessions.** A session in an exclave without the `session-events` mod is never
  closed (C24); `seanced doctor` warns about it, and about an exclave without the `inbox` mod, whose
  sessions a nudge answers `no_listener`. The retained state is per process, so a session already at rest
  when the daemon restarts is `unobserved` too until its next frame; `sessions` says when retention began
  (`retainedSince`), which is how the round can tell, though not why per pane.
- **Queued nudges and Escape.** Measure, on the pinned Claude Code release, whether a message the inbox mod submits
  to a busy session is drawn inside the input box's rules (then `interrupt` after a `nudge` answers `waiting`, safe
  but it leaves such a session only flagged), and whether Escape moves queued messages back into the box as a draft
  (then the interrupt turns the nudge into an unsent draft and `close` refuses that pane). If either holds, the
  agent's "interrupt, then nudge" order needs rethinking (DESIGN.md, `interrupt`).
- **Prompt suggestions.** `close` reads the box through `capture-pane -e` and ignores faint and grey cells
  (DESIGN.md, "The custodian frame kind"). Measure the attributes a real Claude Code release draws the suggestion
  with: a style the daemon does not list reads as a draft and the session is refused `waiting`, which is safe and
  silent. A paste or image placeholder in the box (`[Pasted text #1 +40 lines]`, `[Image #1]`) counts as a draft by its
  wording whatever its style; measure how a real release draws those too, and drop the wording match only if it is
  drawn unlike a suggestion.
- **What "unchanged on screen" cannot see.** The change hash drops Claude's input box and footer and masks
  elapsed timers and the spinner glyph (DESIGN.md, "Per-pane retention"), matched on wording from Claude
  Code 2.1.x. A release that rewords them, or a repaint nobody has listed (a rotating tip, a clock in the
  transcript), moves the hash while the session is hung, so C27's `interrupt` reads it as moving and answers
  `too_soon`: it fails to fire, never fires wrongly. Check against a live busy session in 4b's drill. A resize
  (another client attaching at another size) moves it too.
