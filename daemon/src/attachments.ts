import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTACHMENT_FETCH_DEADLINE_MS,
  ATTACHMENT_OVERHEAD_BYTES,
  ATTACHMENT_RETENTION_MS,
  attachmentHash,
  attachmentUrl,
  isRecord,
  isTaskId,
  openAttachment,
  type AttachmentRef,
} from "@seance/shared";
import type { ReapAudit } from "./audit.ts";
import type { SessionAttachments } from "./backend.ts";
import type { TaskAttachments } from "./handlers.ts";
import { canonical } from "./gitdir.ts";
import { stateDir } from "./paths.ts";
import type { Fetch } from "./seams.ts";
import type { PaneInfo } from "./sessions.ts";

/**
 * Extension by MIME type, so Claude's Read tool picks its image and PDF handling; an
 * unmapped type gets none. Fixed here, never from the manifest's name: a file lands as
 * `<index>.<ext>`, so none can be a `CLAUDE.md`, a `.claude/` path or carry a separator.
 */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "js",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/x-yaml": "yaml",
  "application/yaml": "yaml",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** Staging directories a crashed fetch left; past this none is still being written. */
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const SIDECAR_VERSION = 1;

/** 0700 like `runDir()`: `stateDir()` is 0755, and these are the user's files. */
export function attachmentsRoot(): string {
  return join(stateDir(), "attachments");
}

/** Every refusal of a fetch; its message names a file by index, never by name. */
export class AttachmentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUnavailable";
  }
}

export interface AttachmentSource {
  /** The daemon config's own `relayUrl`: the only origin a file is fetched from. */
  readonly relayUrl: string;
  readonly bearerToken: string;
  readonly key: CryptoKey;
  readonly fetch?: Fetch;
  readonly deadlineMs?: number;
  /** `attachmentsRoot()` in production; a test's own directory otherwise. */
  readonly root: string;
  readonly now?: () => number;
}

class Retryable extends Error {}

async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // mkdir's mode is umask-filtered and ignored for a directory already there.
  await chmod(root, 0o700);
}

/** The body up to `expected` bytes and no further: a longer one is refused, not truncated. */
async function readExactly(res: Response, expected: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(expected);
  let filled = 0;
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk
      const { done, value } = await reader.read();
      if (done) break;
      if (filled + value.byteLength > expected) throw new Error("body longer than its length");
      out.set(value, filled);
      filled += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (filled !== expected) throw new Retryable(`body ended at ${filled} of ${expected} bytes`);
  return out;
}

async function download(
  source: AttachmentSource,
  ref: AttachmentRef,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const expected = ref.size + ATTACHMENT_OVERHEAD_BYTES;
  let res: Response;
  try {
    res = await (source.fetch ?? fetch)(attachmentUrl(source.relayUrl, ref.id), {
      headers: { authorization: `Bearer ${source.bearerToken}` },
      redirect: "error",
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new AttachmentUnavailable("deadline passed");
    throw new Retryable(`fetch failed: ${String(err)}`);
  }
  if (res.status >= 500) {
    await res.body?.cancel();
    throw new Retryable(`relay answered ${res.status}`);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new AttachmentUnavailable(
      res.status === 404 ? "not found (expired or never stored)" : `relay answered ${res.status}`,
    );
  }
  if (res.headers.get("content-length") !== String(expected)) {
    await res.body?.cancel();
    throw new AttachmentUnavailable(`wrong length (${res.headers.get("content-length") ?? "none"}, not ${expected})`);
  }
  try {
    return await readExactly(res, expected);
  } catch (err) {
    if (signal.aborted) throw new AttachmentUnavailable("deadline passed");
    if (err instanceof Retryable) throw err;
    throw new AttachmentUnavailable(err instanceof Error ? err.message : String(err));
  }
}

async function fetchOne(source: AttachmentSource, ref: AttachmentRef, signal: AbortSignal): Promise<Uint8Array> {
  let object: Uint8Array<ArrayBuffer>;
  try {
    object = await download(source, ref, signal);
  } catch (err) {
    if (!(err instanceof Retryable)) throw err;
    if (signal.aborted) throw new AttachmentUnavailable("deadline passed");
    try {
      object = await download(source, ref, signal);
    } catch (again) {
      throw again instanceof Retryable ? new AttachmentUnavailable(again.message) : again;
    }
  }
  if ((await attachmentHash(object)) !== ref.hash) throw new AttachmentUnavailable("hash mismatch");
  let plain: Uint8Array;
  try {
    plain = await openAttachment(source.key, ref.id, object);
  } catch {
    throw new AttachmentUnavailable("did not decrypt");
  }
  if (plain.byteLength !== ref.size) throw new AttachmentUnavailable("wrong size after decryption");
  return plain;
}

function sidecarPath(root: string, taskId: string): string {
  return join(root, `${taskId}.json`);
}

/**
 * Downloads, verifies and decrypts `refs` into `root/<taskId>`, replacing any directory a
 * launch that never landed left there, and returns what the session is handed. Sequential,
 * under one deadline for all files. Throws `AttachmentUnavailable` and leaves nothing behind.
 */
export async function fetchAttachments(
  source: AttachmentSource,
  taskId: string,
  refs: readonly AttachmentRef[],
): Promise<SessionAttachments> {
  // The task id names a directory: `isSpawnRequest` already held it to `isTaskId`, this says so here too.
  if (!isTaskId(taskId)) throw new AttachmentUnavailable("no task id to file them under");
  const { root } = source;
  await ensureRoot(root);
  const final = join(root, taskId);
  const staging = join(root, `.${taskId}.${crypto.randomUUID()}`);
  const signal = AbortSignal.timeout(source.deadlineMs ?? ATTACHMENT_FETCH_DEADLINE_MS);
  try {
    await mkdir(staging, { mode: 0o700 });
    const names: string[] = [];
    for (const [index, ref] of refs.entries()) {
      let plain: Uint8Array;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time, under one deadline
        plain = await fetchOne(source, ref, signal);
      } catch (err) {
        const why = err instanceof AttachmentUnavailable ? err.message : String(err);
        throw new AttachmentUnavailable(`attachment ${index + 1} of ${refs.length}: ${why}`);
      }
      const ext = ATTACHMENT_EXTENSIONS[ref.type];
      const name = ext === undefined ? `${index + 1}` : `${index + 1}.${ext}`;
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(join(staging, name), plain, { mode: 0o600, flag: "wx" });
      names.push(name);
    }
    if (signal.aborted) throw new AttachmentUnavailable("deadline passed before the files were in place");
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    await writeSidecar(root, taskId, { v: SIDECAR_VERSION, at: (source.now ?? Date.now)() });
    return {
      dirs: [final],
      files: refs.map((ref, index) => ({
        path: join(final, names[index] ?? ""),
        name: ref.name,
        type: ref.type,
        size: ref.size,
      })),
    };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    await rm(final, { recursive: true, force: true });
    await rm(sidecarPath(root, taskId), { force: true });
    if (err instanceof AttachmentUnavailable) throw err;
    throw new AttachmentUnavailable(`could not write them: ${String(err)}`);
  }
}

interface Sidecar {
  readonly v: number;
  /** When the files were fetched. */
  readonly at: number;
  /** The worktree the task's session landed in; absent for here mode, or until it landed. */
  readonly worktree?: string;
}

async function writeSidecar(root: string, taskId: string, sidecar: Sidecar): Promise<void> {
  const path = sidecarPath(root, taskId);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(sidecar), { mode: 0o600 });
  await rename(temp, path);
}

async function readSidecar(root: string, taskId: string): Promise<Sidecar | null> {
  try {
    const value: unknown = JSON.parse(await Bun.file(sidecarPath(root, taskId)).text());
    if (!isRecord(value) || value["v"] !== SIDECAR_VERSION || typeof value["at"] !== "number") return null;
    const worktree = value["worktree"];
    return {
      v: SIDECAR_VERSION,
      at: value["at"],
      ...(typeof worktree === "string" ? { worktree } : {}),
    };
  } catch {
    return null;
  }
}

/** Notes the worktree a task's session landed in, for cleanup and continuations. Best effort. */
export async function noteAttachmentsWorktree(root: string, taskId: string, worktree: string): Promise<void> {
  const sidecar = await readSidecar(root, taskId);
  if (sidecar === null) return;
  await writeSidecar(root, taskId, { ...sidecar, worktree });
}

/** Task ids holding a fetched directory under `root`, from the listing alone. */
async function taskDirs(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && isTaskId(entry.name)).map((entry) => entry.name);
}

/**
 * Every task's directory whose sidecar names `worktree`: a continuation's `--add-dir`s,
 * a chain of them included, since they share the worktree. None is no refusal.
 */
export async function attachmentDirsFor(root: string, worktree: string): Promise<readonly string[]> {
  const found = await Promise.all(
    (await taskDirs(root)).map(async (taskId) =>
      (await readSidecar(root, taskId))?.worktree === worktree ? join(root, taskId) : null,
    ),
  );
  return found.filter((dir) => dir !== null).toSorted();
}

export type AttachmentPruneReason = "worktree-gone" | "aged" | "staging";

export interface PrunedAttachments {
  /** The task id, or for `staging` the staging directory's name. */
  readonly task: string;
  readonly reason: AttachmentPruneReason;
}

export interface PruneAttachmentsOptions {
  readonly root: string;
  readonly now: number;
  readonly dryRun: boolean;
  readonly audit: ReapAudit;
  /** Read after the worktree pass, so a worktree that pass removed reads gone. */
  readonly panes: readonly PaneInfo[];
  readonly retentionMs?: number;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const mtimeOf = (path: string): Promise<number | null> =>
  stat(path).then(
    (info) => info.mtimeMs,
    () => null,
  );

function inside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Reap's attachment pass: a task's directory goes once the worktree its session ran in is
 * gone, or once it is older than the bucket keeps the object and no live pane carries the
 * task or sits in its worktree — the rule that covers here-mode tasks. Staging a crashed
 * fetch left goes after an hour. Each removal is audited; a dry run only lists.
 */
export async function pruneAttachments(opts: PruneAttachmentsOptions): Promise<readonly PrunedAttachments[]> {
  const { root, now } = opts;
  const retention = opts.retentionMs ?? ATTACHMENT_RETENTION_MS;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const live = opts.panes.filter((pane) => !pane.dead);
  const liveDirs = await Promise.all(live.map((pane) => canonical(pane.path)));

  const judge = async (name: string): Promise<AttachmentPruneReason | null> => {
    const dir = join(root, name);
    if (name.startsWith(".")) {
      const mtime = await mtimeOf(dir);
      return mtime !== null && now - mtime > STAGING_MAX_AGE_MS ? "staging" : null;
    }
    const sidecar = await readSidecar(root, name);
    const worktree = sidecar?.worktree;
    if (worktree !== undefined && !(await exists(worktree))) return "worktree-gone";
    const at = sidecar?.at ?? (await mtimeOf(dir));
    if (at === null || now - at <= retention) return null;
    const held =
      live.some((pane) => pane.taskId === name) ||
      (worktree !== undefined && liveDirs.some((path) => inside(worktree, path)));
    return held ? null : "aged";
  };

  const names = entries
    .filter((entry) => entry.isDirectory() && (entry.name.startsWith(".") || isTaskId(entry.name)))
    .map((entry) => entry.name);
  const verdicts = await Promise.all(names.map(async (task) => ({ task, reason: await judge(task) })));
  const doomed = verdicts.filter((verdict): verdict is PrunedAttachments => verdict.reason !== null);
  if (opts.dryRun) return doomed;
  for (const { task, reason } of doomed) {
    // The directory before its sidecar: a sidecar alone is harmless, a directory alone would be judged by mtime.
    // oxlint-disable-next-line no-await-in-loop -- one line per removal, in order, after it happened
    await rm(join(root, task), { recursive: true, force: true });
    // oxlint-disable-next-line no-await-in-loop
    if (reason !== "staging") await rm(sidecarPath(root, task), { force: true });
    // oxlint-disable-next-line no-await-in-loop
    await opts.audit.removedAttachments(task, reason);
  }
  return doomed;
}

/** The handlers' view, bound to the daemon's own origin, token and key: no frame names any of them. */
export function taskAttachments(source: AttachmentSource): TaskAttachments {
  return {
    fetch: (taskId, refs) => fetchAttachments(source, taskId, refs),
    landed: (taskId, worktree) => noteAttachmentsWorktree(source.root, taskId, worktree),
    dirsFor: (worktree) => attachmentDirsFor(source.root, worktree),
  };
}
