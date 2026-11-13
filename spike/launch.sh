#!/bin/bash
# Spike-2: start a real `claude` with the throwaway `inbox` mod in a session of the private tmux
# server `spk2`, in a throwaway dir whose .claude/settings.json disables session-events, tmux-rename
# and codex. Accepts the trust dialog and waits until the mod has started.
#   spike/launch.sh <tmux-session> <dir> <model> [append-system-prompt] (extra env via SPIKE_ENV)
set -euo pipefail
name=$1 dir=$2 model=$3 append=${4:-}
plugin="$(cd "$(dirname "$0")" && pwd)/inbox"
cmd="export CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR SPIKE_DIR=$dir ${SPIKE_ENV:-}; claude --model $model --strict-mcp-config --plugin-dir $plugin --debug-file $dir/debug.log"
[ -n "$append" ] && cmd="$cmd --append-system-prompt $(printf %q "$append")"
tmux -L spk2 -f /dev/null new-session -d -s "$name" -x 200 -y 50 -c "$dir"
tmux -L spk2 send-keys -t "$name" "$cmd" Enter
until tmux -L spk2 capture-pane -p -t "$name" | grep -q "trust this folder"; do sleep 1; done
tmux -L spk2 send-keys -t "$name" Down
sleep 0.5
tmux -L spk2 send-keys -t "$name" Enter
until compgen -G "$dir/log-*.jsonl" >/dev/null; do sleep 1; done
until tmux -L spk2 capture-pane -p -t "$name" | grep -q "bypass permissions"; do sleep 1; done
sleep 2
