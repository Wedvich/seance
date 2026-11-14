# The custodian — what is left

**Status: built and folded into DESIGN.md, bar item 4b.** The custodian is a cheap agent, one seat per
machine, that walks the machine's sessions on a timer, closes the finished ones, nudges the stuck ones and
flags what it cannot settle. Every decision (C1–C49), its rejected alternatives and its threat model are
recorded in DESIGN.md (index below). Rounds are held behind `ROUNDS_LIVE` (owner decision, 2026-11-14): the
verbs bound only what goes through them, and a round's sandbox can still reach the tmux socket and the
daemon's plain ops and read on-disk secrets, so **item 4b (contain the round) comes before any round runs**.
What is left here is 4b and the open build-time details. Decided
with the owner on 2026-11-12, 2026-11-13 and 2026-11-14. Each part folds into DESIGN.md as it is built, and its
text here goes.

## Where each decision is recorded

Code cites the decisions by number; each is now in DESIGN.md.

| Decisions                    | DESIGN.md                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| C1–C4, C8–C14, C16–C21       | "The custodian's seat"                                                                        |
| C5–C7, C22–C34, C37–C40, C42 | "The custodian frame kind"                                                                    |
| C15                          | "Session events", "Per-pane retention and the screen sampler"                                 |
| C32, C35, C36                | Reap, "Nothing lost" and "Surfaces"; Threat model, "A daemon reads a forge only for reap's …" |
| C40, C41, C43, C45, C47 (app op) | "The custodian's status and the Machines row"                                                 |
| C44, C47 (flags and events)  | "The custodian frame kind" (its leader's-side bullet)                                         |
| C46                          | "The custodian's seat" (the config)                                                           |
| C48, C49                     | "The custodian's seat" (audit lines) and "The custodian frame kind"                           |

## Not built

### Item 4b. Contain the round, then remove `ROUNDS_LIVE`

Decided with the owner on 2026-11-14 after the code review of item 4 showed the reach in DESIGN.md's
"The custodian frame kind" (its threat-model bullet). The claim, and what the PR's drill must prove: **from
inside the sandbox the round reaches one socket that acts, the round's own, which serves the `custodian` verbs
and nothing else; and reads nothing but its own directory.** Everything below follows from that sentence, so
a route not on the list still counts as a hole. Five changes, one PR. A route is **masked** (the path is hidden
from the sandbox; a mask that stops only `stat` and not `connect()` is no mask, so each is spiked), never merely
denied by the fence's command list, which `bash -c` gets past (C21).

- **(a) A socket only the round can reach, and the daemon's main socket out of its sight.** The seat
  opens a second listener (a new module beside `local-socket.ts`; it reuses `custodianVerbs` and the
  frame parser) in its own 0700 directory **outside `stateDir()` and outside every path the sandbox may
  write** (a per-seat dir under the literal `/tmp/seance-cu-` prefix, as the tmp dir is, but not the
  round's scratch dir, so the round cannot replace the socket). It answers the `custodian` kind only:
  any other kind is refused `unsupported`, with one warn line a minute at most. The peer-pid binding stays as it is, a **positive** check (only a descendant of the
  seat's running round pane is served), so a process that re-parents away loses access, never gains it.
  The round's `seanced custodian` finds it through an env var the daemon sets in the round's launch
  env (a path, not a credential; the binding is the kernel's, never the path's). Then the daemon's main
  socket (`runDir()/seanced.sock`, so `stateDir()/run`) is out of sight: macOS drops `runDir()` from
  `network.allowUnixSockets` and lists only the round socket's dir and nothing for tmux; Linux masks
  `runDir()`. This is also what makes (d) possible: the verbs no longer live under `stateDir()`, so
  masking `stateDir()` does not take the round's own verbs with it.
- **(b) Every other socket that acts as the user, one by one.** Linux's `allowAllUnixSockets` is
  all-or-nothing (seccomp cannot filter by path), so on Linux each socket the user can reach is either
  masked by path or, if the spike shows it can be done, the filter is **inverted**: the round's mount
  namespace hides `/run`, `/var/run`, `/tmp` and `$HOME` except the paths it needs (the round socket's
  dir, its scratch dir, its toolchain), which also answers abstract-namespace sockets only to the extent
  the sandbox's network namespace does (spike: whether Claude Code's `bwrap` unshares the network
  namespace, so a host's abstract sockets are unreachable; if not, `bwrap --unshare-net` or a path-free
  route is part of this PR). Each reach and how 4b treats it:

  | Reach                | How the round gets there                                                                                                                                           | 4b                                                                                                                                                                                                                                                                                                                                                                             |
  | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | tmux server socket   | `capture-pane`, and `new-window`/`run-shell`/`send-keys`                                                                                                           | masked (Linux `/tmp/tmux-<uid>` or `#{socket_path}`'s dir) / dropped from `allowUnixSockets` (macOS); `capture` verb (c) replaces the one thing the round needs it for. Spike: the mask stops `connect()`                                                                                                                                                                      |
  | Daemon main socket   | raw `Plain` `despawn` with `force: true`, broker, `message`, `inbox`                                                                                               | (a)                                                                                                                                                                                                                                                                                                                                                                            |
  | User systemd manager | `/run/user/<uid>/bus`, `…/systemd/private`: `systemd-run --user sh -c '…'` runs outside the sandbox (the deny list's `systemctl` does not catch it, nor `bash -c`) | Linux: mask `/run/user/<uid>` (and `/run/dbus`, the system bus); spike: `systemd-run --user` and `busctl --user` are refused. Mind `/etc/resolv.conf` linking into `/run/systemd/resolve`: the spike checks name resolution still works                                                                                                                                        |
  | Docker / Podman      | `/var/run/docker.sock`, `/run/docker.sock`, `$XDG_RUNTIME_DIR/podman/podman.sock`: root for a user in the group                                                    | Linux: masked with `/run`, `/var/run`                                                                                                                                                                                                                                                                                                                                          |
  | ssh-agent, gpg-agent | `$SSH_AUTH_SOCK` signs as the owner (a `git push` over SSH works with `~/.ssh` masked), `~/.gnupg`, `/run/user/<uid>/gnupg`                                        | `SSH_AUTH_SOCK` and `GPG_*` are not in the round's launch env (the env is built, not inherited); the socket's dir is masked; `ssh` stays on the deny list as a mistake guard only                                                                                                                                                                                              |
  | macOS Mach services  | `launchctl submit`/`bootstrap`/`load`, `osascript`, `open`, `defaults` reach launchd and LaunchServices over Mach; a job runs outside Seatbelt                     | **Open, spike first**: whether Claude Code's Seatbelt profile refuses the Mach lookups (DESIGN.md records it as untested). If it does not, a macOS round cannot be contained by that profile, and the fallback is below                                                                                                                                                        |
  | `kill`               | `kill`/`pkill` reach every same-uid process: other sessions' `claude`, the daemon, **the tmux server (every session on the machine)**                              | **Open, owner decides.** Recommended: contain on Linux by a pid namespace (spike: whether the sandbox can run `--unshare-pid`; it also lets the peer-pid walk stay honest), accept on macOS and record it as the one accepted reach; a lost turn is cheap, a killed tmux server costs every session's live context (the worktrees and transcripts survive, `continue` resumes) |

  If a spike shows a reach cannot be masked on a platform, the fallback is **the round as a different
  OS user** (or a container) with no access to the owner's sockets, signals or files, and the daemon's
  verbs reached over the round socket only; never a wider fence and never ancestry or env checks in the
  daemon standing in for isolation.

- **(c) A `seanced custodian capture <pane>` verb.** The round can no longer run `capture-pane`, so
  the daemon does: it already captures the screen to hash it. The verb returns the text to the
  round only, for `ours` panes and never the round's own, is never logged or audited with text, and
  replaces `tmux capture-pane` in the agent's checklist (`daemon/custodian/agent.md`) and the
  fence's allowances.
- **(d) Reads.** Two different mechanisms cover two different tools, and 4b needs both. The sandbox's
  `denyRead` confines the Bash tool's subprocesses; the fence allows the `Read` tool outright
  (`allow: ["Read", …]`), and whether `denyRead` also stops Claude Code's in-process `Read`, `Grep` and
  `Glob` is **not established**: spike it, and until it is shown, assume not. So: `denyRead` **and**
  `Read(<path>)` deny rules for each secret below, or better, narrow the `Read` allow to the round's own
  directory so a path nobody listed is refused too. The secrets: `stateDir()` (identity seed,
  `state.json`: safe to mask whole once (a) moves the round's socket out of it), `~/.ssh`, `~/.gnupg`,
  `~/.config/gh`, each exclave's Claude credential store (`.credentials.json`, the keychain on macOS),
  and the other credential files a user keeps (`~/.aws`, `~/.config/gcloud`, `~/.netrc`, `~/.npmrc`,
  `~/.docker/config.json`): a deny list of home is never complete, so prefer the inverted form, `$HOME`
  denied with the round dir, its toolchain and `seanced`'s own install re-allowed, if the pinned Claude
  Code release's sandbox settings can express it (spike). github.com stays reachable, so anything
  readable is something the round can send; the claim is about what is readable. The round's `gh` token
  for reads must come some other way than a file it can read; check where macOS keeps `gh`'s credential
  (keychain storage is not a path to deny, and may need the round's `gh` run through a daemon-side verb
  or a scoped read-only token).
- **(e) The drill and the removal.** Then remove `ROUNDS_LIVE`, `CustodianSeatOpts.live` and `seatLive`,
  and fold the held-branch tests into ones that run rounds. The dev check is a real round on Linux
  (a VM or bare metal, and an LXC container) and macOS: the `--agents` tools shape, the peer pid under
  bwrap and Seatbelt, and Bun running the round's own `seanced` inside the sandbox, plus an
  **injected-round drill that tries every row of the table above and every read in (d) and is refused**,
  each by the route a hostile model would take and not only the plain one: `tmux new-window` and
  `send-keys`; a `Plain` `despawn` frame written straight to the main socket, **and from a process the
  round re-parented away (`setsid -f`, `nohup … &`, a double fork) so its parent is init or launchd**;
  `bash -c 'systemd-run --user …'`, `docker ps`, an `ssh-add -l` against the owner's agent, `launchctl
  submit`; a `kill` of another pane's `claude` under whatever the owner decided; and `state.json`,
  `~/.ssh/id_*` and `~/.config/gh/hosts.yml` read through `cat`, through `bash -c`, and through the `Read`
  tool, then sent through `curl` to github.com. The drill passing is the only evidence for the claim; the
  doctor, the docs and the threat model say "contained" only after it has. Two checks of custodian 5's
  surfaces belong to the drill: an owner verb typed in a round (`seanced custodian pause`, through
  `bash -c` and through tmux `send-keys`) and a write of `custodian/state.json` or `round-request` are
  refused, since until 4b only the fence's mistake guard stands; and the rc check on a live round written
  under the sandbox, and on macOS through the `caffeinate -is` child (`roundRemoteId` binds to the pane's
  pid or its direct child only). And one of custodian 8's: a nudge from a live round lands through a real
  `inbox` mod, and an `interrupt` of a session hung in a `sleep` ends its turn.
- **Open, decided by a spike before any of it is built:** each "spike" in the table and in (d); whether a
  second listener or a different process (a daemon-spawned broker the round alone reaches) is the simpler
  home for (a); whether the round can keep `allowAllUnixSockets` at all once `/run`, `/var/run` and the
  agent dirs are masked, or Linux gets the inverted mount form or the other-user fallback.

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
