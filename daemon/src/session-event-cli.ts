import {
  BACKGROUND_COUNT_MAX,
  isRecord,
  isStopError,
  type BackgroundKind,
  type BackgroundWork,
  type IdleNote,
} from "@seance/shared";
import { exchange } from "./local-client.ts";
import { socketPath } from "./paths.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "./session-event-frame.ts";

/**
 * Long enough for the daemon's pane lookup and parent walk, short enough that
 * a wedged daemon costs the mod's fire-and-forget call nothing it would notice.
 * A settings hook waits on it (Claude runs them in line), so it bounds that too.
 */
const EVENT_TIMEOUT_MS = 2_000;

/** `SessionStart` sources that begin a session at its prompt; `compact` is not one (it can fall mid-turn). */
const STARTS: ReadonlySet<unknown> = new Set(["startup", "resume", "clear"]);

/** Claude's `background_tasks[].type` labels, by séance's kind; any other is `other`. */
const KIND_OF: ReadonlyMap<unknown, BackgroundKind> = new Map([
  ["shell", "shell"],
  ["subagent", "agent"],
  ["monitor", "monitor"],
  ["workflow", "workflow"],
]);

function counted(work: Partial<Record<BackgroundKind, number>>, kind: BackgroundKind, by: number): void {
  if (by <= 0) return;
  work[kind] = Math.min(BACKGROUND_COUNT_MAX, (work[kind] ?? 0) + by);
}

/** Counts by kind, never a command, description or prompt: those are whatever the session ran. */
function backgroundOf(tasks: unknown, crons: unknown): BackgroundWork {
  const work: Partial<Record<BackgroundKind, number>> = {};
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!isRecord(task)) continue;
      // A Map, not an object: a `type` of `constructor` or `__proto__` must not read Object's prototype.
      counted(work, KIND_OF.get(task["type"]) ?? "other", 1);
    }
  }
  if (Array.isArray(crons)) counted(work, "wakeup", crons.length);
  return work;
}

/**
 * One Claude settings-hook input as the frame it reports, or null for nothing to report (exported for tests):
 * - `SessionStart` (startup, resume, clear) is the session at its prompt: `idle`, never `turnEnded` — the mod's
 *   `session.start` also fires on a hooks-worker respawn mid-turn, which is why it no longer reports.
 * - `Stop` and `StopFailure` are a `stop` note, no state: Claude runs them before the turn is over, and another
 *   `Stop` hook may continue it, so the turn's end stays the mod's `turn.complete`.
 * - `Elicitation` is `needs-input` (`elicitation`), its `ElicitationResult` `busy`: an MCP server asks inside a tool
 *   call, which the mod reports nothing of.
 * Each carries `agent` with the hook's `session_id`, as the mod's reports do.
 */
export function hookFrame(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const frame = hookBody(input);
  if (frame === null) return null;
  // A claim like the mod's, which the daemon verifies and parses (`parseAgentClaim`): a `SessionStart` after `/clear`
  // or `/resume` is the report that names the conversation the process moved to.
  const session = input["session_id"];
  return typeof session === "string" ? { ...frame, agent: { kind: "claude", session } } : frame;
}

function hookBody(input: Record<string, unknown>): Record<string, unknown> | null {
  switch (input["hook_event_name"]) {
    case "SessionStart":
      return STARTS.has(input["source"]) ? { state: "idle" } : null;
    case "Stop": {
      const stop: IdleNote = { background: backgroundOf(input["background_tasks"], input["session_crons"]) };
      return { stop };
    }
    case "StopFailure": {
      const error = input["error"];
      const stop: IdleNote = { stopError: isStopError(error) ? error : "unknown" };
      return { stop };
    }
    case "Elicitation":
      return { state: "needs-input", reason: "elicitation" };
    case "ElicitationResult":
      return { state: "busy" };
    default:
      return null;
  }
}

/**
 * `seance session-event`: one event from the session-events mod, read as JSON
 * on stdin (`state`, `prUrl`, `turnEnded`, `reason`, `tool`), sent to the local daemon as a
 * `session-event` frame. A `state: "done"` is never sent (the MCP tool is the
 * one report path, #21) and fails as silently as everything else. Silent and always exit 0 — a session must never see
 * its own telemetry fail — and it waits for the daemon's answer before exiting,
 * because the daemon binds the event by walking this process's parents, which
 * only works while it is alive.
 *
 * With `--hook`, stdin is a Claude settings hook's input instead (`hookFrame`), and nothing of it is passed on but
 * the state, counts and enum it maps to. Silent there too: a `Stop` hook's stdout is read by Claude as a decision.
 *
 * `TMUX_PANE` rides along as `pane`; the daemon reads it only on a host where
 * the kernel cannot name a socket's peer (DESIGN.md, "Session events").
 * `CLAUDE_CODE_BRIDGE_SESSION_ID` rides along as `remoteSession`: Claude Code
 * sets it once the session's Remote Control bridge connects, and the hook's
 * `$.process.run` inherits it, so the mod need not read it.
 */
export async function cmdSessionEvent(argv: readonly string[] = []): Promise<void> {
  try {
    const raw: unknown = JSON.parse(await Bun.stdin.text());
    const input = argv[0] === "--hook" ? hookFrame(raw) : raw;
    if (!isRecord(input)) return;
    // A done report is `report_task_done`'s alone: the mod's input is whatever its hook was fed, and a report settles a task.
    if (input["state"] === "done") return;
    // So is a hand-off, `hand_off_task`'s: it closes the session.
    if (input["handoff"] !== undefined) return;
    // And a pass, `pass_to_successor`'s: it pushes a branch and moves the task to a successor.
    if (input["pass"] !== undefined) return;
    const pane = process.env["TMUX_PANE"];
    // Outside tmux the daemon answers `unbound` every time: not worth its tmux and ps calls, in line with a hook.
    if (argv[0] === "--hook" && (pane === undefined || pane === "")) return;
    const remoteSession = process.env["CLAUDE_CODE_BRIDGE_SESSION_ID"];
    const frame = {
      ...input,
      v: SESSION_EVENT_VERSION,
      kind: SESSION_EVENT_KIND,
      ...(pane === undefined || pane === "" ? {} : { pane }),
      ...(remoteSession === undefined || remoteSession === "" ? {} : { remoteSession }),
    };
    await exchange(frame, {
      path: socketPath(),
      timeoutMs: EVENT_TIMEOUT_MS,
      timeoutText: "the daemon did not take the event in time",
    });
  } catch {
    // No daemon, no socket, unparseable input: nothing for a session to act on.
  }
}
