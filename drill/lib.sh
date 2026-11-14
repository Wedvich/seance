# Sourced by check.sh and cleanup.sh after env.sh. Where the round actually ran, from the drill daemon's own audit.

# The exclave the round ran in: the last `op=start` audit line's; setup's $EXCLAVE when no round started.
round_exclave() {
  local x
  x=$(sed -n 's/.*audit custodian origin=custodian op=start exclave="\([a-z0-9-]*\)".*/\1/p' "$D/daemon.log" 2>/dev/null | tail -n1)
  printf %s "${x:-$EXCLAVE}"
}

# True when an `op=start` line exists at all.
round_started() { grep -q 'audit custodian origin=custodian op=start ' "$D/daemon.log" 2>/dev/null; }

# Claude Code's project dir for that exclave's round: its config dir (`~/.claude`, `~/.claude-<x>`) and the round dir's
# real path (roundDirFor: `$D/state/custodian/cwd` for default, `~/<x>/.seance-custodian` for a named one) with every
# character but [A-Za-z0-9] made '-', as Claude Code names a project dir.
round_project_dir() {
  local x=$1 cfg dir real
  if [ "$x" = default ]; then
    cfg=$HOME/.claude
    dir=$D/state/custodian/cwd
  else
    cfg=$HOME/.claude-$x
    dir=$HOME/$x/.seance-custodian
  fi
  real=$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P) || real=$(dirname "$dir")
  real=$real/$(basename "$dir")
  printf '%s/projects/%s' "$cfg" "$(printf %s "$real" | sed 's/[^A-Za-z0-9]/-/g')"
}
