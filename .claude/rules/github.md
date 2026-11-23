---
paths:
  - "daemon/src/{push-branch,gh,pr-status,reap-git,github-rate,github-alerts,watch-leader,watch-registry,git-hardened,branch-state}.ts"
  - "daemon/test/{push-branch,pr-status,github}*.ts"
  - "shared/src/{watch,task-prs,pr-blocked}.ts"
---

# GitHub: the one write, and every read

Requirements, not observations: DESIGN.md's "GitHub rate limits", "Watches" and Threat model are the
record; docs/gh-watch.md indexes the watch decisions. The daemon's own watch table is watches.md.

## The one write: `pushTaskBranch`

- The daemon's one write to a forge is `pushTaskBranch` (`daemon/src/push-branch.ts`): a `git push`
  through `networkGit`, never forced, of `<tip sha>:refs/heads/<r>` to `origin` only, `<tip>` that of
  `<b>`, the branch its own launch ledger's worktree has checked out, and `<r>` that branch's configured
  upstream on `origin` (one on another remote counts as none).
  - With no upstream and a scheduler-sealed `push-branch`'s `expect` (the PR head the leader read): that
    `expect`, only when origin's tip of it is an ancestor of the local tip and of no default branch's tip,
    the default fetched with it (else nothing is pushed, `branch_mismatch`; the default branch itself is
    `default_branch`).
  - With neither: `<b>`.
  - A push refused as a non-fast-forward is `push_rejected` unless the pushed sha is already part of
    origin's refetched `<r>`, which is `ok` with nothing pushed — never forced, merged or rebased.
- Never a path, never a branch a session names, only on a clean tree and never to the default branch,
  refusing repo-local `remote.*.pushurl` and `url.*.pushinsteadof` (`pushConfigRefusal`), only on a
  `push-branch` sealed `from` the scheduler (or the leader in process), audited with no branch name and
  with git's stderr never in a reply, a log or an audit line.

## The leader's reads

- The leader reads a PR's head only with its own `gh` (`readPrHead`), bound to the task's `prUrl`, its
  values passed as GraphQL variables, and never logs it.
- A PR status is read only by the leader's own `gh`, bound to a PR URL the record holds (`taskPrs`), its
  values passed as GraphQL variables, and no frame carries one.
- A watched target is read only by the leader's own poller (`daemon/src/pr-status.ts`), as a URL
  `parseWatchSet` (`shared/src/watch.ts`) holds to the PR or run pattern and the poller rebuilds from its
  parsed owner, repo and number or id, passed as GraphQL variables with the query text built from alias
  indices alone, never a session's string, read-only through `askGithub`.
- A `watch-set` is honoured only sealed from a registered machine's own device id advertising
  `CAPABILITIES.watches` (never `from: "app"`, never the archivist) or in process, parsed fresh and past
  the one `schedulerGuard`. A `watch-event` is acted on only sealed from the scheduler or in process,
  parsed by `parseWatchEvent`. Neither frame names a pane, a task or a session.
- A watch never changes a task's `PrStatus` or record nor a poller class (`daemon/src/watch-registry.ts`
  imports no scheduler and no `log.ts`).
- The fleet caps (100 PRs, 100 runs), the per-device cap (64) and the reserve for tasks' reads (under 500
  points of `remaining`) are the leader's, never a frame's, and no URL, head, check name or watch id is
  logged.

## A daemon's reads

- A daemon reads a forge only for reap's nothing-lost rule (`nothingLost`, `daemon/src/reap-git.ts`): its
  own `gh` through `askGithub` (`daemon/src/gh.ts`), read-only, argv-array, a constant query, owner, name
  and branch as `-f` GraphQL variables, bound to the worktree's own branch and `origin`'s GitHub repo,
  merged same-repository PRs only, its output never logged, deciding only whether a worktree on that
  machine is removed and only when local git shows the PR's head contains the tip. A rule that cannot be
  evaluated (no network, `gh` failing, a non-GitHub origin) keeps the worktree and is never reported as a
  failure.
- Beside it a daemon reads only its own GitHub budget (`daemon/src/github-rate.ts`): two constant REST
  reads in `gh.ts`, `gh api --hostname github.com rate_limit` (`readRateLimit`, on a timer, free of any
  limit) and `gh api --hostname github.com user --jq .id` (`readGithubUserId`, cached a day). Argv arrays
  with no variable and nothing from a frame, session or config, a timeout with the group killed,
  read-only, keeping only `resources.core` and `resources.graphql`'s four counts after an exact-shape
  check and a 1–16 digit id, never logging stdout or stderr, a failure no reading and no line, and
  sending nothing but `MachineStatus.gh` (display-only but for the leader's `github` push, never trimmed
  by `fitStatus`, a bad one dropped alone).
- The leader alerts a budget once per GitHub user (`gh.u`), budget and reset window
  (`SettingsRecord.githubAlerts`, `daemon/src/github-alerts.ts`) with a push carrying only the budget's
  name and reset, never the user id.
