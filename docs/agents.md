# Other agents (Codex, …) — scoping

**Status: analysis, nothing decided, nothing built.** Written 2026-11-13 from an owner voice memo
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
ended and the PR report come from Claude Code plugin hooks calling `seanced session-event`. A
`codex-mods` counterpart on Codex's hooks is plausible. The remote session id becomes a link into
the ChatGPT/Codex app instead of `claude.ai/code/<id>`, in the PWA and in push notifications.

**MCP tools** (`report_task_done`, `hand_off_task`, `pass_to_successor`). Agent-neutral already:
they bind by peer pid. `seanced mcp` needs registering in each `CODEX_HOME`'s config, as
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

**Further agents** (Gemini, Mistral, …). Once the adapter exists, each is a launcher, an account
reader, a quota reader and a hook mod. Worth it only where the CLI has hooks and a remote UI;
otherwise headless only. Neither CLI was installed or checked.

The launcher is not where the cost is. Every new task field takes the sealer, sentinel and
capability dance the invariants require, and a second credential store widens the threat model.
