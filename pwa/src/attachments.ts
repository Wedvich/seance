import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_NAME_FORBIDDEN,
  ATTACHMENT_TYPE_PATTERN,
  type AttachmentRefusal,
  type AttachmentRef,
} from "@seance/shared";

/**
 * A file on the form (DESIGN.md, "Attachments", The PWA). `name` and `type` are
 * what the manifest will carry, normalised once at pick time so the list shows
 * what the session gets. `stored` is set by a `201` and kept for the compose
 * session, so a retry uploads only the rest.
 */
export interface PickedFile {
  /** Local only: the list's key and the remove handle; never sent. */
  readonly key: string;
  readonly file: Blob;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly stored: { readonly id: string; readonly hash: string } | null;
}

const FALLBACK_TYPE = "application/octet-stream";

/** `File.type` lowercased without parameters, or octet-stream when empty or outside the manifest's pattern. */
export function attachmentType(raw: string): string {
  const bare = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return bare.length <= ATTACHMENT_LIMITS.type && ATTACHMENT_TYPE_PATTERN.test(bare) ? bare : FALLBACK_TYPE;
}

/**
 * A name the manifest admits: control characters become `_`, and one past the bound
 * is cut in the stem, so the extension (what the session reads the kind from) stays.
 */
export function attachmentName(raw: string): string {
  const clean = [...raw].map((ch) => (ATTACHMENT_NAME_FORBIDDEN.test(ch) ? "_" : ch)).join("");
  const name = clean.trim() === "" ? "file" : clean;
  const max = ATTACHMENT_LIMITS.name;
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  // An "extension" as long as the bound is no extension: cut the whole name.
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  return cutUnits(name.slice(0, name.length - ext.length), max - ext.length) + ext;
}

/** At most `max` UTF-16 units, never splitting a surrogate pair. */
function cutUnits(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const MB = 1024 * 1024;

/** Coarse on purpose: a phone screen, and the limits are whole MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / MB;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Adds what fits the limits, in order, and says why the rest didn't. A file over
 * the per-file bound is skipped and the next still tried; once the count or total
 * is reached, nothing after it is.
 */
export function admitFiles(
  current: readonly PickedFile[],
  incoming: readonly File[],
  mintKey: () => string = () => crypto.randomUUID(),
): { readonly files: readonly PickedFile[]; readonly notice: string | null } {
  const files = [...current];
  const refused: string[] = [];
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of incoming) {
    const name = attachmentName(file.name);
    if (file.size > ATTACHMENT_LIMITS.fileBytes) {
      refused.push(
        `${name} is ${formatBytes(file.size)}; a file can be at most ${formatBytes(ATTACHMENT_LIMITS.fileBytes)}`,
      );
      continue;
    }
    if (files.length >= ATTACHMENT_LIMITS.files) {
      refused.push(`a task takes at most ${ATTACHMENT_LIMITS.files} files`);
      break;
    }
    if (total + file.size > ATTACHMENT_LIMITS.totalBytes) {
      refused.push(`${name} would take the task past ${formatBytes(ATTACHMENT_LIMITS.totalBytes)} in all`);
      continue;
    }
    total += file.size;
    files.push({ key: mintKey(), file, name, type: attachmentType(file.type), size: file.size, stored: null });
  }
  if (refused.length === 0) return { files, notice: null };
  return { files, notice: `Not attached: ${refused.join("; ")}.` };
}

/** The manifest once every file is stored; null while any is not. */
export function manifestOf(files: readonly PickedFile[]): readonly AttachmentRef[] | null {
  const refs: AttachmentRef[] = [];
  for (const { name, type, size, stored } of files) {
    if (stored === null) return null;
    refs.push({ id: stored.id, name, type, size, hash: stored.hash });
  }
  return refs;
}

function waitText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "a minute";
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** Why `name` was not stored, as a sentence. Always ends by saying nothing was queued. */
export function uploadRefusalText(name: string, refusal: AttachmentRefusal): string {
  const tail = " Nothing was queued; files already uploaded aren't sent again.";
  switch (refusal.code) {
    case "allowance_exhausted":
      return `Upload limit reached: the relay's ${refusal.window === "hour" ? "hourly" : "30-day"} allowance is spent. Try again in ${waitText(refusal.retryAfter)}.${tail}`;
    case "unauthorized":
      return `The relay refused the bearer token for the upload of ${name}. Check it in Settings.${tail}`;
    case "unreachable":
      return `Couldn't reach the relay to upload ${name}. Check the connection and try again.${tail}`;
    case "storage_error":
      return `The relay's storage failed while uploading ${name}. Try again.${tail}`;
    case "exists":
      return `The relay already held an upload under ${name}'s new id. Try again: it gets another.${tail}`;
    default:
      return `The relay refused the upload of ${name} (${refusal.code}). Update the app and the relay to matching versions.${tail}`;
  }
}
