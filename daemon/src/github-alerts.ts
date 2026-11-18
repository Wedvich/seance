import {
  GITHUB_ALERTS_MAX,
  isStatusStale,
  liveStatus,
  type GithubAlerted,
  type GithubBudget,
  type GithubResource,
  type Machine,
  type PushAlert,
} from "@seance/shared";

/**
 * GitHub budget alerts (DESIGN.md, "GitHub rate limits"): the pure step the leader runs over the registry, beside
 * `diskAlertStep`. A budget is a GitHub user's (`MachineStatus.gh.u`) REST or GraphQL allowance; every machine signed
 * in as that user reports the same one, so the step groups readings by user and alerts once per user and budget, not
 * per machine. A reading without `u` (its daemon has not read `/user` yet) says nothing.
 *
 * A budget alerts when the lowest live reading of its newest window has under `GITHUB_ALERT_SHARE` of its limit left,
 * once per reset window: the held entry keeps that window's `reset`, and a budget with an entry whose reset is still
 * ahead is not alerted again, whatever its readings do. An entry goes once its reset has passed. `alerted` is the
 * settings record's `githubAlerts`, not memory, so a new leader does not repeat an alert inside the window.
 */

/** Under this share of a budget left, it is nearly gone: 1,000 of 5,000 is ~3.5 minutes at the 2026-11-17 burn. */
export const GITHUB_ALERT_SHARE = 0.2;

export interface GithubAlertStep {
  readonly alerts: readonly PushAlert[];
  /** The list to store when it changed, else null. */
  readonly next: readonly GithubAlerted[] | null;
}

const RESOURCES: readonly (readonly [GithubResource, "c" | "g"])[] = [
  ["core", "c"],
  ["graphql", "g"],
];

export function githubAlertStep(
  machines: readonly Machine[],
  alerted: readonly GithubAlerted[],
  now: number,
): GithubAlertStep {
  const nowS = now / 1000;
  // The lowest reading of the newest window per user and budget: two machines straddling a reset read two windows.
  const lowest = new Map<string, { readonly u: number; readonly r: GithubResource; readonly b: GithubBudget }>();
  for (const machine of machines) {
    const status = liveStatus(machine);
    if (status === undefined || isStatusStale(status, now)) continue;
    const gh = status.gh;
    if (gh?.u === undefined) continue;
    for (const [r, field] of RESOURCES) {
      const b = gh[field];
      if (b === undefined || b[2] <= nowS) continue;
      const key = `${gh.u}:${r}`;
      const held = lowest.get(key);
      if (held === undefined || b[2] > held.b[2] || (b[2] === held.b[2] && b[1] < held.b[1])) {
        lowest.set(key, { u: gh.u, r, b });
      }
    }
  }
  const kept = alerted.filter((entry) => entry.reset > nowS);
  const alerts: PushAlert[] = [];
  for (const { u, r, b } of lowest.values()) {
    const [limit, remaining, reset] = b;
    if (remaining >= limit * GITHUB_ALERT_SHARE) continue;
    if (kept.some((entry) => entry.u === u && entry.r === r)) continue;
    // Never evicted to make room: a window ends within the hour and frees its slot.
    if (kept.length >= GITHUB_ALERTS_MAX) continue;
    kept.push({ u, r, reset, at: now });
    alerts.push({ v: 1, kind: "github", at: now, resource: r, reset });
  }
  const unchanged = kept.length === alerted.length && kept.every((entry, i) => entry === alerted[i]);
  return { alerts, next: unchanged ? null : kept };
}
