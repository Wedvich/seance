import { DEP_AFTER, isTaskId, parseTask, TASK_SPEC_LIMITS, TASK_UNTIL, type TaskDep } from "@seance/shared";
import {
  DEFAULT_FORM,
  HELD_MAX,
  isEffort,
  isModel,
  type HeldTask,
  type OpenBatch,
  type PersistedForm,
} from "./state.ts";

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

function isAutoStrategy(strategy: unknown): boolean {
  if (strategy === "auto") return true;
  return typeof strategy === "object" && strategy !== null && Reflect.get(strategy, "mode") === "auto";
}

/**
 * An older build's open batch also held a `strategy`. `auto` (or none) is a plain group and stays open;
 * a sequential or parallel one is dropped, since further enqueues would join it with no order or bound.
 */
function asBatch(value: unknown): OpenBatch | null {
  if (typeof value !== "object" || value === null) return null;
  const id: unknown = Reflect.get(value, "id");
  const next: unknown = Reflect.get(value, "next");
  if (!isTaskId(id)) return null;
  const strategy: unknown = Reflect.get(value, "strategy");
  if (strategy !== undefined && !isAutoStrategy(strategy)) return null;
  // One past the bound is a full batch: the last member took `batchIndex`, and the form says so instead of forgetting it.
  if (typeof next !== "number" || !Number.isInteger(next) || next < 1 || next > TASK_SPEC_LIMITS.batchIndex + 1)
    return null;
  return { id, next };
}

/** Hand-validated rather than trusted: this is last week's build's output. */
export function readForm(): PersistedForm {
  const raw = readJson(FORM_KEY);
  if (typeof raw !== "object" || raw === null) return DEFAULT_FORM;
  const record = raw as Record<string, unknown>;
  return {
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
    batch: asBatch(record["batch"]),
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
