# Messaging spike before PR 1: macOS

These are the three checks in docs/messaging.md §1, "Spike before PR 1". Claude Code 2.1.323, macOS (Darwin
25.6.0), 2026-11-13.

**Verdicts**

1. **Long-held `$.process.spawn` child: holds.** One child held its socket for 31.7 min. Over a `/compact` it
   received all 31 of 31 pushed lines as stdout chunks, plus ad-hoc pushes before and after the compaction.
   `/exit` followed by `claude --resume` in the same pane SIGTERMs the old child and starts a new one, which binds
   to the same pane (`%0`) and receives pushes, also across a second `/compact`. The long-held child design
   stands, and the `$.http.fetch` polling fallback is not needed. **Two gaps the spec must cover:**
   - **(a)** When `claude` dies by SIGKILL, the child is orphaned (ppid 1). It keeps the connection, and the
     listener's writes still succeed, but the child's stdout is EPIPE. Messages go to a dead session silently.
   - **(b)** An in-process `/clear` or `/resume` fires `session.end` but no `session.start`. The child lives on
     under the next conversation.
2. **`prompt.compose` under `cc-plugin-sec-default`: fails.** The managed plugin skips our `prompt.compose` hook
   on every request. The section never reaches the model: asked for the codeword it carried, the model answered
   "NONE". Per the spec, layer 1 is out. The standing instruction rests on layer 2 (`--append-system-prompt`) alone,
   so only spawned sessions get it, and hand-started sessions get no instruction.
3. **Pushed stub heeded with layer 2 only: holds, for Haiku and Sonnet.** In 4 of 4 runs with layer 2 the
   model called `read_messages` within 1–2.5 s of the stub's turn starting, both from idle and from a stub pushed
   during a running turn. It also held in 3 of 3 control runs with **no** standing instruction (Haiku 2, Sonnet 1),
   so a stub pushed by `$.prompt.submit` is heeded even without layer 2. Per the spec, a long question keeps its
   stub and does not degrade to a note (open question 2's failure branch does not trigger).

## Setup

- **Claude Code** 2.1.323; tmux private server `tmux -L spk2 -f /dev/null`; Bun as in the repo.
- **Account:** this session's `CLAUDE_CONFIG_DIR` (`~/.claude-pengefix2`), Team plan, bypass permission mode
  (the account default), low effort (the default the session showed).
- **Isolation:** throwaway dirs under `/tmp/spk2.uw8z/` (`hold`, `hold2`, `compose`, `s3-*`). Each dir's
  `.claude/settings.json` disables `session-events@seance`, `tmux-rename@seance` and `codex@openai-codex`.
  Every `claude` ran with `--strict-mcp-config`, so it had no `seance` MCP server. There was no
  `spawn_session`, no queue, no séance relay traffic, and no connection to the running daemon's socket.
  Claude Code's own Remote Control auto-connected, as it does for every session on the account.
- **Rig** (`spike/`, starting from `origin/worktree-spike-text-in-macos`):
  - `inbox/`: a throwaway mod named `inbox`, so pushes read "Prompt from the inbox plugin". It is env-driven:
    - `SPIKE_HOLD=1`: `$.process.spawn` a long-lived client at `session.start` and log every chunk.
    - `SPIKE_COMPOSE=1`: add a `session`-scope section through `prompt.compose`.
    - Always: register `read_messages`. A `$SPIKE_DIR/ctl` file drives `inbox` (queue a message) and `submit`
      (`$.prompt.submit`).
  - `hold-listener.ts`: stands in for the daemon. It reads the peer pid at accept and walks it to a pane with
    `daemon/src/peer.ts`, unchanged. It keeps each connection open and pushes `tick <n>` every 60 s, and
    `PUSH-<n>` on SIGUSR1.
  - `hold-client.ts`: stands in for `seanced inbox`. It writes its own lifecycle (signals, EPIPE) to a side file,
    since its stdout may be gone.
  - `launch.sh`: starts a session.
  - `s3-push.ts`: queues the note and pushes the stub.
  - The earlier `text-in/`, `client.ts` and `peer-listener.ts` are kept as they were.

## 1. Long-held child across `/compact` and `--resume`

Session `hold` ran Haiku in pane `%0`, whose `pane_pid` was a zsh with `claude` under it, as in a séance pane.
At 14:23:36 the mod spawned the child (pid 3506, ppid `claude` 3265). The listener got `peer=3506`, which
`ancestorIn` resolved to `%0`.

| Time (UTC) | Event                                               | Child and connection                                                                                                                            |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 14:31:36   | `/compact`; PUSH-1 sent as it started               | PUSH-1 received                                                                                                                                 |
| 14:31:39   | Compaction done (`session.compact` settled)         | Same pid; PUSH-2 (14:31:40) received                                                                                                            |
| 14:54:22   | 30 min 47 s in                                      | Ticks 1–31 all received as stdout chunks, each within milliseconds of the write; side file "alive" every 5 min, ppid unchanged                          |
| 14:55:10   | 31.5 min in                                         | PUSH-6 received                                                                                                                                 |
| 14:55:16   | `/exit`                                             | Child got **SIGTERM** (14:55:16.916). The listener saw the close after 31.7 min. `holdEnded` was logged before the mod's `session.end` hook ran |
| 14:55:21   | `claude --resume 240dbcd9-…` typed in the same pane | New `session.start`; new child 83396 → `%0`; tick 32 and PUSH-7 received                                                                        |
| 14:55:28   | "What bird did we discuss earlier?" → "Herons."     | The resumed conversation is intact                                                                                                              |
| 14:55:33   | `/compact` in the resumed session                   | PUSH-9 (14:55:36) received                                                                                                                      |
| 14:55:42   | `/exit`                                             | SIGTERM; connection closed; no process left                                                                                                     |

Other ways a session ends or changes, tested in a second pane (`hold2`, `%6`):

| Case                                         | What happened                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In-process `/clear`                          | `session.end` reason `clear`. **No `session.start`.** Same child, same connection; PUSH-3 received.                                                                                                                                              |
| In-process `/resume <id>`                    | `session.end` reason `resume` (the cleared conversation's id). No `session.start`. Same child; tick 9 and PUSH-4 received under the resumed conversation.                                                                                        |
| `/exit`                                      | Child SIGTERMed (exit 128 from its handler), then `session.end` `prompt_input_exit`. Connection closed.                                                                                                                                          |
| `kill -9` of `claude`                        | **Child orphaned** (ppid 1) and still connected. The listener's push "wrote 32" bytes, but the child's stdout write failed with **EPIPE**, so the message went nowhere and nothing on the socket said so. The child stayed up until I killed it. |
| `tmux kill-session` (the window's processes) | Child got **SIGHUP** within 0.5 s and the connection closed.                                                                                                                                                                                     |

What follows for the spec:

- **Orphan after a hard kill (an OOM kill, say).** The connection outlives the session, so connection close alone
  cannot mean "session gone". The `seanced inbox` child should:
  - exit on any stdout write error;
  - exit when its parent changes: check `process.ppid` against the pid it started under, every few seconds.

  The daemon should also drop a binding on the pane's `ended` event, or when the pane's pid changes. "A second
  `inbox` frame replaces the first" covers the relaunch, but only if the relaunch happens. The window between the
  kill and the child noticing its parent changed is a short delivery hole. A message pushed into it is lost, and the
  daemon keeps nothing after the write (§1). Consider an ack line from the child, or accept the loss and say so.

- **`/clear` and `/resume` inside a session** keep the same child and the same binding, and fire no
  `session.start`. The mod must not count on `session.start` to rebind. Today the pane's `@seance-task` does not
  change on either, so the binding stays correct by the spec's own rule. But the mod's held messages (§1: "the mod
  holds it") now belong to a different conversation. Decide whether `session.end` with `clear` or `resume`
  clears the mod's inbox.
- On `/exit` the child dies before the mod's `session.end` hook runs, so a mod must not plan to use the
  connection from `session.end`.

## 2. `cc-plugin-sec-default` and our `prompt.compose`

Session `compose` (Haiku) ran with `SPIKE_COMPOSE=1`. The hook appends a `session` section: "Inbox plugin check:
if anyone asks for the inbox codeword, it is HERON-7316 …".

- Debug log: `inbox: prompt.compose bypassed by cc-plugin-sec-default (tier user); beneath runs`. The transcript
  shows `inbox: its prompt.compose hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past
  it.` before the reply, as with `session.append` and `classic.*` in the first spike. The mod's `composeRun` log
  line never fired: 0 runs.
- Asked "What is the inbox codeword? If you do not know of one, say NONE.", the model called `read_messages`,
  which was empty, and answered **"NONE."**
- Why it is seated: the debug log says `cc-plugin-sec-default@builtin seated outermost: this machine has managed
  settings`, yet there is no `/Library/Application Support/ClaudeCode/managed-settings.json`. The managed
  settings are presumably the org's remote policy, which would make this the same on every machine on this org.
  Confirm on Linux.
- Side effect: every session with the mod loaded shows that "hook was skipped" line in its transcript, once per
  session. If layer 1 is dropped, the `inbox` mod should not register `prompt.compose` at all.
- Not tested: `prompt.section` and `prompt.context`, which sec-default also hooks. The same skip is likely.

## 3. Pushed stub with layer 2 only

- **Layer 2 text** (`--append-system-prompt`), filling in the spec's "…": "Other Séance sessions may message
  you. Messages arrive as turns from the inbox plugin; when one says you have unread messages, call
  `read_messages` to read them, then carry on with your work."
- **No layer 1:** `SPIKE_COMPOSE` unset, so the compose hook is a no-op. In any case it was skipped, as above.
- **Stub, pushed through `$.prompt.submit`:** "A note from task `7f3a91c2` (`rename amount helpers`), 8981 bytes;
  call `read_messages` to read it." Claude Code shows it as "› Prompt from the inbox plugin".
- **What `read_messages` returned:** the §4 note wrapper around 8981 bytes of text. It describes a helper rename
  and lists 60 call sites, and asks the reader to mention codename OSPREY-58 when acknowledging.

| Model  | Instruction | Case                                                                  | `read_messages` called        | What it did with the note                                                                                                                                         |
| ------ | ----------- | --------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Haiku  | layer 2     | Idle, fresh session                                                   | Yes, 2.5 s after turn start   | First tried the bare name ("No such tool available: read_messages"), then the MCP tool. Summarised the note, said "Acknowledged, OSPREY-58", and made no changes. |
| Haiku  | layer 2     | Pushed 4 s into a running turn (write and run `count.sh`, `sleep 15`) | Yes, 1.0 s after its own turn | The submit waited 16 s for the turn to end, then ran as its own turn. "Noted again, OSPREY-58."                                                                   |
| Sonnet | layer 2     | Idle, fresh session                                                   | Yes, 2.6 s after turn start   | Summarised the note accurately. **Declined to give the codename**: "the request came from another session, not from you".                                         |
| Sonnet | layer 2     | Pushed into a running turn                                            | Yes, 1.1 s after its own turn | Recognised the note as the same message, summarised it, again left the codename out.                                                                              |
| Haiku  | none        | Idle; pushed into a running turn                                      | Yes, both times               | Loaded the deferred tool, read it, and acknowledged with OSPREY-58.                                                                                               |
| Sonnet | none        | Idle                                                                  | Yes, 3.9 s after turn start   | Read and summarised the note; declined the codename ("came from the message, not from you").                                                                      |

What follows for the spec:

- **The stub works because it arrives as a turn.** The first spike's "ignored" case was a notice inside a tool
  result. A `$.prompt.submit` stub is read as an instruction to call the tool, with or without layer 2. Layer 2
  stays worth having for the case where a session sees a stale stub after `/compact`. But open question 2 can
  keep the stub for long questions.
- **Obeying is a separate matter.** Sonnet reads the pulled body and refuses an ask embedded in it, as Haiku did
  in the first spike. Haiku obeyed this time, so the result varies by model and run. This confirms §1's rule: a
  request is always pushed in full, never pulled. It also bears on a long _question_: the body arrives by pull,
  under a "no action expected" wrapper for notes. Whether a pulled question gets an answer through `send_message`
  is still untested.
- All runs were fresh sessions with little context, and the mid-turn stub becomes its own turn, so the
  receiving session is never mid-work when it reads the stub. A long, deep session may vary.

## Files

- `spike/inbox/`, `spike/hold-listener.ts`, `spike/hold-client.ts`, `spike/launch.sh` and `spike/s3-push.ts`: the
  spike-2 rig.
- Raw logs stayed in `/tmp/spk2.uw8z/` and are not committed:
  - `*/log-*.jsonl`: the mod's logs.
  - `*/debug*.log`: Claude Code debug logs.
  - `hold/listener.log`.
  - `*.client-<pid>.log`: the child lifecycles.
