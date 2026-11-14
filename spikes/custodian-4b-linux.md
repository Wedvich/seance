# Custodian 4b — Linux spikes

Answers, by experiment, to the open spikes in docs/custodian.md, Build order item 4b ("Contain the round"), for
Linux. No product code was changed, no round was started, and the daemon was not touched. Everything started for the
experiments (listeners, `sleep`, scratch dirs under `$HOME` and `/tmp`, one transient user unit that ran `/bin/true`)
was stopped or deleted.

## Host and versions

| What            | Value                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host            | Proxmox **LXC container** (`systemd-detect-virt` → `lxc`), kernel `7.0.14-8-pve`, uid 1000                                                                    |
| `/proc/sys`     | read-only mount (`/proc/sys ro,relatime`): `procSysReadOnly(/proc/self/mountinfo)` → **true**, so the fence sets `enableWeakerNestedSandbox`                  |
| Claude Code     | `2.1.325` (native binary; its own sandbox runtime is bundled)                                                                                                 |
| sandbox-runtime | `@anthropic-ai/sandbox-runtime@0.0.81` via `srt`. 0.0.82/0.0.83 exist but are inside the owner's npm `min-release-age = 14`, so not installed                 |
| bubblewrap      | 0.12.0; socat 1.8.0.3; Python 3.13.5; Bun 1.4.4 (mise)                                                                                                        |
| ripgrep         | none on the host. `srt` refuses to start without `rg`; a symlink named `rg` to the claude binary works (`ripgrep 14.1.1`) and was put first on `srt`'s `PATH` |

**How each answer was obtained.** "srt" = driven model-free through `srt -s <settings> -c '<probe>'`; "CC" =
confirmed through `claude -p --model haiku --settings <file> --setting-sources project --permission-mode dontAsk
--strict-mcp-config` in a scratch dir, asking it to run the exact probe or tool call. Every srt finding that Claude
Code could change was rechecked under CC; the two agree everywhere except the round-dir mount-point failure under
"Inverted form" below (CC-only).

Probe helpers (in the scratch dir `$X`, not committed):

- `listener.py <path> <log>`: an outside AF_UNIX listener that logs `SO_PEERCRED` (pid, uid) of each peer and walks
  the peer's `PPid` chain in the host's `/proc`.
- `client.py <path|@abstract> [tag]`: `connect()` only; with no tag it sends nothing. Prints `CONNECT OK` or
  `CONNECT FAIL <errno text>`.

### Base settings (the fence's Linux `sandbox` block, as `srt` settings)

The fence's `sandbox` block for this host (`custodianFence({ platform: "linux", weakerNested: true })`), in srt's
format; each question adds to `filesystem`:

```json
{
  "enableWeakerNestedSandbox": true,
  "enableWeakerNetworkIsolation": true,
  "filesystem": { "denyRead": [], "allowWrite": [], "denyWrite": [] },
  "network": {
    "allowedDomains": ["github.com", "api.github.com", "*.githubusercontent.com"],
    "deniedDomains": [],
    "allowAllUnixSockets": true
  }
}
```

The CC runs used the fence's shape too (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`,
`autoAllowBashIfSandboxed`, `enableWeakerNetworkIsolation`, `enableWeakerNestedSandbox`, `allowAllUnixSockets`, the
three GitHub domains, `denyWrite: [<cwd>]`, `permissions.defaultMode: "dontAsk"`) plus the `denyRead`/`allowRead` or
permission rules each question names.

## Summary

| Q   | Question                                                 | Verdict                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Does a `denyRead` mask stop `connect()`?                 | **Masked.** A masked dir is an empty tmpfs: `connect()` → `ENOENT` for own listener, tmux socket, daemon main socket                                                                                                                |
| Q2  | `/run/user/<uid>`, `/run/dbus`, `/run`, `/var/run` masks | **Masked** with them; **reachable** (and executes code outside) without. DNS: `getent` never works in the sandbox, curl/gh go through srt's proxy, unaffected by the masks                                                          |
| Q3  | Network namespace / abstract sockets                     | **Masked.** `--unshare-net` always: abstract listener outside → `ECONNREFUSED`; `/proc/net/unix` is the new netns'                                                                                                                  |
| Q4  | Pid namespace / kill                                     | **Masked for signals** (`--unshare-pid` always: `kill -0` → `ESRCH`, pidfd → `EINVAL`). Under the weaker nested mode the **host `/proc` is visible** (pids, `cmdline`, `status`; not `environ`, `cwd`, `root`)                      |
| Q5  | Peer pid of an inside client                             | **Valid host pid**; its ppid chain reaches `bwrap` → `claude`. A re-parented process (`setsid -f`, double fork, `nohup`) re-parents to `bwrap` (pid-ns init), so the chain still reaches the round                                  |
| Q6  | Inverted reads; does `denyRead` stop the Read tool?      | srt **can** express "deny `$HOME`, re-allow subdirs". `denyRead` does **not** stop CC's Read tool. `Read(//abs/**)` deny rules do; `Read(/abs/**)` (one slash) does **not**. A narrowed `allow` under `dontAsk` refuses other paths |
| Q7  | Bun inside with `$HOME` masked                           | **Works** with `~/.local/share/mise`, `~/.config/mise`, `~/.bun` (and the checkout `seanced` runs from) re-allowed                                                                                                                  |
| Q8  | Env                                                      | srt and CC **pass `SSH_AUTH_SOCK` and `GH_TOKEN` through unchanged**; the agent is reachable unless its dir is masked                                                                                                               |
| Q10 | gh credential                                            | Plain file `~/.config/gh/hosts.yml` (no keyring). Masked → `gh` is **unauthenticated** (`exit 4`)                                                                                                                                   |
| Q11 | `/proc/sys`, nested mode                                 | Read-only here → weaker nested mode is **required** (strict fails at start). Masks and write denies **survive** a nested `unshare -Urm`. The weaker mode's cost is the host-`/proc` view (Q4)                                       |
| —   | Inverted form under CC (`/tmp`, `/run`, `$HOME` masked)  | **Works**, with two conditions: srt's proxy sockets must live in a re-allowed dir (set `TMPDIR` on the claude process), and a read-only round dir must already hold Claude Code's protected names (below)                           |

---

## Q1 — Does a mask stop `connect()`?

Settings: base + `"denyRead": ["$X/sock", "/tmp/tmux-1000", "~/.local/state/seance/run"]` (`q1.json`). Two outside
listeners: `$X/sock/l.sock` (masked dir) and `$X/open/l.sock` (not masked).

```sh
python3 -I client.py $X/sock/l.sock q1-masked
python3 -I client.py $X/open/l.sock q1-open
tmux -S /tmp/tmux-1000/default list-sessions >/dev/null; echo "tmux exit=$?"
python3 -I client.py /tmp/tmux-1000/default
python3 -I client.py ~/.local/state/seance/run/seanced.sock     # connect only, nothing sent
```

Unmasked (base settings), via srt:

```
CONNECT OK $X/sock/l.sock
CONNECT OK $X/open/l.sock
tmux exit=0
CONNECT OK /tmp/tmux-1000/default
CONNECT OK ~/.local/state/seance/run/seanced.sock
```

Masked (`q1.json`), via srt:

```
CONNECT FAIL $X/sock/l.sock: [Errno 2] No such file or directory
CONNECT OK $X/open/l.sock
error connecting to /tmp/tmux-1000/default (No such file or directory)
tmux exit=1
CONNECT FAIL /tmp/tmux-1000/default: [Errno 2] No such file or directory
CONNECT FAIL ~/.local/state/seance/run/seanced.sock: [Errno 2] No such file or directory
ls -a /tmp/tmux-1000  →  . ..
```

Under CC (`denyRead` of the tmux dir and `stateDir()/run`), the same connects gave `[Errno 2] No such file or
directory`.

**Verdict: masked.** On Linux, srt implements `denyRead` on a directory as `--tmpfs <dir>`. The socket inode is gone
from the sandbox's mount tree, so `connect()` fails with `ENOENT`, not just `stat`. A file `denyRead` is `--ro-bind
/dev/null <file>`. tmux's socket path came from `tmux display -p '#{socket_path}'` → `/tmp/tmux-1000/default`.

Bypass attempts that **failed** (see also Q11): `/proc/<host pid>/root/tmp/tmux-1000/default` →
`[Errno 13] Permission denied` (`ls /proc/<pid>/root/...` likewise); `umount2(<mask>, MNT_DETACH)` inside a nested
userns → `EINVAL`; an `rbind` of `/` shows the masked dirs empty.

## Q2 — `/run` masks, systemd, D-Bus, docker, DNS

Probe (`q2probe.sh`; `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` set explicitly to the user's so the test is
fair):

```sh
systemd-run --user --quiet true
busctl --user list; busctl --system list
docker ps                                  # docker is not installed on this host
python3 -I client.py /run/user/1000/bus | /run/user/1000/systemd/private | /run/dbus/system_bus_socket
python3 -I client.py /run/ssh-unix-local/socket | /run/user/1000/openssh_agent | /var/run/dbus/system_bus_socket
getent hosts github.com; curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/zen
```

| Settings                                                     | systemd-run --user           | busctl --user/--system | the six sockets above                                        | getent | curl |
| ------------------------------------------------------------ | ---------------------------- | ---------------------- | ------------------------------------------------------------ | ------ | ---- |
| base (no mask)                                               | exit 1 `… No data available` | **0 / 0**              | **all CONNECT OK**                                           | exit 2 | 200  |
| `denyRead: ["/run/user/1000","/run/dbus"]`                   | exit 1 `ENOENT`              | 1 / 1                  | all FAIL `ENOENT` **except** `/run/ssh-unix-local/socket` OK | exit 2 | 200  |
| `denyRead: ["/run/user/1000","/run/dbus","/run","/var/run"]` | exit 1 `ENOENT`              | 1 / 1                  | all FAIL `ENOENT`                                            | exit 2 | 200  |

**Unmasked, the user manager runs code outside the sandbox.** `systemd-run --user` itself failed in the sandbox
(`Failed to connect to user scope bus via local transport: No data available`), but that is only systemd-run's
transport. The same act over the session bus works:

```sh
busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager \
  StartTransientUnit 'ssa(sv)a(sa(sv))' seance-spike-sbx-14050.service fail 1 ExecStart 'a(sasb)' 1 /bin/true 1 /bin/true false 0
# → o "/org/freedesktop/systemd1/job/66"   exit=0
# host journal: systemd[1486457]: Started seance-spike-sbx-14050.service.
```

With `/run/user/1000` masked, the same call → `Failed to connect to user scope bus via local transport: No such file or
directory`. The unit ran `/bin/true` and is gone (`systemctl --user list-units --all 'seance-spike*'` → 0 units). So
the fence's `systemctl` deny entry is no guard here; the mask is.

**DNS.** `/etc/resolv.conf` on this host is a regular file, not a link into `/run/systemd/resolve`, and stays
readable. But `getent hosts github.com` fails (exit 2) in **every** configuration, masked or not. srt always
unshares the network namespace (Q3), so the sandbox has no resolver. Tools resolve through srt's proxy, which
resolves on the host: `HTTPS_PROXY=http://srt…@localhost:3128` is set, and curl and gh (Q10) work with `/run` masked.
On a host whose `resolv.conf` _is_ a link into `/run`, the mask would not change this, since nothing inside resolves
directly anyway. Not tested on such a host.

**Which masks srt can express.** Any path: a directory becomes a tmpfs, a file is covered by `/dev/null`, and a symlink
in the path works (`/var/run` → `/run` was accepted and masked). `/run` whole is fine. It cannot express a mask for an
**abstract** socket (no path), which is what the network namespace covers (Q3), nor filter `connect()` by path (seccomp
cannot, as the fence's comment says). docker/podman: not installed here, so they are covered only by the `/run`,
`/var/run` and `$XDG_RUNTIME_DIR` masks above; untested.

Other host sockets this survey found reachable from an unmasked sandbox: `/run/ssh-unix-local/socket` (root-owned
dir, connect OK), the gpg agent's `/run/user/1000/gnupg/S.*`, `/run/systemd/*` (journal, userdb, networkd). See
"Other reach" below for `/tmp`.

## Q3 — Network namespace and abstract sockets

Outside: `socat ABSTRACT-LISTEN:seance-spike,fork SYSTEM:'echo abstract-hello'`. Inside (`q1.json` and base),
via srt and CC:

```
CONNECT FAIL @seance-spike: [Errno 111] Connection refused
grep -c @seance-spike /proc/net/unix → 0      (5 lines total in /proc/net/unix)
netns: net:[4026533028]   (host: net:[4026533121])
```

**Verdict: masked.** srt always passes `--unshare-net` when network rules are set (source: `linux-sandbox-utils.js`,
`if (needsNetworkRestriction) bwrapArgs.push('--unshare-net')`; the fence's `allowedDomains` makes that true). This
holds under `allowAllUnixSockets` and under the weaker nested mode. Abstract sockets are per network namespace, so the
host's are unreachable without any path mask. CC confirmed the same `ECONNREFUSED`. (`/sys/class/net` still lists the
host's `eth0`: `/sys` is the host's bind, not a view of the new netns. Harmless.)

## Q4 — Pid namespace and kill

Outside: `sleep 600` (pid P). Inside (`q1.json`, weaker nested mode), via srt; `kill -0` and the namespace id
confirmed under CC:

```
pidns: pid:[4026533025] self=8                     (host: pid:[4026533118])
ps -e → "fatal library error, lookup self"         (procps can't find /proc/self: host /proc, own pid ns)
ls -d /proc/[0-9]* | wc -l → 91                    (host pids are listed)
/proc/P visible: sleep
kill -0 P → bash: kill: (P) - No such process      exit=1
pidfd_send_signal(open("/proc/P", O_DIRECTORY), 0) → [Errno 22] Invalid argument
/proc/P/cmdline READABLE   /proc/P/status READABLE   /proc/P/environ denied   readlink /proc/P/cwd denied
/proc/P/root/...  → Permission denied
```

**Verdict: signals are masked; the process list is not hidden.** srt always passes `--unshare-pid` (source: "If we
don't have --unshare-pid, it is possible to escape the sandbox"). There is no setting to turn it off or on: it is
unconditional. A pid from outside is not in the sandbox's namespace (`ESRCH`), and a pidfd for an outside process
cannot be signalled from a descendant namespace (`EINVAL`).

But under `enableWeakerNestedSandbox` srt does `--bind /proc /proc` (the host's procfs) instead of `--proc /proc`. So
the round **can enumerate every host process and read its `cmdline` and `status`**, though not `environ`, `cwd`,
`fd` or `root` (ptrace-guarded). Anything a process puts on its argv is readable by the round on an LXC host. In the
strict mode (`--proc /proc`), it would see only its own namespace; that could not be run on this host (Q11).
**Recommendation:** treat argv as readable by the round on container hosts. Don't put anything secret on any argv;
the daemon already keeps the fence and seed off argv.

## Q5 — Peer pid across the sandbox boundary

Listener outside at `$X/open/l.sock` (the path is not masked), using `SO_PEERCRED` (`struct ucred` via
`getsockopt(SOL_SOCKET, SO_PEERCRED)`, as `daemon/src/peer.ts` does). Clients inside, via srt (`q1.json`):

```
q5-direct : peer pid=1689233  chain: 1689233:python3 <- 1689225:bash <- 1689219:bash <- 1689218:bwrap <- 1689217:bwrap
            <- 1689216:sh <- 1689169:node-MainThread(srt) <- 1689168:bash <- 1689164:zsh <- 1683289:claude <- 571353:tmux: server
q5-setsid : peer pid=1689239  chain: 1689239:python3 <- 1689218:bwrap <- 1689217:bwrap <- 1689216:sh <- 1689169:node … <- 1683289:claude <- tmux
q5-dblfork: peer pid=1689244  chain: 1689244:python3 <- 1689218:bwrap <- 1689217:bwrap <- … <- 1683289:claude <- tmux
q5-nohup  : peer pid=1689248  chain: 1689248:python3 <- 1689218:bwrap <- 1689217:bwrap <- … <- 1683289:claude <- tmux
```

(`setsid -f client.py`; `( ( client.py & ) & )`; `bash -c "nohup bash -c 'sleep 1; client.py' &"` whose parent exits
first.) The client itself reported pid 16 in its own namespace. The kernel translates `SO_PEERCRED` into the
listener's pid namespace.

Under CC (its own Bash tool, `A.json`):

```
peer pid=1698798 chain: 1698798:python3 <- 1698790:bash <- 1698782:zsh <- 1698781:bwrap <- 1698780:bwrap <- 1698779:sh
                        <- 1698474:claude <- 1698473:timeout <- 1698472:bash <- 1698470:zsh <- 1683289:claude <- tmux
```

**Verdict: the peer pid is a valid host pid, and ancestry is honest.** The inner `bwrap` is the pid namespace's init,
so every orphan inside re-parents to it, never to the host's init or a subreaper outside. A process the round
re-parents away still walks up to the round pane's `claude`, so `ancestorIn` stays a positive check. And
`--die-with-parent` plus the pid namespace mean nothing inside outlives the sandbox. **Caveat:** the round socket must
be at a path the sandbox can see, so it has to be re-allowed (a dir outside the masks, or `allowRead` under one). It
must not be writable, or the round can replace it.

## Q6 — Reads

### srt: "deny `$HOME`, re-allow subdirs"

Settings `q6.json`: base + `"denyRead": ["~"], "allowRead": ["~/seance-spike-q6/allowed"]`. Planted
`~/seance-spike-q6/{allowed,denied}/dummy.txt`. Via srt:

```
cat ~/seance-spike-q6/allowed/dummy.txt → dummy-allowed
cat ~/seance-spike-q6/denied/dummy.txt  → No such file or directory
ls -a ~ → . .. seance-spike-q6
~/.ssh, ~/.config/gh, ~/.gnupg, ~/.claude, ~/.local/state/seance → hidden
```

**Verdict: expressible.** `allowRead` "takes precedence over denyRead" (srt schema): `$HOME` becomes a tmpfs with the
allowed paths ro-bound back. Anything under home that isn't listed is `ENOENT`. Writes to that tmpfs land in a
sandbox-private tmpfs and never reach the host (checked for `/tmp`, below).

### CC: does `denyRead` stop the in-process tools?

Settings (all with `sandbox.filesystem.denyRead` including `~/seance-spike-q6/denied`); prompt: "Use the Read tool
(NOT Bash) on …/denied/dummy.txt; Glob `*` in …/denied; Read …/allowed/dummy.txt":

| File    | `permissions`                                                                    | Read denied/dummy.txt                                                                      | Read allowed/dummy.txt |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| A.json  | `allow: ["Read","Grep","Glob"]`                                                  | **`dummy-denied` (read succeeded)**                                                        | ok                     |
| B1.json | A + `deny: ["Read(//home/martin/seance-spike-q6/denied/**)"]`                    | `File is in a directory that is denied by your permission settings.`                       | ok                     |
| B2.json | A + `deny: ["Read(/home/martin/seance-spike-q6/denied/**)"]` (one leading slash) | **`dummy-denied` (read succeeded)**                                                        | ok                     |
| C.json  | `allow: ["Read(//home/martin/seance-spike-q6/allowed/**)"]` only                 | `Permission to use Read has been denied because Claude Code is running in don't ask mode.` | ok                     |

C.json, further: Read of a file in the **cwd** → allowed (content returned) without any allow rule; Read of
`/etc/hostname` → refused with the same don't-ask message.

**Verdicts:**

- `sandbox.filesystem.denyRead` **does not** stop Claude Code's Read tool: it confines Bash subprocesses only. Assume
  the same of any in-process tool.
- `Grep` and `Glob` **do not exist** as tools in 2.1.325 here: `No such tool available: Grep. Grep is not available in
  this session — search file contents with grep via the Bash tool instead.` So search runs only through Bash, which is
  sandboxed. Re-check on the pinned release; a later one may bring them back.
- A `Read(...)` deny rule **does** stop the Read tool, but **only with an absolute path spelled `//abs/path`**. `Read(/abs/...)`
  is resolved relative to the settings file's root and silently matches nothing. The 4b PR must use `//`.
- Narrowing `allow` to `Read(//<dir>/**)` under `defaultMode: "dontAsk"` refuses every path outside it **except the
  cwd**, which Claude Code reads without a rule. That is the inverted form 4b wants: allow the round dir (implicit)
  plus whatever it needs, and refuse the rest. The fence's current `allow: ["Read", …]` (bare) must go.

## Q7 — Bun inside with `$HOME` masked

`q7.json`: `q6.json` + `allowRead` of `~/.local/share/mise`, `~/.config/mise`, `~/.bun`. Without them (`q6.json`):
`bun: command not found` (exit 127). With them:

```
command -v bun → ~/.local/share/mise/installs/bun/latest/bin/bun
bun x.ts → "bun ok 1.4.4"   exit 0
```

`q7b.json` (+ this checkout re-allowed): `bun <checkout>/daemon/src/main.ts help` → `seanced — séance daemon … usage:
seanced [command]`, exit 0. The round's own `<tmp>/bin/seanced` (`exec <bun> <main.ts>`) works under a masked
`$HOME` as long as `resolvedBun()`'s install dir and `resolvedMain()`'s checkout (with its `node_modules`) are
re-allowed. Under CC (inverted form, below), `bun` from `PATH` ran a script in `$TMPDIR`: `bun ok`, exit 0.

**Verdict: works.** Re-allow the toolchain the PATH needs (here mise: data dir and config dir; `~/.bun` for a
`bun upgrade`-style install) and the checkout `seanced` runs from. Note that re-allowing the checkout makes its
contents readable (e.g. any `.env`/`.dev.vars` in it). On this machine the main checkout has none.

## Q8 — Environment

Started srt and CC with `SSH_AUTH_SOCK=/run/user/1000/openssh_agent GH_TOKEN=dummy-not-a-token GPG_AGENT_INFO=dummy`
(dummy values, never a real token):

```
srt base     : SSH_AUTH_SOCK=/run/user/1000/openssh_agent  GH_TOKEN set, unchanged  ssh-add -l exit=1 (agent reached, no identities)
srt /run/user/1000 masked : same env                                                ssh-add -l exit=2 (cannot connect)
CC (A.json, /run/user/1000 masked): SSH_AUTH_SOCK=/run/user/1000/openssh_agent GH_TOKEN=set  ssh-add -l exit=2
host (outside)               : ssh-add -l exit=1 with the socket, exit=2 with SSH_AUTH_SOCK unset
```

Vars srt **adds** inside: `HTTP(S)_PROXY`/`http(s)_proxy`, `ALL_PROXY`, `NO_PROXY`, `GRPC_PROXY`, `FTP_PROXY`,
`RSYNC_PROXY`, `DOCKER_HTTP(S)_PROXY`, `CLOUDSDK_PROXY_*`, `JAVA_TOOL_OPTIONS`, `GIT_SSH_COMMAND` (ssh through socat
to the proxy), `GIT_CONFIG_PARAMETERS`, `TMPDIR` (`/tmp/claude` or `$CLAUDE_CODE_TMPDIR`), `SANDBOX_RUNTIME=1`,
`CLAUDE_CODE_HOST_{HTTP,SOCKS}_PROXY_PORT`. Vars absent inside: only `CLAUDECODE`, `AI_AGENT`,
`CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` (and `_`). Where those are dropped was not traced.

**Verdict: srt strips nothing that matters.** `SSH_AUTH_SOCK`, `GH_TOKEN` and `GPG_AGENT_INFO` arrive unchanged. 4b's
"the env is built, not inherited" is needed, and so is the dir mask: the agent socket is reachable whenever its path
is, env var or not (`ssh-add` with an explicit socket path works the same). This host's agent holds no identities,
so "signs as the owner" could not be shown, only "connects".

## Q10 — gh credential

```
gh auth status → ✓ Logged in to github.com account … (/home/martin/.config/gh/hosts.yml)
~/.config/gh: config.yml, hosts.yml (both 0600); hosts.yml holds oauth_token entries (counted, not printed)
token scopes: 'admin:org', 'gist', 'repo', 'workflow'
```

Inside, via srt (`GH_TOKEN`/`GITHUB_TOKEN` unset):

| Settings                      | `head -c0 hosts.yml` | `gh api /zen`                                                          | curl api.github.com/zen |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------- | ----------------------- |
| base                          | READABLE             | exit 0                                                                 | 200                     |
| `denyRead: ["~/.config/gh"]`  | not readable         | **exit 4** `To get started with GitHub CLI, please run: gh auth login` | 200                     |
| inverted `$HOME` (`q7b.json`) | not readable         | **exit 4**                                                             | 200                     |

**Verdict:** on this Linux host gh keeps its token in a **plain file** (no secret-service or keyring), and it is a
broad token (`repo`, `workflow`, `admin:org`). Unmasked, the round can read it and has github.com to send it to.
Masked, the round's `gh` is unauthenticated, and reads of private repos (the round's PR checks) fail. 4b needs one of
the options it already lists: a daemon-side verb for the reads, or a scoped read-only token given to the round. It
must not be `GH_TOKEN` inherited from the owner's env (Q8).

## Q11 — `/proc/sys`, nested mode

```
grep ' /proc/sys ' /proc/self/mountinfo → 483 481 0:59 /sys /proc/sys ro,relatime shared:317 - proc proc rw
bun -e 'procSysReadOnly(readFileSync("/proc/self/mountinfo"))' → true
srt with q1.json minus enableWeakerNestedSandbox → bwrap: cannot open /proc/sys/user/max_user_namespaces: Read-only file system   (exit 1)
```

So this host can **only** run the weaker nested mode, and the fence picks it correctly. The strict mode's behaviour
(`--proc /proc`, `--disable-userns`) could not be observed here and needs a VM or bare-metal run.

What changes under `enableWeakerNestedSandbox` (srt source plus the runs above):

- `/proc` is the **host's** (`--bind /proc /proc`), not a fresh one: host processes are visible (Q4). Signals still
  fail (`--unshare-pid` is unconditional), and `/proc/<pid>/root`, `cwd` and `environ` are denied.
- No `--disable-userns`, and with `allowAllUnixSockets` there is no seccomp helper either. So the sandboxed command
  **can create a nested user namespace**: `unshare -Ur true` → OK. srt warns this "can undo the write denies". Tested
  against masks and write denies, inside `unshare -Urm`, by raw syscalls (`q11b.py`):

  ```
  umount2($X/sock, MNT_DETACH)                  → -1 EINVAL      (mask still empty)
  umount2(/tmp/tmux-1000, MNT_DETACH)           → -1 EINVAL
  umount2(~/.local/state/seance/run, …)         → -1 EINVAL
  mount tmpfs /mnt; mount --rbind / /mnt/r      → OK, but /mnt/r/tmp/tmux-1000 and …/seance/run are []
  mount --bind /tmp /mnt/r (non-recursive)      → -1 EINVAL      (kernel refuses to uncover locked children)
  mount -t proc proc /proc                      → permission denied
  mount -o remount,rw /                         → permission denied
  touch <denyWrite path>                        → Read-only file system
  ```

  The kernel locks mounts inherited into a less-privileged mount namespace (`MNT_LOCKED`), so on this kernel neither a
  mask nor a read-only bind can be undone from a nested userns. **Masks survive the weaker mode.**

- Network and pid namespaces are unshared either way (Q3, Q4).

## Inverted form under CC — `/tmp`, `/run`, `$HOME` masked

The 4b "inverted" layout, end to end in Claude Code 2.1.325. Settings `E.json` (sandbox part):

```json
"filesystem": {
  "denyWrite": ["<round dir>"],
  "denyRead": ["/tmp", "/run", "/var/run", "/home/martin"],
  "allowRead": ["<round dir>", "<T: /tmp/seance-cu-…>", "~/.local/share/mise", "~/.config/mise", "~/.bun"]
}
```

The round dir was `~/seance-spike-q6/rounddir` (under the masked `$HOME`, as a real round dir is). Claude ran with
`TMPDIR=<T> CLAUDE_CODE_TMPDIR=<T>`. Final output:

```
ls -a /tmp: . .. seance-cu-spikeUKNW
CONNECT FAIL /tmp/cc-socks/1683289.sock: [Errno 2] No such file or directory
CONNECT FAIL /tmp/mongodb-27399.sock: [Errno 2] No such file or directory
CONNECT FAIL /tmp/tmux-1000/default: [Errno 2] No such file or directory
CONNECT FAIL /run/user/1000/bus: [Errno 2] No such file or directory
touch: cannot touch '<round dir>/w': Read-only file system
write to TMPDIR ok                      ($TMPDIR = <T>/claude-1000)
curl api.github.com 200
bun ok   bun exit=0
```

It took two conditions to get there; both are findings:

1. **srt's proxy bridge sockets are made in the claude process's `TMPDIR`** (`/tmp/claude-http-*.sock`,
   `/tmp/srt-mux-*.sock`; seen in `srt -d`). They are bound into the sandbox _before_ the filesystem rules, so a `/tmp`
   mask hides them: `curl: (56) Proxy CONNECT aborted`. `CLAUDE_CODE_TMPDIR` alone does not move them under CC; it
   moves only the sandbox's own `TMPDIR`. Fix: launch the round's claude with `TMPDIR` (and `CLAUDE_CODE_TMPDIR`) set
   to a dir that is in `allowRead`. The round's tmp dir is the natural one, as long as nothing in it that the daemon
   trusts is writable from inside. Inside, only `<T>/claude-<uid>` was writable; `<T>` itself was not.
2. **A read-only round dir under a mask must already contain Claude Code's protected names.** CC write-protects a list
   of "dangerous" names in the cwd, and bwrap has to create each missing one as a mount point. On a dir that is
   ro-bound back over a tmpfs (the `allowRead`-under-`denyRead` case) that fails before any command runs:
   `bwrap: Can't create file <round dir>/.gitconfig: Read-only file system`, then `.gitmodules`, then the dir `.vscode`.
   It worked once these existed as empty files or dirs. The 37 files are 2.1.325's list as read from the binary
   (`.gitconfig .gitmodules .bashrc .bash_profile .zshrc .zprofile .profile .zshenv .zlogin .zlogout .bash_login
   .bash_aliases .bash_logout .envrc .ripgreprc .mcp.json .claude.json .npmrc .yarnrc .yarnrc.yml .pnp.cjs
   .pnp.loader.mjs .pnpmfile.cjs bunfig.toml .bunfig.toml .bazelrc .bazelversion .bazeliskrc .pre-commit-config.yaml
   lefthook.yml .lefthook.yml lefthook.yaml .lefthook.yaml gradle-wrapper.properties maven-wrapper.properties
   .devcontainer.json pyrightconfig.json`); the dirs are `.vscode` and `.idea`. `.claude/commands` and
   `.claude/agents` were **not** needed, which matters because `roundDirPlanted` treats `.claude/agents` as a plant.
   srt 0.0.81 alone did not hit this (same layout, exit 0), so it is Claude Code's own list or its newer bundled
   runtime.
   - Dropping `denyWrite` on the round dir also makes bwrap start (`E2.json`), but CC's default write grant for `.`
     then re-binds the cwd writable, which breaks C20. Don't.
   - The list is version-dependent. A name added in a later release fails the round at start, loudly, which is
     fail-closed. The daemon could create the names at `ensureRoundDir`, or `seanced doctor` could check for them. The
     list here is a snapshot, not a contract.

## Other reach found

- **`/tmp/cc-socks/<pid>.sock`**: one per running Claude Code process (6 live here, mode 0600, owned by the user).
  These are other sessions' sockets, reachable from any sandbox that doesn't mask `/tmp`. Their protocol was not
  probed. A `/tmp` mask hides them (above).
- **`/tmp/mongodb-27399.sock`** (a `mongod`, from another project): reachable unless `/tmp` is masked. This is
  arbitrary per machine, which argues for the inverted `/tmp` mask over a list.
- `/tmp/tmux-1000/` also holds stale sockets (`msgspike`, `spike`, `seance-probe`, …) from earlier spikes.
- `/run/user/1000/gnupg/S.gpg-agent{,.ssh,.extra,.browser}`, `S.keyboxd`, `S.dirmngr`; `/run/user/1000/openssh_agent`;
  `/run/user/1000/bus` and `systemd/private` (code execution, Q2); `/run/dbus/system_bus_socket`;
  `/run/ssh-unix-local/socket`; `/run/systemd/{private,journal/stdout,userdb/…,netif/…}`. All are hidden by masking
  `/run` (plus `/var/run`).
- `$XDG_RUNTIME_DIR` was **unset** in the sessions' env on this host (tmux started without it); the runtime dir is still
  `/run/user/1000`. Mask by path, never by reading the env var.
- **Host `/proc` under the weaker mode** (Q4): every process's `cmdline` is readable on container hosts.
- A `/tmp` mask leaves a sandbox-private writable tmpfs at `/tmp` (writes there never reach the host; checked).

## What this means for 4b on Linux

1. Masks work as needed. Every path-addressed socket is unreachable once its directory is in `denyRead` (`ENOENT` at
   `connect()`), and a nested userns cannot undo it. Abstract sockets and signals are already out of reach (srt's
   unconditional `--unshare-net` and `--unshare-pid`). So `allowAllUnixSockets` can stay on Linux.
2. Prefer the inverted form: `denyRead: ["/tmp", "/run", "/var/run", "$HOME"]` with `allowRead` for the round dir,
   the round socket's dir, the round tmp dir, the toolchain and the `seanced` checkout. Launch claude with `TMPDIR`
   and `CLAUDE_CODE_TMPDIR` in an allowed dir, and pre-create CC's protected names in the read-only round dir. A
   per-socket list is never complete here (`cc-socks`, `mongod`).
3. The round socket (4b (a)) at `/tmp/seance-cu-…/` works with this: re-allow its dir for reading and keep it out of
   every write grant. Peer-pid binding works through bwrap, including after re-parenting (Q5).
4. The Read tool needs permission rules, not `denyRead`: `allow` narrowed to `Read(//<dir>/**)` entries (the cwd is
   implicit), with `//`-absolute paths, never `/`.
5. Build the env. `SSH_AUTH_SOCK`, `GH_TOKEN` and `GPG_*` pass straight through srt and CC.
6. gh: the token is a plain, broad file token. Masking it leaves the round's `gh` unauthenticated, so a daemon-side read
   verb or a scoped token is needed.
7. Open for a non-container Linux (VM or bare metal): the strict mode (`--proc /proc`, `--disable-userns`) and whether
   anything above differs there; untested here.
