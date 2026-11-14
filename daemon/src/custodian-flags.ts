import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, isTaskId, parseTaskFlag, type FlagReason, type TaskFlag } from "@seance/shared";
import { writeDurable } from "./durable-write.ts";
import type { PaneActivity, TrackedState } from "./pane-activity.ts";

/**
 * The daemon's open custodian flags (docs/custodian.md C30; DESIGN.md, "The custodian frame kind"): one entry per
 * flagged session in `stateDir()/custodian/sessions.json`, 0600 in the 0700 `custodian/` dir. Not `state.json`: that
 * file is the owner CLI's alone, an unreadable one there means "paused", and a daemon write racing the CLI's
 * read-modify-write could pause the seat. Nudge and interrupt counts join this file at item 8.
 *
 * The key is the pane's task id, or its pane id for an untasked pane (a `%`, which a task id never starts with).
 * A pane id means nothing after the tmux server restarts, which reuses them, so pane-keyed entries are dropped at
 * load. Nothing here logs or returns the note except `get`, whose one caller (`custodian-verbs.ts`) never passes it on.
 * Must not import `log.ts`: `warn` is a dependency, as `custodian-verbs.ts` takes it.
 */

export interface CustodianFlagsDeps {
  readonly path: string;
  readonly now: () => number;
  readonly warn: (line: string) => void;
}

/** What `set` did: a flag for a reason the key did not hold, a changed note under the same reason, or nothing. */
export type FlagSet = "new" | "note" | "same";

export interface CustodianFlags {
  readonly get: (key: string) => Promise<TaskFlag | null>;
  /** The same reason keeps its `at`. */
  readonly set: (key: string, reason: FlagReason, note: string | undefined) => Promise<FlagSet>;
  /** True when there was an entry. Writes nothing for a missing key. */
  readonly clear: (key: string) => Promise<boolean>;
  /**
   * Drops every entry whose key is no live task id and no live pane id, and returns the task ids it dropped, for the
   * caller to send `unflag` for: a finished task's flag must not outlive its session on the record. Writes only when
   * something went.
   */
  readonly prune: (live: {
    readonly taskIds: ReadonlySet<string>;
    readonly panes: ReadonlySet<string>;
  }) => Promise<readonly string[]>;
}

/**
 * A bound `busy` frame after an `idle` that ended a turn: the session was given a new turn, so a flag about the last one
 * is stale. Not `needs-input` to `busy` (a permission answered), not `busy` to `busy`, and not an unobserved pane: with
 * no state before it there is nothing to say the last turn ended.
 */
export function isNewTurn(before: Pick<PaneActivity, "state" | "turnEnded"> | null, state: TrackedState): boolean {
  return state === "busy" && before?.state === "idle" && before.turnEnded;
}

const isPaneKey = (key: string): boolean => key.startsWith("%");

export function createCustodianFlags(deps: CustodianFlagsDeps): CustodianFlags {
  let entries: Map<string, TaskFlag> | null = null;
  // Reads and writes both wait their turn: `writeDurable` is not serialized, and a lazy load must not race a set.
  let chain: Promise<unknown> = Promise.resolve();
  const turn = <T>(act: () => Promise<T>): Promise<T> => {
    const next = chain.then(act);
    chain = next.catch(() => {});
    return next;
  };

  const load = async (): Promise<Map<string, TaskFlag>> => {
    if (entries !== null) return entries;
    const loaded = new Map<string, TaskFlag>();
    let text: string | null = null;
    try {
      text = await readFile(deps.path, "utf8");
    } catch (err) {
      if (!(isRecord(err) && err["code"] === "ENOENT")) deps.warn("custodian: the flags file could not be read");
    }
    if (text !== null) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        // Warned below.
      }
      if (isRecord(raw) && raw["v"] === 1 && isRecord(raw["flags"])) {
        for (const [key, value] of Object.entries(raw["flags"])) {
          const flag = parseTaskFlag(value);
          // A bad entry is dropped alone; a pane id is dead after a restart.
          if (flag !== null && isTaskId(key)) loaded.set(key, flag);
        }
      } else {
        // Never the content: it holds a note.
        deps.warn("custodian: the flags file is malformed and was read as empty");
      }
    }
    entries = loaded;
    return loaded;
  };

  const persist = async (held: ReadonlyMap<string, TaskFlag>): Promise<void> => {
    await mkdir(dirname(deps.path), { recursive: true, mode: 0o700 });
    await writeDurable(deps.path, `${JSON.stringify({ v: 1, flags: Object.fromEntries(held) })}\n`, 0o600);
  };

  /** A change applied to memory and then to disk; a write that fails leaves memory as the disk is. */
  const changing = async <T>(change: (held: Map<string, TaskFlag>) => T | null): Promise<T | null> => {
    const held = await load();
    const before = new Map(held);
    const result = change(held);
    if (result === null) return null;
    try {
      await persist(held);
    } catch (err) {
      held.clear();
      for (const [key, flag] of before) held.set(key, flag);
      throw err;
    }
    return result;
  };

  return {
    get: (key) => turn(async () => (await load()).get(key) ?? null),
    set: (key, reason, note) =>
      turn(async () => {
        const result = await changing<FlagSet>((held) => {
          const was = held.get(key);
          if (was?.reason === reason && was.note === note) return null;
          held.set(key, {
            reason,
            ...(note === undefined ? {} : { note }),
            at: was?.reason === reason ? was.at : deps.now(),
          });
          return was?.reason === reason ? "note" : "new";
        });
        return result ?? "same";
      }),
    clear: (key) =>
      turn(async () => {
        const result = await changing<true>((held) => (held.delete(key) ? true : null));
        return result === true;
      }),
    prune: (live) =>
      turn(async () => {
        const dropped = await changing<readonly string[]>((held) => {
          const gone = [...held.keys()].filter(
            (key) => !(isPaneKey(key) ? live.panes.has(key) : live.taskIds.has(key)),
          );
          for (const key of gone) held.delete(key);
          return gone.length === 0 ? null : gone.filter((key) => !isPaneKey(key));
        });
        return dropped ?? [];
      }),
  };
}
