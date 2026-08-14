import { RequestFailure } from "@seance/shared";

/**
 * One line for a Toast, from whatever the relay client threw. `RequestFailure`
 * carries a structured reason, so the two cases worth distinguishing are
 * distinguished: `offline` means nothing started, `timeout` means the request
 * went out and no answer came back — a session may well be running.
 */
export function failureText(err: unknown): string {
  if (err instanceof RequestFailure) {
    if (err.reason === "offline") return "That machine is not connected to the relay";
    if (err.reason === "unknown") return "The relay has never seen that machine";
    if (err.reason === "disconnected") return "Lost the relay connection before the request went out";
    if (err.reason === "timeout") return `${err.message} — it may be asleep, or the session may have started anyway`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
