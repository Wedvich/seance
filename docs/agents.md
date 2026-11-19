# Other agents (Codex, …) — scoping

**Status: analysis, nothing built.** Decided only what "Antigravity CLI", below, records (2026-11-19).
Written 2026-11-13 from an owner voice memo
(2026-11-12) and a read of the codebase at `ff048d3`. The question: could Séance spawn sessions of
agents other than Claude Code — OpenAI Codex first, later Gemini, Mistral or whatever a free-token
campaign makes worth using — so a ChatGPT subscription's quota can carry some of the work? The
owner's picture: pick a model like any other in the model list (a GPT model beside Opus), on an
account record of its own, one account per provider. This file is the rough scope and the order;
it becomes a spec once the spike below has answered its questions.

## What the CLI offers

Checked against `codex --help` on codex-cli 0.163.0 (2026-11-12), not assumed:

- `-m <model>`, `-C <dir>`, `--worktree` (a managed git worktree, like `claude --worktree`),
  `--add-dir`, `-a <approval policy>` (`on-request`, `never`, …), `-s <sandbox>` (`read-only`,
  `workspace-write`, `danger-full-access`), `--dangerously-bypass-approvals-and-sandbox`.
- `codex exec` (non-interactive, `--json`, `-o <last message file>`, `exec resume`), `codex resume`,
  `codex fork`, `codex queue` (queue a message for an existing session).
- `codex mcp` (MCP servers per config), `codex plugin`, and the `hooks` feature flag, `stable` and on.
- `codex remote-control start|stop|pair` — **experimental**: an app-server daemon with remote
  control on, which a TUI joins with `--remote <ws|unix addr>`. Not a per-session flag like
  `claude --remote-control`.
- `CODEX_HOME` (default `~/.codex`) holds `auth.json`, `config.toml`, `sessions/`,
  `models_cache.json` — the counterpart of `CLAUDE_CONFIG_DIR`.

Not checked, from memory: that Codex's session logs carry the 5-hour and weekly rate-limit
windows (`rate_limits.primary`/`secondary`, used percent and reset time). The spike confirms it.

## Where Séance assumes Claude

| Layer                  | Size  |
| ---------------------- | ----- |
| The agent as a concept | M     |
| Launch                 | L     |
| Accounts               | M–L   |
| Quota and routing      | M     |
| Session events         | M (L) |
| MCP tools              | S–M   |
| Clients and the record | M     |

**The agent as a concept** (`shared/src/types.ts`, task records). Nothing names which agent runs a
task: the model is a free string, `DEFAULT_MODEL = "opus"`, and the PWA's list is
`MODELS = ["fable", "opus", "sonnet", "haiku"]` (`pwa/src/state.ts`). Needs an `agent` on the spawn
request and the task spec, a `CAPABILITIES` flag, and a dep sentinel through the one task sealer
so an older leader refuses a Codex task rather than handing it to `claude` — the same pattern as
`requires` and attachments. Codex's `models_cache.json` could supply its model list instead of a
hard-coded one.

**Launch** (`daemon/src/spawn.ts`, `sessions.ts`, `despawn.ts`, `trust.ts`). The command is built
for claude (`-n`, `--remote-control`, `--session-id`, `--resume`, the stale-resume env vars);
sessions are recognised by `--remote-control` in `pane_start_command`; the trust dialog is answered
in `.claude.json`; `.claude/worktrees` is where worktrees live. `daemon/src/backend.ts` is a seam,
but for the whole backend (a fork swaps tmux out), not per agent: it splits into an agent adapter
— build argv, recognise a pane, close gracefully, answer trust, resume — beside the tmux backend.
Autonomy maps onto `-a`/`-s`. Open: whether codex takes a non-tty stdin as its opening prompt
(the seed must never be argv), and whether the daemon can choose the session id up front — the
continue invariant resumes "the Claude session id this daemon chose at that launch", never one
from a frame; without an id flag the daemon reads it after launch from its own `CODEX_HOME`.

**Accounts** (`daemon/src/exclaves.ts`, `auth-health.ts`, `ExclaveInfo`, `AccountRecord`). An
exclave is a tree plus `~/.claude-<name>`; its account id is `organizationUuid:accountUuid` from
`.claude.json`; `seatTier` and `extraUsageEnabled` are Claude's. A Codex account is
`CODEX_HOME=~/.codex-<name>` per exclave, its id read from `auth.json` — which is a credential
store, so auth health's rule holds: read only through the short-lived child running the one
constant script, keeping only an exact-shape result. An exclave then carries one account per
agent, and an account record's id is namespaced by agent.

**Quota and routing** (`QuotaObservation`, `daemon/src/usage-refresh.ts`, `scheduler/src/route.ts`).
Codex's two windows fit `h`/`d` (and their reset stamps) without a schema change; the source and
the refresh poke are new. Routing filters accounts by the task's agent; `gatedModels` and seats
stay Claude-only. Scoring across agents is the load-balancing question below.

**Session events** (`claude-mods/session-events`). Busy, idle with `turnEnded`, needs-input,
ended and the PR report come from Claude Code plugin hooks calling `seance session-event`. A
`codex-mods` counterpart on Codex's hooks is plausible. The remote session id becomes a link into
the ChatGPT/Codex app instead of `claude.ai/code/<id>`, in the PWA and in push notifications.

**MCP tools** (`report_task_done`, `hand_off_task`, `pass_to_successor`). Agent-neutral already:
they bind by peer pid. `seance mcp` needs registering in each `CODEX_HOME`'s config, as
`daemon/src/link.ts` does for Claude.

**Clients and the record.** The PWA's model picker grouped by agent, the Accounts and Machines
screens, Raycast's options, MCP `spawn_session`'s schema, skills (`.claude/skills` vs Codex's).
DESIGN.md's threat model gains a second credential store and a second binary; CLAUDE.md's
invariants gain the new sentinel and capability.

## The two risks

1. **The session UI.** Séance is a spawner because the official Claude app is the session UI
   through Remote Control (DESIGN.md, "Problem & scope"). Codex's remote control is experimental
   and shaped differently: an app-server daemon that TUIs connect to.
2. **Binding by peer pid.** If a Codex session runs inside that app-server rather than in the tmux
   pane, its hooks do not descend from the pane, and binding a session event to its pane by the
   kernel-reported peer pid — a threat-model invariant — has nothing to bind to. This is the
   largest unknown; it decides whether session events are M or L.

## Order

0. **Spike**, one session, probing only: does a tmux-run `codex` reach the ChatGPT app over remote
   control; where do its hooks run (whose child); does it read a seed from stdin; where do the
   rate-limit windows live; can the daemon choose the session id.
1. **Headless first.** `codex exec` for `autonomy: "auto"` queued tasks only, the agent chosen
   explicitly on the task: no session UI, no needs-input; the task ends on process exit or a
   reported PR. Covers the agent concept, launch, accounts and a basic quota reading — about 4–5
   PRs — and already spends the ChatGPT quota.
2. **Parity.** Interactive sessions over remote control, session events, continue, pass to a
   successor, needs-input alerts. About 4–6 more PRs, depending on the spike.
3. **Load balancing.** The leader's `auto` choosing the agent as well as the account. A policy
   question, not a code one: is a Codex session interchangeable with an Opus one for a given task?
   Keep the agent explicit until Codex has a track record on these repos.

**Further agents** (Mistral, …). Once the adapter exists, each is a launcher, an account reader, a
quota reader and a hook mod. Worth it only where the CLI has hooks and a remote UI; otherwise
headless only. Google's is the next section.

## Antigravity CLI (`agy`)

Added 2026-11-19 from a read of Google's docs, release notes and third-party integrations, then
probed the same day on a live binary: **`agy` 1.5.12**, macOS (arm64), a pengefix.no Workspace
account on the "Antigravity Starter Quota" tier, run in a private tmux server. Rows below say where
the binary disagreed with the docs; the spike's answers are at the end.

**Gemini CLI is not the target.** Google folded it into Antigravity (announced 2026-05-19). Since
2026-06-18 Gemini CLI serves only paid API keys and Gemini Code Assist Standard/Enterprise, which are
per-token billing. Google AI Pro/Ultra subscriptions, the quota worth spending, now go through
**Antigravity CLI (`agy`)**: a Go binary, closed source by third-party accounts, with a feedback-only
repo at `github.com/google-antigravity/antigravity-cli`. It keeps hooks, skills, subagents and
plugins (Gemini CLI's extensions), not at 1:1 parity. Closed source means every question below is
answered by probing a live binary, and its hook shapes can change between releases with nothing but
release notes to say so.

### Against the two risks

`agy` is shaped more like `claude` than Codex is. **Remote control is per session**: `agy
--remote-control` (or `/remote-control` in a session) opens a reverse tunnel tied to that terminal
process. It prints `https://antigravity.google.com/r/<instance-id>?p=c%2F<conversation-id>` and ends
when the process exits. The UI is a web dashboard, no native app; a home-screen PWA carries
notifications. A separate `agy remote-control start` registers an always-on daemon as an OS service,
the Codex shape, which Séance would not use. Remote control can be off by Workspace policy ("Remote
control is not enabled for your account"); it was on for the pengefix.no account.

**Both risks pass (1.5.12).** A tmux-run `agy --remote-control` showed on the dashboard (machine by
hostname, then the session's conversation under "CLI Project") and a prompt sent from Chrome on
Android ran in the pane, firing the same hooks as a typed one. The dashboard lists a conversation
only once it has a first message. Hooks, the status line, the tools' commands (`run_command`) and
MCP stdio servers are all **direct children of the pane's `agy` process**, which keeps no other
child: the "server-side harness" is not a local process, so binding by peer pid holds.

### Mapping

| Séance need              | `agy` (1.5.12, probed)                                                                                                                             | Fit                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| busy                     | `PreInvocation` hook, once per model call (`invocationNum`), several per turn                                                                      | good                                                      |
| idle with `turnEnded`    | `Stop` hook: `fullyIdle: true`, `terminationReason: "NO_TOOL_CALL"`, `continuationActive`; **not fired on an interrupted turn**                    | good, plus the status line's `idle` for interrupts        |
| needs-input `permission` | the status line (below): `agent_state: "tool_use"`, `tool_confirmation_pending: true`                                                              | good; a dialog answered within ~300 ms is never seen      |
| needs-input `question`   | `PreToolUse` / `PostToolUse` on `ask_question` (`toolCall.args.questions`); the status line shows `tool_use` with no pending flag                  | good for the tool; a prose question reads as idle         |
| ended                    | no `SessionEnd` hook                                                                                                                               | the daemon seeing the pane die                            |
| `agent.session`          | every hook's `conversationId` (also `$ANTIGRAVITY_CONVERSATION_ID` in the hook's env), `transcriptPath`; the status line's `conversation_id`       | good; `""` until the first prompt                         |
| daemon-chosen session id | none: `--conversation <unknown id>` warns `conversation "<id>" not found` and mints one; `ANTIGRAVITY_CONVERSATION_ID` at launch is ignored        | threat-model change (below)                               |
| seed never in argv       | none for the TUI: a non-tty stdin turns `agy` into print mode (answers, exits 0); `-i -` opens the TUI with `-` as the prompt, stdin unread        | a seed file and a constant `-i` prompt                    |
| autonomy                 | `--mode accept-edits\|auto\|plan`, `--dangerously-skip-permissions`; `auto` is refused on the Workspace account (`--mode auto is not available …`) | fine                                                      |
| worktrees                | no `--worktree`                                                                                                                                    | the daemon's own `git worktree add`                       |
| quota                    | `agy -p "/usage" --output-format json`: `command.data.groups[].buckets[]` (`id`, `window`, `remaining_fraction`, `reset_time`), no model call      | good; also on the status line as `quota`                  |
| account id               | the status line's `email` and `plan_tier`; the keychain item (service `gemini`) names no account                                                   | display id only while a session runs                      |
| config                   | `~/.gemini/config/` (hooks, MCP, plugins), `~/.gemini/antigravity-cli/` (settings, logs, `brain/` transcripts); `HOME` is the only override found  | one account per OS user, or per `HOME`                    |
| per-session settings     | `--settings <json or path>`: `settings.json` keys for this session only, never saved                                                               | the status line without touching the owner's              |
| MCP tools                | `agy mcp add <name> <cmd>` writes `~/.gemini/config/mcp_config.json`; stdio servers start with the session                                         | register `seance mcp` there, as `link.ts` does for Claude |

**Hooks** are `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and
`Stop` (official). They are configured in `~/.gemini/config/hooks.json` or a repo's
`.agents/hooks.json`, run via `sh -c` with a 30 s default timeout, and get camelCase JSON on stdin.
Gemini CLI's `Notification` event (`notification_type: "ToolPermission"`) did not carry over.
`PreToolUse` runs before the permission policy, deciding `allow` (defer to policy), `auto_approve`,
`deny`, `ask`, `force_ask` or `deny_unless_prior_grant`. It fires on every matched call whether a
prompt follows or not, so it is no permission signal on its own; Pushary's phone approvals make the
hook the approval instead.

**Hooks as observed (1.5.12).** Every event carries `hookEventName`, `cwd`, `conversationId`,
`workspacePaths`, `transcriptPath` (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`),
`artifactDirectoryPath`, `modelName` (`gemini-3.8-flash-high`) and `lastUserInput` (prompt text: never
log it), and the hook's env has `ANTIGRAVITY_CONVERSATION_ID` equal to `conversationId`. Beyond that:

- `SessionStart`: nothing more. Fires at a new conversation's first prompt, not at launch, and **not
  on resume** (`--conversation <id>`).
- `PreInvocation` / `PostInvocation`: `invocationNum` (from 0, per model call in the turn) and
  `initialNumSteps`.
- `PreToolUse`: `toolCall` (`id`, `name`, `args`; `run_command`'s are `CommandLine`,
  `WaitMsBeforeAsync`, `toolSummary`) and `stepIdx`. `PostToolUse` adds `error` (`""` on success) and
  does not carry the tool's result (no `ask_question` answer).
- `Stop`: `executionNum` (0 throughout), `terminationReason`, `error`, `fullyIdle`,
  `continuationActive` (camelCase, not the docs' `continuation_active`). Every completed turn gave
  `fullyIdle: true`, `terminationReason: "NO_TOOL_CALL"`, including turns with tools and an
  `ask_question`. The binary's enum also names `USER_CANCELED`, `MAX_INVOCATIONS`, `ERROR`, `HALTED_STEP`,
  `TERMINAL_STEP_TYPE`, `INJECTED_RESPONSE`, `EARLY_CONTINUE`, `CHAINED` (prefix
  `EXECUTOR_TERMINATION_REASON_`), none seen.
- **An interrupted turn fires nothing**: Esc mid-thought, Esc at a permission dialog and "No, cancel"
  each ended the turn ("Interrupted · What should Antigravity CLI do instead?") with no `PostToolUse`,
  `PostInvocation` or `Stop`. Only the status line went back to `idle`.
- Hooks also fire in print mode (`-p`).

**The status line is the permission signal.** `statusLine` in `settings.json` (or in `--settings`
for one session, never saved) is a script `agy` runs via `sh -c`, a direct child of `agy`, about
every 300 ms while the state changes. Its stdin JSON is as documented, snake_case: `session_id` (equal
to `conversation_id`), `transcript_path` (a different path from the hooks':
`~/.gemini/antigravity/brain/<id>/…/transcript.jsonl`), `agent_state`, `cycle_mode`, `plan_tier`,
`email`, `quota` (by bucket id: `remaining_fraction`, `reset_time`, `reset_in_seconds`) and the rest.
States seen: `authenticating`, `idle`, `working`, `tool_use`. A permission dialog gave
`agent_state: "tool_use"` with `tool_confirmation_pending: true` on every run while it stood (two
runs ~300 ms apart within the first 0.6 s); `ask_question` gave `tool_use` with no pending flag. **The
throttle does swallow short dialogs**: six dialogs approved 100–140 ms after they appeared produced no
run with the flag. A human-answered dialog always showed; only an automated approver races it. It is
one global slot, so Séance's script would replace the owner's own status line unless it calls it and
passes its output through (`stack_with_default` is the documented knob, untested).

**Fallback signal.** Since 1.4.0 `agy` writes OSC 7501 (working, waiting for input, done, failed;
`AGY_CLI_OSC7501=on` forces it). tmux 3.8 drops it, and tmux master added `pane_program_state` for it
around 2026-11-12. Nothing shows `agy` sends the spec's `kind=permission|question`. Not probed: the
status line passed, so this stays a fallback, read with `tmux pipe-pane -O` if ever needed.

**Not useful here:** `agy acp` carries permission requests and question forms, but it is a stdio mode
for editors, not the interactive terminal session, and stream-json is `-p` only.

### Owner decisions (2026-11-19)

- **Antigravity is the second agent after Codex**; "Gemini" meant `agy`.
- **One `agy` account per machine for V1**, usable from any exclave's tree. An exclave is 1:1 with a
  Claude account only to isolate Claude accounts, and exclave trees are clones of the same repos.
  Multi-account per agent is not a V1 requirement.

What that means for the design:

- **The account hangs off the machine as an agent login, not off an exclave.** An exclave supplies
  only the tree. A future config-dir override then makes multi-account additive; 1.5.12 has only
  `HOME` (spike 7), which moves every other tool's config with it.
- **A stable account id is still needed.** The same Google account signed in on several machines must
  read as one account, or the fleet-wide account record, quota and per-account cap count it twice. If
  `agy` gives no non-credential identity, V1 treats each machine as its own account and accepts that.
  It gives one, the status line's `email`, but only from a running session (Gaps).
- **Routing** picks a machine where `agy` is signed in, then any exclave whose tree holds the repo,
  the default exclave first.
- **The global `hooks.json` fires for the desktop app's sessions too.** Peer-pid binding refuses them,
  but each costs a hook process. Accepted over a `.agents/hooks.json` committed to every repo; the hook
  script exits early outside a Séance tmux session.

### Gaps

- **Continue.** The invariant resumes "the session id this daemon chose at that launch". `agy` cannot
  take one (spike 5), so the daemon learns it from its own ledger plus the pane's first verified hook
  `conversationId`, which exists only from the first prompt. That is a CLAUDE.md invariant and a
  DESIGN.md threat-model change.
- **Interrupts.** No hook fires on an interrupted turn (above), so a `busy` with no `Stop` after it is
  normal. The status line's `idle` is the only end signal there; without it, an interrupted pane reads
  busy until its next turn.
- **Seed.** The TUI never reads stdin (spike 6). The seed goes in a file the daemon writes (0600, under
  `stateDir()`), and argv carries only a constant `-i` prompt naming it. A prompt the model reads from a
  file is a tool call: it needs a read permission the mode grants, and it lands in the transcript as a
  tool result, not a user turn.
- **Account policy.** The pengefix.no Workspace account had remote control on and `--mode auto`
  refused (`warning: --mode auto is not available for this account; continuing in the default mode`),
  although the TUI's first-run banner says "Auto is now the default agent mode". Its tier, "Antigravity
  Starter Quota", has weekly buckets only (`gemini-weekly`, `3p-weekly` for Claude and GPT models), no
  5-hour window. A personal Google AI Pro/Ultra account was not tried.
- **Account identity.** The only one found is the status line's `email` (with `plan_tier`), so it
  exists only while a session runs, and only through the status line slot. The keychain item (service
  `gemini`, created at sign-in) has an 11-character constant as its account, not the user. No
  `/usage` field names the account. Under the owner's V1 decision, the email is the cross-machine id,
  handled like any account id (HMAC'd, never a route).
- **Quota.** Users report multi-day lockouts and a dashboard at 1% while the CLI was blocked: read
  `/usage` as Google's word, not ground truth. Antigravity serves Claude models from the Google quota
  (`3p-weekly`: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B); a policy question, not a code one.
- **Self-update.** `agy` updates itself in the background during regular runs (the installer says
  so; `~/.gemini/antigravity-cli/updater/`), so the hook shapes above can change under a running
  fleet. The hook script must refuse unknown shapes, not guess.

### Spike (`agy`)

Run 2026-11-19 on one Mac, `agy` 1.5.12 (installed by Google's `install.sh` into `~/.local/bin`),
pengefix.no Workspace account, in a private tmux server. Hooks came from the scratch repo's
`.agents/hooks.json`, the status line from `--settings`, so no global config was written.

1. **Remote control: yes.** A tmux-run `agy --remote-control` printed
   `https://antigravity.google.com/r/<instance-id>` (no `?p=c%2F…` before a conversation exists). On
   Chrome on Android the dashboard showed the machine by hostname, and the conversation under "CLI
   Project" once it had a first message. A prompt sent from the phone ran in the pane and fired the
   same hooks as a typed one.
2. **Descendants: yes, direct children.** Every hook, the status line script, `run_command`'s
   commands and an MCP stdio server (started with the session) had the pane's `agy` as parent:
   `hook.sh → agy → zsh → tmux`. `agy` had no other child process.
3. **`Stop`: yes, on every completed turn**, `fullyIdle: true`, `terminationReason: "NO_TOOL_CALL"`
   (the only value seen), `continuationActive: false`. **Not at all on an interrupted turn** (Esc, or a
   declined or escaped permission dialog).
4. **Status line: yes**, `agent_state: "tool_use"` with `tool_confirmation_pending: true` on every run
   while a dialog stands. **The 300 ms throttle swallows a dialog answered within ~140 ms** (six of
   six). `ask_question` hits both `PreToolUse` and `PostToolUse` (`toolCall.name: "ask_question"`); the
   status line shows it as `tool_use` without the pending flag.
5. **Chosen conversation id: no.** `--conversation <fresh uuid>` warns `conversation "<id>" not found`
   and mints its own; `ANTIGRAVITY_CONVERSATION_ID` set at launch is ignored. `-p --output-format
   json` returns the minted `conversation_id`.
6. **Seed on stdin: no.** `agy < seed` with no `-i` runs print mode, answers and exits 0: no TUI, no
   remote control. `agy -i - < seed` opens the TUI (keys come from the tty) with the literal `-` as the
   prompt; stdin is never read.
7. **Config-dir override: only `HOME`.** Under another `HOME`, `agy` builds a fresh `.gemini/` tree
   and reads as signed out (asks for OAuth), so a second account per `HOME` looks possible but was not
   signed in. `ANTIGRAVITY_CONFIG_REL_DIR` changed nothing; no flag exists. **Identity without a
   credential: the status line's `email`**, nothing else (Gaps).
8. **`/usage` as JSON: yes.** `agy -p "/usage" --output-format json` makes no model call (0 tokens,
   `num_turns: 0`) and returns `command.data.groups[]`, each with `buckets[]` of `id`, `name`,
   `window` (`weekly` seen), `remaining_fraction` and `reset_time`.

Also: `SessionStart` does not fire on resume (`--conversation <id>`), nor at a bare launch.

1–4 pass, so `agy` skips the headless stage Codex needs and goes straight to parity, with the
interrupt and seed gaps above as its cost.

Sources: Google's transition post
(`developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/`),
`antigravity.google/docs/` (`remote-control/`, `cli/reference`, `cli/statusline`, `hooks.md`,
`plans`, `getting-started?tab=cli`), the `agy` release notes, `agy --help` (1.5.12),
`symposium.dev/design/agent-details/antigravity-cli.html`,
`pushary.com/antigravity-cli-notifications`, tmux issue 5713.

The launcher is not where the cost is. Every new task field takes the sealer, sentinel and
capability dance the invariants require, and a second credential store widens the threat model.
