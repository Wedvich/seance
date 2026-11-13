import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, chmod, mkdir, open, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname } from "node:path";
import {
  amendedFields,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  quote,
  type AmendRequest,
  type DespawnRequest,
  type FailureReason,
  type MessageKind,
  type SpawnClient,
  type SpawnRequest,
  type SuccessorTrigger,
  type UpdateOutcome,
} from "@seance/shared";
import type { DespawnResult, SpawnOutcome } from "./backend.ts";
import type { BrokerErrorCode, BrokerSchedulerOp } from "./broker-protocol.ts";
import type { Check } from "./check.ts";
import { fingerprintText } from "./hash.ts";
import { formatLine, log } from "./log.ts";
import { logPath } from "./paths.ts";

/**
 * The first question when a line looks unfamiliar. `cli` at 2pm is the human at
 * the keyboard; `relay` at 3am with the phone in a drawer is not. `local` is
 * neither: something on this box drove the daemon over its op socket without
 * touching the relay — in practice a Claude session holding the MCP server, so
 * the `client` tag beside it is the rest of the answer. `leader` is this
 * daemon's own scheduler loop dispatching to this machine, which it reaches in
 * process rather than through the relay (`leader.ts`). `handoff` is a session
 * closing itself through `hand_off_task` (`handoff.ts`): despawn only. `successor` is a session passing
 * its own task through `pass_to_successor`: the push it asked for and, once the leader confirms, the
 * close at its turn's end (`handoff.ts`), never anything else.
 */
export type SpawnOrigin = "relay" | "cli" | "local" | "leader" | "handoff" | "successor";

export type AuditSink = (line: string) => void | Promise<void>;

/**
 * Owner-only, like config.json and the sealed PSK blobs — this is the file that
 * records repo paths, device ids and window titles unhashed, and 0644 was only
 * ever the default umask answering for it.
 */
export const AUDIT_LOG_MODE = 0o600;

/** The daemon's stdout — launchd redirects it into the file the CLI appends to. */
export const daemonSink: AuditSink = (line) => log.info(line);

/**
 * `seanced spawn` is a separate process with no launchd redirect, so it appends
 * to the log itself. Never throws: an unwritable log must not fail a spawn the
 * human asked for. Two independent writers is safe while nothing rotates the
 * file — a rename-and-recreate would leave the daemon on the old inode.
 */
export const cliSink: AuditSink = async (line) => {
  const path = logPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${formatLine("info", line)}\n`, { mode: AUDIT_LOG_MODE });
  } catch (err) {
    console.error(`could not write the audit log at ${path}: ${String(err)}`);
  }
};

/**
 * Names the state observed in production: a log the daemon's own user cannot
 * append to, so `seanced spawn` records nothing and the both-paths-audit
 * invariant holds only for `origin=relay`.
 */
export function unwritableLogMessage(path: string, user: string): string {
  return (
    `the audit log at ${path} is not writable by ${user} — spawns typed at this machine go unrecorded. ` +
    `This is what a service redirect opened as root leaves behind: sudo chown ${user} ${path} && sudo chmod 600 ${path}`
  );
}

/**
 * Makes the log exist, owner-only and appendable, before anything writes to it.
 * Returns null when it is, otherwise what the operator has to run — the daemon
 * warns and keeps serving, matching `cliSink`'s posture: a broken audit trail
 * is not a reason to take the machine offline.
 *
 * Repair rather than reinstall, because `install --system` chowns the log once
 * and systemd re-creates it as root — `StandardOutput=append:` is opened before
 * the drop to `User=` — every time it goes missing afterwards. What is not
 * repairable from an unprivileged daemon is the ownership of someone else's
 * file, hence the message.
 *
 * Never renames or truncates: the daemon's redirect holds an fd on this inode
 * and the CLI appends to it by name, so rotating it under them would split the
 * trail across two files (see `cliSink`).
 */
export async function ensureAuditLog(path: string = logPath()): Promise<string | null> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const info = await stat(path).catch(() => null);
    if (info === null) {
      // Created 0600 outright rather than written and chmod'd, as the PSK blobs
      // are; "a" is what makes creating it safe on a file that already exists.
      await (await open(path, "a", AUDIT_LOG_MODE)).close();
    } else if (ownedByUs(info.uid) && (info.mode & 0o777) !== AUDIT_LOG_MODE) {
      // The redirect creates it at the manager's umask, so tightening it is the
      // daemon's job on every start, not the installer's once.
      await chmod(path, AUDIT_LOG_MODE);
    }
  } catch (err) {
    return `could not prepare the audit log at ${path}: ${String(err)} — spawns typed at this machine go unrecorded`;
  }
  return (await writable(path)) ? null : unwritableLogMessage(path, userInfo().username);
}

/** Doctor's audit-log section: writability first — size was never the question worth asking. */
export async function auditLogChecks(path: string = logPath()): Promise<readonly Check[]> {
  const info = await stat(path).catch(() => null);
  if (info === null) return [];
  if (!(await writable(path))) {
    // No size line under the fail: an `ok` verdict on the same broken file reads
    // as re-checked-and-passed — and "consider truncating" a file the user can't
    // write is not advice.
    return [{ level: "fail", message: unwritableLogMessage(path, userInfo().username) }];
  }
  const checks: Check[] = [];
  if ((info.mode & 0o777) !== AUDIT_LOG_MODE) {
    const mode = (info.mode & 0o777).toString(8).padStart(4, "0");
    const exposure = `log is ${mode}, and it records repo paths and window titles`;
    // `seanced restart` repairs the mode only on a file the daemon owns
    // (ensureAuditLog); on someone else's file the honest fix is the chown pair.
    checks.push({
      level: "warn",
      message: ownedByUs(info.uid)
        ? `${exposure} — \`seanced restart\` tightens it to 0600`
        : `${exposure} — owned by another user, so restart can't tighten it: ` +
          `sudo chown ${userInfo().username} ${path} && sudo chmod 600 ${path}`,
    });
  }
  const size = info.size;
  checks.push(
    size > 10 * 1024 * 1024
      ? { level: "warn", message: `log is ${Math.round(size / 1024 / 1024)}MB — consider truncating (${path})` }
      : { level: "ok", message: `log ${Math.round(size / 1024)}KB (${path})` },
  );
  return checks;
}

function ownedByUs(uid: number): boolean {
  const me = process.getuid?.();
  return me === undefined || me === uid;
}

async function writable(path: string): Promise<boolean> {
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

export interface SpawnAudit {
  readonly request: (request: SpawnRequest) => Promise<void>;
  readonly ok: (outcome: SpawnOutcome) => Promise<void>;
  /** `id`: the session a `task_running` refusal points at. */
  readonly failed: (code: string, id?: string) => Promise<void>;
  readonly rejected: (reason: string) => Promise<void>;
}

/**
 * Every spawn path audits through here so they never drift into formats that
 * need three greps. The prompt is recorded as a length plus eight hex of SHA-256,
 * never quoted — the log is plaintext at rest, and a hash still answers "was
 * that mine?" without turning it into a transcript of everything ever asked.
 */
export function spawnAudit(origin: SpawnOrigin, sink: AuditSink): SpawnAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit spawn origin=${origin} ${rest}`);
  };
  return {
    request: async (request: SpawnRequest): Promise<void> => {
      const prompt = request.prompt ?? "";
      const promptNote =
        prompt === "" ? "prompt=none" : `promptLen=${prompt.length} promptSha=${await fingerprintText(prompt)}`;
      // First when present, so `origin=relay client=…` reads as one attribution.
      const clientNote = request.client === undefined ? "" : `client=${quote(request.client)} `;
      // Only when on, so every ordinary spawn's line stays byte-identical.
      const planNote = request.plan === true ? "plan=true " : "";
      const autonomyNote = request.autonomy === undefined ? "" : `autonomy=${request.autonomy} `;
      const taskNote = request.taskId === undefined ? "" : `task=${quote(request.taskId)} `;
      const continuesNote = request.continues === undefined ? "" : `continues=${quote(request.continues)} `;
      // Presence only: the URL names a private repo, and the log is plaintext at rest.
      const inheritedNote = request.inheritedPr === undefined ? "" : "inheritedPr=true ";
      // Counts only: names are treated as prompt text, and ids and hashes say nothing an operator needs.
      const files = request.attachments;
      const attachmentsNote =
        files === undefined
          ? ""
          : `attachments=${files.length} attachmentBytes=${files.reduce((sum, file) => sum + file.size, 0)} `;
      await emit(
        `${clientNote}repo=${quote(request.repo)} mode=${request.mode} title=${quote(request.title ?? "")} ` +
          `model=${quote(request.model ?? DEFAULT_MODEL)} effort=${quote(request.effort ?? DEFAULT_EFFORT)} ` +
          planNote +
          autonomyNote +
          taskNote +
          continuesNote +
          inheritedNote +
          attachmentsNote +
          promptNote,
      );
    },
    ok: async (outcome: SpawnOutcome): Promise<void> => {
      await emit(`ok window=${quote(outcome.window)} path=${quote(outcome.path)}`);
    },
    failed: async (code: string, id?: string): Promise<void> => {
      await emit(`failed code=${code}${id === undefined ? "" : ` target=${quote(id)}`}`);
    },
    rejected: async (reason: string): Promise<void> => {
      await emit(`rejected ${reason}`);
    },
  };
}

export interface DespawnAudit {
  readonly request: (request: DespawnRequest) => Promise<void>;
  readonly ok: (result: DespawnResult) => Promise<void>;
  readonly failed: (code: string) => Promise<void>;
  readonly rejected: (reason: string) => Promise<void>;
}

/**
 * Despawns audit like spawns — same origins, same sink — since ending a session
 * is as much "something used my machine" as starting one. The id and window
 * name are both wire text, so both are quoted, as spawn's title is.
 */
export function despawnAudit(origin: SpawnOrigin, sink: AuditSink): DespawnAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit despawn origin=${origin} ${rest}`);
  };
  return {
    request: async (request: DespawnRequest): Promise<void> => {
      const clientNote = request.client === undefined ? "" : `client=${quote(request.client)} `;
      const forceNote = request.force === true ? " force=true" : "";
      await emit(`${clientNote}target=${quote(request.id)}${forceNote}`);
    },
    ok: async (result: DespawnResult): Promise<void> => {
      await emit(`ok window=${quote(result.window)} outcome=${result.outcome}`);
    },
    failed: async (code: string): Promise<void> => {
      await emit(`failed code=${code}`);
    },
    rejected: async (reason: string): Promise<void> => {
      await emit(`rejected ${reason}`);
    },
  };
}

/**
 * A `push-branch`: which task's worktree, in which repo, and what came of it — a code, `pushed` or `unchanged`
 * (origin already held the tip) — with the first seven characters of the tip. Never the branch, its remote name or a
 * URL: they are the user's own text (DESIGN.md, "Passing to a successor"). `malformed`: a scheduler-sealed request
 * that did not parse, so it names no task.
 */
export interface PushAudit {
  readonly malformed: () => Promise<void>;
  readonly refused: (taskId: string, outcome: string) => Promise<void>;
  readonly done: (taskId: string, repo: string, outcome: string, tip: string | undefined) => Promise<void>;
}

export function pushAudit(origin: SpawnOrigin, sink: AuditSink): PushAudit {
  return {
    malformed: async () => {
      await sink(`audit push origin=${origin} task=- outcome=invalid_request`);
    },
    refused: async (taskId, outcome) => {
      await sink(`audit push origin=${origin} task=${quote(taskId)} outcome=${outcome}`);
    },
    done: async (taskId, repo, outcome, tip) => {
      const tipNote = tip === undefined ? "" : ` tip=${tip.slice(0, 7)}`;
      await sink(`audit push origin=${origin} task=${quote(taskId)} repo=${quote(repo)} outcome=${outcome}${tipNote}`);
    },
  };
}

/**
 * A `pass-close` the scheduler sent: whether it armed a pane's close at its turn end. Names the task, never a pane;
 * `null` for one that did not parse (`task=-`).
 */
export function passCloseAudit(
  origin: SpawnOrigin,
  sink: AuditSink,
): (taskId: string | null, outcome: string) => Promise<void> {
  return async (taskId, outcome) => {
    await sink(`audit pass-close origin=${origin} task=${taskId === null ? "-" : quote(taskId)} outcome=${outcome}`);
  };
}

/**
 * An `availability` request: whether a person closed or reopened this machine, one line so a
 * count of `open=false` is a count of closes (docs/drain.md). `open` is `-` for one that did not parse.
 */
export function availabilityAudit(
  origin: SpawnOrigin,
  sink: AuditSink,
): (opened: boolean | null, outcome: string, now?: boolean) => Promise<void> {
  return async (opened, outcome, now) => {
    const nowNote = now === true ? " now=true" : "";
    await sink(
      `audit availability origin=${origin} open=${opened === null ? "-" : String(opened)} outcome=${outcome}${nowNote}`,
    );
  };
}

export interface QueueAudit {
  readonly markedDone: (id: string, task: { readonly id: string }) => Promise<void>;
  /** A `run-now` that reserved the task past the concurrency caps. */
  readonly ranNow: (id: string, task: { readonly id: string }) => Promise<void>;
  readonly cancelled: (id: string, task: { readonly id: string; readonly leftRunning?: boolean }) => Promise<void>;
  /** A `pass` that created `successor` for `task`. The branch and the PR stay out: they are the user's own text. */
  readonly passed: (
    id: string,
    task: { readonly id: string },
    successorId: string,
    trigger: SuccessorTrigger,
  ) => Promise<void>;
  /** A `discard` that deleted the unreadable record at `task` and `version`. */
  readonly discarded: (id: string, taskId: string, version: number) => Promise<void>;
  /**
   * An `amend` answered with `task`: the fields it named and, beside the prompt, its mode and the
   * prompt's length after — never a field's value, the prompt and the amendment least of all.
   */
  readonly amended: (
    id: string,
    task: { readonly id: string; readonly spec: { readonly prompt?: string } },
    request: AmendRequest,
  ) => Promise<void>;
  readonly refused: (
    op:
      | "cancel"
      | "mark-done"
      | "run-now"
      | "pass"
      | "amend"
      | "pause"
      | "resume"
      | "discard"
      | "push-subscribe"
      | "push-unsubscribe",
    id: string,
    code: string,
    /** What the request named: a `cancel`, `mark-done` or `run-now`'s task, a `pause` or `resume`'s account (absent: the whole queue). */
    subject?: { readonly taskId?: string; readonly account?: string },
  ) => Promise<void>;
  /** A `pause` or `resume` answered with the holds; `account` absent is the whole queue. */
  readonly held: (op: "pause" | "resume", id: string, account: string | undefined) => Promise<void>;
  /** A `push-subscribe` that is now held (added, or already was). Names no endpoint, host or key: the endpoint is the subscription's secret. */
  readonly subscribed: (id: string) => Promise<void>;
  /** A `push-unsubscribe` answered: the endpoint is no longer held (removed, or never was). Names no endpoint, as `subscribed`. */
  readonly unsubscribed: (id: string) => Promise<void>;
}

/**
 * An app's request that changed, or tried to change, this leader's queue. Always
 * `origin=relay`: apps reach the scheduler only through it. `id` is the
 * request's, so the app's side can be found; `task` is what joins the line to
 * the `task=` on the spawn it leads to, on whichever machine runs it. Never the
 * prompt — that spawn line fingerprints it. The restrictions it carries are counted,
 * never named (`avoid`, `requires` as numbers, `pin` as 0 or 1): what the measurement
 * of placement wants, and a machine, account or trait name is the task's own business.
 */
export function queueAudit(sink: AuditSink): QueueAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit queue origin=relay ${rest}`);
  };
  return {
    markedDone: (id, task) => emit(`op=mark-done id=${quote(id)} task=${quote(task.id)} ok`),
    ranNow: (id, task) => emit(`op=run-now id=${quote(id)} task=${quote(task.id)} ok`),
    cancelled: (id, task) =>
      emit(
        `op=cancel id=${quote(id)} task=${quote(task.id)} ok${task.leftRunning === true ? " leftRunning=true" : ""}`,
      ),
    passed: (id, task, successorId, trigger) =>
      emit(`op=pass id=${quote(id)} task=${quote(task.id)} successor=${quote(successorId)} trigger=${trigger} ok`),
    discarded: (id, taskId, version) => emit(`op=discard id=${quote(id)} task=${quote(taskId)} version=${version} ok`),
    amended: (id, task, request) => {
      const prompt =
        request.prompt === undefined ? "" : ` mode=${request.prompt.mode} chars=${task.spec.prompt?.length ?? 0}`;
      return emit(
        `op=amend id=${quote(id)} task=${quote(task.id)} fields=${amendedFields(request).join(",")}${prompt} ok`,
      );
    },
    held: (op, id, account) =>
      emit(`op=${op} id=${quote(id)}${account === undefined ? "" : ` account=${quote(account)}`} ok`),
    subscribed: (id) => emit(`op=push-subscribe id=${quote(id)} ok`),
    unsubscribed: (id) => emit(`op=push-unsubscribe id=${quote(id)} ok`),
    refused: (op, id, code, subject) =>
      emit(
        `op=${op} id=${quote(id)}${subject?.taskId === undefined ? "" : ` task=${quote(subject.taskId)}`}${subject?.account === undefined ? "" : ` account=${quote(subject.account)}`} refused code=${code}`,
      ),
  };
}

/**
 * The leader taking an app's create into the queue — its first write to the
 * record, which leaves it `ready`, `blocked`, or `failed` at admission. The only
 * line an enqueue leaves on the leader: an app's create is a store write the
 * relay answers, never a request. `client` is the record's own (`TaskSpec.client`),
 * a PSK holder's word; `createdAt` is the app's clock. Never the prompt.
 */
export function admitAudit(sink: AuditSink): (task: {
  readonly id: string;
  readonly createdAt: number;
  readonly state: string;
  readonly spec: {
    readonly client?: string;
    readonly avoid?: readonly unknown[];
    readonly requires?: readonly unknown[];
    readonly pin?: unknown;
  };
}) => Promise<void> {
  return async (task) => {
    const client = task.spec.client === undefined ? "" : ` client=${quote(task.spec.client)}`;
    const counts = `avoid=${task.spec.avoid?.length ?? 0} requires=${task.spec.requires?.length ?? 0} pin=${task.spec.pin === undefined ? 0 : 1}`;
    await sink(
      `audit queue origin=leader op=admit task=${quote(task.id)}${client} createdAt=${task.createdAt} state=${task.state} ${counts}`,
    );
  };
}

/** How an enqueue ended: stored, refused by the relay with a code, or unanswered after every try. */
export type EnqueueOutcome =
  | { readonly kind: "queued"; readonly landedEarlier: boolean }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "unanswered" };

/**
 * Who enqueued, as both the line's origin and its client: `seanced mcp`, or
 * `seanced spawn` typed at this machine — the CLI's own origin, since
 * `audit enqueue` already tells the act apart from its `audit spawn`.
 */
export type EnqueueSurface = Extract<SpawnClient, "mcp" | "cli">;

/**
 * Where an enqueue line was written: the surface's own, or the daemon's when it
 * made the enqueue for a keyless peer. The broker's line labels the client
 * `claimed_client` — the peer's word, which the daemon cannot verify.
 */
export type EnqueueOrigin = EnqueueSurface | BrokerOrigin;

export type EnqueueAuditLine = (
  task: {
    readonly id: string;
    readonly createdAt: number;
    readonly spec?: { readonly continues?: { readonly task: string } };
  },
  outcome: EnqueueOutcome,
) => Promise<void>;

/**
 * An app-role process on this box enqueuing on `auto` with the key itself
 * (`relayFleet`): a store write that reaches no daemon, so this line, under its
 * surface's origin, is the enqueuing box's only record of it; the leader's
 * `op=admit` is the other end. A keyless peer's enqueue leaves two: its
 * surface's, and the daemon's under `local-broker`, whose `createdAt` is the
 * daemon's stamp. Never the prompt.
 */
export function enqueueAudit(sink: AuditSink, surface: EnqueueSurface): EnqueueAuditLine;
export function enqueueAudit(sink: AuditSink, origin: BrokerOrigin, claimedClient: EnqueueSurface): EnqueueAuditLine;
export function enqueueAudit(sink: AuditSink, origin: EnqueueOrigin, claimedClient?: EnqueueSurface): EnqueueAuditLine {
  // A surface's origin is its client; only the daemon writing for a peer has a client that is not its own origin.
  const client = claimedClient ?? origin;
  return async (task, outcome) => {
    const how =
      outcome.kind === "queued"
        ? `queued${outcome.landedEarlier ? " landedEarlier=true" : ""}`
        : outcome.kind === "refused"
          ? // The relay's word, so quoted: a line it shaped could otherwise read as more fields.
            `refused code=${quote(outcome.code)}`
          : "unanswered";
    const who = origin === "local-broker" ? "claimed_client" : "client";
    // Only a continuation has one, so every other line is unchanged.
    const continued = task.spec?.continues?.task;
    const continues = continued === undefined ? "" : ` continues=${quote(continued)}`;
    await sink(
      `audit enqueue origin=${origin} ${who}=${client} task=${quote(task.id)}${continues} createdAt=${task.createdAt} ${how}`,
    );
  };
}

/** Why an enqueue was refused before it was written, for the trait checks (`requiresCheck`). */
export type TraitRefusalKind = "unknown_trait" | "unreachable_trait";

/**
 * An enqueue refused locally for what it requires (`requiresCheck`): one line per refusal, under the
 * surface's own origin, the same shape as `enqueueAudit`'s so the measurement reads both. Counts
 * only — `requires` is how many traits it asked for, `count` how many were unknown (or, for
 * `unreachable_trait`, missing from every place it could go), and `split=1` when each trait is on some
 * place it could go but none has them all (`missing=0` alone would read as no reason). The names are
 * user-typed free text and stay out, as a prompt does.
 */
export function traitRefusalAudit(
  sink: AuditSink,
  surface: EnqueueSurface,
): (refusal: TraitRefusalKind, requested: number, count: number, split?: boolean) => Promise<void> {
  return async (refusal, requested, count, split = false) => {
    const counted = refusal === "unknown_trait" ? "unknown" : "missing";
    await sink(
      `audit enqueue origin=${surface} client=${surface} refused=${refusal} requires=${requested} ${counted}=${count}${split ? " split=1" : ""}`,
    );
  };
}

/**
 * Something on this box asked the daemon to reach *another* machine, or the
 * scheduler, for it over the op socket — a keyless `seanced mcp` or `seanced
 * spawn`. Its own origin, never `local`: a
 * `local` line means this box's tmux was touched, and a brokered spawn touches
 * someone else's. The target daemon audits the spawn itself as `origin=relay`.
 */
export type BrokerOrigin = "local-broker";

export interface BrokerAudit {
  readonly machines: (id: string) => Promise<void>;
  readonly fleet: (id: string) => Promise<void>;
  /**
   * `task` and `client` only where the op carries them; `client` is the peer's claim, never verified.
   * `continues` is the old task id of an enqueued continue spec.
   */
  readonly scheduler: (
    id: string,
    op: BrokerSchedulerOp,
    task: string | undefined,
    client: string | undefined,
    continues?: string,
  ) => Promise<void>;
  readonly request: (id: string, op: string, deviceId: string, client: string | undefined) => Promise<void>;
  readonly ok: (id: string) => Promise<void>;
  readonly failed: (id: string, code: BrokerErrorCode, reason?: FailureReason) => Promise<void>;
}

/**
 * Metadata only: which action, which op, which machine, which client. Never the
 * payload — a spawn's carries the prompt, and the target daemon's own line
 * already fingerprints it; a scheduler enqueue's spec is never logged either.
 * Every wire-supplied value is quoted.
 */
export function brokerAudit(sink: AuditSink, origin: BrokerOrigin = "local-broker"): BrokerAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit broker origin=${origin} ${rest}`);
  };
  return {
    machines: (id) => emit(`action=machines id=${quote(id)}`),
    fleet: (id) => emit(`action=fleet id=${quote(id)}`),
    scheduler: (id, op, task, client, continues) =>
      emit(
        `action=scheduler op=${quote(op)}${task === undefined ? "" : ` task=${quote(task)}`}${client === undefined ? "" : ` claimed_client=${quote(client)}`}${continues === undefined ? "" : ` continues=${quote(continues)}`} id=${quote(id)}`,
      ),
    request: (id, op, deviceId, client) =>
      emit(
        `action=request op=${quote(op)} target=${quote(deviceId)}${client === undefined ? "" : ` client=${quote(client)}`} id=${quote(id)}`,
      ),
    ok: (id) => emit(`ok id=${quote(id)}`),
    failed: (id, code, reason) =>
      emit(`failed code=${code}${reason === undefined ? "" : ` reason=${reason}`} id=${quote(id)}`),
  };
}

/**
 * What ran a reap: the human at the keyboard (`cli`), the daemon's own timer
 * (`schedule`), or the daemon closing a dead task pane after noting its exit
 * status (`harvest`, `exit-status.ts`). A new surface, so a new origin — never
 * `cli` reused for the timer, which would make a 3am cleanup read as someone at the desk.
 */
export type ReapOrigin = "cli" | "schedule" | "harvest";

export interface ReapAudit {
  readonly start: (repos: number) => Promise<void>;
  /** `how` is the nothing-lost rule's fixed passing reason (a merge kind, `origin` or `pr`): a removal is not always a merge. */
  readonly removedWorktree: (
    repo: string,
    path: string,
    branch: string | null,
    head: string,
    how: string,
  ) => Promise<void>;
  /** The full tip sha is the recovery: `git branch <name> <sha>` brings the branch back. */
  readonly deletedBranch: (repo: string, name: string, sha: string, reason: string) => Promise<void>;
  readonly closedPane: (paneId: string, window: string, reason: string) => Promise<void>;
  /** A `git fsmonitor--daemon` asked to stop (`stop`) or signalled (`signal`); pid null when unmapped. */
  readonly stoppedMonitor: (path: string, pid: number | null, how: string, reason: string) => Promise<void>;
  /** A task's fetched attachments (`pruneAttachments`); `task` is a staging directory's name for `staging`. */
  readonly removedAttachments: (task: string, reason: string) => Promise<void>;
  readonly done: (counts: {
    readonly worktrees: number;
    readonly branches: number;
    readonly panes: number;
    readonly monitors: number;
    readonly attachments: number;
  }) => Promise<void>;
}

/**
 * Reap audits what it destroyed, one line per thing, through the same sink as
 * spawns. Only actions: a dry run changes nothing and records nothing. Paths,
 * branch and window names are quoted — a branch name is whatever a session
 * pushed, and a window name is wire text.
 */
export function reapAudit(origin: ReapOrigin, sink: AuditSink): ReapAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit reap origin=${origin} ${rest}`);
  };
  return {
    start: (repos) => emit(`start repos=${repos}`),
    removedWorktree: (repo, path, branch, head, how) =>
      emit(
        `removed-worktree repo=${quote(repo)} path=${quote(path)} branch=${quote(branch ?? "(detached)")} head=${head} reason=${how}`,
      ),
    deletedBranch: (repo, name, sha, reason) =>
      emit(`deleted-branch repo=${quote(repo)} branch=${quote(name)} sha=${sha} reason=${reason}`),
    closedPane: (paneId, window, reason) => emit(`closed-pane pane=${paneId} window=${quote(window)} reason=${reason}`),
    stoppedMonitor: (path, pid, how, reason) =>
      emit(`stopped-fsmonitor path=${quote(path)} pid=${pid ?? "(unknown)"} how=${how} reason=${reason}`),
    removedAttachments: (task, reason) => emit(`removed-attachments task=${quote(task)} reason=${reason}`),
    done: (counts) =>
      emit(
        `done worktrees=${counts.worktrees} branches=${counts.branches} panes=${counts.panes} monitors=${counts.monitors} attachments=${counts.attachments}`,
      ),
  };
}

/** What triggered a self-update check: a fleet announce, this daemon's own register, or `seanced update`. */
export type UpdateOrigin = "announce" | "register" | "cli";

export interface UpdateAudit {
  readonly checking: (sha: string) => Promise<void>;
  readonly outcome: (outcome: UpdateOutcome, detail?: string) => Promise<void>;
}

/** Self-updates audit like spawns — same sink, one formatter — so "what changed my machine at 3am" is one grep. */
export function updateAudit(origin: UpdateOrigin, sink: AuditSink): UpdateAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit update origin=${origin} ${rest}`);
  };
  return {
    checking: (sha: string): Promise<void> => emit(`checking head=${sha.slice(0, 12)}`),
    outcome: (outcome: UpdateOutcome, detail?: string): Promise<void> =>
      emit(`outcome=${outcome}${detail === undefined ? "" : ` detail=${quote(detail)}`}`),
  };
}

/**
 * What ran a trait probe: only ever the daemon itself, on its own cadence, from the argv its own
 * `config.json` names (`trait-probes.ts`). Not a spawn, but an exec surface, and a new surface
 * adds an origin, never reuses one.
 */
export type ProbeOrigin = "probe";

/** Why this daemon is arming: a process start, or a config reload swapping the daemon in place. */
export type ProbeVia = "start" | "reload";

/** The unit a line is about. A trait name and an exclave id both passed their name rules, so they are written bare. */
export interface ProbeUnitAudit {
  readonly trait: string;
  readonly exclave?: string;
  readonly everyMinutes: number;
  readonly timeoutSeconds: number;
  readonly argv: readonly string[];
}

export type ProbeOutcomeAudit =
  | { readonly state: "healthy" }
  | { readonly state: "failing"; readonly exit: number }
  | { readonly state: "unknown"; readonly why: string };

export interface ProbeAudit {
  readonly armed: (unit: ProbeUnitAudit, via: ProbeVia) => Promise<void>;
  readonly result: (unit: ProbeUnitAudit, outcome: ProbeOutcomeAudit) => Promise<void>;
}

/**
 * The argv is never written: a word count, a SHA-256 prefix that says "the command changed", and the
 * program's basename (the one word an operator needs to tell two probes apart) stand for it. A token
 * pasted into an argv word must not reach the log, and neither may anything the probe printed (its
 * stdio is ignored, never read).
 */
export function probeAudit(sink: AuditSink): ProbeAudit {
  const emit = async (rest: string): Promise<void> => {
    await sink(`audit probe origin=probe ${rest}`);
  };
  const who = (unit: ProbeUnitAudit): string =>
    `trait=${unit.trait}${unit.exclave === undefined ? "" : ` exclave=${unit.exclave}`}`;
  return {
    armed: (unit, via) =>
      emit(
        `op=armed ${who(unit)} every=${unit.everyMinutes}m timeout=${unit.timeoutSeconds}s argv=${unit.argv.length} ` +
          `argvSha=${createHash("sha256").update(unit.argv.join("\0")).digest("hex").slice(0, 12)} ` +
          `argv0=${quote(basename(unit.argv[0] ?? ""))} via=${via}`,
      ),
    result: (unit, outcome) => {
      const detail =
        outcome.state === "failing"
          ? ` exit=${outcome.exit}`
          : outcome.state === "unknown"
            ? ` why=${outcome.why}`
            : "";
      return emit(`op=result ${who(unit)} state=${outcome.state}${detail}`);
    },
  };
}

/** The daemon typing its constant drain prompt or Esc into a pane of a closed machine (`drain-ask.ts`). */
export type DrainOrigin = "drain";

export type DrainAskOutcome = "typed" | "interrupted" | "skipped";

/** One line per act, naming the task and what happened, never the text typed or a pane. */
export function drainAskAudit(sink: AuditSink): (taskId: string, outcome: DrainAskOutcome) => Promise<void> {
  const origin: DrainOrigin = "drain";
  return async (taskId, outcome) => {
    await sink(`audit drain origin=${origin} task=${quote(taskId)} outcome=${outcome}`);
  };
}

/** The daemon starting, killing and ending the custodian seat's round (`custodian-seat.ts`). */
export type CustodianOrigin = "custodian";

export interface CustodianAudit {
  readonly start: (exclave: string, pane: string | null, outcome: "started" | "launch_failed") => Promise<void>;
  readonly kill: (
    pane: string,
    reason: "deadline" | "stray" | "off" | "exited",
    outcome: "exited" | "killed" | "gone",
  ) => Promise<void>;
  readonly end: (pane: string | null, reason: "deadline" | "exited" | "lost") => Promise<void>;
}

/**
 * One line per round start, kill and end. A round has no task id, so none is named; nothing read from a pane, the
 * seed, the notes or the agent's text reaches a line. Every end is `failed` until the verbs exist (custodian PR 4
 * adds `healthy`).
 */
export function custodianAudit(sink: AuditSink): CustodianAudit {
  const origin: CustodianOrigin = "custodian";
  return {
    start: async (exclave, pane, outcome) => {
      await sink(
        `audit custodian origin=${origin} op=start exclave=${quote(exclave)} pane=${pane ?? "-"} outcome=${outcome}`,
      );
    },
    kill: async (pane, reason, outcome) => {
      await sink(`audit custodian origin=${origin} op=kill pane=${pane} reason=${reason} outcome=${outcome}`);
    },
    end: async (pane, reason) => {
      await sink(`audit custodian origin=${origin} op=end pane=${pane ?? "-"} outcome=failed reason=${reason}`);
    },
  };
}

/** A session's message to another session on this machine (`messages.ts`). */
export type MessageOrigin = "message";

/**
 * `out` outcomes are the sender's answer (`sent`: held for a listener that has not connected; `held`: the task has
 * no pane yet, nothing kept); `in` outcomes are what became of the message at the receiving pane. `dropped` is a
 * daemon-inbox cap drop, which the record's three `in` outcomes do not cover.
 */
export type MessageOutcome =
  | "delivered"
  | "sent"
  | "held"
  | "ended"
  | "nolistener"
  | "dropped"
  | "unknown"
  | "too_long"
  | "rate_limited"
  | "unbound";

export type MessageAudit = (line: {
  readonly dir: "out" | "in";
  /** A task id; null for an untasked sender; undefined when the sender could not be bound at all. */
  readonly from: string | null | undefined;
  readonly to: string;
  readonly kind: MessageKind;
  readonly bytes: number;
  readonly outcome: MessageOutcome;
}) => Promise<void>;

/** Ids, kind and a byte count, never text, a title, a message id or a pane. */
export function messageAudit(sink: AuditSink): MessageAudit {
  const origin: MessageOrigin = "message";
  return async (line) => {
    const from = line.from === undefined ? "-" : line.from === null ? "untasked" : quote(line.from);
    await sink(
      `audit message origin=${origin} dir=${line.dir} from=${from} to=${quote(line.to)} kind=${line.kind} bytes=${line.bytes} outcome=${line.outcome}`,
    );
  };
}
