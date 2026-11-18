import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkoutCommit, parseAdapterManifest, readAdapterManifest } from "./adapter-manifest.ts";

let base: string;
let runs = 0;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-manifest-")));
});
afterAll(() => rm(base, { recursive: true, force: true }));

/** A fresh checkout holding `files` (path → text) and the manifest. */
async function checkout(manifest: unknown, files: Readonly<Record<string, string>> = {}): Promise<string> {
  const dir = join(base, `c${++runs}`);
  await mkdir(join(dir, "src"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture files
    await mkdir(dirname(path), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- as above
    await writeFile(path, text);
  }
  await writeFile(join(dir, "seance-adapter.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return dir;
}

describe("parseAdapterManifest", () => {
  test("takes exactly name, protocol and argv", () => {
    expect(parseAdapterManifest({ name: "chat", protocol: 1, argv: ["bun", "src/main.ts"] })).toEqual({
      name: "chat",
      protocol: 1,
      argv: ["bun", "src/main.ts"],
    });
    expect(parseAdapterManifest({ name: "chat", protocol: 1, argv: ["x"], kinds: ["request"] })).toContain("kinds");
    expect(parseAdapterManifest({ name: "Chat", protocol: 1, argv: ["x"] })).toContain('"name"');
    expect(parseAdapterManifest({ name: "chat", protocol: 1.5, argv: ["x"] })).toContain('"protocol"');
    expect(parseAdapterManifest({ name: "chat", protocol: 1, argv: [] })).toContain('"argv"');
    expect(parseAdapterManifest({ name: "chat", protocol: 1, argv: ["a\0b"] })).toContain('"argv"');
    expect(parseAdapterManifest(["chat"])).toBe("must be a JSON object");
  });
});

describe("readAdapterManifest", () => {
  test("a bare program stays bare; a word naming a file in the checkout becomes absolute; flags and plain words stay", async () => {
    const dir = await checkout(
      { name: "chat", protocol: 1, argv: ["bun", "src/main.ts", "--verbose", "config.json", "serve"] },
      { "src/main.ts": "", "config.json": "{}" },
    );
    const read = await readAdapterManifest(dir);
    expect(read).toEqual({
      ok: true,
      manifest: { name: "chat", protocol: 1, argv: ["bun", "src/main.ts", "--verbose", "config.json", "serve"] },
      dir,
      argv: ["bun", join(dir, "src/main.ts"), "--verbose", join(dir, "config.json"), "serve"],
    });
  });

  test("a relative argv[0] must be an executable file in the checkout", async () => {
    const good = await checkout({ name: "chat", protocol: 1, argv: ["./bin/run"] }, { "bin/run": "#!/bin/sh\n" });
    expect(await readAdapterManifest(good)).toMatchObject({
      ok: false,
      message: expect.stringContaining("executable"),
    });
    await chmod(join(good, "bin/run"), 0o755);
    expect(await readAdapterManifest(good)).toMatchObject({ ok: true, argv: [join(good, "bin/run")] });
  });

  test("refuses what it cannot run as written: no manifest, bad JSON, a protocol this séance does not speak", async () => {
    const empty = join(base, "empty");
    await mkdir(empty);
    expect(await readAdapterManifest(empty)).toMatchObject({
      ok: false,
      message: expect.stringContaining("no seance-adapter.json"),
    });
    expect(await readAdapterManifest(join(base, "nowhere"))).toMatchObject({ ok: false });
    expect(await readAdapterManifest(await checkout("{nope"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("not valid JSON"),
    });
    expect(await readAdapterManifest(await checkout({ name: "chat", protocol: 2, argv: ["bun"] }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("names protocol 2"),
    });
  });

  test("refuses a path outside the checkout: absolute, through .., or through a link", async () => {
    const outside = join(base, "outside.ts");
    await writeFile(outside, "");
    for (const argv of [
      ["/usr/bin/env", "bun"],
      ["bun", outside],
      ["bun", "../outside.ts"],
      ["bun", "src/nope.ts"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const read = await readAdapterManifest(await checkout({ name: "chat", protocol: 1, argv }));
      expect({ argv, ok: read.ok }).toEqual({ argv, ok: false });
    }
    const linked = await checkout({ name: "chat", protocol: 1, argv: ["bun", "src/main.ts"] });
    await symlink(outside, join(linked, "src/main.ts"));
    expect(await readAdapterManifest(linked)).toMatchObject({
      ok: false,
      message: expect.stringContaining("outside the checkout"),
    });
  });

  test("the checkout's commit is HEAD in a git work tree, and null outside one", async () => {
    const dir = await checkout({ name: "chat", protocol: 1, argv: ["bun"] });
    expect(await checkoutCommit(dir)).toBeNull();
    const git = (args: readonly string[]): void => {
      const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    };
    git(["init", "-q"]);
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
    expect(await checkoutCommit(dir)).toBe(head);
  });
});
