import { open, readFile, rm, stat } from "node:fs/promises";

/**
 * A lock past this age is taken over whatever its pid says: the update unit's
 * `TimeoutStartSec` is 15 minutes, so a holder older than that is gone or wedged,
 * and a recycled pid must not hold the lock for good.
 */
export const UPDATE_LOCK_STALE_MS = 20 * 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists, owned by someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether the lock file at `path` names a live holder that took it recently. */
async function held(path: string, now: number): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (info === null) return false;
  if (now - info.mtimeMs > UPDATE_LOCK_STALE_MS) return false;
  const text = (await readFile(path, "utf8").catch(() => "")).trim();
  // Created but not yet written: its taker is between `open` and `writeFile`.
  if (text === "") return now - info.mtimeMs < 10_000;
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

/**
 * Runs `fn` holding an exclusive lock file at `path`, or returns `null` without
 * running it when another update (the oneshot, or a hand `update`) holds it: two
 * git and `bun install` pipelines in one checkout would race, and a hand update's
 * restart can start the oneshot while it is still waiting on the relaunch. The
 * holder's own request loop (`runWhileRequested`) covers a request that arrives
 * meanwhile. Created `wx`, so two starters cannot both win; a dead or stale
 * holder's file is removed once and the take retried.
 */
export async function withUpdateLock<T>(
  path: string,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T | null> {
  if (!(await take(path))) {
    if (await held(path, now())) return null;
    await rm(path, { force: true });
    if (!(await take(path))) return null;
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/** Creates the lock file `wx` and writes our pid; false when it exists. */
async function take(path: string): Promise<boolean> {
  const handle = await open(path, "wx", 0o600).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  });
  if (handle === null) return false;
  try {
    await handle.writeFile(`${process.pid}\n`);
  } finally {
    await handle.close();
  }
  return true;
}
