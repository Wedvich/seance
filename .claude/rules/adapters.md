---
paths:
  - "daemon/src/adapter-*.ts"
  - "daemon/src/{leader-adapters,closing-panes,messages}.ts"
  - "daemon/test/adapter-*.ts"
  - "shared/src/adapter-protocol*"
  - "scripts/adapter-schema.ts"
---

# Adapters

**An adapter is declared only in its machine's own `config.json` and speaks only on its stdin and
stdout.** Requirements, not observations: DESIGN.md's "Adapters" (and "Installing") is the record, with
Threat model item 6 and its adapter invariant. CLAUDE.md's recurring rules hold throughout. Giving the
seam another act is a threat-model change, made in DESIGN.md with it.

## Configuration and supervision

- `adapters` is parsed strictly (`parseAdapters`, at most `ADAPTERS_MAX`, a name by
  `ADAPTER_NAME_PATTERN`, any mistake failing the load), never from a frame, the PWA, MCP or another
  machine, and nothing about adapters crosses the relay.
- Its `argv` is an argv array, never a shell string, `argv[0]` absolute or a bare name resolved through
  `PATH` at each start, never `process.execPath`.
- The supervisor (`adapter-supervisor.ts`) starts it with the env a session gets less
  `CREDENTIALS_DIRECTORY` and every `TMUX*`, plus `SEANCE_ADAPTER_NAME` and `SEANCE_ADAPTER_DIR` (0700
  `stateDir()/adapters/<name>`, its cwd), in its own process group, stderr discarded, never while the
  daemon drains for a restart, and stops it with the daemon (stdin closed, SIGTERM to the group, SIGKILL
  after 5 s).
- Every line it writes goes through `parseAdapterLine` (`shared/src/adapter-protocol.ts`, the schema of
  record; the committed JSON Schema is generated from it), exact fields only, at most `ADAPTER_LINE_MAX`.
  A protocol major outside `ADAPTER_PROTOCOLS` or a `name` other than its key stops it for good, and the
  daemon sends only what its `wants` names.
- An adapter runs as the owner's uid, so these rules bound what Séance grants, never what the program can
  do.

## State out

- State out is `snapshot`, `session`, `session-gone` and `task` from the feed (`adapter-feed.ts`) and only
  those: never a prompt, an attachment, a session-to-session message, a transcript, the screen, an
  account id, an absolute path or anything of the PSK.
- `repos`, when set, bounds both sessions and tasks; another adapter's `adapter.*` tags are stripped
  (`tagsFor`); a `task` frame goes only for a task this machine's launch ledger holds.
- `closed` is read only from the despawn's own note (`closing-panes.ts`), never a log.
- Nothing an adapter writes, and no argv word but `argv[0]`'s basename, reaches a log or an audit line:
  the adapter modules load neither `log.ts` nor `audit.ts` at run time
  (`daemon/test/adapter-layering.test.ts`).

## Its other acts, and only these

- `deliver` (`Messages.deliverFromAdapter`), checked against `kinds` first, never routed: to a task this
  machine's launch ledger holds at a live pane carrying it, to a conversation subscribed to it
  re-verified at the act (`atAct`: `ambiguous`, `unverified`, `ended`), or by `inReplyTo` only to a
  message a session sent that adapter (its `sent` entry names it). `repos` bounds every address; it runs
  within its own bucket (`ADAPTER_RATE`) and the target's, in the adapter wrapper
  (`renderAdapterMessage`, `from` a display label through `displayTitle`), by the mod's local delivery,
  never a key.
- A `message` frame out, only for a session's `send_message` to `adapter:<name>`: bound by peer pid,
  refused `unbound` with no `claude` process on the peer's chain and `refused` outside `repos`, sent only
  to an adapter whose hello wants `messages`, carrying an `inReplyTo` only when it names that adapter's
  delivery to that same session.
- A subscription (`adapter-subscriptions.ts`), made only from the sender's bound process's verified
  conversation that it alone claims (`verifiedFor`), never from a frame, never by a reply by handle. It
  is kept 0600 in `conversations.json` (one owner, `openSubscriptions`, beside the owner's labels) with
  ids, names, fingerprints and times only (an unreadable file loads empty), and ended by `leave`, 30 days
  not live, the cap, or the name gone or configured as another program.
- A `tag`, only under its own `adapter.<name>.*`, on a conversation subscribed to it or a task this ledger
  holds, within `repos`, in memory only, cleared at each handshake, never shown to another adapter or
  MCP.
- Every message either way is audited under origin `adapter`, never `message`.

## Installing

`adapter-cli.ts`; DESIGN.md "Installing".

- The owner installs one with `seance adapter add | remove | restart | status`: shell verbs in the one
  `COMMANDS` table (so denied to a custodian round), never a frame, a local-socket op, a broker action, an
  app op or MCP.
- `add` reads `seance-adapter.json` (exact keys, a protocol in `ADAPTER_PROTOCOLS`, an argv whose
  relative words resolve inside the checkout by realpath and no absolute word), writes `adapters.<name>`
  and nothing else of `config.json`, only after the new file loads, and records the checkout's commit and
  an `added` stamp that joins the subscription fingerprint.
- Neither `add` nor `remove` writes `conversations.json` (the daemon is its one writer, one store per path
  per process, `subscriptionsFor`); the daemon ends that name's subscriptions when it reads the config
  (`reconcileWith`, at each start and reload, with no adapter left too). Neither deletes the adapter's
  own directory.
- `restart` and `status` reach the daemon only through `adapter-status.json` (believed only under the
  live daemon's pid; the hello's `version` printed only through `printable`) and `adapter-restart.json`
  (names only, 60 s), never the socket.
- `doctor` warns when the checkout moved since `add`, never refuses.
- The verbs audit under origin `cli` with a name, argv word count, `argv[0]`'s basename, kinds, a repo
  count and booleans, never a path or sha.
