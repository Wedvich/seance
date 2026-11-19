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

Added 2026-11-19 from a read of Google's docs, release notes and third-party integrations. **Nothing
was installed or run**: every row below is from documentation until the spike at the end confirms it.

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
the Codex shape, which Séance would not use. Hooks run via `sh -c`, and the session appears to live in
the pane's process, so binding by peer pid should hold. The blog's phrase "server-side harness shared
with Antigravity 2.0" is what the spike must rule out. Remote control can be off by Workspace policy
("Remote control is not enabled for your account").

### Mapping

| Séance need              | `agy`                                                                                                                                             | Fit                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| busy                     | `PreInvocation` hook                                                                                                                              | good                                                      |
| idle with `turnEnded`    | `Stop` hook: `fullyIdle`, `terminationReason`, `continuation_active`                                                                              | good                                                      |
| needs-input `permission` | the status line (below), `tool_confirmation_pending`                                                                                              | good if it fires on the dialog                            |
| needs-input `question`   | `PreToolUse` / `PostToolUse` matching the built-in `ask_question` tool                                                                            | good for the tool; a prose question reads as idle         |
| ended                    | no `SessionEnd` hook                                                                                                                              | the daemon seeing the pane die                            |
| `agent.session`          | every hook's `conversationId`, `transcriptPath`                                                                                                   | good                                                      |
| daemon-chosen session id | `--conversation <id>` resumes; nothing documented to set one at launch                                                                            | threat-model change if missing (below)                    |
| seed never in argv       | `-i <prompt>` is argv; `--input-format text\|stream-json` is documented for `-p` only                                                             | spike, or a seed file and a constant prompt               |
| autonomy                 | `--mode accept-edits\|auto\|plan`, `--dangerously-skip-permissions`; `auto` needs the terminal sandbox and is refused on business accounts        | fine                                                      |
| worktrees                | no `--worktree`                                                                                                                                   | the daemon's own `git worktree add`                       |
| quota                    | `/usage` (`/quota`), also `agy -p "/usage"`: a 5-hour window refreshed only while the weekly one holds                                            | fits `h`/`d`; JSON form unknown                           |
| account id               | unknown; tokens are in the OS keyring                                                                                                             | spike                                                     |
| config                   | `~/.gemini/config/` (hooks, MCP, skills, plugins, shared with the desktop app), `~/.gemini/antigravity-cli/settings.json`; no override documented | one account per OS user                                   |
| MCP tools                | MCP configured under `~/.gemini/config/`                                                                                                          | register `seance mcp` there, as `link.ts` does for Claude |

**Hooks** are `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and
`Stop` (official). They are configured in `~/.gemini/config/hooks.json` or a repo's
`.agents/hooks.json`, run via `sh -c` with a 30 s default timeout, and get camelCase JSON on stdin.
Gemini CLI's `Notification` event (`notification_type: "ToolPermission"`) did not carry over.
`PreToolUse` runs before the permission policy, deciding `allow` (defer to policy), `auto_approve`,
`deny`, `ask`, `force_ask` or `deny_unless_prior_grant`. It fires on every matched call whether a
prompt follows or not, so it is no permission signal on its own; Pushary's phone approvals make the
hook the approval instead.

**The status line is the permission signal.** `statusLine` in `settings.json` is a script `agy` runs
via `sh -c` "whenever the agent state changes", at most every 300 ms. Its stdin JSON carries
`tool_confirmation_pending` ("true when a tool confirmation dialog is showing") and `agent_state`
(`idle`, `working`, `tool_use`, `reviewing`, `authenticating`, `initializing`, `error`). Unconfirmed:
that a dialog appearing counts as a state change, and that the throttle cannot fold it into a
neighbouring run. It is one global slot, so Séance's script would replace the owner's own status line
unless it calls it and passes its output through.

**Fallback signal.** Since 1.4.0 `agy` writes OSC 7501 (working, waiting for input, done, failed;
`AGY_CLI_OSC7501=on` forces it). tmux 3.8 drops it, and tmux master added `pane_program_state` for it
around 2026-11-12. Nothing shows `agy` sends the spec's `kind=permission|question`. Needed only if the
status line fails the spike; otherwise `tmux pipe-pane -O` is the way to read it.

**Not useful here:** `agy acp` carries permission requests and question forms, but it is a stdio mode
for editors, not the interactive terminal session, and stream-json is `-p` only.

### Owner decisions (2026-11-19)

- **Antigravity is the second agent after Codex**; "Gemini" meant `agy`.
- **One `agy` account per machine for V1**, usable from any exclave's tree. An exclave is 1:1 with a
  Claude account only to isolate Claude accounts, and exclave trees are clones of the same repos.
  Multi-account per agent is not a V1 requirement.

What that means for the design:

- **The account hangs off the machine as an agent login, not off an exclave.** An exclave supplies
  only the tree. A future config-dir override then makes multi-account additive.
- **A stable account id is still needed.** The same Google account signed in on several machines must
  read as one account, or the fleet-wide account record, quota and per-account cap count it twice. If
  `agy` gives no non-credential identity, V1 treats each machine as its own account and accepts that.
- **Routing** picks a machine where `agy` is signed in, then any exclave whose tree holds the repo,
  the default exclave first.
- **The global `hooks.json` fires for the desktop app's sessions too.** Peer-pid binding refuses them,
  but each costs a hook process. Accepted over a `.agents/hooks.json` committed to every repo; the hook
  script exits early outside a Séance tmux session.

### Gaps

- **Continue.** The invariant resumes "the session id this daemon chose at that launch". If `agy`
  cannot take one at launch, the daemon learns it from its own ledger plus the pane's first verified
  hook `conversationId`. That is a CLAUDE.md invariant and a DESIGN.md threat-model change.
- **Account policy.** A Workspace account may have remote control off and cannot use `--mode auto`; a
  personal Google AI Ultra account likely has both.
- **Quota.** Users report multi-day lockouts and a dashboard at 1% while the CLI was blocked: read
  `/usage` as Google's word, not ground truth. Antigravity reportedly also serves Claude models from
  the Google quota; a policy question, not a code one.

### Spike (`agy`)

Probing only, on one Mac, beside the Codex spike in "Order" above:

1. Does a tmux-run `agy --remote-control` appear on the dashboard and drive the session from Chrome
   on Android?
2. Are hook processes, the status line script and MCP stdio servers descendants of the pane's process?
3. Does `Stop` fire with `fullyIdle` at each turn's end, and what are `terminationReason`'s values?
4. Does the status line run with `tool_confirmation_pending` when a permission dialog shows, and does
   `ask_question` hit `PreToolUse`?
5. Can the daemon choose the conversation id at launch?
6. Does interactive `agy` read its seed from a non-tty stdin?
7. Is there a config-dir override, and an account identity readable without a credential?
8. Can `/usage` be read as JSON (`agy -p "/usage" --output-format json`)?

If 1–4 pass, `agy` skips the headless stage Codex needs and goes straight to parity.

Sources: Google's transition post
(`developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/`),
`antigravity.google/docs/` (`remote-control/`, `cli/reference`, `cli/statusline`, `hooks.md`,
`plans`), the `agy` release notes, `symposium.dev/design/agent-details/antigravity-cli.html`,
`pushary.com/antigravity-cli-notifications`, tmux issue 5713.

The launcher is not where the cost is. Every new task field takes the sealer, sentinel and
capability dance the invariants require, and a second credential store widens the threat model.
