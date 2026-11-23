---
paths:
  - "daemon/src/{watch-*,watches*,pr-status}.ts"
  - "daemon/test/{watch,watches}*.ts"
  - "shared/src/watch.ts"
---

# Watches

**A watch is the daemon's, bound to a `claude` process, and its notes go only through messaging's local
delivery.** Requirements, not observations: DESIGN.md's "Watches" and its threat model ("A daemon's
watch table binds a watch to its session's `claude` process") are the record; docs/gh-watch.md indexes
W1–W11. CLAUDE.md's recurring rules hold throughout; the leader's side (the poller, `watch-set`,
`watch-event`, the caps and the reserve) is github.md.

- The local socket's `watch` frame (`add`, `remove`; `watch-frame.ts`, `parseWatchFrame`, exactly its
  fields) is bound only by peer pid, to the pane, its pane process and the innermost `claude` on the
  peer's chain (`bindPeer`): refused `unbound` where the host names no peer (`peerPidSupported`) or the
  pid came back null, `nosession` with no `claude` on the chain and `nolistener` for a pane no inbox
  listener serves, never by a field. It carries a URL, a head and an id and nothing that names a pane,
  task or session; it is on neither `LOCAL_OPS` nor the broker.
- A `remove` is honoured only from the session that made the watch (a wrong, foreign or unknown id all
  answer `unknown`).
- The caps (8 a session, 64 a machine, `WATCH_MACHINE_MAX` equal to the leader's per-device
  `WATCH_SET_MAX`) are the table's: refused at the add, never an eviction, and a replacement is not
  counted.
- A watch ends with its session (`claude` gone, pane gone or its pid changed), its task changing,
  `ended`, its 24 h expiry, a terminal or `unreadable` event, an `invalid` refusal, or a note its listener
  never took.
- A `watch-event` is looked up by watch id in the daemon's own table and placed only at the pane, pane
  pid, task and `claude` process that entry names, through `Messages.deliverWatchNote` (a `wake` line or
  a plain note, never `asUser`, `$.prompt.fill` or tmux keys), rendered by the one `watchNote` formatter
  from enums, hex, rebuilt URLs and bounded check names whose control, format (bidi, zero-width),
  surrogate and line or paragraph separator characters `watchNote` replaces with U+FFFD. A failed read of
  the pane list is `unreadable`, which delivers and ends nothing.
- `delivered` lists a watch only when all its events in the frame were placed or held (a held note's
  keys are saved like a placed one's: the leader keeps them across a daemon restart either way). A
  stopped table audits no end, writes no file and answers an event it placed after the stop not
  delivered.
- A replacing add (the same target, the same session) leaves the old watch in the table's place only for
  the new one's set, and puts it back when the add is refused; adds and removes of one session run one at
  a time.
- The set goes to the leader sealed from this daemon's own device id and never `from: "app"`: in process
  through `leader.onWatchSet` when this daemon leads (the parsed set, like a frame), else
  `RelayClient.sendWatchSet`. Who leads is read only through a lazily held app-role leg (`LazyRelay`, held
  while the table is non-empty) that sends nothing, and the add is refused `no_leader` or `unsupported`
  unless a verified leader advertising `CAPABILITIES.watches` is visible.
- `gen` is `{boot: instance, n}`, `n` rising on every send, and a set no answer named is resent at the
  next tick.
- `watches.json` is 0600, written by atomic rename through one write chain per path per process (the
  table's `stop()` returns it and shutdown awaits it), holds ids, targets, heads, keys and process
  identity only, and an entry is reloaded only while its `claude` process still runs with the saved start
  time and its pane carries the same task.
- A live watch holds its pane from the custodian's `close` (`awaitsWake`) and nothing else: no hand-off,
  pass, drain or reap waits on it.
- `watch-frame.ts` is in `seance mcp`'s closure (`message-layering.test.ts`), and nothing of a watch is
  logged but the closed-enum `watch` audit line.
