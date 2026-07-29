import { DEFAULT_FORM, isEffort, isModel, type PendingSpawn, type PersistedForm } from "./state.ts";

/**
 * The form survives a reload because iOS kills backgrounded PWAs freely and the
 * prompt is the one thing here the user wrote. The pending spawn survives for
 * the same reason: reconciliation has to work across a kill, not just a
 * background, or it is useless in exactly the case it exists for.
 *
 * The prompt therefore sits in plaintext localStorage, unlike the PSK. That is a
 * deliberate asymmetry — one message's worth of text on your own phone, versus
 * permanent authority over every machine you own.
 */

const FORM_KEY = "seance:form";
const PENDING_KEY = "seance:pending";

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

function asRepoMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter(([, repo]) => typeof repo === "string"));
}

/** Hand-validated rather than trusted: this is last week's build's output. */
export function readForm(): PersistedForm {
  const raw = readJson(FORM_KEY);
  if (typeof raw !== "object" || raw === null) return DEFAULT_FORM;
  const record = raw as Record<string, unknown>;
  return {
    machineId: asString(record["machineId"]),
    repos: asRepoMap(record["repos"]),
    prompt: asString(record["prompt"]) ?? "",
    worktree: typeof record["worktree"] === "boolean" ? record["worktree"] : DEFAULT_FORM.worktree,
    model: isModel(record["model"]) ? record["model"] : DEFAULT_FORM.model,
    effort: isEffort(record["effort"]) ? record["effort"] : DEFAULT_FORM.effort,
  };
}

export function writeForm(form: PersistedForm): void {
  writeJson(FORM_KEY, form);
}

export function readPending(): PendingSpawn | null {
  const raw = readJson(PENDING_KEY);
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const machineId = asString(record["machineId"]);
  const repo = asString(record["repo"]);
  const requestedAt = record["requestedAt"];
  if (machineId === null || repo === null || typeof requestedAt !== "number") return null;
  return { machineId, repo, requestedAt };
}

export function writePending(pending: PendingSpawn | null): void {
  writeJson(PENDING_KEY, pending);
}
