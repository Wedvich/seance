/**
 * One account refresh at a time in the whole process: the `/usage` refresh's Claude run and the Codex probe each spawn
 * a whole agent process, and a small LXC cannot carry two at once. Process-wide, not per instance, because a config
 * reload starts a second daemon in process while the first one's run may still be going.
 */
let lane: Promise<unknown> = Promise.resolve();

export function inRefreshLane<T>(run: () => Promise<T>): Promise<T> {
  const next = lane.then(run);
  lane = next.catch(() => undefined);
  return next;
}
