# The custodian — what is left

**Status: built and folded into DESIGN.md; item 4b's containment drilled 2026-11-14 on macOS and on Linux's weaker nested
mode, and on strict-mode Linux (WSL2) under the vsock filter that drill made necessary; the weaker mode re-drilled under
that filter 2026-11-15, which every Linux round now runs under.** The custodian is a cheap agent, one seat per
machine, that walks the machine's sessions on a timer, closes the finished ones, nudges the stuck ones and
flags what it cannot settle. Every decision (C1–C49), its rejected alternatives and its threat model are
recorded in DESIGN.md (index below). Rounds are live since item 4b (2026-11-14), which built the round's containment
(its own socket, the masks, the built environment, no network, and the `capture` and `pr` verbs: DESIGN.md, "The
custodian's seat") and drilled it the same day (results in that entry's "Contained"). What is left here is what the
drills did not settle and the open build-time details. Decided with the owner on 2026-11-12,
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

## Item 4b's drill: what is left

The round's containment is built (2026-11-14) and was drilled the same day by an injected round on macOS (Seatbelt) and
on Linux in the weaker nested mode (Proxmox LXC, bwrap): no hole on either, results in DESIGN.md's "The custodian's
seat", "Contained". The claim is **from inside the sandbox the round reaches one socket that acts, the round's own,
which serves the `custodian` verbs and nothing else; and reads nothing but its own directories and the read-only
toolchain**, and it holds **only for the modes drilled**: macOS, and Linux in both bwrap modes under the vsock filter
(strict on WSL2, 2026-11-14: without the filter a round reached the Windows host over `AF_VSOCK`; weaker nested on an
LXC container, 2026-11-15, where a fresh network namespace reached the host kernel's vsock loopback; DESIGN.md,
"Contained"), and a change to the masks, the fence, the built environment or the round socket needs a re-drill
before the docs say _contained_ again. The drills settled the E2 walk's Data-volume aliases (nothing readable in a masked
root), that the macOS masks added after the spike do not break a round's start, that Seatbelt's `denyRead` with an
`allowRead` beneath it holds, and that the Read tool refuses every baked secret path and every planted link (one
refused Read per path, none read).

- **Not settled.** (1) strict-mode Linux on bare metal (only WSL2 was drilled); (2) a
  version-manager shim bun that is a copy, not a script or a differently named file, which `toolchainProblem` cannot
  see (a mise `latest` symlink dir was found instead, and is fixed: the round's `seanced` wrapper execs bun's
  realpath); (3) a `default-shell` of fish under tmux (the window runs `exec /bin/sh '<script>'`, which holds nothing fish
  parses differently; a test runs it under fish where installed, the drills did not); (4) the `start_failed`
  heuristic against a real protected-name failure, and what else ends a round inside two minutes (a rejected `model`, a
  refused sign-in); (5) custodian 5's surfaces from inside a live round (an owner verb through `bash -c` and `send-keys`,
  a write of `custodian/state.json`, `round-request` or `sessions.json`; the drills showed the round's own files
  unwritable and no tmux or main-socket reach, not these verbs by name), and the rc check on a live round on macOS
  through the `caffeinate -is` child.
- **Owner looks from the drill.** S19 cannot produce counts: the fence refuses `alias` and `declare -F`, so the owner's
  aliases and exported functions reaching the round's Bash are shown only by "no exported functions" (0 on both hosts),
  and the drill's step 2 wants dropping or recording as INFO-only. S18 lists 57 env names, the unlisted ones Claude
  Code's own (`CLAUDE_CODE_*`, `AI_AGENT`, `GIT_EDITOR`) and `CLOUDSDK_PROXY_*` (address, port, type, username and
  password), which Claude Code's sandbox proxy sets: a name-only look, values never read, and whether that password
  reaches the round's Bash is for the owner to judge.
- **Custodian 8's.** A nudge from a live round lands through a real `inbox` mod, and an `interrupt` of a session hung
  in a `sleep` ends its turn: neither drill's round nudged or interrupted (its rounds closed, captured and finished),
  so both, with the queued-nudge and Escape measurements under "Open details" below, are still to be run.

## Open details (build time)

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
  `too_soon`: it fails to fire, never fires wrongly. Check against a live busy session (neither drill had one). A resize
  (another client attaching at another size) moves it too.
