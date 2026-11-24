// Séance's Claude settings hooks: one command per `SETTINGS_HOOK_EVENTS` event in each config dir's `settings.json`,
// running this checkout's `seance session-event --hook` (DESIGN.md, "Settings hooks"). Written by `seance mod install`
// beside the mods, removed by `uninstall`, checked by doctor. Claude's own CLI has no verb for a hook, so this is the
// one place séance writes a Claude settings file itself: it touches only entries whose command is ours, and leaves a
// file it cannot read as JSON alone.

import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@seance/shared";
import type { Check } from "./check.ts";
import { writeDurable } from "./durable-write.ts";
import type { ClaudeConfigTarget } from "./exclaves.ts";
import { SETTINGS_HOOK_EVENTS } from "./session-event-frame.ts";
import { shq } from "./shq.ts";

/** Seconds, as Claude reads a hook's `timeout`: past the CLI's own 2 s exchange, so Claude never kills it first. */
const HOOK_TIMEOUT_S = 5;

const SUFFIX = " session-event --hook";

/**
 * The hook command for the checkout at `root`: bun by bare name (resolved at use, never a recorded path) running this
 * checkout's CLI by path, as the mod does — the PATH link is opt-in and nothing re-points it on a pull.
 */
export function hookCommand(root: string): string {
  return `bun ${shq(join(root, "daemon", "src", "main.ts"))}${SUFFIX}`;
}

/** Any checkout's: what install replaces and uninstall removes, so a moved or re-cloned checkout leaves no stale entry. */
function isOurs(command: unknown): boolean {
  return typeof command === "string" && command.startsWith("bun ") && command.endsWith(`/daemon/src/main.ts'${SUFFIX}`);
}

type Settings = Record<string, unknown>;

/** `hooks[event]` with every group's commands of ours dropped, and a group left with none dropped whole. */
function withoutOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    if (!isRecord(group) || !Array.isArray(group["hooks"])) return [group];
    const kept = group["hooks"].filter((hook: unknown) => !isRecord(hook) || !isOurs(hook["command"]));
    if (kept.length === group["hooks"].length) return [group];
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
}

/**
 * `settings` without séance's hooks, then with one group per event running `command` when it is given (exported for
 * tests). Everything else in the file, the person's own hooks included, is kept as it was.
 */
export function withSeanceHooks(settings: Settings, command: string | null): Settings {
  const current = settings["hooks"];
  if (current !== undefined && !isRecord(current)) throw new Error("its `hooks` is not an object — left it untouched");
  const hooks: Record<string, unknown> = { ...current };
  for (const event of SETTINGS_HOOK_EVENTS) {
    const kept = withoutOurs(hooks[event]);
    const groups =
      command === null ? kept : [...kept, { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }];
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  const { hooks: _old, ...rest } = settings;
  if (Object.keys(hooks).length === 0) return rest;
  // Keep `hooks` where it stood, so a round trip leaves the person's file as it was, key order included.
  if (current === undefined) return { ...rest, hooks };
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, key === "hooks" ? hooks : value]));
}

/** Each event's commands of ours, as `settings` holds them (exported for tests). */
export function seanceHooksIn(settings: Settings): ReadonlyMap<string, readonly string[]> {
  const hooks = isRecord(settings["hooks"]) ? settings["hooks"] : {};
  const found = new Map<string, string[]>();
  for (const event of SETTINGS_HOOK_EVENTS) {
    const groups = hooks[event];
    const commands = (Array.isArray(groups) ? groups : [])
      .flatMap((group: unknown) => (isRecord(group) && Array.isArray(group["hooks"]) ? group["hooks"] : []))
      .flatMap((hook: unknown) => (isRecord(hook) && isOurs(hook["command"]) ? [String(hook["command"])] : []));
    found.set(event, commands);
  }
  return found;
}

function settingsPath(target: ClaudeConfigTarget): string {
  return join(target.configDir, "settings.json");
}

/** The file as an object, `{}` when there is none; a throw for one that is not a JSON object, which is never written. */
async function readSettings(path: string): Promise<{ readonly settings: Settings; readonly mode: number | null }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { settings: {}, mode: null };
  const parsed: unknown = JSON.parse(await file.text());
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object — left it untouched`);
  return { settings: parsed, mode: (await stat(path)).mode & 0o777 };
}

/** `readSettings` with its failure named for the install or uninstall line that reports it. */
function readForEdit(path: string): Promise<{ readonly settings: Settings; readonly mode: number | null }> {
  return readSettings(path).catch((err: unknown) => {
    throw new Error(`settings hooks: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Writes `next` over `path` only when it differs: a re-run that changes nothing leaves the file as it is. Through a
 * symlink to its target, since the rename would otherwise replace a dotfiles repo's link with a plain file.
 */
async function rewrite(path: string, before: Settings, next: Settings, mode: number | null): Promise<boolean> {
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  const target = await realpath(path).catch(() => path);
  await writeDurable(target, `${JSON.stringify(next, null, 2)}\n`, mode ?? 0o600);
  return true;
}

/** Install's step for one config dir: séance's hooks, pointed at the checkout at `root`. */
export async function installSettingsHooks(target: ClaudeConfigTarget, root: string): Promise<string> {
  const path = settingsPath(target);
  const { settings, mode } = await readForEdit(path);
  const changed = await rewrite(path, settings, withSeanceHooks(settings, hookCommand(root)), mode);
  return changed ? `séance's settings hooks written to ${path}` : `séance's settings hooks already in ${path}`;
}

/** Uninstall's step for one config dir. */
export async function uninstallSettingsHooks(target: ClaudeConfigTarget): Promise<string> {
  const path = settingsPath(target);
  const { settings, mode } = await readForEdit(path);
  const changed = await rewrite(path, settings, withSeanceHooks(settings, null), mode);
  return changed ? `removed séance's settings hooks from ${path}` : `no séance settings hooks in ${path}`;
}

/** Doctor's line for one config dir (exported for tests): every event carrying exactly this checkout's command. */
export function settingsHooksCheck(settings: Settings | null, root: string, label: string): Check {
  if (settings === null) {
    return { level: "warn", message: `${label}: settings.json is not a JSON object — séance's settings hooks unread` };
  }
  const want = hookCommand(root);
  const found = seanceHooksIn(settings);
  const missing = [...found].filter(([, commands]) => commands.length === 0).map(([event]) => event);
  if (missing.length > 0) {
    return {
      level: "warn",
      message: `séance's settings hooks missing in ${label} (${missing.join(", ")}) — run \`seance mod install\``,
    };
  }
  const stale = [...found.values()].some((commands) => commands.some((command) => command !== want));
  if (stale) {
    return {
      level: "warn",
      message: `séance's settings hooks in ${label} name another checkout's CLI — \`seance mod install\` repoints them`,
    };
  }
  return { level: "ok", message: `séance's settings hooks installed in ${label}` };
}

export async function settingsHooksChecks(targets: readonly ClaudeConfigTarget[], root: string): Promise<Check[]> {
  return Promise.all(
    targets.map(async (target) => {
      const settings = await readSettings(settingsPath(target)).then(
        (read) => read.settings,
        () => null,
      );
      return settingsHooksCheck(settings, root, target.label);
    }),
  );
}
