import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord, parseQuotaReading, type QuotaObservation } from "@seance/shared";
import { log } from "./log.ts";
import { stateDir } from "./paths.ts";

/**
 * A reading older than this has passed every window it describes (the longest
 * is seven days), so it reads 0% wherever it lands and is dropped at load —
 * which also bounds the file to exclaves that reported within a week.
 */
export const SESSION_QUOTA_MAX_AGE_S = 7 * 24 * 3_600;

const FILE_VERSION = 1;
const FILE_MODE = 0o600;

export function sessionQuotaPath(): string {
  return join(stateDir(), "session-quota.json");
}

type Reading = Omit<QuotaObservation, "x">;

interface Entry {
  /** The account the exclave was signed into when the reading came in. */
  readonly account: string | null;
  readonly reading: Reading;
}

interface QuotaFile {
  readonly v: typeof FILE_VERSION;
  /** Exclave id → `{ a: accountId, o: reading }`. */
  readonly exclaves: Readonly<Record<string, { readonly a: string | null; readonly o: Reading }>>;
}

function parseFile(raw: unknown, nowS: number): Map<string, Entry> | null {
  if (!isRecord(raw) || raw["v"] !== FILE_VERSION || !isRecord(raw["exclaves"])) return null;
  const entries = new Map<string, Entry>();
  for (const [exclave, value] of Object.entries(raw["exclaves"])) {
    if (!isRecord(value)) return null;
    const account = value["a"];
    const reading = parseQuotaReading(value["o"]);
    if ((account !== null && typeof account !== "string") || reading === null) return null;
    if (reading.at < nowS - SESSION_QUOTA_MAX_AGE_S) continue;
    entries.set(exclave, { account, reading });
  }
  return entries;
}

let tempSeq = 0;

/**
 * Each path's write chain, process-wide: a config reload stops one daemon and
 * opens the next in this process, and an open that read past the outgoing
 * instance's write in flight would start without its newest reading.
 */
const writes = new Map<string, Promise<void>>();

/**
 * Newest session-reported quota per exclave id: the telemetry tick folds it
 * beside the config dir's cache (`telemetry.ts`). On disk so a restart — every
 * self-update — keeps it: otherwise an account with no session running falls
 * back to a cache hours or days old, and the machine's next `status` replaces
 * the relay's kept snapshot with that older reading. Kept with the account it
 * was read under, because the key is the exclave: a reading never answers for
 * an account signed in after it.
 */
export class SessionQuota {
  readonly #path: string | null;
  readonly #entries: Map<string, Entry>;
  /** A write waiting behind the one in flight: it takes every record made until it starts. */
  #queued = false;

  private constructor(path: string | null, entries: Map<string, Entry>) {
    this.#path = path;
    this.#entries = entries;
  }

  /** Never throws: a missing or corrupt file costs only freshness, and is replaced on the next record. */
  static async open(path: string = sessionQuotaPath(), nowMs: number = Date.now()): Promise<SessionQuota> {
    await writes.get(path);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : undefined;
      if (code !== "ENOENT") log.warn(`session quota at ${path} unreadable (${String(err)}) — starting empty`);
      return new SessionQuota(path, new Map());
    }
    let parsed: Map<string, Entry> | null = null;
    try {
      parsed = parseFile(JSON.parse(text), Math.floor(nowMs / 1000));
    } catch {
      // Falls through to the warning below.
    }
    if (parsed === null) log.warn(`session quota at ${path} is corrupt — starting empty`);
    return new SessionQuota(path, parsed ?? new Map());
  }

  /** No file: for tests and a host that keeps none. */
  static memory(): SessionQuota {
    return new SessionQuota(null, new Map());
  }

  /** A reading under a different account replaces the old one whatever its stamp: it is a different account's. */
  record(exclave: string, account: string | null, reading: Reading): void {
    const current = this.#entries.get(exclave);
    if (current !== undefined && current.account === account && reading.at < current.reading.at) return;
    this.#entries.set(exclave, { account, reading });
    this.#persist();
  }

  get(exclave: string, account: string | null): Reading | undefined {
    const entry = this.#entries.get(exclave);
    return entry?.account === account ? entry.reading : undefined;
  }

  /** Resolves once every record made so far is on disk, or failed to be; for tests and shutdown. */
  async flushed(): Promise<void> {
    if (this.#path !== null) await writes.get(this.#path);
  }

  /**
   * Coalesced: a burst of records costs one write behind the one in flight.
   * Temp and rename, no fsync — a reading lost to a power cut costs freshness,
   * never correctness, unlike the launch ledger's write-ahead.
   */
  #persist(): void {
    const path = this.#path;
    if (path === null || this.#queued) return;
    this.#queued = true;
    const written = (writes.get(path) ?? Promise.resolve())
      .then(async () => {
        this.#queued = false;
        const file: QuotaFile = {
          v: FILE_VERSION,
          exclaves: Object.fromEntries(
            [...this.#entries].map(([exclave, { account, reading }]) => [exclave, { a: account, o: reading }]),
          ),
        };
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${tempSeq++}.tmp`;
        try {
          const handle = await open(temp, "w", FILE_MODE);
          try {
            await handle.writeFile(`${JSON.stringify(file)}\n`);
          } finally {
            await handle.close();
          }
          await rename(temp, path);
        } catch (err) {
          await unlink(temp).catch(() => {});
          throw err;
        }
      })
      .catch((err: unknown) => {
        log.warn(`session quota: could not save (${String(err)}) — a restart will fall back to the cache`);
      });
    writes.set(path, written);
  }
}
