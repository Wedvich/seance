import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importedExtensionDir,
  installExtension,
  manifestName,
  meetsNodeFloor,
  nodeFloor,
  parseVersion,
  pickBundledRuntime,
  raycastChecks,
  uninstallExtension,
} from "./raycast.ts";

const darwin = process.platform === "darwin";

describe("node engine floor", () => {
  test("parses the shapes node and Raycast's runtime directory both use", () => {
    expect(parseVersion("v22.22.2\n")).toEqual([22, 22, 2]);
    expect(parseVersion("22.22.2")).toEqual([22, 22, 2]);
    expect(parseVersion("not a version")).toBeNull();
  });

  // The floor is @raycast/api's to declare: restating it here would let a
  // dependency bump leave the fallback stale and unnoticed.
  test("comes from the installed @raycast/api's engines.node", async () => {
    const workspace = new URL("../../raycast", import.meta.url).pathname;
    const manifest: { readonly engines?: { readonly node?: string } } = await Bun.file(
      join(workspace, "node_modules", "@raycast", "api", "package.json"),
    ).json();
    const declared = manifest.engines?.node ?? "";
    expect(declared).toMatch(/^>=/u);
    expect(await nodeFloor(workspace)).toEqual(parseVersion(declared.replace(/^>=/u, "")) ?? []);
  });

  test("falls back to the literal when there is no @raycast/api to read", async () => {
    expect(await nodeFloor(join(tmpdir(), "seance-no-such-workspace"))).toEqual([22, 22, 2]);
  });

  test("one patch below the floor fails, above it passes", () => {
    const floor = [22, 22, 2];
    expect(meetsNodeFloor("v22.22.2", floor)).toBe(true);
    expect(meetsNodeFloor("v22.22.1", floor)).toBe(false);
    expect(meetsNodeFloor("v22.23.0", floor)).toBe(true);
    expect(meetsNodeFloor("v26.5.1", floor)).toBe(true);
    expect(meetsNodeFloor("v20.19.0", floor)).toBe(false);
    expect(meetsNodeFloor("garbage", floor)).toBe(false);
  });

  test("picks the newest bundled runtime that clears it, numerically not lexically", () => {
    expect(pickBundledRuntime(["20.18.0", "22.22.2", "24.9.0"])).toBe("24.9.0");
    expect(pickBundledRuntime(["9.0.0", "22.22.2", "22.9.0"])).toBe("22.22.2");
    expect(pickBundledRuntime(["20.18.0"])).toBeNull();
    expect(pickBundledRuntime([])).toBeNull();
  });
});

describe("the imported extension directory", () => {
  test("is keyed by manifest name under ~/.config/raycast, not by a UUID", () => {
    expect(importedExtensionDir("seance-raycast", "/home/ada")).toBe(
      "/home/ada/.config/raycast/extensions/seance-raycast",
    );
  });
});

describe("manifestName", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "seance-raycast-manifest-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  // The whole point of reading it: a constant in the CLI and a rename in the
  // manifest would leave install polling a directory that never appears.
  test("comes from the manifest, whatever it says", async () => {
    await Bun.write(join(workspace, "package.json"), JSON.stringify({ name: "renamed-extension" }));
    expect(await manifestName(workspace)).toBe("renamed-extension");
  });

  test("the checked-in manifest is what this checkout would import as", async () => {
    const workspaceRoot = new URL("../../raycast", import.meta.url).pathname;
    expect(await manifestName(workspaceRoot)).toBe("seance-raycast");
  });

  test("a missing or nameless manifest is an error, never a guessed name", async () => {
    await expect(manifestName(workspace)).rejects.toThrow(/no extension manifest/u);
    await Bun.write(join(workspace, "package.json"), JSON.stringify({ version: "0.0.0" }));
    await expect(manifestName(workspace)).rejects.toThrow(/declares no "name"/u);
  });
});

describe("off macOS", () => {
  test.if(!darwin)("install and uninstall refuse — the manifest is platforms: [macOS]", async () => {
    await expect(installExtension(() => {})).rejects.toThrow(/macOS-only/u);
    await expect(uninstallExtension()).rejects.toThrow(/macOS-only/u);
  });

  test.if(!darwin)("doctor stays silent, the way the TPM checks do off Linux", async () => {
    expect(await raycastChecks()).toEqual([]);
  });
});

describe("raycastChecks", () => {
  let root: string;
  let home: string;
  let workspace: string;
  let previous: string | undefined;

  const extensionDir = (): string => importedExtensionDir("seance-raycast-test", home);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-raycast-checks-"));
    home = join(root, "home");
    workspace = join(root, "checkout", "raycast");
    // Satisfies the "Raycast present" probe without needing the real app, so
    // this runs on a bare macOS CI box too.
    await mkdir(join(home, "Applications", "Raycast.app"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(root, "checkout", "shared", "src"), { recursive: true });
    await Bun.write(join(workspace, "package.json"), JSON.stringify({ name: "seance-raycast-test" }));
    await Bun.write(join(workspace, "src", "spawn.tsx"), "// source\n");
    await Bun.write(join(root, "checkout", "shared", "src", "types.ts"), "// wire types\n");
    previous = process.env["SEANCE_RAYCAST_DIR"];
    process.env["SEANCE_RAYCAST_DIR"] = workspace;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env["SEANCE_RAYCAST_DIR"];
    else process.env["SEANCE_RAYCAST_DIR"] = previous;
    await rm(root, { recursive: true, force: true });
  });

  const messages = async (): Promise<string> => (await raycastChecks(home)).map((check) => check.message).join("\n");

  test.if(darwin)("warns when nothing is imported", async () => {
    const checks = await raycastChecks(home);
    expect(checks.map((check) => check.level)).toEqual(["ok", "warn"]);
    expect(checks[1]?.message).toContain("seanced raycast install");
  });

  test.if(darwin)("an imported copy newer than the sources is clean", async () => {
    await mkdir(extensionDir(), { recursive: true });
    await Bun.write(join(extensionDir(), "package.json"), JSON.stringify({ name: "seance-raycast-test" }));
    const checks = await raycastChecks(home);
    expect(checks.every((check) => check.level === "ok")).toBe(true);
    expect(await messages()).toContain("seance-raycast-test");
  });

  // The `git pull` case: nothing rebuilds the imported copy, so this warning is
  // the only thing standing between a pull and an extension speaking last
  // week's wire types.
  test.if(darwin)("warns when raycast/src or shared/src is newer than the import", async () => {
    await mkdir(extensionDir(), { recursive: true });
    const built = join(extensionDir(), "package.json");
    await Bun.write(built, JSON.stringify({ name: "seance-raycast-test" }));
    const old = new Date(Date.now() - 60_000);
    await utimes(built, old, old);

    const soleSourceTouched = join(root, "checkout", "shared", "src", "types.ts");
    const now = new Date();
    await utimes(soleSourceTouched, now, now);

    const checks = await raycastChecks(home);
    expect(checks.at(-1)?.level).toBe("warn");
    expect(checks.at(-1)?.message).toContain("older than raycast/src or shared/src");
  });
});
