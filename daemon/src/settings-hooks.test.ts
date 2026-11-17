import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@seance/shared";
import type { ClaudeConfigTarget } from "./exclaves.ts";
import { SETTINGS_HOOK_EVENTS } from "./session-event-frame.ts";
import {
  hookCommand,
  installSettingsHooks,
  settingsHooksCheck,
  settingsHooksChecks,
  uninstallSettingsHooks,
  withSeanceHooks,
} from "./settings-hooks.ts";

const OURS = hookCommand("/src/seance");
const THEIRS = { matcher: "", hooks: [{ type: "command", command: "say done" }] };

describe("withSeanceHooks", () => {
  test("adds one group per event and keeps the person's own hooks and settings beside it", () => {
    const next = withSeanceHooks({ model: "opus", hooks: { Stop: [THEIRS], PreToolUse: [THEIRS] } }, OURS);
    expect(next["model"]).toBe("opus");
    const hooks = next["hooks"];
    if (!isRecord(hooks)) throw new Error("no hooks object");
    expect(Object.keys(hooks).toSorted()).toEqual([...SETTINGS_HOOK_EVENTS, "PreToolUse"].toSorted());
    expect(hooks["Stop"]).toEqual([THEIRS, { hooks: [{ type: "command", command: OURS, timeout: 5 }] }]);
  });

  test("a re-install changes nothing; another checkout's command is replaced, not doubled", () => {
    const once = withSeanceHooks({}, OURS);
    expect(withSeanceHooks(once, OURS)).toEqual(once);
    const moved = withSeanceHooks(withSeanceHooks({}, hookCommand("/old/clone")), OURS);
    expect(moved).toEqual(once);
  });

  test("removal takes only ours: a shared group keeps the person's command, an emptied hooks key goes", () => {
    const shared = { hooks: [{ type: "command", command: OURS }, THEIRS.hooks[0]] };
    expect(withSeanceHooks({ hooks: { Stop: [shared] } }, null)).toEqual({
      hooks: { Stop: [{ hooks: [THEIRS.hooks[0]] }] },
    });
    expect(withSeanceHooks(withSeanceHooks({ theme: "dark" }, OURS), null)).toEqual({ theme: "dark" });
  });

  test("another tool's SessionStart hook stands first, and a round trip returns the file key for key, in order", () => {
    const attach = { hooks: [{ type: "command", command: "/usr/local/bin/attach --hook", timeout: 15 }] };
    const file = { model: "opus", hooks: { SessionStart: [attach] }, theme: "dark" };
    const installed = withSeanceHooks(file, OURS);
    expect(Object.keys(installed)).toEqual(["model", "hooks", "theme"]);
    const hooks = installed["hooks"];
    if (!isRecord(hooks)) throw new Error("no hooks object");
    expect(hooks["SessionStart"]).toEqual([attach, { hooks: [{ type: "command", command: OURS, timeout: 5 }] }]);
    expect(JSON.stringify(withSeanceHooks(installed, null))).toBe(JSON.stringify(file));
  });

  test("a hooks value that is not an object is refused", () => {
    expect(() => withSeanceHooks({ hooks: [] }, OURS)).toThrow("not an object");
  });
});

describe("settings files", () => {
  let dir: string;
  let target: ClaudeConfigTarget;
  const path = (): string => join(dir, "settings.json");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-settings-hooks-"));
    target = { label: "default", configDir: dir, env: {} };
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("install writes a new file 0600, a re-run leaves it, uninstall returns the person's file", async () => {
    expect(await installSettingsHooks(target, "/src/seance")).toContain("written to");
    expect((await stat(path())).mode & 0o777).toBe(0o600);
    expect(await installSettingsHooks(target, "/src/seance")).toContain("already in");
    expect(settingsHooksCheck(JSON.parse(await readFile(path(), "utf8")), "/src/seance", "default").level).toBe("ok");
    expect(await uninstallSettingsHooks(target)).toContain("removed");
    expect(JSON.parse(await readFile(path(), "utf8"))).toEqual({});
    expect(await uninstallSettingsHooks(target)).toContain("no séance settings hooks");
  });

  test("an existing file keeps its mode; one that is not a JSON object is never written", async () => {
    await writeFile(path(), JSON.stringify({ model: "sonnet" }), { mode: 0o644 });
    await installSettingsHooks(target, "/src/seance");
    expect((await stat(path())).mode & 0o777).toBe(0o644);
    await writeFile(path(), "[1, 2]");
    await expect(installSettingsHooks(target, "/src/seance")).rejects.toThrow("left it untouched");
    expect(await readFile(path(), "utf8")).toBe("[1, 2]");
    expect((await settingsHooksChecks([target], "/src/seance"))[0]?.message).toContain("unread");
  });

  test("a symlinked file is written through to its target, the link kept", async () => {
    const real = join(dir, "dotfiles-settings.json");
    await writeFile(real, JSON.stringify({ model: "sonnet" }));
    await symlink(real, path());
    await installSettingsHooks(target, "/src/seance");
    expect((await lstat(path())).isSymbolicLink()).toBe(true);
    expect(settingsHooksCheck(JSON.parse(await readFile(real, "utf8")), "/src/seance", "default").level).toBe("ok");
    await uninstallSettingsHooks(target);
    expect((await lstat(path())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({ model: "sonnet" });
  });
});

describe("settingsHooksCheck", () => {
  test("warns for a missing event and for another checkout's command", () => {
    const missing = settingsHooksCheck(
      { hooks: { Stop: [{ hooks: [{ type: "command", command: OURS }] }] } },
      "/src/seance",
      "work",
    );
    expect(missing.level).toBe("warn");
    expect(missing.message).toContain("SessionStart");
    const stale = settingsHooksCheck(withSeanceHooks({}, hookCommand("/old")), "/src/seance", "work");
    expect(stale).toEqual({ level: "warn", message: expect.stringContaining("another checkout") });
  });
});
