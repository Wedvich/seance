import { readFile, writeFile } from "node:fs/promises";

/**
 * How the running archivist follows the fleet's update announce without running
 * anything itself (docs/archivist.md, A26). The `run` process holds the PSK and
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
 * The first connect of a process always asks.
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
}): UpdateRequester {
  const now = opts.now ?? Date.now;
  const debounceMs = opts.debounceMs ?? REGISTER_DEBOUNCE_MS;
  let lastSha: string | null = null;
  let lastRegister: number | null = null;
  // A sha is not a path or a flag anywhere downstream, but it is wire-supplied: one line, hex only.
  const write = (line: string): Promise<void> => writeFile(opts.path, `${line}\n`, { mode: 0o600 });
  return {
    announce: async (sha: string): Promise<void> => {
      if (sha === lastSha) return;
      lastSha = sha;
      await write(/^[0-9a-f]{1,64}$/u.test(sha) ? `announce ${sha}` : "announce");
    },
    registered: async (): Promise<void> => {
      const at = now();
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
