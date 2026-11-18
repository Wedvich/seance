// What no writer re-sends, kept at rest per conversation (docs/tags.md §3.2) in the one file
// `stateDir()/conversations.json`, owned by this module alone (a second writer of its own format would erase this one's
// entries, each loading the other's as empty): the adapter subscriptions (docs/tags.md §8, amending docs/messaging.md
// D3) — a session that messages `adapter:<name>` subscribes its verified conversation to that adapter, which may then
// deliver to it by `toSession` for the conversation's life — and the owner's label on an untasked conversation (§3.1,
// the `session-tag` op). The label is the one text the file holds, the owner's own. Nothing in this module logs (an
// adapter module: `daemon/test/adapter-layering.test.ts`; `message-layering.test.ts` holds it off both sinks too).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAdapterName, isAgentSessionId, isRecord, parseTagValue } from "@seance/shared";
import { writeDurable } from "./durable-write.ts";

/** A conversation not live this long is dropped with its subscriptions (docs/tags.md §3.2). */
export const CONVERSATION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** Conversations kept at rest; past it the least recently live goes first. */
export const CONVERSATIONS_KEPT_MAX = 256;

/** `lastLive` is written at most this often per conversation: it only has to outlast `CONVERSATION_IDLE_MS`. */
const TOUCH_WRITE_MS = 60 * 60 * 1000;

const FILE_VERSION = 1;

interface Subscription {
  readonly adapter: string;
  readonly since: number;
}

export interface OwnerLabel {
  readonly value: string;
  /** When the owner set it, ms. */
  readonly at: number;
}

interface Entry {
  readonly ownerLabel?: OwnerLabel;
  readonly subscriptions: readonly Subscription[];
  readonly lastLive: number;
}

/** The owner's label, as `conversations.ts` reads and writes it (the `session-tag` op). */
export interface ConversationStore {
  readonly label: (id: string) => OwnerLabel | undefined;
  /**
   * Sets the label (`""` clears it) and writes the file; throws, the label as it was, when the write fails. A write that
   * fails after its rename (the directory's sync) leaves the new file on disk while memory keeps the old value: the next
   * write overwrites it, a restart before then shows it. Accepted: the owner's retry settles it.
   */
  readonly setLabel: (id: string, value: string) => Promise<void>;
  /** The conversation was live now (`touch`). */
  readonly live: (id: string) => void;
}

/**
 * What makes an adapter "the same program" across a daemon restart: its argv, recorded commit and, once
 * `seance adapter add` wrote one, the time of that add, hashed. `added` joins only when present, so an entry written
 * before it keeps the fingerprint it had.
 */
export function adapterFingerprint(config: {
  readonly argv: readonly string[];
  readonly commit?: string;
  readonly added?: string;
}): string {
  const parts = [config.argv, config.commit ?? null, ...(config.added === undefined ? [] : [config.added])];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * `reconcile` against the adapters a config names (none: every name's subscriptions end). The daemon calls it at each
 * start and config reload, which is how `seance adapter add` and `remove` end a name's subscriptions: the CLI writes
 * only `config.json`, so this file keeps one writer.
 */
export function reconcileWith(
  subscriptions: Subscriptions,
  adapters: Readonly<Record<string, Parameters<typeof adapterFingerprint>[0]>> | undefined,
): void {
  subscriptions.reconcile(
    new Map(Object.entries(adapters ?? {}).map(([name, config]) => [name, adapterFingerprint(config)])),
  );
}

export interface Subscriptions extends ConversationStore {
  has(adapter: string, conversation: string): boolean;
  /** Subscribe, or renew `lastLive` on, a verified conversation. */
  add(adapter: string, conversation: string): void;
  /** The session's own `leave`: ends that one subscription. */
  leave(adapter: string, conversation: string): void;
  /** The conversation was seen live (a verified, unconflicted process claims it). */
  touch(conversation: string): void;
  /**
   * Ends every subscription to an adapter no longer configured, or configured as another program (its fingerprint
   * changed, as a hand edit or a re-add makes it): a replaced program inherits none.
   */
  reconcile(adapters: ReadonlyMap<string, string>): void;
  /** Resolves once every write so far reached the disk (or failed: memory stays the truth until restart). */
  flushed(): Promise<void>;
}

/** A bad label drops the label, never the entry's subscriptions. */
function parseLabel(raw: unknown): OwnerLabel | undefined {
  if (!isRecord(raw)) return undefined;
  const at = raw["at"];
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return undefined;
  const value = parseTagValue("owner.label", raw["value"], "conversation");
  return value === null || value === "" ? undefined : { value, at };
}

function parseEntry(raw: unknown): Entry | null {
  if (!isRecord(raw)) return null;
  const { subscriptions, lastLive } = raw;
  if (typeof lastLive !== "number" || !Number.isFinite(lastLive) || !Array.isArray(subscriptions)) return null;
  const kept: Subscription[] = [];
  for (const each of subscriptions) {
    if (!isRecord(each)) return null;
    const { adapter, since } = each;
    if (!isAdapterName(adapter) || typeof since !== "number" || !Number.isFinite(since)) return null;
    if (!kept.some((s) => s.adapter === adapter)) kept.push({ adapter, since });
  }
  const ownerLabel = parseLabel(raw["ownerLabel"]);
  return { ...(ownerLabel === undefined ? {} : { ownerLabel }), subscriptions: kept, lastLive };
}

const holdsNothing = (entry: Entry): boolean => entry.subscriptions.length === 0 && entry.ownerLabel === undefined;

interface Loaded {
  readonly adapters: Map<string, string>;
  readonly conversations: Map<string, Entry>;
}

/** A file it cannot read loads empty: subscriptions are lost, never invented. */
function parseFile(text: string): Loaded {
  const empty: Loaded = { adapters: new Map(), conversations: new Map() };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!isRecord(raw) || raw["v"] !== FILE_VERSION) return empty;
  const { adapters, conversations } = raw;
  if (!isRecord(adapters) || !isRecord(conversations)) return empty;
  const loaded: Loaded = { adapters: new Map(), conversations: new Map() };
  for (const [name, fingerprint] of Object.entries(adapters)) {
    if (isAdapterName(name) && typeof fingerprint === "string" && /^[0-9a-f]{64}$/u.test(fingerprint)) {
      loaded.adapters.set(name, fingerprint);
    }
  }
  for (const [id, value] of Object.entries(conversations)) {
    const entry = parseEntry(value);
    if (isAgentSessionId(id) && entry !== null) loaded.conversations.set(id, entry);
  }
  return loaded;
}

/**
 * Read once, synchronously, at the daemon's start: one small file, before any adapter speaks. One store per file per
 * process (`subscriptionsFor`, `run-capabilities.ts`): a second one over the same file would write its map over this one's.
 */
export function openSubscriptions(path: string, opts: { readonly now?: () => number } = {}): Subscriptions {
  const now = opts.now ?? Date.now;
  let text: string | null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  const { adapters, conversations } = text === null ? parseFile("") : parseFile(text);
  // When each conversation's `lastLive` was last written, so `touch` writes at most hourly.
  const written = new Map<string, number>();
  for (const [id, entry] of conversations) written.set(id, entry.lastLive);

  let chain: Promise<void> = Promise.resolve();

  function prune(): void {
    const horizon = now() - CONVERSATION_IDLE_MS;
    for (const [id, entry] of conversations) {
      if (entry.lastLive < horizon || holdsNothing(entry)) conversations.delete(id);
    }
    if (conversations.size <= CONVERSATIONS_KEPT_MAX) return;
    const oldest = [...conversations].toSorted(([, a], [, b]) => a.lastLive - b.lastLive);
    for (const [id] of oldest.slice(0, conversations.size - CONVERSATIONS_KEPT_MAX)) conversations.delete(id);
  }

  /** The returned write rejects on failure (for `setLabel`); every other caller leaves memory the truth until restart. */
  function persist(): Promise<void> {
    prune();
    const body = {
      v: FILE_VERSION,
      adapters: Object.fromEntries(adapters),
      conversations: Object.fromEntries(conversations),
    };
    const out = `${JSON.stringify(body)}\n`;
    for (const [id, entry] of conversations) written.set(id, entry.lastLive);
    // Serialized: two renames racing could publish the older body last.
    const run = chain.then(() => writeDurable(path, out, 0o600));
    chain = run.catch(() => {});
    return run;
  }

  /** Keeps the entry while it holds a label or a subscription. */
  function put(id: string, entry: Entry): void {
    if (holdsNothing(entry)) conversations.delete(id);
    else conversations.set(id, entry);
  }

  /** Ends every subscription to one adapter in memory; whether any ended. */
  function strip(adapter: string): boolean {
    let changed = false;
    for (const [id, entry] of conversations) {
      if (!entry.subscriptions.some((sub) => sub.adapter === adapter)) continue;
      put(id, { ...entry, subscriptions: entry.subscriptions.filter((sub) => sub.adapter !== adapter) });
      changed = true;
    }
    return changed;
  }

  function set(id: string, subscriptions: readonly Subscription[], lastLive: number): void {
    const ownerLabel = conversations.get(id)?.ownerLabel;
    put(id, { ...(ownerLabel === undefined ? {} : { ownerLabel }), subscriptions, lastLive });
    void persist();
  }

  function touch(conversation: string): void {
    const entry = conversations.get(conversation);
    if (entry === undefined) return;
    const at = now();
    conversations.set(conversation, { ...entry, lastLive: at });
    if (at - (written.get(conversation) ?? 0) >= TOUCH_WRITE_MS) void persist();
  }

  // A load that dropped idle entries writes the pruned file back.
  const before = conversations.size;
  prune();
  if (conversations.size !== before) void persist();

  return {
    has(adapter, conversation) {
      return conversations.get(conversation)?.subscriptions.some((s) => s.adapter === adapter) ?? false;
    },
    add(adapter, conversation) {
      const at = now();
      const entry = conversations.get(conversation);
      const subscriptions = entry?.subscriptions ?? [];
      if (subscriptions.some((s) => s.adapter === adapter)) {
        set(conversation, subscriptions, at);
        return;
      }
      set(conversation, [...subscriptions, { adapter, since: at }], at);
    },
    leave(adapter, conversation) {
      const entry = conversations.get(conversation);
      if (entry === undefined || !entry.subscriptions.some((s) => s.adapter === adapter)) return;
      set(
        conversation,
        entry.subscriptions.filter((s) => s.adapter !== adapter),
        entry.lastLive,
      );
    },
    touch,
    live: touch,
    label(id) {
      return conversations.get(id)?.ownerLabel;
    },
    async setLabel(id, value) {
      const held = conversations.get(id);
      // Nothing to clear: no write, and no file made for it.
      if (value === "" && held?.ownerLabel === undefined) return;
      const at = now();
      put(id, {
        ...(value === "" ? {} : { ownerLabel: { value, at } }),
        subscriptions: held?.subscriptions ?? [],
        lastLive: at,
      });
      try {
        await persist();
      } catch (err) {
        // Only the label goes back: a subscription change made meanwhile stands, and its own write follows.
        const current = conversations.get(id);
        const ownerLabel = held?.ownerLabel;
        put(id, {
          ...(ownerLabel === undefined ? {} : { ownerLabel }),
          subscriptions: current?.subscriptions ?? [],
          lastLive: current?.lastLive ?? held?.lastLive ?? at,
        });
        throw err;
      }
    },
    reconcile(configured) {
      let changed = false;
      const named = new Set(adapters.keys());
      for (const entry of conversations.values()) for (const sub of entry.subscriptions) named.add(sub.adapter);
      for (const name of named) {
        const fingerprint = configured.get(name);
        if (fingerprint !== undefined && adapters.get(name) === fingerprint) continue;
        if (strip(name)) changed = true;
      }
      for (const name of adapters.keys()) {
        if (configured.has(name)) continue;
        adapters.delete(name);
        changed = true;
      }
      for (const [name, fingerprint] of configured) {
        if (adapters.get(name) === fingerprint) continue;
        adapters.set(name, fingerprint);
        changed = true;
      }
      if (changed) void persist();
    },
    flushed() {
      return chain;
    },
  };
}
