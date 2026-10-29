import { DEP_AFTER, isTaskId, parseTask, TASK_SPEC_LIMITS, TASK_UNTIL, type TaskDep } from "@seance/shared";
import { DEFAULT_FORM, HELD_MAX, isEffort, isModel, type HeldTask, type PersistedForm } from "./state.ts";

/**
 * The form survives a reload because iOS kills backgrounded PWAs freely and the
 * prompt is the one thing here the user wrote.
 *
 * The prompt therefore sits in plaintext localStorage, unlike the PSK. That is a
 * deliberate asymmetry — one message's worth of text on your own phone, versus
 * permanent authority over every machine you own. Held tasks (`HeldTask`) extend
 * it to at most `HELD_MAX` prompts, sealed only when sent: sealing them at rest
 * would stop nobody running code in the app, since the key is usable there.
 */

const FORM_KEY = "seance:form";
const PENDING_KEY = "seance:pending";
const HELD_KEY = "seance:held";
/** Only cleared now — machines are forgotten at the relay, not hidden per browser. */
const HIDDEN_KEY = "seance:hidden";

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage costs a lost draft, not a broken session.
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asDeps(value: unknown): readonly TaskDep[] {
  if (!Array.isArray(value)) return [];
  const deps: TaskDep[] = [];
  for (const entry of value) {
    if (deps.length === TASK_SPEC_LIMITS.deps) break;
    if (typeof entry !== "object" || entry === null) continue;
    const task: unknown = Reflect.get(entry, "task");
    const after = DEP_AFTER.find((when) => when === Reflect.get(entry, "after"));
    if (isTaskId(task) && after !== undefined) deps.push({ task, after });
  }
  return deps;
}

/** Hand-validated rather than trusted: this is last week's build's output. */
export function readForm(): PersistedForm {
  const raw = readJson(FORM_KEY);
  if (typeof raw !== "object" || raw === null) return DEFAULT_FORM;
  const record = raw as Record<string, unknown>;
  return {
    // An older build's open `batch` is dropped: the form no longer authors batches, and a
    // silent one would keep grouping tasks with no tile left to end it.
    // A legacy form's `machineId`, `auto` and `repos` are dropped on purpose: a saved machine
    // pick becomes auto, since a silent pin would make a former direct spawner's next task
    // wait on caps it never chose. Its `autoRepo` is the repo only when `auto` was true: with `auto`
    // false it is a stale leftover from an earlier auto session, and a task queued there is a surprise.
    machine: asString(record["machine"]),
    account: asString(record["account"]),
    repo: asString(record["repo"]) ?? (record["auto"] === true ? asString(record["autoRepo"]) : null),
    prompt: asString(record["prompt"]) ?? "",
    worktree: typeof record["worktree"] === "boolean" ? record["worktree"] : DEFAULT_FORM.worktree,
    model: isModel(record["model"]) ? record["model"] : DEFAULT_FORM.model,
    effort: isEffort(record["effort"]) ? record["effort"] : DEFAULT_FORM.effort,
    after: asDeps(record["after"]),
    until: TASK_UNTIL.find((until) => until === record["until"]) ?? DEFAULT_FORM.until,
  };
}

export function writeForm(form: PersistedForm): void {
  writeJson(FORM_KEY, form);
}

/** Stricter than the form: a held task is sent as it stands, so one this build can't parse is dropped, not sent. */
export function readHeld(): readonly HeldTask[] {
  const raw = readJson(HELD_KEY);
  if (!Array.isArray(raw)) return [];
  const held: HeldTask[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (held.length === HELD_MAX) break;
    if (typeof entry !== "object" || entry === null) continue;
    const task = parseTask(Reflect.get(entry, "task"));
    // Never one with files: those go only to a leader verified to take them, which holding never sees.
    if (task === null || task.state !== "queued" || task.spec.attachments !== undefined || ids.has(task.id)) continue;
    const failure: unknown = Reflect.get(entry, "failure");
    ids.add(task.id);
    held.push({ task, failure: typeof failure === "string" ? failure : null, sending: false });
  }
  return held;
}

/** Written on every change, never debounced: a held task lost to a kill is a task that never runs. */
export function writeHeld(held: readonly HeldTask[]): void {
  writeJson(HELD_KEY, held.length === 0 ? null : held.map(({ task, failure }) => ({ task, failure })));
}

/** No spawn is sent directly any more, so a pending record has nothing left to reconcile; cleared like `dropLegacyHidden`. */
export function dropLegacyPending(): void {
  writeJson(PENDING_KEY, null);
}

/**
 * Machines are removed at the relay now, so nothing local decides what to show.
 * Cleared rather than left behind: a stored list that once meant "don't show
 * these" is the kind of leftover a later reader mistakes for live state.
 */
export function dropLegacyHidden(): void {
  writeJson(HIDDEN_KEY, null);
}

const FORM_FILES_KEY = "seance:form-files";
/** The unload of a document a share replaced and the boot that follows are seconds apart; older facts are a closed document's. */
export const FORM_FILES_FRESH_MS = 60_000;

/** What the form held when the document a share replaced went away. */
export interface FormBeforeShare {
  readonly files: number;
  readonly submitting: boolean;
}

/**
 * How many files the form held and whether a submit was in flight, kept for one reader:
 * a share is a navigation, so it reloads the document and drops both (a `File` can't be
 * persisted), and the boot it lands on says so (share-inbox.ts, `reloadCostText`).
 * Stamped, so that boot can tell a document the share replaced from one closed long ago.
 */
export function writeFormFiles(state: FormBeforeShare, now: number = Date.now()): void {
  writeJson(FORM_FILES_KEY, { ...state, at: now });
}

/** Null when absent, malformed, or older than `FORM_FILES_FRESH_MS`: then no live document was replaced. */
export function readFormFiles(now: number = Date.now()): FormBeforeShare | null {
  const raw = readJson(FORM_FILES_KEY);
  if (typeof raw !== "object" || raw === null) return null;
  const files: unknown = Reflect.get(raw, "files");
  const submitting: unknown = Reflect.get(raw, "submitting");
  const at: unknown = Reflect.get(raw, "at");
  if (typeof files !== "number" || !Number.isSafeInteger(files) || files < 0 || typeof submitting !== "boolean") {
    return null;
  }
  if (typeof at !== "number" || now - at > FORM_FILES_FRESH_MS) return null;
  return { files, submitting };
}

/**
 * Keeps the facts current as the form changes, and restamps them when the page goes
 * away: a share's navigation fires `pagehide` just before the boot that reads them.
 */
export function trackFormFiles(
  source: {
    subscribe(listener: () => void): unknown;
    getState(): { readonly attachments: readonly unknown[]; readonly spawning: boolean };
  },
  onHide: (flush: () => void) => void,
): void {
  let facts: FormBeforeShare = { files: 0, submitting: false };
  writeFormFiles(facts);
  source.subscribe(() => {
    const { attachments, spawning } = source.getState();
    if (attachments.length === facts.files && spawning === facts.submitting) return;
    facts = { files: attachments.length, submitting: spawning };
    writeFormFiles(facts);
  });
  onHide(() => writeFormFiles(facts));
}
