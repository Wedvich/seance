import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FLAG_NOTE_MAX,
  isFlagNote,
  isFlagReason,
  isTaskId,
  MESSAGE_PUSH_MAX,
  type CustodianEvent,
  type FlagReason,
} from "@seance/shared";
import type { CustodianAudit } from "./audit.ts";
import { DespawnFailure, type SessionBackend } from "./backend.ts";
import type { CustodianConfig } from "./config.ts";
import { NOTES_MAX } from "./custodian-agent.ts";
import {
  isPaneKey,
  isTurnFlag,
  liftEntry,
  type CustodianFlags,
  type LiftDeps,
  type SessionCounts,
} from "./custodian-flags.ts";
import {
  parseCustodianFrame,
  SUMMARY_MAX,
  type CloseRefusal,
  type CustodianFrame,
  type CustodianPaneView,
  type CustodianReply,
  type CustodianReplyCode,
  type CustodianVerb,
  type InterruptRefusal,
  type KeptWhy,
} from "./custodian-frame.ts";
import type { CustodianDelivery, CustodianTarget } from "./messages.ts";
import type { WorktreeOutcome, WorktreeRule } from "./custodian-worktree.ts";
import { mapLimit } from "./concurrency.ts";
import { inputBoxDraft } from "./drain-ask.ts";
import { writeDurable } from "./durable-write.ts";
import { harvestable } from "./exit-status.ts";
import { custodianNotesPath, reapRefusalsPath } from "./paths.ts";
import { ancestorIn, peerPidSupported } from "./peer.ts";
import { PANE_ID } from "./pane-id.ts";
import { SAMPLE_INTERVAL_MS, type PaneActivity } from "./pane-activity.ts";
import { DEAD_PANE_MIN_AGE_MS, readReapRefusals } from "./reap.ts";
import type { EndedTasks } from "./session-events.ts";
import { classifyPane, listPanes, paneInfo, type PaneInfo, type PaneState } from "./sessions.ts";
import { capturePane } from "./tmux.ts";

/**
 * The custodian round's verbs, the `custodian` frame kind on the local socket (DESIGN.md, "The custodian frame
 * kind"). They bound only what goes through them: a frame is acted on only for a process of the
 * live pane the seat record names as the running round, found by the kernel's peer pid and never by a field, and
 * `close` acts only on a session at rest, through the graceful despawn, the exit-status harvest or a `closing`-first
 * kill. They do not bound a round's other reach (the tmux socket, the daemon's plain ops, on-disk secrets), which is
 * why rounds stay held (`ROUNDS_LIVE`) until docs/custodian.md item 4b. Everything outside effects goes through
 * `CustodianVerbDeps`. Nothing a pane's screen, the notes or the
 * summary held is ever logged, audited or returned: a screen is read in memory to judge it and dropped.
 */

/** A `close`'s act, by what the pane is. */
export type CloseAct = "despawn" | "harvest" | "kill";

export interface CloseVerdictInput {
  readonly info: PaneInfo;
  readonly state: PaneState;
  readonly activity: PaneActivity | null;
  /** A hand-off, pass or drain mark (C7). */
  readonly untouchable: boolean;
  readonly now: number;
  readonly closeAfterMs: number;
}

/**
 * C24, C5, C7: what `close` would do to this pane right now, or why it would not. The rules are the boundary under an
 * injected round, so the order is the table's: custodian and foreign first, then marks, then by what the pane is.
 */
export function closeVerdict(o: CloseVerdictInput): CloseAct | CloseRefusal {
  const { info, state, activity } = o;
  if (info.custodian) return "marked";
  if (!info.ours) return "foreign";
  if (o.untouchable) return "marked";
  switch (state) {
    case "dead":
      // Killed first, it would lose its exit status: `harvestExits` notes it, then closes the pane.
      if (harvestable(info)) return "harvest";
      // Spawn's own dying pane (reap's guard), or a death time an old tmux does not give.
      if (info.deadAt === null || o.now - info.deadAt < DEAD_PANE_MIN_AGE_MS) return "too_soon";
      return "kill";
    // Never one of ours (it is the pane's own process); an unreadable state is not a session at rest either.
    case "shell":
    case "starting":
      return "unobserved";
    case "background-prompt":
      return "waiting";
    // Someone already asked it to exit: the despawn's Keep answers it.
    case "exit-prompt":
      return "despawn";
    case "live": {
      const seen = activity?.state ?? null;
      if (seen === null || seen === "ended") return "unobserved";
      if (seen === "needs-input") return "waiting";
      if (seen === "busy") return "busy";
      if (!activity?.turnEnded) return "unobserved";
      if (o.now - (activity.stateSince ?? o.now) < o.closeAfterMs) return "too_soon";
      return "despawn";
    }
  }
}

/**
 * A screen sample older than this says nothing about the screen now: the sampler runs every `SAMPLE_INTERVAL_MS`, so
 * three intervals allow for a slow pass or two. A stalled sampler leaves `screenSince` frozen, which would otherwise read
 * as a screen that has not moved.
 */
export const SCREEN_FRESH_MS = 3 * SAMPLE_INTERVAL_MS;

export interface InterruptVerdictInput {
  readonly info: PaneInfo;
  readonly state: PaneState;
  readonly activity: PaneActivity | null;
  readonly untouchable: boolean;
  /** The session was interrupted already (C27: once per session). */
  readonly interrupted: boolean;
  readonly now: number;
  readonly interruptAfterMs: number;
  /** The screen must have been sampled at or after this: the act's own sampling pass began then (0 for no such pass). */
  readonly sampledAfter: number;
}

/**
 * C27, C7: whether `interrupt` may send its one Escape to this pane now. Only a live session whose last state is `busy`
 * (never `needs-input`: an Escape there dismisses the owner's question or denies a permission) and whose screen, as
 * sampled recently, has stood still for `interruptAfterMs`, and only once per session.
 */
export function interruptVerdict(o: InterruptVerdictInput): "interrupt" | InterruptRefusal {
  const { info, activity } = o;
  if (info.custodian) return "marked";
  if (!info.ours) return "foreign";
  if (o.untouchable) return "marked";
  if (o.state !== "live") return "not_busy";
  const seen = activity?.state ?? null;
  if (seen === "needs-input") return "waiting";
  if (seen !== "busy" || activity === null) return "not_busy";
  if (o.interrupted) return "limit";
  const { screenSince, sampledAt } = activity;
  if (screenSince === null || sampledAt === null || o.now - sampledAt > SCREEN_FRESH_MS) return "too_soon";
  if (sampledAt < o.sampledAfter) return "too_soon";
  if (o.now - screenSince < o.interruptAfterMs) return "too_soon";
  return "interrupt";
}

const HEADING = /^## (\S+)[ \t]*$/u;

/**
 * C38: the sections of the notes the daemon keeps. A section is a `## <key>` line and what follows to the next one;
 * its key is `standing`, a task id some current pane carries, or a pane id that exists. Anything else — an unknown
 * key, a repeat of a key, text before the first heading — is dropped and counted. CRLF is read as LF.
 */
export function pruneNotes(
  text: string,
  live: { readonly taskIds: ReadonlySet<string>; readonly panes: ReadonlySet<string> },
): { readonly text: string; readonly kept: readonly string[]; readonly dropped: number } {
  const sections: { readonly key: string | null; readonly lines: string[] }[] = [{ key: null, lines: [] }];
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const key = HEADING.exec(line)?.[1];
    if (key === undefined) sections.at(-1)?.lines.push(line);
    else sections.push({ key, lines: [line] });
  }
  const kept: string[] = [];
  const out: string[] = [];
  let dropped = 0;
  for (const section of sections) {
    const body = section.lines.join("\n").trimEnd();
    if (section.key === null) {
      if (body.trim() !== "") dropped += 1;
      continue;
    }
    const known =
      section.key === "standing" ||
      (isTaskId(section.key) && live.taskIds.has(section.key)) ||
      (PANE_ID.test(section.key) && live.panes.has(section.key));
    if (!known || kept.includes(section.key)) {
      dropped += 1;
      continue;
    }
    kept.push(section.key);
    out.push(`${body}\n`);
  }
  return { text: out.join("\n"), kept, dropped };
}

/** The seat's side of the verbs: the round's tally and `done`, which `custodian-seat.ts` owns. */
export interface VerbSeat {
  readonly count: (verb: CustodianVerb, ok: boolean) => void;
  readonly countWorktree: (kind: "removed" | "kept") => void;
  /** A flag counted for the round: one a `flag` verb took as new, or one the daemon set after a close kept a worktree. */
  readonly countFlagged: () => void;
  readonly done: (summary: string) => Promise<"ok" | "too_late" | "no_round">;
  readonly isDone: () => boolean;
}

export interface CustodianVerbDeps {
  /** The seat's current round pane, null when there is no seat or no round. */
  readonly roundPane: () => string | null;
  /** Pid → pane for every live pane carrying `@seance-custodian` (`listRoundPanePids`). */
  readonly roundPanePids: () => Promise<ReadonlyMap<number, string>>;
  readonly hostNamesPeers?: () => boolean;
  readonly ancestorIn?: (pid: number, targets: ReadonlyMap<number, string>) => Promise<string | null>;
  readonly listPanes?: () => Promise<readonly PaneInfo[]>;
  readonly paneInfo?: (pane: string) => Promise<PaneInfo | null>;
  readonly classifyPane?: (info: PaneInfo) => Promise<PaneState>;
  /** The pane's current screen with its attributes (`capture-pane -e`), null when tmux cannot say. */
  readonly capture?: (pane: string) => Promise<string | null>;
  /** One screen sampling pass (`PaneActivityTracker.sample`), which `interrupt` takes at the act; absent, the sampler's last reading stands. */
  readonly sample?: () => Promise<void>;
  readonly activity: (pane: string) => PaneActivity | null;
  /** When this process began retaining pane state; null while no seat holds the tracker. */
  readonly retainedSince: () => number | null;
  /** A hand-off, pass or drain ask marked it: the same expression the seat's due check gets. */
  readonly untouchable: (pane: string) => boolean;
  readonly tasks: Pick<EndedTasks, "worktree" | "prUrl" | "closing" | "harvestExits" | "launchedAt">;
  readonly worktree: WorktreeRule;
  readonly despawn: NonNullable<SessionBackend["despawn"]>;
  /** `tmux kill-pane -t`; true when it exited 0. */
  readonly killPane: (pane: string) => Promise<boolean>;
  /**
   * A nudge's delivery: messaging's local delivery (`Messages.deliverAsCustodian`), the inbox mod's `$.prompt.submit`,
   * never a key. `unsupported` when this daemon wires no messaging.
   */
  readonly deliver: (pane: string, text: string, expect: CustodianTarget) => Promise<CustodianDelivery>;
  /** One `send-keys -t <pane> ...args` (`drain-ask.ts`'s `sendKeys`); true when tmux took it. Only ever `["Escape"]`. */
  readonly keys: (pane: string, args: readonly string[]) => Promise<boolean>;
  readonly readRefusals?: () => Promise<unknown>;
  readonly notesPath?: string;
  readonly seat: VerbSeat;
  readonly settings: Pick<CustodianConfig, "closeAfterMinutes" | "maxNudges" | "interruptAfterMinutes">;
  readonly now: () => number;
  readonly audit: CustodianAudit;
  /** Open flags: the round's own and the daemon's. Read by `sessions`, written by `flag` and a close. */
  readonly flags: CustodianFlags;
  /**
   * Sends a `custodian-event` to the leader (in process when this daemon leads, else through the relay). True when it
   * was handed on, false when nothing could take it; fire-and-forget, so a false is never an error to the round.
   */
  readonly sendEvent: (event: CustodianEvent) => Promise<boolean>;
  readonly warn: (line: string) => void;
}

export interface CustodianVerbs {
  /** `peer` is the connecting process's kernel-reported pid, null where the host cannot say. */
  readonly handle: (raw: unknown, peer: number | null) => Promise<CustodianReply>;
  /**
   * Whether a verb could act on this `busy` pane whose screen has stood still for `stillMs`: `nudge` on a session with
   * a task this machine launched and nudges left, `interrupt` once the screen has stood still `interruptAfterMinutes`
   * and the session was not interrupted. The seat's due check asks, so a round is not held for a pane no verb could
   * touch (a hand-started session on a long build, a session whose nudges are spent).
   */
  readonly reach: (pane: string, stillMs: number) => Promise<boolean>;
}

const MINUTE_MS = 60_000;
/** Refusals of an unbound sender that are written (log and audit) per minute, whatever the senders. */
const REFUSAL_LINES_PER_MIN = 20;
/** Unbound senders remembered for the once-a-minute collapse. */
const REFUSAL_PIDS_KEPT = 64;
const SESSIONS_CONCURRENCY = 4;

const minutesSince = (now: number, since: number | null): number | null =>
  since === null ? null : Math.max(0, Math.floor((now - since) / MINUTE_MS));

/** Chained, since `writeDurable` is not serialized. */
let notesChain: Promise<unknown> = Promise.resolve();

export function createCustodianVerbs(deps: CustodianVerbDeps): CustodianVerbs {
  const hostNamesPeers = deps.hostNamesPeers ?? peerPidSupported;
  const walk = deps.ancestorIn ?? ancestorIn;
  const panesNow = deps.listPanes ?? listPanes;
  const infoOf = deps.paneInfo ?? paneInfo;
  const classify = deps.classifyPane ?? classifyPane;
  const capture = deps.capture ?? ((pane: string) => capturePane(pane, { history: false, styled: true }));
  const readRefusals = deps.readRefusals ?? (() => readReapRefusals(reapRefusalsPath()));
  const notesPath = deps.notesPath ?? custodianNotesPath();
  const closeAfterMs = deps.settings.closeAfterMinutes * MINUTE_MS;
  const interruptAfterMs = deps.settings.interruptAfterMinutes * MINUTE_MS;
  /** A close, nudge or interrupt in flight holds its pane: another act on it is refused `marked`. */
  const inFlight = new Set<string>();

  const verdictOf = (info: PaneInfo, state: PaneState): CloseAct | CloseRefusal =>
    closeVerdict({
      info,
      state,
      activity: info.ours ? deps.activity(info.paneId) : null,
      untouchable: deps.untouchable(info.paneId) || inFlight.has(info.paneId),
      now: deps.now(),
      closeAfterMs,
    });

  /** Fire-and-forget: whatever goes wrong, the round's verb does not fail for it. */
  const send = async (event: CustodianEvent): Promise<boolean> => {
    try {
      return await deps.sendEvent(event);
    } catch {
      return false;
    }
  };

  /**
   * An entry whose session no longer exists is settled on the record, then dropped, and only once the leader's event was
   * taken, so a lost one is tried again on the next call. `stuck` and `look` are about the session, so its end lifts them
   * (`unflag`). `dirty` and `unpushed` are about the worktree, which the session's end leaves as it is, so the record
   * keeps them (as it does the daemon's own) and the entry is only sent again, as `flag`, until taken. A failure is a
   * warning, never the verb's failure.
   */
  const pruneFlags = async (panes: readonly PaneInfo[]): Promise<void> => {
    try {
      const gone = await deps.flags.stale({
        taskIds: new Set(panes.flatMap((pane) => (pane.taskId === null ? [] : [pane.taskId]))),
        panes: new Set(panes.map((pane) => pane.paneId)),
      });
      const held = await Promise.all(
        gone.map(async ([key, entry]): Promise<boolean> => {
          if (isTurnFlag(entry) || isPaneKey(key)) return !(await liftEntry(lifting, key, entry));
          const sent = await send({
            kind: "flag",
            taskId: key,
            reason: entry.reason,
            ...(entry.note === undefined ? {} : { note: entry.note }),
            at: deps.now(),
          });
          if (sent) await deps.flags.clear(key, entry);
          return !sent;
        }),
      );
      const kept = held.filter(Boolean).length;
      if (kept > 0) deps.warn(`custodian: ${kept} flag event(s) were not taken; the entries stay for the next call`);
    } catch (err) {
      deps.warn(`custodian: pruning the flags failed (${err instanceof Error ? err.name : "error"})`);
    }
  };

  /**
   * C30: a session's nudge and interrupt counts go when it ends, which is when no live `ours` pane carries its key with
   * its pid. Nothing to settle first (the leader never sees them). A failure is a warning.
   */
  const pruneCounts = async (panes: readonly PaneInfo[]): Promise<void> => {
    const live = new Map<string, Set<number>>();
    for (const pane of panes) {
      if (!pane.ours || pane.dead || pane.pid === null) continue;
      const key = pane.taskId ?? pane.paneId;
      live.set(key, (live.get(key) ?? new Set()).add(pane.pid));
    }
    try {
      await deps.flags.pruneCounts(live);
    } catch (err) {
      deps.warn(`custodian: pruning the counts failed (${err instanceof Error ? err.name : "error"})`);
    }
  };

  /** Puts back what a write-ahead count replaced, when the act it was written for did not happen. */
  const restoreCounts = async (key: string, was: SessionCounts): Promise<void> => {
    try {
      await deps.flags.setCounts(key, was.nudges === 0 && !was.interrupted ? null : was);
    } catch (err) {
      deps.warn(`custodian: restoring a count failed (${err instanceof Error ? err.name : "error"})`);
    }
  };

  const lifting: LiftDeps = { flags: deps.flags, send, now: deps.now };

  /**
   * A session closed with nothing to keep, or nothing worth a flag: the record's flag goes, and its entry once that was
   * taken. With no entry the record may still hold the daemon's own flag from an earlier close, so the `unflag` goes
   * anyway.
   */
  const lift = async (key: string, taskId: string | null): Promise<void> => {
    try {
      const entry = await deps.flags.get(key);
      if (entry !== null) {
        if (!(await liftEntry(lifting, key, entry))) {
          deps.warn("custodian: an unflag was not taken; the entry stays for the next call");
        }
        return;
      }
      if (taskId !== null) await send({ kind: "unflag", taskId, at: deps.now() });
    } catch (err) {
      deps.warn(`custodian: clearing a flag failed (${err instanceof Error ? err.name : "error"})`);
    }
  };

  const sessions = async (): Promise<CustodianReply> => {
    let panes: readonly PaneInfo[];
    try {
      panes = await panesNow();
    } catch {
      return { ok: false, code: "internal" };
    }
    const now = deps.now();
    await pruneFlags(panes);
    await pruneCounts(panes);
    const views = await mapLimit(panes, SESSIONS_CONCURRENCY, async (info): Promise<CustodianPaneView> => {
      const state = await classify(info);
      // Reason and time only: the note is model-written from untrusted pane text and is not fed back to later rounds.
      const open = info.ours ? await deps.flags.get(info.taskId ?? info.paneId) : null;
      const counted =
        info.ours && info.pid !== null ? await deps.flags.counts(info.taskId ?? info.paneId, info.pid) : null;
      const seen = info.ours ? deps.activity(info.paneId) : null;
      const site = info.taskId === null ? null : deps.tasks.worktree(info.taskId);
      const verdict = verdictOf(info, state);
      return {
        pane: info.paneId,
        window: info.windowName,
        cwd: info.path,
        owner: info.ours ? "ours" : "foreign",
        classification: state,
        state: seen?.state ?? null,
        stateMinutes: minutesSince(now, seen?.stateSince ?? null),
        turnEnded: seen?.turnEnded ?? false,
        screenMinutes: minutesSince(now, seen?.screenSince ?? null),
        taskId: info.taskId,
        prUrl: info.taskId === null ? null : (deps.tasks.prUrl(info.taskId) ?? null),
        worktree: site === null || "refused" in site ? null : site.path,
        marked: deps.untouchable(info.paneId),
        nudges: counted?.nudges ?? 0,
        interrupted: counted?.interrupted ?? false,
        flag: open === null ? null : { reason: open.reason, at: open.at },
        close: verdict === "despawn" || verdict === "harvest" || verdict === "kill" ? "ok" : verdict,
      };
    });
    return {
      ok: true,
      verb: "sessions",
      now,
      retainedSince: deps.retainedSince(),
      panes: views,
      reapRefusals: await readRefusals(),
    };
  };

  /** What the worktree decision came to: audited, tallied, and, for a failure of the rule, flagged. */
  const settleWorktree = async (
    pane: string,
    taskId: string,
    outcome: WorktreeOutcome | null,
  ): Promise<WorktreeOutcome | null> => {
    if (outcome === null) return null;
    if ("removed" in outcome) {
      await deps.audit.removedWorktree(pane, taskId, outcome.how);
      deps.seat.countWorktree("removed");
      await lift(taskId, taskId);
      return outcome;
    }
    await deps.audit.keptWorktree(pane, taskId, outcome.kept);
    deps.seat.countWorktree("kept");
    if (outcome.kept === "dirty" || outcome.kept === "unpushed") {
      // The daemon's own flag (C33): work that exists only in that worktree. The record's flag becomes this one, so the
      // session's earlier entry goes without an `unflag`, which a later prune would otherwise send over it. A send that
      // nothing took leaves the entry as this flag instead, which a later `sessions` sends again until it is taken.
      const sent = await send({ kind: "flag", taskId, reason: outcome.kept, at: deps.now() });
      deps.seat.countFlagged();
      await deps.audit.flag(pane, taskId, outcome.kept, sent ? "ok" : "unsent", "daemon");
      try {
        if (sent) await deps.flags.clear(taskId);
        else await deps.flags.set(taskId, outcome.kept, undefined);
      } catch (err) {
        deps.warn(`custodian: updating a flag entry failed (${err instanceof Error ? err.name : "error"})`);
      }
    }
    return outcome;
  };

  const refuseClose = async (pane: string, taskId: string | null, code: CloseRefusal): Promise<CustodianReply> => {
    await deps.audit.close(pane, taskId, code);
    return { ok: false, code };
  };

  const close = async (pane: string): Promise<CustodianReply> => {
    if (deps.seat.isDone()) return { ok: false, code: "round_done" };
    if (inFlight.has(pane)) return refuseClose(pane, null, "marked");
    // Read again now, at the moment of the act: nothing the round saw earlier counts.
    const info = await infoOf(pane);
    if (info === null) return refuseClose(pane, null, "gone");
    const state = await classify(info);
    const verdict = verdictOf(info, state);
    if (verdict !== "despawn" && verdict !== "harvest" && verdict !== "kill") {
      return refuseClose(pane, info.taskId, verdict);
    }
    const activity = info.ours ? deps.activity(pane) : null;
    inFlight.add(pane);
    try {
      const turnEndedAt = state === "live" && activity?.turnEnded === true ? (activity.stateSince ?? null) : null;
      // Before the despawn, whose `/exit` writes the session's own transcript.
      const touchedAt =
        info.taskId === null || turnEndedAt === null ? null : await deps.worktree.touchedAt(info.taskId);
      if (verdict === "despawn" && state === "live") {
        // `askToExit` clears the input box with Escape and Ctrl+C, and neither the screen hash nor a frame sees typing:
        // an owner composing a reply there would lose it. Read after the stats, the slow awaits, so the screen and the
        // facts below are both the last thing read before the act. Any typed text, or a box that cannot be found, fails
        // closed; a prompt suggestion, which the styled read tells apart by its faint cells, is not a draft.
        const screen = await capture(pane);
        const draft = screen === null ? null : inputBoxDraft(screen);
        if (draft !== "") return await refuseClose(pane, info.taskId, "waiting");
        // The awaits above are a window in which the owner may have sent a prompt, from claude.ai say: the despawn's
        // Escape would interrupt that turn and `/exit` end it. `inFlight` is left out of the re-read, since it holds
        // this very pane.
        const again = closeVerdict({
          info,
          state,
          activity: deps.activity(pane),
          untouchable: deps.untouchable(pane),
          now: deps.now(),
          closeAfterMs,
        });
        if (again !== "despawn" && again !== "harvest" && again !== "kill") {
          return await refuseClose(pane, info.taskId, again);
        }
      }
      const act = await actOn(verdict, info);
      if ("refused" in act) return await refuseClose(pane, info.taskId, act.refused);
      await deps.audit.close(pane, info.taskId, act.outcome);
      const worktree =
        info.taskId === null
          ? null
          : await settleWorktree(
              pane,
              info.taskId,
              await decideWorktree(pane, info.taskId, { turnEndedAt, touchedAt }),
            );
      // A pane with no task, or a task whose worktree there was none to decide on (here mode, or gone): nothing was
      // kept, so nothing stays flagged. A kept worktree for any other reason leaves the entry to the prune.
      if (info.taskId === null) await lift(pane, null);
      else if (worktree === null) await lift(info.taskId, info.taskId);
      return { ok: true, verb: "close", pane, taskId: info.taskId, outcome: act.outcome, worktree };
    } catch (err) {
      if (err instanceof DespawnFailure && err.code === "session_not_found")
        return await refuseClose(pane, info.taskId, "gone");
      // Never the error's text: it may hold a path or pane output.
      deps.warn(`custodian: close of ${pane} failed (${err instanceof Error ? err.name : "error"})`);
      await deps.audit.close(pane, info.taskId, "internal").catch(() => {});
      return { ok: false, code: "internal" };
    } finally {
      inFlight.delete(pane);
    }
  };

  const decideWorktree = async (
    pane: string,
    taskId: string,
    seen: { readonly turnEndedAt: number | null; readonly touchedAt: number | null },
  ): Promise<WorktreeOutcome | null> => {
    try {
      return await deps.worktree.decide(taskId, seen);
    } catch (err) {
      deps.warn(`custodian: the worktree decision for ${pane} failed (${err instanceof Error ? err.name : "error"})`);
      const kept: KeptWhy = "unevaluated";
      return { kept };
    }
  };

  const actOn = async (
    act: CloseAct,
    info: PaneInfo,
  ): Promise<{ readonly outcome: "exited" | "killed" | "harvested" } | { readonly refused: CloseRefusal }> => {
    const pane = info.paneId;
    if (act === "despawn") {
      const result = await deps.despawn(pane, { force: false, closing: (taskId) => deps.tasks.closing(taskId) });
      return { outcome: result.outcome };
    }
    if (act === "harvest") {
      await deps.tasks.harvestExits();
      // Harvest leaves a pane whose launch is in flight: not closed, so not this close's to report.
      return (await infoOf(pane)) === null ? { outcome: "harvested" } : { refused: "too_soon" };
    }
    if (info.taskId !== null) await deps.tasks.closing(info.taskId);
    if (await deps.killPane(pane)) return { outcome: "killed" };
    // A pane that went by itself is gone; one that is still there and would not die is a failure.
    if ((await infoOf(pane)) === null) return { refused: "gone" };
    throw new Error("kill-pane failed");
  };

  /** C29: the round's flag. Every call, taken or refused, is one audit line, and the note is in none. */
  const flag = async (pane: string, reason: string, note: string | undefined): Promise<CustodianReply> => {
    const refuse = async (
      code: "round_done" | "bad_reason" | "too_long" | "invalid" | "gone" | "foreign",
      taskId: string | null,
      known: FlagReason | "-",
    ): Promise<CustodianReply> => {
      await deps.audit.flag(pane, taskId, known, code, "round");
      return { ok: false, code };
    };
    if (deps.seat.isDone()) return refuse("round_done", null, "-");
    if (!isFlagReason(reason)) return refuse("bad_reason", null, "-");
    // The length first, so an over-long note learns `too_long` rather than `invalid`.
    if (note !== undefined && note.length > FLAG_NOTE_MAX) return refuse("too_long", null, reason);
    if (note !== undefined && !isFlagNote(note)) return refuse("invalid", null, reason);
    try {
      const info = await infoOf(pane);
      if (info === null) return await refuse("gone", null, reason);
      if (!info.ours || pane === deps.roundPane()) return await refuse("foreign", info.taskId, reason);
      await pruneFlags(await panesNow());
      const changed = await deps.flags.set(info.taskId ?? pane, reason, note);
      // Every accepted call is sent again, also a repeat: it is the only retry a lost event gets, and the leader writes
      // and pushes nothing for what the record already holds.
      const sent =
        info.taskId === null
          ? false
          : await send({
              kind: "flag",
              taskId: info.taskId,
              reason,
              ...(note === undefined ? {} : { note }),
              at: deps.now(),
            });
      if (changed === "new") deps.seat.countFlagged();
      // An untasked pane has no record to tell, so nothing went unsent.
      await deps.audit.flag(pane, info.taskId, reason, info.taskId === null || sent ? "ok" : "unsent", "round");
      return { ok: true, verb: "flag", pane, taskId: info.taskId, reason, sent };
    } catch (err) {
      deps.warn(`custodian: flagging ${pane} failed (${err instanceof Error ? err.name : "error"})`);
      await deps.audit.flag(pane, null, reason, "internal", "round").catch(() => {});
      return { ok: false, code: "internal" };
    }
  };

  /** More than one live `ours` pane under this pane's task id: the counts could not tell them apart. */
  const sharesTask = (panes: readonly PaneInfo[], info: PaneInfo): boolean =>
    info.taskId !== null &&
    panes.some((p) => p.paneId !== info.paneId && p.ours && !p.dead && p.pid !== null && p.taskId === info.taskId);

  /** What stands between a nudge and its delivery once the pane is read again; null when nothing does. */
  const nudgeStillOk = async (again: PaneInfo, first: PaneInfo): Promise<CustodianReplyCode | null> => {
    if (again.dead || again.pid !== first.pid || again.taskId !== first.taskId || !again.ours) return "gone";
    if (again.custodian || again.paneId === deps.roundPane() || deps.untouchable(again.paneId)) return "marked";
    if (deps.activity(again.paneId)?.state === "needs-input") return "waiting";
    const state = await classify(again);
    if (state === "background-prompt" || state === "exit-prompt") return "waiting";
    return state === "live" ? null : "unobserved";
  };

  /**
   * C26: one `request` to a task session, through messaging's delivery, so it can never answer a dialog or touch a
   * draft. Counted ahead of the delivery (at most `maxNudges` per session, one per round); a delivery that placed
   * nothing gives the count back. Every call is one audit line, and the text is in none.
   */
  const nudge = async (pane: string, text: string): Promise<CustodianReply> => {
    const refuse = async (code: CustodianReplyCode, taskId: string | null): Promise<CustodianReply> => {
      await deps.audit.nudge(pane, taskId, code);
      return { ok: false, code };
    };
    if (deps.seat.isDone()) return refuse("round_done", null);
    if (Buffer.byteLength(text, "utf8") > MESSAGE_PUSH_MAX) return refuse("too_long", null);
    if (text.trim() === "") return refuse("invalid", null);
    if (inFlight.has(pane)) return refuse("marked", null);
    inFlight.add(pane);
    let taskId: string | null = null;
    try {
      const info = await infoOf(pane);
      if (info === null || info.dead || info.pid === null) return await refuse("gone", null);
      taskId = info.taskId;
      if (info.custodian || pane === deps.roundPane()) return await refuse("marked", taskId);
      if (!info.ours) return await refuse("foreign", taskId);
      if (deps.untouchable(pane)) return await refuse("marked", taskId);
      // C7: a session waiting on the owner is the needs-input alert's.
      if (deps.activity(pane)?.state === "needs-input") return await refuse("waiting", taskId);
      // The same screens `close` leaves to the owner: a request submitted in front of a dialog is not messaging's case.
      const state = await classify(info);
      if (state === "background-prompt" || state === "exit-prompt") return await refuse("waiting", taskId);
      if (state !== "live") return await refuse("unobserved", taskId);
      // Messaging addresses only a task this machine launched (its D3).
      if (taskId === null || deps.tasks.launchedAt(taskId) === undefined) return await refuse("untasked", taskId);
      const all = await panesNow();
      // The counts hold one pid a task id: two panes under it would read each other's entry as zero.
      if (sharesTask(all, info)) return await refuse("marked", taskId);
      await pruneCounts(all);
      const was = await deps.flags.counts(taskId, info.pid);
      if (was.nudges >= deps.settings.maxNudges) return await refuse("limit", taskId);
      const round = deps.roundPane();
      if (round !== null && was.round === round) return await refuse("once_per_round", taskId);
      const counted: SessionCounts = { ...was, nudges: was.nudges + 1, round };
      await deps.flags.setCounts(taskId, counted);
      // The write was a window (a durable file): what C7 excludes, the pane and the task are read again before the text goes.
      const again = await infoOf(pane);
      const last = again === null ? "gone" : await nudgeStillOk(again, info);
      if (last !== null) {
        await restoreCounts(taskId, was);
        return await refuse(last, taskId);
      }
      const delivery = await deps.deliver(pane, text, { pid: info.pid, taskId });
      if (!delivery.ok) {
        await restoreCounts(taskId, was);
        // A daemon on its way down delivers nothing now: as good as no messaging here.
        return await refuse(delivery.code === "stopping" ? "unsupported" : delivery.code, taskId);
      }
      await deps.audit.nudge(pane, taskId, delivery.outcome);
      return { ok: true, verb: "nudge", pane, taskId, outcome: delivery.outcome, nudges: counted.nudges };
    } catch (err) {
      deps.warn(`custodian: nudging ${pane} failed (${err instanceof Error ? err.name : "error"})`);
      await deps.audit.nudge(pane, taskId, "internal").catch(() => {});
      return { ok: false, code: "internal" };
    } finally {
      inFlight.delete(pane);
    }
  };

  /**
   * C27: the one Escape, for a session hung inside a command. Counted ahead of the key, so a key that fails or a restart
   * after it never makes a second; the pane and the daemon's facts are read again after that write, and the facts once
   * more with nothing awaited between them and the key. Every call is one audit line.
   */
  const interrupt = async (pane: string): Promise<CustodianReply> => {
    const refuse = async (code: CustodianReplyCode, taskId: string | null): Promise<CustodianReply> => {
      await deps.audit.interrupt(pane, taskId, code);
      return { ok: false, code };
    };
    if (deps.seat.isDone()) return refuse("round_done", null);
    if (inFlight.has(pane)) return refuse("marked", null);
    inFlight.add(pane);
    let taskId: string | null = null;
    try {
      const info = await infoOf(pane);
      if (info === null || info.dead || info.pid === null) return await refuse("gone", null);
      taskId = info.taskId;
      const key = taskId ?? pane;
      const all = await panesNow();
      if (sharesTask(all, info)) return await refuse("marked", taskId);
      await pruneCounts(all);
      const was = await deps.flags.counts(key, info.pid);
      let sampledAfter = 0;
      const judge = (read: PaneInfo, state: PaneState, interrupted: boolean): "interrupt" | InterruptRefusal =>
        interruptVerdict({
          info: read,
          state,
          activity: deps.activity(pane),
          untouchable: deps.untouchable(pane) || pane === deps.roundPane(),
          interrupted,
          now: deps.now(),
          interruptAfterMs,
          sampledAfter,
        });
      const first = judge(info, await classify(info), was.interrupted);
      if (first !== "interrupt") return await refuse(first, taskId);
      await deps.flags.setCounts(key, { ...was, interrupted: true });
      // The sampler's reading may be minutes old, and a command that began printing again since would still read as
      // still: take a pass now and trust only a reading it made.
      // A pass already running is joined, and may have read this pane before the call: a second pass is a new one.
      const pass = async (sampler: () => Promise<void>): Promise<boolean> => {
        sampledAfter = deps.now();
        await sampler();
        return (deps.activity(pane)?.sampledAt ?? -1) >= sampledAfter;
      };
      if (deps.sample !== undefined && !(await pass(deps.sample))) await pass(deps.sample);
      // Escape on a busy turn is not known to leave a typed draft alone: `close`'s rule, the same read.
      const screen = await capture(pane);
      if (screen === null || inputBoxDraft(screen) !== "") {
        await restoreCounts(key, was);
        return await refuse("waiting", taskId);
      }
      // Read again now: these were windows in which the session may have answered, asked or ended.
      const again = await infoOf(pane);
      const againState = again === null ? null : await classify(again);
      // Nothing is awaited from this verdict to the key.
      const last =
        again === null ||
        againState === null ||
        again.dead ||
        again.pid !== info.pid ||
        again.taskId !== info.taskId ||
        !again.ours
          ? "gone"
          : judge(again, againState, false);
      if (last !== "interrupt") {
        await restoreCounts(key, was);
        return await refuse(last, taskId);
      }
      if (!(await deps.keys(pane, ["Escape"]))) {
        // Counted all the same: at most once is what C27 promises, and a key tmux refused may still have landed.
        deps.warn(`custodian: tmux refused the Escape for ${pane}`);
        await deps.audit.interrupt(pane, taskId, "internal");
        return { ok: false, code: "internal" };
      }
      await deps.audit.interrupt(pane, taskId, "sent");
      return { ok: true, verb: "interrupt", pane, taskId };
    } catch (err) {
      deps.warn(`custodian: interrupting ${pane} failed (${err instanceof Error ? err.name : "error"})`);
      await deps.audit.interrupt(pane, taskId, "internal").catch(() => {});
      return { ok: false, code: "internal" };
    } finally {
      inFlight.delete(pane);
    }
  };

  const notes = async (text: string): Promise<CustodianReply> => {
    if (deps.seat.isDone()) return { ok: false, code: "round_done" };
    if (Buffer.byteLength(text) > NOTES_MAX) return { ok: false, code: "too_long" };
    // An empty heredoc is the likely slip, and C38 says a round that writes none keeps the old file.
    if (text.trim() === "") return { ok: false, code: "invalid" };
    let panes: readonly PaneInfo[];
    try {
      panes = await panesNow();
    } catch {
      return { ok: false, code: "internal" };
    }
    const pruned = pruneNotes(text, {
      taskIds: new Set(panes.flatMap((pane) => (pane.taskId === null ? [] : [pane.taskId]))),
      panes: new Set(panes.map((pane) => pane.paneId)),
    });
    const apply = async (): Promise<void> => {
      await mkdir(dirname(notesPath), { recursive: true, mode: 0o700 });
      await writeDurable(notesPath, pruned.text, 0o600);
    };
    const write = notesChain.then(apply);
    notesChain = write.catch(() => {});
    try {
      await write;
    } catch (err) {
      deps.warn(`custodian: writing the notes failed (${err instanceof Error ? err.name : "error"})`);
      return { ok: false, code: "internal" };
    }
    return { ok: true, verb: "notes", kept: pruned.kept, dropped: pruned.dropped };
  };

  const done = async (summary: string): Promise<CustodianReply> => {
    if (Buffer.byteLength(summary) > SUMMARY_MAX) return { ok: false, code: "too_long" };
    const accepted = await deps.seat.done(summary);
    if (accepted === "too_late") return { ok: false, code: "too_late" };
    if (accepted === "no_round") return { ok: false, code: "not_custodian" };
    return { ok: true, verb: "done" };
  };

  const dispatch = (frame: CustodianFrame): Promise<CustodianReply> => {
    switch (frame.verb) {
      case "sessions":
        return sessions();
      case "close":
        return close(frame.pane);
      case "flag":
        return flag(frame.pane, frame.reason, frame.note);
      case "nudge":
        return nudge(frame.pane, frame.text);
      case "interrupt":
        return interrupt(frame.pane);
      case "notes":
        return notes(frame.text);
      case "done":
        return done(frame.summary);
    }
  };

  /** The frame's sender is a process of the pane the seat record names as the running round, by pid alone. */
  const bound = async (peer: number | null): Promise<boolean> => {
    const round = deps.roundPane();
    if (peer === null || !hostNamesPeers() || round === null) return false;
    return (await walk(peer, await deps.roundPanePids())) === round;
  };

  /** Whether this unbound sender's refusal is written: once a minute per pid, and `REFUSAL_LINES_PER_MIN` overall. */
  const refusals = { at: new Map<number | null, number>(), windowStart: 0, lines: 0, dropped: 0 };
  const worthWriting = (peer: number | null): boolean => {
    const now = deps.now();
    // A flood leaves a trace: when a window that dropped refusals rolls over, one line says how many.
    if (now - refusals.windowStart >= MINUTE_MS && refusals.dropped > 0) {
      deps.warn(
        `custodian: ${refusals.dropped} refused frames from unbound senders were not written in the last minute`,
      );
      refusals.dropped = 0;
    }
    const last = refusals.at.get(peer);
    if (last !== undefined && now - last < MINUTE_MS) {
      refusals.dropped += 1;
      return false;
    }
    if (now - refusals.windowStart >= MINUTE_MS) {
      refusals.windowStart = now;
      refusals.lines = 0;
    }
    if (refusals.lines >= REFUSAL_LINES_PER_MIN) {
      refusals.dropped += 1;
      return false;
    }
    refusals.lines += 1;
    refusals.at.delete(peer);
    refusals.at.set(peer, now);
    const oldest = refusals.at.keys().next();
    if (refusals.at.size > REFUSAL_PIDS_KEPT && !oldest.done) refusals.at.delete(oldest.value);
    return true;
  };

  const reach: CustodianVerbs["reach"] = async (pane, stillMs) => {
    try {
      const info = await infoOf(pane);
      if (info === null || !info.ours || info.dead || info.pid === null || info.custodian) return false;
      const held = await deps.flags.counts(info.taskId ?? pane, info.pid);
      const nudgeable =
        info.taskId !== null &&
        deps.tasks.launchedAt(info.taskId) !== undefined &&
        held.nudges < deps.settings.maxNudges;
      return nudgeable || (stillMs >= interruptAfterMs && !held.interrupted);
    } catch {
      // An unreadable fact must not hold a round due on every tick: the owner's request still starts one.
      return false;
    }
  };

  return {
    reach,
    handle: async (raw, peer) => {
      const frame = parseCustodianFrame(raw);
      if (frame === null) return { ok: false, code: "invalid" };
      if (!(await bound(peer))) {
        // Any same-uid process can send a frame, so a loop of them must not grow the log without bound (C48's audit
        // stays, but is collapsed). The verb is one of the parsed constants, so it is safe to name.
        if (worthWriting(peer)) {
          deps.warn(`custodian: refused a ${frame.verb} frame from pid ${peer ?? "-"} (not the round)`);
          if (frame.verb === "close") await deps.audit.close(frame.pane, null, "not_custodian");
          if (frame.verb === "flag") await deps.audit.flag(frame.pane, null, "-", "not_custodian", "round");
          if (frame.verb === "nudge") await deps.audit.nudge(frame.pane, null, "not_custodian");
          if (frame.verb === "interrupt") await deps.audit.interrupt(frame.pane, null, "not_custodian");
        }
        return { ok: false, code: "not_custodian" };
      }
      const reply = await dispatch(frame);
      deps.seat.count(frame.verb, reply.ok);
      return reply;
    },
  };
}
