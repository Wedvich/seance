import { despawnAudit, type AuditSink, type SpawnOrigin } from "./audit.ts";
import { DespawnFailure, type SessionBackend } from "./backend.ts";
import { log } from "./log.ts";
import type { BoundPane } from "./session-events.ts";

/**
 * The act behind `hand_off_task` (DESIGN.md, "Session events"): a session that opened its PR and armed
 * what merges it closes itself, so its task ends `awaiting-merge` and the scheduler watches the PR
 * instead of a session sleeping on it. The ingest calls this at the pane's next `idle` — the end of
 * the turn that called the tool, so its last message is written — and nothing here reads the frame.
 *
 * The graceful despawn every other path uses: `/exit`, Keep on the worktree prompt, and the close
 * noted first so harvest reads exit 0, never `vanished`. The worktree and branch stay, for a
 * continuation and for reap's merged-only rules.
 */
export interface HandOffDeps {
  readonly despawn: NonNullable<SessionBackend["despawn"]>;
  readonly panes: () => Promise<readonly BoundPane[]>;
  readonly closing: (taskId: string) => Promise<unknown>;
  readonly sink: AuditSink;
}

/**
 * The close at a turn's end, for the origin that asked: a hand-off's own, or a session's pass
 * (`successor`, once the leader confirmed its commit point). `gone` is the audited reason when the
 * pane no longer runs the task.
 */
export function createTurnEndClose(
  origin: Extract<SpawnOrigin, "handoff" | "successor">,
  deps: HandOffDeps,
  gone: string,
): (pane: string, taskId: string) => Promise<void> {
  const audit = despawnAudit(origin, deps.sink);
  return async (pane, taskId) => {
    try {
      await audit.request({ id: pane });
      // Re-read: between the idle and now the session may have ended and tmux reused the id.
      const live = (await deps.panes()).find((p) => p.id === pane && !p.dead);
      if (live?.taskId !== taskId) {
        await audit.rejected(gone);
        return;
      }
      await audit.ok(await deps.despawn(pane, { force: false, closing: deps.closing }));
    } catch (err) {
      if (err instanceof DespawnFailure) {
        await audit.failed(err.code).catch(() => {});
        return;
      }
      log.error(`${origin === "handoff" ? "hand-off" : "pass"} despawn crashed: ${String(err)}`);
      await audit.failed("internal_error").catch(() => {});
    }
  };
}

export function createHandOff(deps: HandOffDeps): (pane: string, taskId: string) => Promise<void> {
  return createTurnEndClose("handoff", deps, "the pane no longer runs the task that handed off");
}

/** A session's own pass closes the same way: its daemon, at the turn's end, under origin `successor`. */
export function createPassClose(deps: HandOffDeps): (pane: string, taskId: string) => Promise<void> {
  return createTurnEndClose("successor", deps, "the pane no longer runs the task that was passed");
}
