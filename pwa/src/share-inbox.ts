import { attachmentName, pastTotalText, tooLargeText, tooManyText } from "./attachments.ts";
import { SHARE_INBOX, SHARE_INBOX_PATH, SHARE_MARKER, SHARE_UNREADABLE } from "./share.ts";

/**
 * The app's half of the Web Share Target (DESIGN.md, "Attachments", Share target): what
 * the worker's `receiveShare` left in Cache Storage, read back at boot and handed to
 * `Store.receiveShare`. Structural types rather than the DOM's `Cache`, so this module
 * typechecks under the tests' DOM-free lib; `caches` is assignable to them.
 */

export interface InboxCache {
  keys(): Promise<readonly { readonly url: string }[]>;
  match(request: string): Promise<{ json(): Promise<unknown>; blob(): Promise<Blob> } | undefined>;
  delete(request: string): Promise<boolean>;
}

export interface InboxStorage {
  open(name: string): Promise<InboxCache>;
}

/** What a boot received: files still to meet the form's limits, and sentences for the notice. */
export interface ReceivedShare {
  readonly files: readonly File[];
  /** `Not attached` clauses for files the worker left out at the limits. */
  readonly refused: readonly string[];
  /** Whole sentences: parts of the share that never arrived, or what the reload cost. */
  readonly problems: readonly string[];
  /** Title, text and link, joined; appended to the prompt. */
  readonly text: string;
}

/** The redirect's marker, read before the URL is cleaned: null on a boot that is no share. */
export type ShareMarker = "received" | "unreadable" | null;

export const SHARE_UNREADABLE_TEXT =
  "The share couldn't be read, so nothing from it was attached. Share again, or attach the files from the prompt card.";
export const SHARE_MISSING_TEXT =
  "The share didn't reach the app, so nothing from it was attached. Share again, or attach the files from the prompt card.";

interface Meta {
  readonly at: number;
  readonly files: readonly { readonly n: number; readonly name: string; readonly type: string }[];
  readonly skipped: readonly { readonly name: string; readonly size: number; readonly reason: string }[];
  readonly lost: readonly string[];
  readonly title: string;
  readonly text: string;
  readonly url: string;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Hand-validated: written by whichever worker build took the share. Null on any malformed field. */
function parseMeta(raw: unknown): Meta | null {
  const meta = record(raw);
  if (meta === null) return null;
  const { at, files, skipped, lost, title, text, url } = meta;
  if (!isCount(at) || !Array.isArray(files) || !Array.isArray(skipped) || !Array.isArray(lost)) return null;
  if (!isString(title) || !isString(text) || !isString(url) || !lost.every(isString)) return null;
  const fileList: Meta["files"][number][] = [];
  for (const entry of files) {
    const file = record(entry);
    if (file === null || !isCount(file["n"]) || !isString(file["name"]) || !isString(file["type"])) return null;
    fileList.push({ n: file["n"], name: file["name"], type: file["type"] });
  }
  const skippedList: Meta["skipped"][number][] = [];
  for (const entry of skipped) {
    const file = record(entry);
    if (file === null || !isString(file["name"]) || !isCount(file["size"]) || !isString(file["reason"])) return null;
    skippedList.push({ name: file["name"], size: file["size"], reason: file["reason"] });
  }
  return { at, files: fileList, skipped: skippedList, lost, title, text, url };
}

function skippedText({ name, size, reason }: Meta["skipped"][number]): string | null {
  const shown = attachmentName(name);
  if (reason === "file") return tooLargeText(shown, size);
  if (reason === "count") return tooManyText();
  if (reason === "total") return pastTotalText(shown);
  return null;
}

/**
 * Title, text and link as one block: distinct parts only, and a part already inside
 * another dropped, since Android tends to put the link in `text` as well as `url`.
 */
export function sharedText(title: string, text: string, url: string): string {
  const parts = [title, text, url].map((part) => part.trim()).filter((part) => part !== "");
  // A part inside another goes; of two equal parts, the first stays.
  const kept = parts.filter(
    (part, i) => !parts.some((other, j) => j !== i && other.includes(part) && (other !== part || j < i)),
  );
  return kept.join("\n");
}

function lostText(names: readonly string[]): string {
  const them = names.length === 1 ? "it" : "them";
  return `Not received from the share: ${names.map(attachmentName).join(", ")}; this device's storage refused ${them}. Share again, or attach ${them} from the prompt card.`;
}

/** A boot whose share could not be read at all: the marker alone says one was sent. */
function failedShare(marker: ShareMarker): ReceivedShare | null {
  if (marker === null) return null;
  return {
    files: [],
    refused: [],
    problems: [marker === "unreadable" ? SHARE_UNREADABLE_TEXT : SHARE_MISSING_TEXT],
    text: "",
  };
}

/**
 * The boot's drain, never a throw: with no Cache Storage (a browser without it, an
 * insecure origin) or a failing one, a marked boot still says its share was lost.
 */
export async function receiveOnBoot(
  storage: InboxStorage | undefined,
  marker: ShareMarker,
): Promise<ReceivedShare | null> {
  if (storage === undefined) return failedShare(marker);
  try {
    return await drainShareInbox(storage, marker);
  } catch {
    return failedShare(marker);
  }
}

interface Drained {
  readonly files: readonly File[];
  readonly refused: readonly string[];
  readonly lost: readonly string[];
  readonly text: string;
}

async function drainOne(cache: InboxCache, url: string, meta: Meta): Promise<Drained> {
  const blobs = await Promise.all(
    meta.files.map(({ n }) =>
      cache
        .match(`${url}/${n}`)
        .then((response) => response?.blob())
        .catch(() => undefined),
    ),
  );
  const files: File[] = [];
  const lost = [...meta.lost];
  for (const [i, { name, type }] of meta.files.entries()) {
    const blob = blobs[i];
    if (blob === undefined) lost.push(name);
    else files.push(new File([blob], name, { type }));
  }
  const refused = meta.skipped.map(skippedText).filter((clause) => clause !== null);
  return { files, refused, lost, text: sharedText(meta.title, meta.text, meta.url) };
}

/**
 * Every share waiting in the inbox, oldest first, as one. A drained share's meta entry
 * is deleted, so a reload doesn't repeat it, but not its files: the `File`s handed to
 * the form are backed by them, and whether a deleted entry's blob stays readable is
 * the browser's business. They are swept as orphans by the next drain instead.
 * Null when there was nothing to drain and the boot is no share.
 */
export async function drainShareInbox(storage: InboxStorage, marker: ShareMarker): Promise<ReceivedShare | null> {
  const cache = await storage.open(SHARE_INBOX);
  const metas: string[] = [];
  const metaPaths = new Set<string>();
  const fileEntries: { readonly url: string; readonly metaPath: string }[] = [];
  for (const { url } of await cache.keys()) {
    const path = new URL(url).pathname;
    if (!path.startsWith(SHARE_INBOX_PATH)) continue;
    const slash = path.indexOf("/", SHARE_INBOX_PATH.length);
    if (slash !== -1) {
      fileEntries.push({ url, metaPath: path.slice(0, slash) });
      continue;
    }
    metas.push(url);
    metaPaths.add(path);
  }
  // Files with no meta: a previous drain's, which backed that boot's form, or a share the worker never finished.
  await Promise.all(
    fileEntries.filter((entry) => !metaPaths.has(entry.metaPath)).map((entry) => cache.delete(entry.url)),
  );

  const read = await Promise.all(
    metas.map(async (url) => {
      const meta = await cache
        .match(url)
        .then((response) => response?.json())
        .then(parseMeta, () => null);
      return { url, meta };
    }),
  );
  const ordered = read.toSorted((a, b) => (a.meta?.at ?? 0) - (b.meta?.at ?? 0));
  const drained = await Promise.all(
    ordered.map(async ({ url, meta }) => {
      const one = meta === null ? null : await drainOne(cache, url, meta);
      await cache.delete(url);
      return one;
    }),
  );

  const problems: string[] = [];
  const lost = drained.flatMap((one) => one?.lost ?? []);
  if (lost.length > 0) problems.push(lostText(lost));
  if (marker === "unreadable" || drained.includes(null)) problems.push(SHARE_UNREADABLE_TEXT);
  else if (marker === "received" && drained.length === 0) problems.push(SHARE_MISSING_TEXT);
  if (drained.length === 0 && marker === null) return null;
  return {
    files: drained.flatMap((one) => one?.files ?? []),
    refused: drained.flatMap((one) => one?.refused ?? []),
    problems,
    text: drained
      .map((one) => one?.text ?? "")
      .filter((text) => text !== "")
      .join("\n\n"),
  };
}

/** The marker as the redirect set it; anything else in the query is no share. */
export function shareMarker(search: string): ShareMarker {
  const value = new URLSearchParams(search).get(SHARE_MARKER);
  if (value === null) return null;
  return value === SHARE_UNREADABLE ? "unreadable" : "received";
}

/** What the form held when the document a share replaced went away (persist.ts). */
export interface FormBeforeShare {
  readonly files: number;
  readonly submitting: boolean;
}

/** Sentences for what a share's reload cost: unpersisted files, and a submit cut short. */
export function reloadCostText(before: FormBeforeShare | null): readonly string[] {
  if (before === null) return [];
  const problems: string[] = [];
  if (before.files > 0) {
    const one = before.files === 1;
    const files = one ? "1 file that was" : `${before.files} files that were`;
    problems.push(
      `${files} on the form before the share ${one ? "was" : "were"} removed; add ${one ? "it" : "them"} again.`,
    );
  }
  if (before.submitting) {
    problems.push("A Queue was in progress when the share arrived; check the Queue before queueing again.");
  }
  return problems;
}
