---
paths:
  - "daemon/src/custodian-*.ts"
  - "daemon/src/{seat-record,pane-activity,pane-activity-store,pane-holds,despawn,sessions,reap,reap-git,commands,status}.ts"
  - "daemon/test/custodian-*.ts"
  - "pwa/src/machines-view.ts"
---

# The custodian

Requirements, not observations. DESIGN.md's "The custodian's seat", "The custodian frame kind" and "The
custodian's status and the Machines row" are the record and defer here for the rule; docs/custodian.md
indexes C1–C49. CLAUDE.md's recurring rules (peer-pid binding, data-channel stdouts, the owner's sealed
act, no text in logs, a new act is a threat-model change) hold throughout.

## The round is a fenced reader of untrusted text, never a session

- Its pane carries the tmux pane option `@seance-custodian`. Every pane reader skips it through its
  format-field parse (`listClaudeSessions`, `listPanes`, `parsePanePids`, `despawnSession`); only
  `despawnRound` closes it (a pane id and nothing else, no option a wire frame can set); it starts only
  while the daemon is not draining. A `custodian` config key lives only in the machine's own
  `config.json`.
- Its fence (`custodian-fence.ts`) is generated: the deny list comes from constants and the one
  `COMMANDS` table, so a new `seance` command is denied to a round by default (under the CLI's old name
  `seanced` too). It is for a cheap model's mistakes, never a boundary.
- What bounds an injected round is its sandbox plus the daemon's verbs behind the one socket it reaches.
  Drilled (docs/custodian.md item 4b) on macOS (Seatbelt, 2026-11-14) and on Linux in both bwrap modes
  under the vsock filter (`custodian-seccomp.ts`: an outer `bwrap --seccomp` around every Linux round,
  refusing `AF_VSOCK`, `io_uring_setup` and other ABIs, without which a round reached the Windows host
  from WSL2 and the host kernel's vsock loopback from an LXC container; strict mode on WSL2 2026-11-14,
  the weaker nested mode on LXC 2026-11-15), no hole found, so "contained" is claimed for those modes
  only. Linux on a CPU the filter has no table for is refused. **Any change to the masks, the fence, the
  built environment or the round socket needs a re-drill before "contained" is said again.**
- The sandbox: `denyRead` masks every path socket and every secret (Linux inverts the tree, macOS lists
  `allowUnixSockets` as the round socket's directory alone); `allowRead` gives back only the round dir,
  its tmp dir, its socket's directory and the read-only toolchain (never the checkout whole); the Read
  tool is held to the round dir by `Read(//…)` rules and secret denies; `network.allowedDomains` is `[]`
  (present: omitting it lifts the restriction), so there is no network and no `gh`.
- The round starts under `env -i` with a built environment, never inherited: `CLAUDE_CONFIG_DIR` set for
  a named exclave, proxy variables and their CA bundle passed through only when set and a proxy URL with
  userinfo not at all, no credential or provider variable ever. The pane runs
  `exec /bin/sh '<tmp>/run.sh'`, the launch script in the round's tmp dir, so the owner's tmux
  `default-shell` parses no quoting of it.
- A host that cannot show this — Linux with no vsock filter for its CPU, a shim bun, or an `allowRead`
  entry covering any masked path (`sandboxMasks`) or leaving the checkout out — is refused (audited
  `op=refused`, `reason=sandbox_undrilled|toolchain`, a launch-time toolchain refusal included) and runs
  no round. A round this process launched that exits within two minutes of its start with no verb is
  audited `start_failed` (when it ended, not why: the sandbox's start is the usual cause, not the only
  one).
- The daemon reads an exclave's `.claude.json` for the round dir's trust and never writes it. The round
  dir and the tmp dir are made 0700, the tmp dir under the literal `/tmp/seance-cu-` (never `tmpdir()`,
  whose length makes Claude Code fall back to a shared `/tmp`). The seat record in `state.json` is
  validated (`custodianSeatOf`) before the daemon closes a pane or removes a path it names.
- Nothing read from a pane, the seed, the notes or the agent's text is logged or audited; the lines
  carry an exclave id, a pane id, a reason and an outcome.

## The `custodian` frame kind is served only on the round's own socket

`custodian-socket.ts`, `custodian-verbs.ts`, `custodian-frame.ts`.

- The socket is `/tmp/seance-cu-s-<mkdtemp>/c.sock`, its directory kept in the seat record's `socketDir`
  and reused only while `lstat` shows it the daemon's own, else made fresh: a 0700 directory checked with
  `lstat`, a 0600 socket, 64 KiB inbound, every other kind answered `unsupported`. The daemon's main
  socket answers `custodian` `unsupported` too.
- The verbs are `sessions`, `close <pane>`, `capture <pane>`, `pr <pane>`, `flag <pane>`, `nudge <pane>`,
  `interrupt <pane>`, `notes` and `done`, and no other act.
- It is bound only by peer pid, to a process of the one live pane carrying `@seance-custodian` **that the
  seat record names as the running round** (`seat.roundPane()`), else `not_custodian` — as is every host
  that names no peer (`peerPidSupported`) and any pid not given, never a claimed pane, an env var or a
  field of the frame. A frame carries no path, branch, task id or session id.
- `capture`: a pane of ours's screen as plain text, to the round only, never logged, audited or kept.
- `pr`: the state of the PR the task's own launch ledger holds, read by the daemon's `askGithub` through
  a constant query with variables, only for a PR in the GitHub repo the task worktree's `origin` names,
  else `foreign_pr`, or `unreadable` where no origin is known; never a title, body or comment; cached
  60 s.
- `close` re-reads the pane at the act and acts only on a session at rest by the daemon's own facts
  (`closeVerdict`: never the round's own pane, one that is `foreign` or `marked`, `needs-input`, `busy`,
  unobserved, or whose input box holds any typed text (a faint or grey prompt suggestion, through
  `capture-pane -e`, is not: `inputBoxDraft`; a paste or image placeholder is) or can't be found —
  `waiting`, since the despawn's Escape and Ctrl+C would clear a draft) through the graceful despawn.
  It then removes the task's worktree only for one its own launch ledger noted, under its clone's
  `.claude/worktrees/`, by `git worktree remove` **without `--force`**, after `nothingLost`, never one
  touched since the turn ended (`TOUCH_SLACK_MS`; only where a live session's turn end was observed, not
  for a dead or exit-prompt pane), locked in git (bar Claude's own lock whose process is gone) or with a
  pane in it (`custodian-worktree.ts`).
- `notes` is stored only through `pruneNotes` (sections by `standing`, a live task id or a live pane,
  once each) within `NOTES_MAX`; `seance custodian notes --clear` is the owner's shell's act, never a
  frame.
- `flag` takes a reason from the fixed `FLAG_REASONS` (the daemon itself also sets `dirty` and
  `unpushed` when a close keeps a worktree) and an optional note of at most `FLAG_NOTE_MAX` characters,
  a printable-text rule applied before anything is stored. It acts only on a session of séance's own that
  is not the round's pane (`foreign` is refused; `marked` is not, since a flag acts on no pane), stores
  `{reason, note, at}` only in `custodian/sessions.json` (0600, the daemon's own file, never the owner
  CLI's `state.json`, keyed by task id or pane id, pane keys dropped at load) and tells the leader by one
  sealed, fire-and-forget `custodian-event`.
  - `stuck` and `look` lift on the session's next turn (a bound `busy` after an `idle` this process saw),
    on a close that kept nothing, or when no live session holds it. `dirty` and `unpushed` (whoever set
    them) lift only on a close that leaves nothing kept (the worktree removed, or none to decide on) or a
    re-assignment, never by a new turn or the session's end otherwise. Each lifts only after the leader's
    `unflag` was taken, or the entry stays for the next try.
  - The flags file is masked from the round's sandbox with `stateDir()` and denied to its `Read` by path
    and realpath (`roundReadDenies`). The note is display-only and never logged, audited, pushed,
    archived, put in `get_queue` or returned by `sessions`.
- `nudge` (text on stdin) delivers one `request` message only through messaging's local delivery
  (`Messages.deliverAsCustodian`, the `inbox` mod's submit: never a key, `asUser`, `$.prompt.fill` or
  tmux), the daemon its sender in the fixed `custodianRequest` wrapper, only to an `ours` pane carrying a
  task this machine's launch ledger holds — never one that is marked, the round's, sharing its task id
  with another live pane, or whose last state is `needs-input` or whose screen is a dialog or exit
  prompt. The pane is read again after its count is written and handed to the delivery with the pid and
  task counted under (`gone` for any other). Its text is at most `MESSAGE_PUSH_MAX` bytes, never logged
  or audited; at most `maxNudges` per session and one per round.
- `nudge` and `interrupt` answer `unsupported` for a Codex pane (no inbox mod; its Escape is the TUI's)
  until phase 3 sends `turn/steer` and `turn/interrupt`; `close` reads no Codex composer for a draft.
- `interrupt` sends only the constant key Escape (`["Escape"]`, never a frame field), once per session,
  only to an `ours`, unmarked, `live` pane whose last state is `busy` (never `needs-input`), whose input
  box holds no draft and whose screen, as read by a sampling pass taken after the count is written, has
  stood still for `interruptAfterMinutes`, re-reading the pane (pid, task, ownership) and its facts
  before the key.
- Both counts are the daemon's (C30): in `custodian/sessions.json` beside the flags, keyed by task id (or
  pane id when untasked) and bound to the session's pid, written before the act, dropped when the
  session ends, kept across a restart, never set by a frame and never sent to the leader.
- `done` takes a summary of at most `SUMMARY_MAX` that goes only into `rounds.jsonl`.
- Each round's `seance` is its own `<tmp>/bin/seance`, first on its `PATH`.
- Nothing a pane, the notes or the summary held is logged or audited: the `custodian` origin's lines are
  `op=close`, `op=worktree`, `op=flag`, `op=nudge` and `op=interrupt` with ids, outcomes and reasons.
  `custodian-cli.ts`'s stdout is the round's data channel; `capture` and `pr` write no line at all.

## The owner's verbs are the shell's acts, never a frame

`custodian-owner-cli.ts`.

- `seance custodian status | log | round | pause | resume` are dispatched from `main.ts` by `import()`,
  outside `custodian-cli.ts`'s import closure (this module logs and audits `origin=cli`), work from files
  and never the socket, and are denied to a round by generated fence entries (a mistake guard, not a
  boundary: the round's sandbox masks the `custodian/` dir and the tmux socket; drilled).
- Their files live in the 0700 `custodian/` dir, each 0600 and written durably: `state.json` (the pause;
  one the daemon cannot read loads as paused indefinitely), `round-request` (honoured only within
  `ROUND_REQUEST_TTL_MS`, spaced by `ROUND_REQUEST_MIN_GAP_MS`, dropped before launch) and `seat.json`
  (the seat's view, no `rc`).
- Everything read from a file reaches the terminal through `printable` (control, format, surrogate and
  separator characters become U+FFFD), since a round's summary quotes untrusted pane text.
- `MachineStatus.cu` is display-only and never trimmed by `fitStatus`; a bad `cu` is dropped alone, never
  the status. Its `rc` is kept only beside `running` and as `isRemoteSessionId` passes it, read by the
  daemon from `<configDir>/sessions/<pid>.json` only for the round pane's own pid or its direct child,
  never logged; the PWA's link origin is a constant.

## The controls are the owner's sealed act

- `custodian` (round now, pause, resume; `parseCustodianRequest`) acts only through the shell verbs' one
  implementation (`daemon/src/custodian-owner.ts`: never a second), which writes the pause or a round
  request in `custodian/` and nothing else.
- A daemon running no seat or one still starting answers `unsupported`; one whose host checks failed (or
  that refused to run rounds) refuses a round `host_failed`, reading the seat's own state, never
  `seat.json`. A round meets the shell's spacing and refusals. The daemon runs the op's acts on one
  chain, and against the shell the later owner act wins (each write one atomic rename of a file holding
  only the pause).
- The PWA offers the controls only for a connected machine advertising `CAPABILITIES.custodian` and shows
  a refusal as fixed text by its code; thresholds, the model and on/off stay in `config.json` (C46),
  never the op's.
