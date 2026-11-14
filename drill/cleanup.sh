#!/bin/bash
# Always runs after the drill. Safe to run twice. Removes only what the drill made (its pids, its tmp dirs, links it planted).
DRILLDIR=$(cd "$(dirname "$0")" && pwd -P)
[ -f "$DRILLDIR/env.sh" ] || { echo "no env.sh: nothing to clean (setup did not finish, or already cleaned)"; exit 0; }
. "$DRILLDIR/env.sh"
. "$DRILLDIR/lib.sh"
say(){ echo "cleanup: $*"; }

touch "$D/watch.stop" 2>/dev/null

# 1. the drill daemon: SIGTERM, wait, then its tmux server
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  kill -TERM "$DAEMON_PID" 2>/dev/null
  for _ in $(seq 1 60); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$DAEMON_PID" 2>/dev/null; then kill -KILL "$DAEMON_PID" 2>/dev/null; say "daemon needed SIGKILL"; else say "daemon stopped on SIGTERM"; fi
else say "daemon already gone"; fi
env -i HOME="$HOME" PATH="$PATH" tmux -S "$D/tmux.sock" kill-server 2>/dev/null && say "tmux server killed" || say "tmux server already gone"
kill "$LISTENER_PID" 2>/dev/null
[ -n "$SOCAT_PID" ] && kill "$SOCAT_PID" 2>/dev/null
[ -f "$D/watch.pid" ] && kill "$(cat "$D/watch.pid")" 2>/dev/null

# 2. macOS leftovers a refused probe could have created
if [ "$OS" = Darwin ]; then
  launchctl list 2>/dev/null | grep -q seance-drill && { launchctl remove seance-drill; say "removed launchd job seance-drill"; }
  defaults read io.seance.drill >/dev/null 2>&1 && { defaults delete io.seance.drill; say "deleted defaults domain io.seance.drill"; }
fi

# 3. links the sandbox managed to plant (notes list them; find -samefile catches hardlinks in the usual temp roots)
n=0
if [ -f "$D/state/custodian/notes.md" ]; then
  while IFS= read -r p; do
    case "$(basename "$p")" in dl-s*-* | dl-h*-*) rm -f "$p" && n=$((n + 1)) ;; esac
  done < <(sed -n 's/^INFO L-plant \(sym\|hard\):\(.*\)$/\2/p' "$D/state/custodian/notes.md" 2>/dev/null || true)
fi
while IFS= read -r t; do
  [ -f "$t" ] || continue
  while IFS= read -r p; do
    case "$(basename "$p")" in dl-h*-*) rm -f "$p" && n=$((n + 1)) ;; esac
  done < <(find /tmp /private/tmp -xdev -samefile "$t" 2>/dev/null)
done <<EOF
$LINKTARGETS
EOF
say "planted links removed: $n"

# 4. the round's tmp dirs, and its socket dir
HASH=$(printf %s "$D/state" | openssl dgst -sha256 | awk '{print $NF}' | cut -c1-12)
[ -d "/tmp/seance-cu-s-$HASH" ] && rm -rf "/tmp/seance-cu-s-$HASH" && say "removed /tmp/seance-cu-s-$HASH"
while IFS= read -r t; do
  case "$t" in /tmp/seance-cu-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9]) [ -d "$t" ] && rm -rf "$t" && say "removed round tmp $t" ;; esac
done < <(cat "$D/rtmp.list" 2>/dev/null)

# 5. the decoy root, when it is not under $D
case "$DECOYROOT" in */seance-drill-decoy.*) rm -rf "$DECOYROOT" && say "removed decoy root" ;; esac

# 6. the round's transcript(s): only inside the one project dir of the round this drill ran (the exclave its audit start line
#    names, lib.sh), only files carrying the nonce, then that dir if left empty. Never another session's project dir (an
#    owner's real custodian rounds share the `*-seance-custodian` name; this harness's own transcript carries the nonce too),
#    history.jsonl or anything else.
PROJ=$(round_project_dir "$(round_exclave)")
if [ -d "$PROJ" ]; then
  grep -rl "DRILL-$NONCE" "$PROJ" 2>/dev/null | while IFS= read -r f; do rm -f "$f" && say "removed transcript file ${f#"$PROJ"/}"; done
  find "$PROJ" -depth -type d -empty -delete 2>/dev/null
  say "transcript sweep: $PROJ"
else say "transcript sweep: no project dir $PROJ"; fi
say "files elsewhere under ~/.claude* carrying the nonce (left in place): $(grep -rl "DRILL-$NONCE" "$HOME"/.claude "$HOME"/.claude-* 2>/dev/null | wc -l | tr -d ' ')"

# 6b. a round dir the seat made under a named exclave's root (ensureRoundDir) during this drill: created after $D/ref, so removable
for d in "$HOME"/*/.seance-custodian; do
  [ -d "$d" ] || continue
  if [ -z "$(find "$d" ! -newer "$D/ref" 2>/dev/null | head -n1)" ]; then rm -rf "$d" && say "removed drill-created round dir $d"; else say "kept round dir $d (older entries: not made by this drill)"; fi
done

# 7. the trust entry stays (harmless once the dir is gone): report it
if grep -q "\"$CWD\"" "$CCJSON" 2>/dev/null; then say "LEFT: trust entry for $CWD in $CCJSON"; else say "no trust entry for $CWD in $CCJSON"; fi

# 8. the dir (after a final copy of the logs the report may need is the caller's job: this removes everything)
if [ "${KEEP_LOGS:-1}" = 1 ]; then
  mkdir -p "$DRILLDIR/logs"
  for f in daemon.log state/seanced.log state/custodian/rounds.jsonl state/custodian/notes.md watch.log; do
    [ -f "$D/$f" ] && cp "$D/$f" "$DRILLDIR/logs/$(basename "$D").$(basename "$f")"
  done
  say "logs kept in $DRILLDIR/logs (daemon log, audit log, rounds, notes: no secrets, no pane text by design)"
fi
rm -rf "$D" && say "removed $D"
rm -f "$DRILLDIR/env.sh"
ps -o pid,command -p "$DAEMON_PID" "$TMUX_PID" "$LISTENER_PID" 2>/dev/null | tail -n +2 | grep . && say "WARNING: a drill process is still alive" || say "no drill process left"
