import type { AgentLogin } from "./types.ts";

/**
 * Codex's version floor (DESIGN.md, Daemon, "Codex login"): the version the spikes ran (docs/codex.md S1–S9), since
 * 0.166.0's `account/read` has no `userId`. Here rather than in the daemon because every reader of a login holds it to
 * the same floor: the daemon's probe and verbs, the PWA's login row, routing's `login_outdated`.
 */
export const CODEX_MIN_VERSION = "0.170.0";

/** A semver triple with an optional prerelease; stateless (no `g`), so one instance serves every caller. */
export const AGENT_VERSION_PATTERN = /\b(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,32})?\b/u;

/** Semver order on the numeric triple; a prerelease of the floor itself is below it. */
export function versionAtLeast(version: string, floor: string = CODEX_MIN_VERSION): boolean {
  const a = AGENT_VERSION_PATTERN.exec(version);
  const b = AGENT_VERSION_PATTERN.exec(floor);
  if (a === null || b === null) return false;
  for (const i of [1, 2, 3]) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return a[4] === undefined || b[4] !== undefined;
}

/**
 * The login's reported binary is below its agent's floor, so it is never placed. False with no version: no `codex`
 * answered, which the login's health says (unknown) rather than this.
 */
export function loginOutdated(login: Pick<AgentLogin, "version">): boolean {
  return login.version !== undefined && !versionAtLeast(login.version);
}
