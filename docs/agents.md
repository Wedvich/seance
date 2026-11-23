# Other agents (Codex, …) — scoping

**Status: analysis, nothing built.** Decided only what "Antigravity CLI", below, records (2026-11-19).
Codex was spiked on 2026-11-19 ("Codex spike", below); its answers revise the order. Codex's design,
built on this file, is docs/codex.md (2026-11-23); where the two differ it wins (the owner chose one Codex home per
login over the pool of paired homes this file's verdict proposes).
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
windows (`rate_limits.primary`/`secondary`, used percent and reset time). The spike found a better
source: the app-server's `account/rateLimits/read` ("Codex spike", below).

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
DESIGN.md's threat model gains a second credential store and a second binary; the `.claude/rules/`
invariants gain the new sentinel and capability.

## The two risks

1. **The session UI.** Séance is a spawner because the official Claude app is the session UI
   through Remote Control (DESIGN.md, "Problem & scope"). Codex's remote control is experimental
   and shaped differently: an app-server daemon that TUIs connect to.
2. **Binding by peer pid.** If a Codex session runs inside that app-server rather than in the tmux
   pane, its hooks do not descend from the pane, and binding a session event to its pane by the
   kernel-reported peer pid — a threat-model invariant — has nothing to bind to. This is the
   largest unknown; it decides whether session events are M or L.

Answered by the spike (0.166.0): by default it does run inside that daemon, and binding holds only
with a server per pane, which remote control allows once per `CODEX_HOME`. "Codex spike", below.

## Order

0. **Spike**, one session, probing only: does a tmux-run `codex` reach the ChatGPT app over remote
   control; where do its hooks run (whose child); does it read a seed from stdin; where do the
   rate-limit windows live; can the daemon choose the session id. **Done 2026-11-19**; it moves step
   1 from `codex exec` to an app-server the daemon owns ("Revised fit", below).
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
headless only. Google's is "Antigravity CLI", below.

## Codex spike

Run 2026-11-19 on one Linux box (Debian 13, x86_64, tmux 3.5a), **codex-cli 0.166.0** from npm, a
ChatGPT Business account, in a private tmux server. Hooks and approvals were driven against a local
Responses API mock (`model_provider` at `127.0.0.1`) under a scratch `CODEX_HOME`, so no quota was
spent on them. Remote control, quota and identity ran under the real `~/.codex` with a handful of real
turns, the phone being the ChatGPT app on Android.

### How Codex runs a session

**The TUI is always an app-server client** (JSON-RPC v2), in one of three modes:

- **Embedded:** the server runs in process.
- **Local daemon:** one shared server per `CODEX_HOME`. This is the default (`daemon_auto_start`,
  stable and on), auto-started and detached (parent pid 1).
- **Remote:** `--remote unix://<sock>|ws://…`.

These bypass the daemon and run embedded: `--no-daemon`, `--dangerously-bypass-hook-trust`,
`--profile`, `--oss`, `--strict-config`, or any `-c` other than `features.*`.

**The daemon updates itself** into `CODEX_HOME/packages/app-server-daemon/`. By the end of the spike it
ran 0.170.0 under a 0.166.0 CLI, though the TUI's update prompt had been told to skip 0.170.

The server's unix control socket speaks WebSocket. Its API is typed and generated
(`codex app-server generate-json-schema`). The calls that matter here:

- `thread/start`, `turn/start` (input as data), `turn/steer`
- `account/read`, `account/rateLimits/read`
- `remoteControl/enable`, `remoteControl/status/read`, `remoteControl/pairing/start`, `remoteControl/client/list`

### Against the two risks

**Binding by peer pid: fails by default, holds per pane.** In default mode, these are all children of
the shared daemon, not of the pane:

- hooks
- tool commands
- MCP stdio servers

A hook's `TMUX_PANE` is that of whichever pane happened to start the daemon, so it names the wrong
pane.

There are two ways to keep everything in the pane's process tree:

- run the session with `--no-daemon`;
- run a server per pane (`codex remote-control --no-daemon`) with the TUI joined to its socket
  (`--remote unix://<sock>`).

Either way, binding holds. An escalated command ran as `zsh` under the pane's own server, and the MCP
probe was a child of the pane's process.

**Remote control: works, but only one server per `CODEX_HOME`.** `codex remote-control` enrolls the
installation, one per `CODEX_HOME`, at `wss://chatgpt.com/backend-api/wham/remote/control/server`.

Pairing the app took `remoteControl/pairing/start` with `manualCode: true` over the server's socket.
The app needed a restart before it connected the first time. After that it showed:

- the machine by hostname;
- projects by cwd;
- the threads in that `CODEX_HOME`'s store.

**A second remote-control server on the same `CODEX_HOME` is refused** with 409 "Remote app server
already online". So a server per pane gives remote control to one session per account per machine.

Approvals and turns across clients:

- An approval pending in a turn the TUI started was **not** shown on the phone.
- A turn started from the phone showed its approval on the phone, and the command ran on the pane's
  server.
- A turn another client starts, in a thread a TUI has open, shows live in that TUI (`turn/start` sent
  over the pane server's socket).

The two risks therefore pull in opposite directions: binding wants a server per pane, and remote
control allows one server per account.

### Mapping

| Séance need              | Codex (0.166.0, probed)                                                                                                           | Fit                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| busy                     | `UserPromptSubmit` at a turn's start, `PreModelRequest` / `PostModelRequest` per model call                                       | good                                                 |
| idle with `turnEnded`    | `Stop`: `stop_hook_active`, `last_assistant_message` (model text: never log it)                                                   | good                                                 |
| interrupted turn         | `Interrupt` hook, fired instead of `Stop`                                                                                         | good (better than `agy`)                             |
| needs-input `permission` | `PermissionRequest` (`tool_name`, `tool_input`) when the dialog opens; OSC 7501 `state=blocked:app=codex:kind=permission`         | good                                                 |
| needs-input `question`   | `request_user_input` exists in Plan mode only (its tool description says so); in Default mode a question is prose                 | a prose question reads as idle, as with `agy`        |
| ended                    | `SessionEnd` (`reason: "other"` on exit)                                                                                          | good                                                 |
| `agent.session`          | every hook's `session_id` (a UUIDv7) and `turn_id`, `transcript_path`                                                             | good                                                 |
| daemon-chosen session id | none for the TUI: resuming an unknown id is refused; `thread/start` returns the id before any turn runs                           | through a server the daemon owns (below)             |
| seed never in argv       | none for the TUI: it needs a tty, so its prompt is argv only; `turn/start` takes the input as data                                | through a server the daemon owns                     |
| autonomy                 | `-a` / `-s`, or `approvalPolicy` / `sandboxPolicy` per turn on `turn/start`                                                       | fine                                                 |
| quota                    | `account/rateLimits/read`: a 300-minute and a 10080-minute window, `usedPercent`, `resetsAt`; no model call                       | maps to `h`/`d` as is                                |
| account id               | `account/read`: `planType`, `workspaceName`, email. Rollouts carry `creator_user_id`; `auth.json`'s account id is the workspace's | the user id, read over the API, not from `auth.json` |
| config                   | `CODEX_HOME` moves everything: auth, config, hooks, sessions, the daemon                                                          | one account per directory, unlike `agy`'s `HOME`     |
| hooks config             | `CODEX_HOME/hooks.json`, Claude Code's shape, 14 events; each needs a trust hash in `config.toml` (below)                         | Séance writes the hashes, or uses managed hooks      |
| MCP tools                | `[mcp_servers]` in `config.toml`; children of whatever runs the session                                                           | bind only per pane (above)                           |

**Hook trust.** Each hook needs `[hooks.state."<hooks.json path>:<event>:0:0"] trusted_hash =
"sha256:…"` in `config.toml`. The TUI writes this on the owner's approval. `--dangerously-bypass-hook-trust`
skips the check but forces embedded mode. Séance would write the hashes beside its `hooks.json`, or use
managed hooks (`/etc/codex/hooks.json`, root-owned; not tried).

**Sandbox.** On Linux, tool commands run under bwrap plus seccomp: `touch /etc/…` was denied.

### Spike answers

1. **Reaches the ChatGPT app: yes**, through `codex remote-control` plus a TUI on `--remote`. Pairing
   took `manualCode: true`. Only one such server per `CODEX_HOME`.
2. **Whose child are hooks:** whatever runs the session. By default that is the shared daemon, which
   breaks binding. With `--no-daemon` or a server per pane it is the pane, and binding holds.
3. **Seed on stdin: no.** The TUI needs a tty. Over the app-server, `turn/start` takes the input as
   data.
4. **Rate-limit windows:** `account/rateLimits/read`, with no model call. Rollouts were not needed for
   this.
5. **Chosen session id: no.** Resuming an unknown id is refused. `thread/start` hands the id back before
   anything runs.

### Revised fit

**Codex fits better than this file assumed on 2026-11-13, but as a server, not as a pane.** The
app-server is a typed API that answers, in one place, what the CLI does not:

- a thread id known before anything runs;
- the seed as data;
- quota and identity with no credential read;
- turn and approval state as notifications.

When the spike's client started a turn, it received `thread/status/changed` without subscribing to
anything.

**Candidate design (not decided).** The Séance daemon owns one app-server per Codex account directory.
It is started and pinned by the daemon, never the auto-start daemon, and it is that server's client:

- **Launch.** `thread/start` (cwd the worktree, sandbox and approvals from autonomy) gives the id, which
  the launch ledger notes. Continue then resumes "the id this daemon's own server returned", never one
  from a frame. `turn/start` carries the seed.
- **State.** Session state comes from the server's notifications on threads the daemon created, so no
  hook needs binding, and the hooks are optional.
- **The pane.** A pane, when wanted, is a view: `codex resume <id> --remote unix://<sock>`. The mirror
  test makes that plausible; it was not run.
- **Remote control.** It is turned on for that one server, and the phone sees every Séance thread on
  that account.

What it costs:

- **The pane is not the session.** Despawn becomes a thread interrupt plus closing the pane. A dead pane
  ends nothing.
- **Tools that bind by peer pid cannot tell sessions apart.** Tools and MCP servers are children of the
  one server, so `report_task_done`, `hand_off_task` and `pass_to_successor` cannot bind that way. Two
  ways out:
  - The daemon serves them as dynamic tools, per thread. The schema has `item/tool/call` and
    `DynamicToolSpec`, but they are not on the stable `thread/start`, and this was not tried.
  - They bind by the server's pid plus the claimed `session_id`. A tool in one session could forge that
    for another, so it is a threat-model change.
- **One server is one failure domain** for every session on that account.
- **The account directory is Séance's alone.** The owner's own Codex on the same `CODEX_HOME` would take
  the one remote-control slot, and its auto-start daemon must not run there.

Open questions, for the next spike:

- Where does an approval go in a turn the daemon started: to the daemon, the phone, or both? The answer
  decides how needs-input reaches the PWA.
- Does `codex resume <id> --remote` attach to a thread another client started?
- Can dynamic tools be registered on the version that ships?

**Order, revised.**

- **Step 1** is the daemon-owned server, with no pane: `autonomy: "auto"` tasks, approval `never`,
  sandbox `workspace-write`, state from notifications, quota and identity over the API. It replaces
  `codex exec`, and it is the base parity builds on rather than a stage thrown away.
- **Step 2** adds the pane view and remote control.

`agy` passes the pane model as it stands; Codex needs this server model. The owner's order (Codex,
then `agy`) stands, but `agy` is the smaller change to Séance's shape.

### Panes or a sidecar

**Owner's preference (2026-11-19).** Native tmux panes, as with Claude Code, come first. A sidecar
server the daemon owns is acceptable if panes cannot work. If the sidecar dies, the Séance daemon must
not go down with it: it sheds the sidecar and keeps running.

**What Codex offers for tmux.** This was a read of `--help`, the 0.166.0 binary's strings, `openai/codex`
`main` and its issues, not a probe.

- **There is no `--tmux`.** The request for one (#12862, "add --worktree and --tmux flags") closed with
  only `--worktree` shipped. "/fork into a pane" (#9798) closed unmerged.
- **Codex is tmux-aware only as a terminal:**
  - It detects tmux from `TMUX`/`TMUX_PANE`.
  - At startup it probes the pane with `tmux display-message` for `extended-keys-format` and `mouse`,
    with a 1 s timeout, and 0.168 adds `allow-passthrough` and the client's terminal features.
  - It adapts keyboard and mouse to what that probe reports.
  - It copies to the clipboard through `tmux load-buffer`, with an OSC 52 fallback.
  - It wraps its OSC 9 notifications in tmux passthrough.
  - It sets the terminal title (`tui.terminal_title`, default `activity`, `thread-name`,
    `project-name`), which shows an action-required text while blocked. Inside tmux that should land in
    `#{pane_title}`, a cheap signal beside OSC 7501. That is inferred, not tested.
- **Nothing sends input into a running session from outside except `codex queue --thread <id>
  --message <text>`.** It goes through the app-server, and puts the message on argv. Upstream still has
  open requests for a supported way to send input (#15355, #36694). Pasting into the pane wedges the
  composer when `send-keys Enter` follows at once (#28167).
- **Upstream knows about the binding problem the spike hit.** #48500 says the shared daemon runs hooks
  with the `TMUX_PANE` of the TUI that started it, and a maintainer did not take it as a bug. #58431 and
  #60625 say nothing local tells which thread a TUI pid shows while the daemon runs. Stdio MCP servers
  get `TMUX`/`TMUX_PANE` only through `env_vars` (#37209).

**Native panes, as far as the spike goes.** A pane runs `codex --no-daemon` (or its own
`remote-control --no-daemon` server plus `--remote`). Binding by peer pid then holds, and
`Stop`/`Interrupt`/`PermissionRequest` map cleanly. The gaps:

- **The session id is not chosen.** The daemon learns it from the first verified hook's `session_id`,
  as `agy`'s gap does: a threat-model change.
- **The seed is argv only.** It is the same gap as `agy`'s and needs the same seed-file answer.
- **The phone gets one remote-controlled session per `CODEX_HOME`.** Homes that share one sign-in each
  get their own enrollment, but each needs pairing once by hand ("A `CODEX_HOME` per pane", below). So
  the shape is a fixed pool of paired homes per machine, not a fresh home per session.
- Without remote control, a pane is a local-only session, which may be enough for `autonomy: "auto"`
  tasks.

### A `CODEX_HOME` per pane

A second spike ran on 2026-11-19 on the same machine and account, with codex-cli 0.166.0. It read the
source at `rust-v0.166.0` and at `main` (0.170.0). Answers marked inferred come from the source alone.

1. **A symlink shares a sign-in; a copy does not.**
   - **Where it lives.** The store is `CODEX_HOME/auth.json`: `tokens` (id, access and refresh tokens,
     the account id) and `last_refresh`. The keyring mode is keyed by a hash of the home's path, so it
     is per home and cannot be shared.
   - **Refresh tokens rotate.** A forced refresh changed all three token hashes, and reusing an old
     token is refused as `refresh_token_reused` ("sign in again"). So a copied `auth.json` that
     refreshes logs out every other copy (inferred). Whether the server then revokes the whole login was
     not tested.
   - **A refresh writes through a symlink.** 0.166 truncates in place (same inode); 0.170 resolves the
     link and renames atomically onto the target.
   - **The lock is per home** (`auth.lock`), so it is symlinked too.
   - **Concurrent refreshes.** A refresh reloads from disk first and skips if another process already
     refreshed. The network call itself can still race between two processes, as plain Codex's daemon
     and TUI can.
   - **When it refreshes.** Within 5 minutes of the access token's expiry (about 10 days here), or 8
     days after `last_refresh`. `account/read {"refreshToken": true}` forces one.
   - **Not an option.** Borrowed tokens (`account/login/start` with `chatgptAuthTokens`, refreshed by
     the client) are marked "UNSTABLE, FOR OPENAI INTERNAL USE ONLY". Not tried.
2. **Separate enrollments: yes, with no 409.** Two `remote-control --no-daemon` servers ran at once,
   one per home, both symlinked to one `auth.json`. Each got its own installation, server and
   environment, and both connected.
   - **Pairing is per home.** Neither showed in the app until each was paired with its own manual code,
     and each environment has its own client list.
   - **Every entry reads as the hostname** (`gethostname()`, not configurable). Panes are told apart in
     the app only by project (cwd) and thread.
   - The first pairing failed until the owner deleted an old offline entry for the machine in the app.
     The cause is unknown.
3. **Surviving a refresh: yes.** A forced refresh in home A wrote through to `~/.codex/auth.json`. Home
   B kept working on the access token it held in memory. B's own forced refresh then saw the changed
   file and skipped, and the owner's own daemon still answered.
4. **Cost and cleanup.**
   - **Cost.** A home is about 57 MB on disk, mostly the plugin and catalog caches; its enrollment is a
     row in `state_5.sqlite`. A server is about 110–125 MB resident. No daemon auto-starts under
     `--no-daemon`.
   - **Leftovers.** A killed server leaves its socket and lock in the shared `/tmp/codex-daemon-<uid>/`.
   - **Removing an entry.** `remoteControl/client/revoke` removes it from the app.
     `remoteControl/disable` only disconnects and leaves an offline entry, and nothing deletes an
     enrollment server-side.
5. **A restart keeps the pairing.** A paired server was SIGKILLed (the app showed it offline) and
   restarted in the same home. It logged "reusing persisted remote control enrollment" under the same
   environment, the phone stayed on its client list, and the app reconnected with no new code.
   - **What it takes.** The pairing lives in the home (`installation_id` plus the enrollment row, keyed
     by URL, account and client name), so the home must persist and the client name stay stable.
   - **What is lost.** Running turns die with the server; threads stay in the store.
   - **Not tested.** Whether an update, or a long time offline, discards the enrollment.

**Verdict.** A fresh `CODEX_HOME` per pane is impractical, because every new home needs a pairing code
typed on the phone. What works is a **fixed pool of long-lived homes per machine**, each paired once:

- each home's `auth.json` and `auth.lock` are symlinks to one store;
- a pane, or a sidecar the daemon restarts in place, takes a free home;
- a home is retired by revoking its client.

The same holds for a sidecar: one per home, restarted in place, keeps its pairing.

**Threat model.**

- **A second credential store.** It is one file per machine holding a ChatGPT refresh token. The daemon
  only links to it and never reads it, the same rule auth health keeps for Claude's.
- **Refresh.** Whichever Codex process finds it due refreshes it, about every 8 days; Séance never
  does.
- **Copies.** The ones that exist are that file, the symlinks, and short-lived tokens in each server's
  memory. Any other copy (a backup, a template home, a sandbox) is a bug, because its first refresh
  logs out the rest.
- **Shared blast radius.** Every Codex session on a machine shares one account, one quota and one blast
  radius.

**Sidecar, if panes fall short.** The sidecar is the daemon-owned server above, supervised as adapters
are (`adapter-supervisor.ts`):

- **Process and output.** It is a child in its own process group, killed by group, with stderr
  discarded and nothing it writes logged.
- **Version.** It runs the pinned binary with its self-update off.
- **Failure.** It restarts with backoff and is held `failed` after repeated crashes.

The daemon talks to it only over its socket, so a crash is a closed connection and an exit code, never
an exception in the daemon. Shedding it means:

- marking that account's Codex launches `interrupted` in the launch ledger, as a restart does;
- dropping the Codex account from the machine's status, so the leader places nothing new there;
- leaving every Claude session alone.

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
  `conversationId`, which exists only from the first prompt. That is a `.claude/rules/scheduler.md` invariant and a
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

1–4 pass, so `agy` fits the pane model as it stands (Codex needs the daemon-owned server instead) and goes straight to parity, with the
interrupt and seed gaps above as its cost.

Sources: Google's transition post
(`developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/`),
`antigravity.google/docs/` (`remote-control/`, `cli/reference`, `cli/statusline`, `hooks.md`,
`plans`, `getting-started?tab=cli`), the `agy` release notes, `agy --help` (1.5.12),
`symposium.dev/design/agent-details/antigravity-cli.html`,
`pushary.com/antigravity-cli-notifications`, tmux issue 5713.

The launcher is not where the cost is. Every new task field takes the sealer, sentinel and
capability dance the invariants require, and a second credential store widens the threat model.
