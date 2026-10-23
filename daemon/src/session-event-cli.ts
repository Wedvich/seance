import { isRecord } from "@seance/shared";
import { exchange } from "./local-client.ts";
import { socketPath } from "./paths.ts";
import { SESSION_EVENT_KIND, SESSION_EVENT_VERSION } from "./session-event-frame.ts";

/**
 * Long enough for the daemon's pane lookup and parent walk, short enough that
 * a wedged daemon costs the mod's fire-and-forget call nothing it would notice.
 */
const EVENT_TIMEOUT_MS = 2_000;

/**
 * `seanced session-event`: one event from the session-events mod, read as JSON
 * on stdin (`state`, `prUrl`), sent to the local daemon as a
 * `session-event` frame. A `state: "done"` is never sent (the MCP tool is the
 * one report path, #21) and fails as silently as everything else. Silent and always exit 0 — a session must never see
 * its own telemetry fail — and it waits for the daemon's answer before exiting,
 * because the daemon binds the event by walking this process's parents, which
 * only works while it is alive.
 *
 * `TMUX_PANE` rides along as `pane`; the daemon reads it only on a host where
 * the kernel cannot name a socket's peer (DESIGN.md, "Session events").
 * `CLAUDE_CODE_BRIDGE_SESSION_ID` rides along as `remoteSession`: Claude Code
 * sets it once the session's Remote Control bridge connects, and the hook's
 * `$.process.run` inherits it, so the mod need not read it.
 */
export async function cmdSessionEvent(): Promise<void> {
  try {
    const input: unknown = JSON.parse(await Bun.stdin.text());
    if (!isRecord(input)) return;
    // A done report is `report_task_done`'s alone: the mod's input is whatever its hook was fed, and a report settles a task.
    if (input["state"] === "done") return;
    const pane = process.env["TMUX_PANE"];
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
