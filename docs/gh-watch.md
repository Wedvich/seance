# Fleet GitHub watches — what is left

**Status: built and folded into DESIGN.md (build steps 1 to 4 and spikes S1 to S4, all 2026-11-18).** A session asks the
fleet to watch a pull request or an Actions run and is woken by a fixed note in its inbox, instead of polling GitHub
itself; the leader folds watched targets into its batched GraphQL PR poll. Drafted 2026-11-17; the owner decided G1 and
the open questions on 2026-11-18. Every decision (W1–W11), its rejected alternatives and its threat model are recorded
in DESIGN.md (index below). What is left here is the changes to /ship and the owner's instructions, which live outside
this repo.

**Where each part is recorded:**

- The problem, W1–W11, the rejected alternatives and S4: DESIGN.md, Daemon, "Watches" (the first bullets after its
  step 4 bullet).
- The leader's side: Scheduler, "PR status": `askGithub`'s `limited` class and the reset-time backoff ("A spent budget is
  waited out", W8), one clock and no `quiet` option (open questions 1 and 2), "Watched targets", "The run query" (S1,
  W7), "What a watch's events are" (S2, W4), "The registry" (W9), "Reserve for tasks", "Suspended and unreadable".
- S3 (the rate-limit shapes, from `gh`'s source and GitHub's docs, not a live spent budget): beside the `limited` class
  in "PR status".
- The daemon's side (the `watch` frame, the table, `watches.json`, notes, the custodian hold, audit): "Watches".
- MCP's `watch_github` and `unwatch_github` and their gate: "MCP server".
- The threat-model invariants (cited elsewhere as "docs/gh-watch.md invariants 1 to 8"; the list went with the spec): Threat model, "A watch's target reaches GitHub only
  through the leader's poller…" (2, 4, 5) and "A daemon's watch table binds a watch to its session's `claude`
  process…" (1, 3, 5-8); CLAUDE.md's conventions list carries the same.
- The budget gauge (open question 3): #547, `MachineStatus.gh` and the leader's `github` alert, "GitHub rate limits".
  A live-watch count on the Machines row is not built, by decision.

## What it replaces in practice

Proposed to the owner, not applied: both live outside this repo (the /ship skill and `~/.claude/CLAUDE.md`).

- **/ship step 8, "Watch".** The hand-off branch stays as it is (W11). The watch branch becomes: after the push,
  `watch_github` on each PR with `head` set to the pushed commit, end the turn. A `checks fail` note carries the
  failing jobs' ids, which step 8's log step needs (it reads them from `gh pr checks --json link` today); a `conflict`
  note replaces the 20×30 s `mergeable` loop; `merged` ends it. A re-run or a fix push is a new `head`: call the tool
  again, which replaces the watch. A refusal (`unsupported`, `no_leader`, `nolistener`, `fleet_full`) falls back to
  today's background script. Step 9's "wait for main's dev deploy job to finish" becomes `watch_github` on that run.
- **The owner's waiting instructions** (`~/.claude/CLAUDE.md`, "Waiting") would gain one rule ahead of the others:
  in a Séance session, wait for a PR or an Actions run with `watch_github` and end the turn; fall back to
  `gh pr checks --watch -i 30` and `gh-run-wait` only when it refuses. The 30-second floor stays for everything else.
  Both tools need `mcp__seance__watch_github` and `mcp__seance__unwatch_github` allowed in the exclave.
- **What it does not replace**: a session watching a non-GitHub forge, a run on GitHub Enterprise, or anything not a
  PR or a run (a deploy's health URL, a release). Those keep their own waits under the owner's rules.
