import { readFile, rename, stat, writeFile } from "node:fs/promises";

/**
 * How the running archivist follows the fleet's update announce without running
 * anything itself (DESIGN.md, Archivist, A26). The `run` process holds the PSK and
 * loads no exec path (archivist/test/layering.test.ts), so it only writes this
 * file; `seance-archivist-update.path` sees the write and starts
 * `seance-archivist-update.service`, which runs `seance-archivist update
 * --requested` as the same user with no credential delivered. The file's first
 * word says what asked, for that run's audit line; nothing else in it is read.
 */
export type RequestOrigin = "announce" | "register";

/**
 * How often a reconnect may ask again. A daemon checks on every register to catch
 * up after sleep; the archivist sits on an always-on box, so its reconnects are
 * network blips and a refused seat's redials, and the announce is the main path.
 * The first connect of a process asks unless the request file itself is younger
 * than this, so a crash-looping service (which reconnects every few seconds) does
 * not fetch from origin on each start.
 */
export const REGISTER_DEBOUNCE_MS = 30 * 60_000;

export interface UpdateRequester {
  /** An announce naming `sha`; one already asked for in this process asks nothing. */
  readonly announce: (sha: string) => Promise<void>;
  /** The seat connected. */
  readonly registered: () => Promise<void>;
}

export function createUpdateRequester(opts: {
  readonly path: string;
  readonly debounceMs?: number;
  readonly now?: () => number;
  /** When the file was last written, as epoch ms; null when absent. Defaults to its mtime. */
  readonly askedAt?: () => Promise<number | null>;
}): UpdateRequester {
  const now = opts.now ?? Date.now;
  const debounceMs = opts.debounceMs ?? REGISTER_DEBOUNCE_MS;
  let lastSha: string | null = null;
  let lastRegister: number | null = null;
  let seenFile = false;
  const askedAt =
    opts.askedAt ?? (async (): Promise<number | null> => (await stat(opts.path).catch(() => null))?.mtimeMs ?? null);
  // A sha is not a path or a flag anywhere downstream, but it is wire-supplied: one line, hex only.
  // Written aside and renamed in: a plain writeFile creates the file before its text lands, and the path
  // unit's `PathChanged=` fires on that create, so the update could read an empty request. Writes are
  // chained so an announce and a register never share the `.part` at once.
  const part = `${opts.path}.part`;
  // Never rejects: a failed write is its own caller's to report, not the next one's.
  let chain: Promise<void> = Promise.resolve();
  const write = (line: string): Promise<void> => {
    const previous = chain;
    const next = (async (): Promise<void> => {
      await previous;
      await writeFile(part, `${line}\n`, { mode: 0o600 });
      await rename(part, opts.path);
    })();
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    announce: async (sha: string): Promise<void> => {
      if (sha === lastSha) return;
      lastSha = sha;
      lastRegister = now();
      await write(/^[0-9a-f]{1,64}$/u.test(sha) ? `announce ${sha}` : "announce");
    },
    registered: async (): Promise<void> => {
      const at = now();
      if (!seenFile) {
        seenFile = true;
        lastRegister ??= await askedAt();
      }
      if (lastRegister !== null && at - lastRegister < debounceMs) return;
      lastRegister = at;
      await write("register");
    },
  };
}

/** What the last request named; an absent or unrecognised file reads as `announce`, the path's main trigger. */
export async function readRequestOrigin(path: string): Promise<RequestOrigin> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split(/\s/u, 1)[0] === "register" ? "register" : "announce";
}

/**
 * Runs `run`, then again while the request file changed during it: the update
 * unit is a oneshot, so a `PathChanged` that lands while it runs merges into the
 * job already running and nothing re-fires it. At most `max` runs; the last result is returned.
 */
export async function runWhileRequested<T>(path: string, run: () => Promise<T>, max = 3): Promise<T> {
  // mtime and ctime at full resolution, not ms. File times still tick coarsely (about 4 ms), so a rewrite of
  // the same text within one tick reads as the write it follows, which is a duplicate of it.
  const stamp = async (): Promise<string> => {
    const info = await stat(path, { bigint: true }).catch(() => null);
    const text = await readFile(path, "utf8").catch(() => "");
    return `${info?.mtimeNs ?? ""}:${info?.ctimeNs ?? ""}:${text}`;
  };
  for (let runs = 1; ; runs++) {
    // Taken before the run, and `run` does nothing slow ahead of its fetch: a write
    // during it differs from this stamp. A write in the instants between the last
    // stamp and the process exiting is the one window left, covered by the next
    // register's check (at most 30 minutes) or announce.
    // oxlint-disable-next-line no-await-in-loop -- each run follows the last
    const before = await stamp();
    // oxlint-disable-next-line no-await-in-loop -- ditto
    const result = await run();
    // oxlint-disable-next-line no-await-in-loop -- ditto
    if (runs >= max || (await stamp()) === before) return result;
  }
}
