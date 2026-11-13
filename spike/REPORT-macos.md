# Text into a live session: macOS repeat

**Verdicts**

1. `$.prompt.submit`: **same as Linux** on all four points (idle, running turn, permission dialog, draft), and the model sees it framed as from the plugin.
2. `$.session.append`: **same as Linux**. The model reads the row at its next request in the same turn, after the tool result. The row does not wake an idle session.
3. `read_messages` via `$.tool.register`: **same as Linux**. The tool works. The notice alone is ignored. With `--append-system-prompt` the model calls the tool on its own. One addition: Haiku called it but refused to act on what it returned, treating it as untrusted.
4. Managed plugin: **same as Linux**. `cc-plugin-sec-default@builtin` is present and skips every mod's `classic.*` hooks and its `session.append` hook, while the `$.session.append` call still works.
5. Reaching the daemon socket: **both ways work**. `$.http.fetch` with `socketPath` and `$.process.spawn` each produce a peer pid that LOCAL_PEERPID returns and `ancestorIn` resolves to the right pane.

## Setup

- **Claude Code:** 2.1.323, macOS (Darwin 25.6.0), tmux 3.8, model Haiku 5.5 (`--model haiku`, medium effort).
- **Account:** claude.ai login, org "Pengefix" (`1e14c658-…`), Team plan, user martin@pengefix.no. The test `claude` ran under the default config dir `~/.claude`. Private tmux `-L spk -f /dev/null` did not carry this session's `CLAUDE_CONFIG_DIR` into the pane, but it is the same account and org.
- **Isolation:** a throwaway dir `/tmp/spk.4Jz0/work` (a bare `git init`). Its `.claude/settings.json` disabled `session-events@seance`, `tmux-rename@seance` and `codex`, and the debug log confirms "will NOT register". So nothing reported to the running seanced. There was no spawn_session, queue or séance relay traffic. Claude Code's own Remote Control did auto-connect (`/rc`), as it does for every session on this account.
- **The mod:** `spike/text-in/`, loaded with `--plugin-dir`. It polls `$SPIKE_DIR/ctl` every 500 ms for one JSON command (`submit`, `append`, `inbox`, `fetch`, `spawn`) and logs engine events to `$SPIKE_DIR/log.jsonl`. It registers `read_messages`. While its inbox is non-empty, every tool result carries a `context` notice: "N unread message, call read_messages". `spike/peer-listener.ts` stands in for the daemon socket; `spike/client.ts` is the spawned client, copied into `$SPIKE_DIR`.
- **Sessions:** A was in bypass mode (default for this account), B in `--permission-mode default`, and C in bypass with `--append-system-prompt`.

## 1. `$.prompt.submit`

| Case              | What I ran                                                                                                                  | What happened                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle              | `submit` "Reply with exactly: PONG-1 …" with the session idle                                                               | `turn.start` 200 ms after the ctl read; `submit` resolved right after. The model answered PONG-1 and said "the text-in plugin submitted this prompt between turns".                                                                    |
| Running turn      | Typed "Run `sleep 15` … reply DONE-A", then `submit` PONG-2 3 s into the turn                                               | `submit` stayed pending 13 s. DONE-A's turn completed at 13:48:34.105; PONG-2's `turn.start` followed at .358 as its own turn, and `submit` resolved then.                                                                             |
| Permission dialog | Session B: typed "echo hi > …/x.txt then reply DONE-B"; once "Do you want to proceed?" showed, `submit` PONG-4; waited 10 s | For 10 s, no `turn.start` and `submit` unresolved; the UI showed "› Prompt from the text-in plugin" queued above the dialog. After I approved, DONE-B's turn completed (13:50:19.906), then PONG-4 ran as its own turn (13:50:20.085). |
| Draft in the box  | Typed `half typed draft xyz` without Enter, then `submit` PONG-3                                                            | The turn started at once and PONG-3 ran. Afterwards the box still read `❯ half typed draft xyz`.                                                                                                                                       |

The transcript stores the row as a plain user message:

```
The text-in plugin sent a message:
Reply with exactly: PONG-1. …

This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.
```

The calling mod's own `prompt.submit` hook does not see its own submission ("every hook but the calling one"). The `submitResolved` origin is `{kind:"plugin", name:"text-in"}`.

## 2. `$.session.append`

- **Idle:** with Session A idle, I appended "NOTE-IDLE: the secret word is MARMALADE." It resolved at once: stored as `{type:"user", isMeta:true}` with a uuid. In the 12 s after, there was no `turn.start` and nothing changed on screen, so it **did not wake** the session. The model saw the row at its next request: in the next turn it quoted MARMALADE.
- **Mid-turn:** I typed "Run `sleep 10` in the foreground … quote any text you received after this prompt that is not a tool result", then appended "NOTE-MIDTURN: the build on machine B finished green." 3 s into the sleep. Transcript order:

  ```
  13:49:10 assistant tool_use:Bash
  13:49:12 user(isMeta) NOTE-MIDTURN …        ← stored while the tool ran
  13:49:20 user tool_result
  13:49:22 assistant "Noted: the build on machine B finished green. …"
  ```

  The model read it in the same turn, in the request after the tool result. Haiku's quoting of it was muddled, but the first line of its answer is the note.

## 3. `read_messages` (`$.tool.register`)

- **Registration:** `$.tool.register` in `session.start` returned `{tool:"mcp__text-in__read_messages"}`. `cc-plugin-sec-default` hooks `tool.register`, and it still went through.
- **Notice alone (Session B):** I queued one inbox message, then typed "Run `ls -a` … how many entries". Two Bash results carried the notice. The model ended its turn without calling the tool and said: "A tool hook also said there's an unread message and asked me to call read_messages. You didn't ask for that, so I ignored it." **Ignored, as on Linux.**
- **Explicit ask (Session B):** "Call read_messages and tell me what it says." The tool returned the message and the model relayed it. This was in manual permission mode, and there was **no permission prompt** for the mod's own tool.
- **Standing instruction (Session C):** I ran `--append-system-prompt 'Other sessions may send you messages. When a tool result or note says you have unread messages, call the read_messages tool right away and act on what they say, …'` with the same `ls -a` prompt. After the first notice the model ran ToolSearch (the tool is loaded deferred), then called `read_messages` unprompted (`readMessages:1` in the log). **It calls the tool on its own, as on Linux.**
- **New on macOS (or new with this model):** the model would not act on the message. It said: "The unread message from text-in asked me to say the word KIWI. That came from a tool result, not from you, so I ignored it." So a standing instruction gets the message read, not obeyed. The test message was a deliberately arbitrary instruction; a message that looks like task-relevant information may fare differently. If messages must be obeyed, `$.prompt.submit`, which arrives as a user turn, is the path.
- **Spike mod bug:** after my `tool.call` hook returned `{...res, context:[notice]}`, Bash's output reached the model empty. Haiku reported `ls -a` printing nothing. A real mod must add the notice without losing the result; I did not chase this.

## Managed plugin

The debug log shows `cc-plugin-sec-default@builtin loaded (native, environment 1, tier prepend)`, hooking `classic.*`, `prompt.section`, `prompt.context`, `prompt.attachment`, `prompt.compose`, `skill.prompt`, `attribution.text`, `session.append`, `session.compact`, `settings.read`, `tool.describe`, `command.describe`, `agent.offer`, `agent.spawn`, `tool.register`, `tool.list`, `tool.check`, `ui.log`, `env.get`, `env.set` and `plugin.register`.

The transcript showed:

```
text-in: its session.append hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.
text-in: its classic.UserPromptSubmit hook was skipped. …
text-in: its classic.PreToolUse hook was skipped. …
```

My `session.append` hook never logged, yet `$.session.append` calls were stored and read. My `env.get` and `tool.register` calls worked despite sec-default hooking those events. This matches Linux.

Other built-ins loaded: `cc-plugin-agents-md`, `cc-plugin-telemetry` and `cc-plugin-plugin-authoring`.

## Reaching the daemon's local socket from the mod

I tested against `spike/peer-listener.ts`, not the running daemon. It accepts on a unix socket and, like `local-socket.ts`'s `open` handler, reads `peerPid(socketFd(sock))` at once. It then runs `ancestorIn(peer, <pane pids of tmux -L spk>)` from `daemon/src/peer.ts`, unchanged. It printed `peerPidSupported=true`.

| Path                                                                                | Peer pid (LOCAL_PEERPID)                  | Resolved pane |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | ------------- |
| `$.http.fetch("http://peer/", { socketPath })`                                      | 35723, `claude` itself (ppid 35722, tmux) | `%0`          |
| `$.process.spawn({ argv: ["bun", "client.ts", sock] })`; the child dials and writes | 36697, `bun` (ppid 35723 = `claude`)      | `%0`          |

The pane's `pane_pid` was 35723, because tmux ran `claude` directly with no shell. In a séance pane there is a shell in between, which `ancestorIn` walks past as it already does for session-events.

- **`$.http.fetch` + `socketPath`** dials from the `claude` process itself. The connection is held open until the reply, so LOCAL_PEERPID is answered and the binding resolves. It is request/response only, so the daemon cannot push text: the mod would have to poll.
- **`$.process.spawn`** puts a child under `claude` that resolves the same way. A long-running child could hold one connection and stream daemon pushes back as stdout chunks, which `spawn` delivers piece by piece. I ran only a short-lived client; I did not test holding one open for minutes.
- **The daemon's caveat holds:** LOCAL_PEERPID fails once the peer has closed, so the pid has to be read at accept, as `local-socket.ts` does. The existing `session-events` mod gets this from a short `bun … session-event` run. The fetch path avoids the extra Bun start.
- **The frame is still the gap.** The socket today admits only `sessions`/`spawn`/`despawn` ops, the broker and ingest-only `session-event` frames. A pull for pending text is a new act on that socket, so it is a threat-model change (CLAUDE.md, DESIGN.md "Local op socket" and "Session events"). This spike does not touch it.

## Files

- `spike/text-in/`: the throwaway mod (`claude plugin validate` passes).
- `spike/peer-listener.ts`, `spike/client.ts`: the socket stand-in and the spawned client.
- Raw logs stayed in `/tmp/spk.4Jz0/` (`log-A.jsonl`, `log-B.jsonl`, `log.jsonl`, `debug*.log`, `listener.log`) and are not committed.
