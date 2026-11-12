import type { RelayClient } from "@seance/shared";
import { uploadFailureShort, uploadRefusalText, type PickedFile, type UploadState } from "./attachments.ts";
import { attachmentsBlock, attachmentsWithdrawn, deriveAttachmentsAvailability, type AppState } from "./view.ts";

/**
 * How long a Queue press sits on a leader that can't be checked for now (a dropped socket, a
 * re-dial, a proof not yet in) before it gives up. Counted only while nothing is uploading: an
 * upload in flight is its own wait. Past a re-dial's settle window on purpose: the press was made
 * while connected, so a socket that takes a few seconds to come back is still worth waiting for.
 */
export const VERIFY_WAIT_MS = 10_000;

/** A refusal every later file would meet too, so the next one isn't sent into it. */
type Halt = "allowance_exhausted" | "unauthorized" | "unreachable";

function isHalt(code: string): code is Halt {
  return code === "allowance_exhausted" || code === "unauthorized" || code === "unreachable";
}

/**
 * The form's uploads, apart from `Store` (DESIGN.md, "The PWA: upload at pick"): sends waiting
 * files one at a time, in list order, while attaching is offered. Each holds its file and the
 * sealed copy in memory, and the phone's uplink is the bottleneck, so parallel uploads would not
 * finish the set sooner. Where each file stands lives in the `AppState` `Store` holds
 * (`attachments`), read and patched through the constructor's two seams; `Store` owns the list
 * itself (admit, remove) and tells this class when it changed.
 */
export class UploadQueue {
  readonly #client: RelayClient;
  readonly #getState: () => AppState;
  readonly #patch: (next: Partial<AppState>) => void;
  /** The abort handle of each upload in flight, by file key: removing the file cuts it off. */
  readonly #aborts = new Map<string, AbortController>();
  /** Checked and set synchronously, so a file added as an upload ends is never missed. */
  #inFlight = false;
  /**
   * Why nothing more is started. A failed chip is the only sign of it, so it stands only while one
   * is listed: a Queue press, a pick or removing the last failed file lifts it, and a reopened
   * socket lifts `unreachable`.
   */
  #halted: Halt | null = null;
  /** Queue presses waiting for the uploads to settle (`settle`). */
  #waiters: (() => void)[] = [];
  #verifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wait on an uncheckable leader ran out: the waiters are let go as they stand. */
  #verifySpent = false;

  constructor(client: RelayClient, getState: () => AppState, patch: (next: Partial<AppState>) => void) {
    this.#client = client;
    this.#getState = getState;
    this.#patch = patch;
  }

  /**
   * The relay state moved. Files admitted while attaching wasn't offered (a share at boot, a pick
   * in a re-dial) start once it is. An upload is its own HTTP request, so a dropped socket doesn't
   * cut it; one going while a verified leader stops taking files is cut: its object may land, but
   * no create follows.
   */
  onRelay(socketBack: boolean): void {
    if (attachmentsWithdrawn(this.#getState().relay))
      for (const controller of this.#aborts.values()) controller.abort();
    if (socketBack) {
      // The network that failed an upload is likely back with the socket. The file that met it goes
      // again with the rest: left failed, only a Queue press would send it, and that also queues.
      if (this.#halted === "unreachable") this.#halted = null;
      this.#requeue((code) => code === "unreachable");
    }
    this.#pump();
  }

  /** Files were admitted: a new pick is a reason to try again. */
  onAdded(): void {
    this.#halted = null;
    this.#pump();
  }

  /** `key` left the list: its upload, if in flight, is cut off. */
  onRemoved(key: string): void {
    this.#aborts.get(key)?.abort();
    // With no failed chip left nothing on the form says why the rest wait, so they go.
    if (!this.#getState().attachments.some((f) => f.upload.kind === "failed")) this.#halted = null;
    this.#pump();
  }

  /**
   * A Queue press: failed files go again under fresh ids, and the promise resolves once nothing
   * is uploading and nothing more can start. A leader that can't be checked for now is waited on
   * for `VERIFY_WAIT_MS` rather than read as a refusal (only a verified leader lacking
   * attachments ends it at once), also when every file is stored: the create needs the same
   * leader. The caller reads the outcome off the list.
   */
  settle(): Promise<void> {
    this.#halted = null;
    this.#requeue(() => true);
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      this.#pump();
    });
  }

  dispose(): void {
    this.#disarm();
  }

  #pump(): void {
    if (this.#inFlight) return;
    const { relay, attachments } = this.#getState();
    const offered = deriveAttachmentsAvailability(relay);
    const next = offered && this.#halted === null ? attachments.find((f) => f.upload.kind === "waiting") : undefined;
    if (next === undefined) {
      this.#wake(attachments.length > 0 && !offered && attachmentsBlock(relay) !== "unavailable");
      return;
    }
    this.#disarm();
    this.#inFlight = true;
    void this.#uploadOne(next).finally(() => {
      this.#inFlight = false;
      this.#pump();
    });
  }

  /** Lets the waiting presses go, unless the leader is only `unchecked` for now and the wait on it hasn't run out. */
  #wake(unchecked: boolean): void {
    if (this.#waiters.length === 0) {
      this.#disarm();
      return;
    }
    if (unchecked && !this.#verifySpent) {
      this.#verifyTimer ??= setTimeout(() => {
        this.#verifyTimer = null;
        this.#verifySpent = true;
        this.#pump();
      }, VERIFY_WAIT_MS);
      return;
    }
    this.#disarm();
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }

  #disarm(): void {
    if (this.#verifyTimer !== null) clearTimeout(this.#verifyTimer);
    this.#verifyTimer = null;
    this.#verifySpent = false;
  }

  /** Puts failed files whose code `again` accepts back in line. */
  #requeue(again: (code: string) => boolean): void {
    const retried = (f: PickedFile): boolean => f.upload.kind === "failed" && again(f.upload.code);
    const { attachments } = this.#getState();
    if (attachments.some(retried)) this.#patch({ attachments: withUpload(attachments, retried, { kind: "waiting" }) });
  }

  /** Seals and uploads one file, recording where it got; a removed file's outcome is dropped. Never rejects. */
  async #uploadOne(picked: PickedFile): Promise<void> {
    const { key } = picked;
    const controller = new AbortController();
    this.#aborts.set(key, controller);
    this.#set(key, { kind: "uploading", percent: 0 });
    try {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = new Uint8Array(await picked.file.arrayBuffer());
      } catch {
        this.#set(key, {
          kind: "failed",
          code: "unread",
          short: "couldn't read the file",
          message:
            "Couldn't read a file from this device. Remove the one marked failed and attach it again. Nothing was queued.",
        });
        return;
      }
      const reply = await this.#client.uploadAttachment(bytes, {
        signal: controller.signal,
        // Short of 100 until the relay answers `201`: the last byte sent is not a stored file.
        onProgress: (sent, total) =>
          this.#set(key, {
            kind: "uploading",
            percent: total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0,
          }),
      });
      if (reply.ok) this.#set(key, { kind: "stored", id: reply.id, hash: reply.hash });
      // A removed file's outcome is dropped by #set; one still on the form goes back in line.
      else if (reply.code === "aborted") this.#set(key, { kind: "waiting" });
      else {
        if (isHalt(reply.code)) this.#halted = reply.code;
        this.#set(key, {
          kind: "failed",
          code: reply.code,
          short: uploadFailureShort(reply),
          message: uploadRefusalText(reply),
        });
      }
    } catch (err) {
      this.#set(key, {
        kind: "failed",
        code: "threw",
        short: "upload failed",
        message: `Couldn't upload a file (${String(err)}). Nothing was queued.`,
      });
    } finally {
      this.#aborts.delete(key);
    }
  }

  /** Patches one file's upload state; nothing for a file since removed, or a percent that didn't move. */
  #set(key: string, upload: UploadState): void {
    const { attachments } = this.#getState();
    const current = attachments.find((f) => f.key === key);
    if (current === undefined) return;
    if (upload.kind === "uploading" && current.upload.kind === "uploading" && current.upload.percent === upload.percent)
      return;
    this.#patch({ attachments: withUpload(attachments, (f) => f.key === key, upload) });
  }
}

/** `files` with `upload` set on those `pick` accepts; the rest are the same objects, so their chips don't re-render. */
function withUpload(
  files: readonly PickedFile[],
  pick: (file: PickedFile) => boolean,
  upload: UploadState,
): readonly PickedFile[] {
  return files.map((f) => (pick(f) ? { ...f, upload } : f));
}
