import { failureReasonText, RequestFailure } from "@seance/shared";

/**
 * One line for a Toast, from whatever the relay client threw. The reason→text
 * mapping is `failureReasonText` in shared/ — the same line `seanced mcp`
 * prints — so the two surfaces cannot drift apart in what a reason means.
 */
export function failureText(err: unknown): string {
  if (err instanceof RequestFailure) return failureReasonText(err);
  return err instanceof Error ? err.message : String(err);
}
