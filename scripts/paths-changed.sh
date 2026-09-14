#!/usr/bin/env bash
#
# Answers "did this push touch any of these paths?" for a workflow's deploy gate.
#
# Job-level `paths` filters don't exist in Actions, and the workflow-level one would
# gate the checks and the test matrix too — so the deploy jobs ask this instead.
# Shell rather than TS on purpose: the gate job runs before `bun install`, and giving
# it a toolchain just to diff two commits would cost more than the job it guards.
#
#   paths-changed.sh <base-sha> <head-sha> <path>...
#
# Prints `changed=true|false` on stdout, and appends the same line to $GITHUB_OUTPUT
# when set. Exit status reports whether the *check ran*, not what it found: a caller
# must read the value, not `if paths-changed.sh`.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <base-sha> <head-sha> <path>..." >&2
  exit 2
fi

base="$1"
head="$2"
shift 2

emit() {
  echo "changed=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "changed=$1" >> "$GITHUB_OUTPUT"
  fi
}

# A new branch, a force-push over the base, or a shallow clone that doesn't reach it
# leaves nothing to diff against. Deploy rather than silently skip: a redundant deploy
# is cheap, a missed one ships nothing and says it succeeded.
if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] \
  || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  emit true
  exit 0
fi

# --quiet rather than piping --name-only into `grep -q`: grep exits at the first
# match, the diff takes SIGPIPE once its output outgrows the pipe buffer, and
# `set -o pipefail` turns that into the false branch. A few hundred changed paths
# is enough — the gate then skips the biggest changes it exists to catch.
if git diff --quiet "$base" "$head" -- "$@"; then
  emit false
else
  emit true
fi
