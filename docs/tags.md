# Tags, session identity and the adapter subscription

**Status: built and folded (2026-11-18).** The owner decided T1–T4 on 2026-11-17, and build steps 1 to 4 are built.
DESIGN.md is the record of each part:

| Part                                                                                                              | Where it lives in DESIGN.md                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The model: T1–T4, `creator.*` and `scheduler.*`, the levels, the vocabulary, the surfaces, rejected, threat model | "Tags and session identity"                                                    |
| Step 1: the vocabulary (`shared/src/tags.ts`), the frame's `agent`, the conversation table and its verification   | "Session events", "Session identity"                                           |
| Step 2: the `session-tag` op, `conversations.json`, the PWA's session names and rename                            | "Session identity", "The owner's label"; Threat model item 6                   |
| Step 3: task tags (`TaskSpec.tags`, the sentinel, `ownerTags`, `SpawnRequest.ref`)                                | "Task tags", with pointers in "Amending a waiting task" and the chain sections |
| Step 4: the adapter subscription and adapter tags                                                                 | "Adapters", "The subscription" and "Tags"; "Replies by handle" (D3 amended)    |

The PWA's per-namespace view of a session's tags and the session rename are built, on the Queue screen since
2026-11-24 (docs/work.md), after leaving the Machines card on 2026-11-19 ("Tags and session identity"). Not built: `self.*`, which
waits on docs/presence.md's `set_self_tag`.

What is left here: the open questions and the spikes' evidence that `agent.session`'s verification (the per-platform
`procStart` read and the 500 ms settle window) rests on.

## Open questions

1. **`self.name` at all?** It is third in T2's precedence and fills the hand-started case. **Taken as recommended in
   step 2, pending the owner's review:** yes, accepted by `set_self_tag` (not built), not asked for by the standing
   instruction, shown only on the owner's surfaces. Step 2's PWA already ranks it third and marks it "(self-named)";
   nothing writes it yet.
2. **Should an owner label on an untasked conversation follow it into a task?** Nothing adopts a hand-started session
   into a task today. _Recommend nothing until something does._
3. **Sessions outside the daemon's tmux server** (an IDE terminal), which a tool would also like to see. _Recommend
   not in this spec_: no pane, no peer-pid binding to a pane, no mod report; it would need its own binding model.
4. **The owner's label reaching adapters while a task runs.** Only the ref is dispatched (DESIGN.md, "Tags and session
   identity", "The join and the name"), so an adapter names a task's session by its title. _Recommend leaving it_
   unless the owner wants tools to show the label; then a scheduler-sealed push of `owner.label` to the task's machine,
   memory only.
5. **Filtering `get_queue` by `creator.ref`** for an orchestrator (orchestrator.md's "find its own tasks").
   _Recommend yes, with orchestrator.md's project-wide read_, not in this spec's PRs.
6. **`agent.kind` for Codex**: whether the daemon can corroborate it as it does for `claude` (`processNames`).
   Part of docs/agents.md's spike.
7. _Folded_: `creator.*` and `scheduler.*` were decided 2026-11-17 and sized at step 3 (DESIGN.md, "Tags and session
   identity", "Decided by the owner", and "Task tags", "The bound").
8. **An older keyless broker daemon drops `tags`** from a brokered enqueue (its `parseTaskSpec`), so a task a session
   queues through `seance mcp` or the CLI behind it lands untagged. Display data only, so no stale-broker check guards
   it (a `staleDaemonOf` test was weighed and left out). _Recommend leaving it_ unless refs become load-bearing.
9. **A task's tags carry the task's `createdAt` as their `at`**: a task has no per-key time, so an amended label shows
   the task's age. _Recommend keeping it_ until a surface wants "labelled 2 h ago"; then `owner.*` gets a stamp, which is
   a record-format change.

## Spikes

- **S1.** Does `<configDir>/sessions/<pid>.json`'s `sessionId` follow `/clear` and `/resume`, and how soon after the
  mod's `session.start`? On macOS and Linux, the current Claude Code.
- **S2.** Is the file written for every interactive `claude` (not only `--remote-control` ones, which is all the
  custodian has relied on), and for `kind`s other than `interactive`?
- **S3.** What precision `procStart` carries (observed as a date string to the second) and how it compares with
  `processStart` on each platform, including across a clock change; whether `startedAt` (ms) is the better match.

Both platforms are below. They agree on S1 and S2; S3 differs in `procStart`'s format, and the verification reads it
per platform (DESIGN.md, "Session identity", "Verification").

### Evidence, macOS (Claude Code 2.1.326, 2026-11-17)

Throwaway `claude` processes in panes of a private tmux server, in a trusted checkout, with no prompt typed but one
`-p` call. A watcher polled `sessions/*.json` every 5 ms and logged each change of `sessionId`; a `SessionStart`
command hook (from a `--settings` file, not the user's settings) logged its own time, `source` and `session_id`. That
hook fires on the event the mod's `session.start` rides. Timings are the watcher's first sight of the file minus the
hook's log line, so each is good to about ±5 ms. Ids were compared, never recorded.

**S1: the file follows `/clear` and `/resume`, in the same process.** Yes to both.

| Act                                | Tries | File names the new id                                                      |
| ---------------------------------- | ----- | -------------------------------------------------------------------------- |
| `/clear`                           | 11    | 13–19 ms **before** the hook (11/11)                                       |
| `/resume <id>`                     | 6     | 37–46 ms **after** the hook (6/6)                                          |
| fresh start                        | 4     | first write 3–390 ms before the hook, already carrying the hook's id (4/4) |
| `claude --resume <id>` (at launch) | 1     | first write 261 ms before the hook, already the resumed id                 |

`procStart`, `startedAt` and `pid` stay put across `/clear` and `/resume`; only `sessionId` (and `updatedAt`) moves.
`/resume` is the case that changed the design: a report read against the file at once would find the old id and be
refuted, so a report the file does not name yet is re-read over a settle window before it is refuted.

**S2: which `claude`s get a file.**

| Process                                                             | File?                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| interactive, Remote Control at startup (the config's own setting)   | yes, `bridgeSessionId` added about a second after the first write                        |
| interactive, `remoteControlAtStartup: false` (through `--settings`) | yes, with no `bridgeSessionId` key; follows `/clear` the same                            |
| `-p`                                                                | yes, for its life; `kind` is still `interactive`, `entrypoint` is `sdk-cli` (else `cli`) |
| `claude --resume <id>`                                              | yes, the resumed id from the first write                                                 |
| under a named exclave's `CLAUDE_CONFIG_DIR`                         | yes, in that dir's `sessions/`, none in the default one                                  |
| waiting at the trust dialog of an untrusted folder                  | no (and no `SessionStart` either)                                                        |

On exit: `/exit`, `SIGTERM` and the end of a `-p` run remove the file; `SIGKILL` leaves it, with its
`<pid>.<hash>.key` beside it, so a stale file for a later process with a reused pid is real and `procStart` is what
rejects it. `kind` does not tell a `-p` process from an interactive one on this version, so nothing should key on it.
The design holds: every config dir is searched, and a file only ever corroborates.

**S3: `procStart` against `processStart`.** `procStart` is a `ctime`-style string (`Ddd Mmm d HH:MM:SS YYYY`) in
**UTC, with no zone**: read as local time it is off by the zone offset (an hour here), read as UTC it equals the
seconds part of `processStart`'s `sec.usec` exactly, in 9 of 9 files (the spike's and the machine's other sessions'
files, read for these two fields only). `ps -o lstart` shows the same second in local time. `processStart`'s
microseconds are unpadded (`.1477` is 1477 µs), so it is compared as two integers, never parsed as a decimal.
`startedAt` (ms) is the process's own clock read early in its boot, 0.30–0.61 s after the kernel's start in the same
9 files: it cannot match `processStart` exactly, and a window wide enough to hold it would be wider than `procStart`'s
one second. `procStart` is the match; `startedAt` is at most a sanity bound (never earlier than the kernel's start).

A clock change was not tested: stepping the clock needs root and would disturb every other process on the owner's
machine (TLS, timers, other sessions). By reasoning only: macOS keeps a process's start as wall time stamped at fork
and never adjusts it, and `procStart` agrees with it to the second (so it is most likely read from the kernel, not
from Claude's own clock), so a step moves neither side and the match survives. Linux, where
`processStart` is ticks since boot and a date string has to add a boot time, is where a clock change could matter and
is part of the Linux run.

### Evidence, Linux (Claude Code 2.1.326, 2026-11-17)

The macOS method, on a Linux host (Proxmox VE kernel 7.0, `CLK_TCK` 100, system zone UTC): throwaway `claude`
processes in panes of a private tmux server, in a trusted checkout, no prompt typed but one `-p` call; a watcher
polling every config dir's `sessions/*.json` every 5 ms and logging each change of `sessionId`; a `SessionStart`
command hook from a `--settings` file logging its own time, `source` and `session_id`. Ids were compared as hashes,
never recorded. Timings are the watcher's first sight minus the hook's log line, good to about ±5 ms; the hook stamps
its line after its shell and `jq` start, so the event itself is a few ms earlier than the hook's time.

**S1: the file follows `/clear` and `/resume`, in the same process.** Yes to both, as on macOS; the timings differ.

| Act                                | Tries | File names the new id                                                  |
| ---------------------------------- | ----- | ---------------------------------------------------------------------- |
| `/clear`                           | 17    | 19 ms before to 3 ms after the hook (17/17); macOS was always before   |
| `/resume <id>`                     | 6     | 13–30 ms **after** the hook (6/6)                                      |
| fresh start                        | 5     | first write 225–826 ms before the hook, already carrying the hook's id |
| `claude --resume <id>` (at launch) | 1     | first write 92 ms before the hook, already the resumed id              |
| `-p`                               | 1     | first write 6 ms **after** the hook, carrying its id                   |

`procStart`, `startedAt` and `pid` stay put across `/clear` and `/resume`, as on macOS. What changed the design: on
Linux a `clear` (and a `-p` start) can be written just after the event, not only a `resume`, so any report the file
does not name yet is held over the settle window, whatever its source, instead of `resume` alone. The slowest lag seen
on either platform is 46 ms, so the 500 ms window stands.

**S2: which `claude`s get a file.** The same answers as macOS.

| Process                                                             | File?                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| interactive, Remote Control at startup (the config's own setting)   | yes, `bridgeSessionId` added 1.16 s after the first write                    |
| interactive, `remoteControlAtStartup: false` (through `--settings`) | yes, with no `bridgeSessionId` key; follows `/clear` and `/resume` the same  |
| `-p`                                                                | yes, for its life (1.2 s here); `kind` `interactive`, `entrypoint` `sdk-cli` |
| `claude --resume <id>`                                              | yes, the resumed id from the first write                                     |
| under a named exclave's `CLAUDE_CONFIG_DIR`                         | yes, in that dir's `sessions/`                                               |
| with no `CLAUDE_CONFIG_DIR` (the default dir)                       | yes, in `~/.claude/sessions/`, none in the named exclave's                   |
| waiting at the trust dialog of an untrusted folder                  | no (and no `SessionStart` either)                                            |

On exit: `SIGTERM` and the end of a `-p` run remove the file; `SIGKILL` leaves it with its `<pid>.<hash>.key`. `/exit`
removes it, but in 2 of 5 tries (one with Remote Control on, one with it off after `/resume`) the file reappeared
about 10 ms after its removal and was gone for good 0.5–0.8 s later. Its `pid` and `procStart` still name the exiting
process, so a reader matching both is not misled; a reader treating the file's presence alone as "running" would be.
The first write carries fewer keys than later ones (`status`, `statusUpdatedAt` and `updatedAt` arrive with the
first status update), so a reader requires only the keys it uses. Linux files also carry `pidDomain`,
`linux:<machine-id>:pid:[<pid-namespace inode>]` (the `/etc/machine-id` and `/proc/<pid>/ns/pid` of the writer),
besides `version`, `peerProtocol`, `peerFeatures`, `messagingSocketPath`, `tmux` and `asksForConvertedSkills`; the
design uses none of them.

**S3: `procStart` against `processStart`.** **`procStart` on Linux is not a date string**: it is the decimal string
of `/proc/<pid>/stat`'s field 22, the start time in clock ticks since boot, exactly what `processStart`
(`daemon/src/peer.ts`) returns. It equals `processStart(pid)` byte for byte in 10 of 10 files (the spike's processes
and the machine's other sessions' files, read for these two fields only), under the default and two named config
dirs, and with `TZ=Europe/Oslo` set on the `claude` process. So the Linux match is string equality, exact to the
tick (10 ms here), with no parse and no zone. `startedAt` (ms) trails the kernel's start by 0.30–0.42 s in 7 files
(the kernel's start taken as `CLOCK_REALTIME − CLOCK_BOOTTIME` plus the ticks, so good to a tick): as on macOS it
cannot match, and `procStart` is the match.

A clock change needs no test on Linux: both sides are ticks since boot, so a wall-clock step moves neither, and no
date conversion (where a step would matter) happens on either side. The platforms disagree only in format, which is
why the verification reads `procStart` per platform.
