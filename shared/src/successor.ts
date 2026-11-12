import type { Machine } from "./app-client.ts";
import { autonomyOf } from "./autonomy.ts";
import { taskPrs } from "./task-prs.ts";
import {
  CAPABILITIES,
  SUCCESSOR_PROMPT_BYTES,
  TASK_REQUEST_LIMITS,
  type Assignment,
  type SuccessorTrigger,
  type Task,
  type TaskSpec,
} from "./types.ts";

/**
 * Passing a running task to a successor (DESIGN.md, Scheduler, "Passing to a successor"): the
 * one rule for who may be offered it, the spec of the task that carries on, and the prompt that
 * tells it where the work stands. Imports nothing that logs, since `seanced mcp` reaches it.
 */

export type PassOffer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether `task` can be passed now: the one rule the PWA's button, MCP's `pass_task` and `seanced
 * pass` share, as `continueOffer` is for Continue, so they cannot drift. The leader checks the
 * same things again with what it alone knows (the old exclave's account, the PR's head).
 * `leaderSuccessor` is whether the verified leader advertises `CAPABILITIES.successor`: an older
 * one answers an unknown op `invalid_request`, never a timeout.
 *
 * Only a `running` task: a task waiting on a person is never moved from under them (the person can
 * answer or cancel first), and `lost` has no live session to push from.
 */
export function passOffer(task: Task, machines: readonly Machine[], leaderSuccessor: boolean): PassOffer {
  if (task.successor !== undefined) return { ok: false, reason: "it has already been passed to a successor" };
  if (task.state === "needs-input") {
    return { ok: false, reason: "it is waiting for you; answer it or cancel it before passing it on" };
  }
  if (task.state !== "running") return { ok: false, reason: "only a running task can be passed to a successor" };
  if (task.spec.mode === "here") {
    return { ok: false, reason: "a task run in place has no branch of its own to pass on" };
  }
  const { assignment } = task;
  if (assignment === undefined) return { ok: false, reason: "the task was never placed on a machine" };
  if (!leaderSuccessor) {
    return { ok: false, reason: "the scheduler's leader can't pass tasks to a successor yet (needs seanced update)" };
  }
  const machine = machines.find((m) => m.deviceId === assignment.deviceId);
  if (machine === undefined) return { ok: false, reason: "the machine it runs on is no longer listed" };
  if (!machine.connected) return { ok: false, reason: "the machine it runs on is not connected" };
  if (machine.capabilities?.includes(CAPABILITIES.successor) !== true) {
    return { ok: false, reason: "the machine it runs on can't push for a successor yet (needs seanced update)" };
  }
  return { ok: true };
}

/**
 * The spec of the task that carries `task`'s work on. Carries what shapes the session (repo, model,
 * effort, skill, autonomy, plan, title) and what settles it (`until`, `linear`, `avoid`), and
 * nothing that places or orders it: no `pin` (an account pin is the old account by definition),
 * `deps` (already satisfied), `batch`, `lineage`, `base`, `continues` or `attachments`. The mode is
 * a plain worktree spawn, so no daemon needs to know about successors to run one. `succeeds` names
 * the predecessor, its account and where it ran (display; nothing routes on its clone).
 *
 * A `steer` task's successor runs at `checkpoint`, without plan mode: the plan was approved. `auto`
 * and `checkpoint` stay as they are, so an unattended failover does not stop at its first choice.
 * The caller stamps `client`.
 */
export function successorSpec(
  task: Task & { readonly assignment: Assignment },
  account: string,
  trigger: SuccessorTrigger,
  prompt?: string,
): TaskSpec {
  const { spec, assignment } = task;
  const steered = autonomyOf(spec) === "steer";
  return {
    repo: spec.repo,
    mode: "worktree",
    ...(prompt === undefined ? {} : { prompt }),
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    ...(steered
      ? { autonomy: "checkpoint" }
      : {
          ...(spec.plan === undefined ? {} : { plan: spec.plan }),
          ...(spec.autonomy === undefined ? {} : { autonomy: spec.autonomy }),
        }),
    ...(spec.skill === undefined ? {} : { skill: spec.skill }),
    ...(spec.avoid === undefined ? {} : { avoid: spec.avoid }),
    ...(spec.until === undefined ? {} : { until: spec.until }),
    ...(spec.linear === undefined ? {} : { linear: spec.linear }),
    succeeds: {
      task: task.id,
      account,
      at: { deviceId: assignment.deviceId, exclave: assignment.exclave, clone: assignment.clone },
      trigger,
    },
  };
}

/** What a successor prompt is built from. `record` is what the old session wrote (the self path, not built here). */
export interface SuccessorPromptInput {
  readonly task: Task;
  /** The branch on `origin` holding the work: validated by the caller (`isBranchName`), the only branch the prompt names. */
  readonly remoteBranch: string;
  /** The commit it holds. */
  readonly tip: string;
  readonly record?: string;
}

export interface SuccessorPrompt {
  readonly prompt: string;
  /** The record had to be cut (the old prompt is cut first and is not reported). */
  readonly recordCut: boolean;
}

const RECORD_HEAD = "\n\nThe previous session wrote this record for you:\n";
const OLD_PROMPT_HEAD = "\n\nThe original task prompt:\n";
const RECORD_CUT_NOTE =
  "\n[The record was too long and its end was cut; the branch and the pull request hold the rest.]";
const OLD_PROMPT_CUT_NOTE = "\n[The rest of the original prompt was cut to fit.]";

/** One word for git, whatever a branch name holds: a name is a ref's, not a shell's, and may carry `$`, `;` or a quote. */
function quoted(value: string): string {
  return /^[A-Za-z0-9._/@+:-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The fixed part of every successor prompt, never cut. It names the remote branch `<r>`, never the old
 * local branch, and tells the successor to keep its fresh worktree and its own branch, put it on the
 * pushed work and track it (nothing is lost, the worktree is fresh), never to check `<r>` out under its
 * own name (a local branch of that name may be checked out in an older worktree), to rebuild where the
 * work stands from git and each pull request, and to push back to `<r>` into the existing pull request.
 */
export function successorPreamble(input: Pick<SuccessorPromptInput, "task" | "remoteBranch" | "tip">): string {
  const { task, remoteBranch, tip } = input;
  const remote = quoted(`origin/${remoteBranch}`);
  const prs = taskPrs(task).map((pr) => pr.url);
  const lines = [
    `You continue task ${task.id}, which an earlier session began. It pushed its work to the branch ${quoted(remoteBranch)} on origin at ${tip}.`,
    "",
    "Keep your own fresh worktree and its own new branch. Do these first, in order:",
    `1. git fetch origin ${quoted(remoteBranch)}`,
    `2. git reset --hard ${remote} (nothing is lost: the worktree is fresh)`,
    `3. git branch --set-upstream-to=${remote}`,
    "Never check that branch out under its own name: a local branch of that name may be checked out in an older worktree.",
    "",
    "Then rebuild where the work stands from `git log`, `git diff origin/HEAD...`" +
      (prs.length === 0 ? "." : ` and \`gh pr view <url>\` for each pull request: ${prs.join(" ")}`),
    "",
    `Push with \`git push origin ${quoted(`HEAD:${remoteBranch}`)}\`. ` +
      (prs.length === 0
        ? "Open a pull request once there is something to review."
        : "Keep the existing pull request and never open a second one for the same work."),
  ];
  if (task.spec.attachments !== undefined) {
    lines.push("", "The original task had attached files; they are not available to you.");
  }
  return lines.join("\n");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The longest prefix of `text`, cut at a code point, that fits the room left under both bounds.
 * A lone surrogate counts the three bytes it encodes to.
 */
function prefixWithin(text: string, units: number, bytes: number): string {
  let usedUnits = 0;
  let usedBytes = 0;
  let end = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (usedUnits + ch.length > units || usedBytes + width > bytes) break;
    usedUnits += ch.length;
    usedBytes += width;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * The successor's prompt: the preamble, the record when one was written, the old prompt and the
 * Linear key. Pure and deterministic. Two bounds hold it, both after substitution:
 * `TASK_REQUEST_LIMITS.prompt` in UTF-16 units and `SUCCESSOR_PROMPT_BYTES` in UTF-8 bytes (the size a
 * create is built for with two-byte text; three-byte text would pass the unit bound and come back
 * `too_large` only after the push). The old prompt is cut first, from its end; a record only when it
 * and the preamble still pass a bound, from its end, and the prompt then says so. The preamble is
 * never cut: its values are each bounded by their own limits, so it always fits.
 */
export function successorPrompt(input: SuccessorPromptInput): SuccessorPrompt {
  const { task, record } = input;
  const preamble = successorPreamble(input);
  const old = task.spec.prompt === undefined || task.spec.prompt === "" ? undefined : task.spec.prompt;
  const linear = task.spec.linear === undefined ? "" : `\n\nLinear issue: ${task.spec.linear.issue}`;
  const room = (fixed: string): { readonly units: number; readonly bytes: number } => ({
    units: Math.max(0, TASK_REQUEST_LIMITS.prompt - fixed.length),
    bytes: Math.max(0, SUCCESSOR_PROMPT_BYTES - utf8Length(fixed)),
  });
  const fits = (text: string): boolean =>
    text.length <= TASK_REQUEST_LIMITS.prompt && utf8Length(text) <= SUCCESSOR_PROMPT_BYTES;
  const compose = (recordText: string | undefined, oldText: string | undefined): string =>
    preamble +
    (recordText === undefined ? "" : RECORD_HEAD + recordText) +
    (oldText === undefined ? "" : OLD_PROMPT_HEAD + oldText) +
    linear;
  const whole = compose(record, old);
  if (fits(whole)) return { prompt: whole, recordCut: false };

  // The old prompt first: whatever room is left once everything else is whole.
  const withoutOld = compose(record, undefined);
  if (fits(withoutOld)) {
    if (old === undefined) return { prompt: withoutOld, recordCut: false };
    const left = room(compose(record, "") + OLD_PROMPT_CUT_NOTE);
    const kept = prefixWithin(old, left.units, left.bytes);
    return { prompt: compose(record, kept === "" ? undefined : kept + OLD_PROMPT_CUT_NOTE), recordCut: false };
  }

  // Then the record's end, with the old prompt gone and the preamble untouched.
  const left = room(compose("", undefined) + RECORD_CUT_NOTE);
  const kept = prefixWithin(record ?? "", left.units, left.bytes);
  return { prompt: compose(kept + RECORD_CUT_NOTE, undefined), recordCut: true };
}
