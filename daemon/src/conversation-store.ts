import { readFileSync } from "node:fs";
import { isAgentSessionId, isRecord, parseTagValue } from "@seance/shared";
import { writeDurable } from "./durable-write.ts";

/**
 * What no writer re-sends, kept at rest per conversation (docs/tags.md §3.2): the owner's label on an untasked
 * conversation and, from step 4, its adapter subscriptions. One small file, `stateDir()/conversations.json`, 0600,
 * written whole through `writeDurable` (temp, fsync, rename), keyed by conversation id:
 * `{ ownerLabel?: { value, at }, subscriptions: [{ adapter, since }], lastLive }`. The label is the one text it holds,
 * the owner's own. Nothing here is logged (`message-layering.test.ts` holds this module off both sinks): a file it
 * cannot read loads empty, so labels are lost, never invented.
 *
 * `subscriptions` is step 4's; nothing writes it yet. It is read and written back so that a daemon downgraded from a
 * build that does write it keeps them on its next label write rather than erasing them.
 */

/** Conversations kept; past it the least recently live goes first. */
export const CONVERSATIONS_KEPT_MAX = 256;
/** A conversation not live for this long is dropped when the file is loaded. */
export const CONVERSATION_IDLE_MS = 30 * 24 * 60 * 60_000;
/** `lastLive` reaches the disk at most this often per conversation: every report touches it, and only the prune reads it. */
export const LAST_LIVE_WRITE_MS = 60 * 60_000;

const FILE_MODE = 0o600;
const ADAPTER_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

export interface OwnerLabel {
  readonly value: string;
  /** When the owner set it, ms. */
  readonly at: number;
}

interface Subscription {
  readonly adapter: string;
  readonly since: number;
}

interface Kept {
  readonly ownerLabel?: OwnerLabel;
  readonly subscriptions: readonly Subscription[];
  readonly lastLive: number;
}

export interface ConversationStore {
  readonly label: (id: string) => OwnerLabel | undefined;
  /** Sets the label (`""` clears it) and writes the file; throws, holding nothing new, when the write fails. */
  readonly setLabel: (id: string, value: string) => Promise<void>;
  /** The conversation was live now; written at most every `LAST_LIVE_WRITE_MS`, a failed write left for the next. */
  readonly live: (id: string) => void;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function parseLabel(raw: unknown): OwnerLabel | undefined {
  if (!isRecord(raw) || !positive(raw["at"])) return undefined;
  const value = parseTagValue("owner.label", raw["value"], "conversation");
  return value === null || value === "" ? undefined : { value, at: raw["at"] };
}

function parseSubscriptions(raw: unknown): readonly Subscription[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) =>
    isRecord(item) &&
    typeof item["adapter"] === "string" &&
    ADAPTER_NAME.test(item["adapter"]) &&
    positive(item["since"])
      ? [{ adapter: item["adapter"], since: item["since"] }]
      : [],
  );
}

/** The file's entries, idle ones and those holding nothing dropped, least recently live first, at most the cap. */
function load(path: string, now: number): Map<string, Kept> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
  if (!isRecord(raw)) return new Map();
  const kept: [string, Kept][] = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (!isAgentSessionId(id) || !isRecord(entry) || !positive(entry["lastLive"])) continue;
    const lastLive = entry["lastLive"];
    if (now - lastLive > CONVERSATION_IDLE_MS) continue;
    const ownerLabel = parseLabel(entry["ownerLabel"]);
    const subscriptions = parseSubscriptions(entry["subscriptions"]);
    if (ownerLabel === undefined && subscriptions.length === 0) continue;
    kept.push([id, { ...(ownerLabel === undefined ? {} : { ownerLabel }), subscriptions, lastLive }]);
  }
  kept.sort(([, a], [, b]) => a.lastLive - b.lastLive);
  return new Map(kept.slice(-CONVERSATIONS_KEPT_MAX));
}

function capped(entries: Map<string, Kept>): void {
  for (const id of entries.keys()) {
    if (entries.size <= CONVERSATIONS_KEPT_MAX) return;
    entries.delete(id);
  }
}

/** Reads `path` now (a missing or unreadable file is an empty store); every write after is whole-file and serialized. */
export function loadConversationStore(path: string, now: () => number = Date.now): ConversationStore {
  // Insertion order is liveness order: a touched entry is re-inserted at the end, so the first is the least recently live.
  let entries = load(path, now());
  /** The `lastLive` each entry last reached the disk with. */
  const written = new Map([...entries].map(([id, entry]) => [id, entry.lastLive]));
  let chain: Promise<unknown> = Promise.resolve();

  const write = async (): Promise<void> => {
    const body = Object.fromEntries(entries);
    await writeDurable(path, `${JSON.stringify(body)}\n`, FILE_MODE);
    for (const [id, entry] of entries) written.set(id, entry.lastLive);
    for (const id of written.keys()) if (!entries.has(id)) written.delete(id);
  };

  const relabel = async (id: string, value: string): Promise<void> => {
    const before = entries;
    const after = new Map(entries);
    const held = after.get(id);
    after.delete(id);
    const at = now();
    const entry: Kept = {
      ...(value === "" ? {} : { ownerLabel: { value, at } }),
      subscriptions: held?.subscriptions ?? [],
      lastLive: at,
    };
    if (entry.ownerLabel !== undefined || entry.subscriptions.length > 0) after.set(id, entry);
    capped(after);
    entries = after;
    try {
      await write();
    } catch (err) {
      entries = before;
      throw err;
    }
  };

  return {
    label: (id) => entries.get(id)?.ownerLabel,
    setLabel: (id, value) => {
      const run = chain.then(() => relabel(id, value));
      chain = run.catch(() => {});
      return run;
    },
    live: (id) => {
      const held = entries.get(id);
      if (held === undefined) return;
      const at = now();
      entries.delete(id);
      entries.set(id, { ...held, lastLive: at });
      if (at - (written.get(id) ?? 0) < LAST_LIVE_WRITE_MS) return;
      // Only the prune reads it: a failed write is retried at the next touch past the spacing.
      chain = chain.then(write).catch(() => {});
    },
  };
}
