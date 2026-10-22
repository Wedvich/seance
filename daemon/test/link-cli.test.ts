import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// link/unlink through the real CLI, as subprocesses: pins what link.test.ts's
// unit level can't — that main.ts carries the executable bit and bun shebang
// in git (without them the created symlink is dead weight), that the symlink
// actually executes through them, and that unlink survives removing the very
// file it is running through.
describe("seance link/unlink through the CLI", () => {
  let root: string;
  let bin: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-link-cli-"));
    bin = join(root, "bin");
    await mkdir(bin);
    // PATH is only the scratch dir plus bun's own (for the shebang's `env
    // bun`): tests may run as root, where every system dir is writable and
    // would compete for the link's placement.
    env = { ...process.env, HOME: root, PATH: `${bin}:${dirname(process.execPath)}` };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (argv: readonly string[]): Promise<string> => {
    const proc = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  };

  test("link creates an executable symlink, repeats as a no-op, unlink removes it", async () => {
    const linked = join(bin, "seance");
    expect(await run([process.execPath, mainPath, "link"])).toContain(`linked ${linked}`);
    // Through the symlink itself — the shebang and the committed +x bit.
    expect(await run([linked, "help"])).toContain("séance CLI");
    expect(await run([process.execPath, mainPath, "link"])).toContain("already linked");
    expect(await run([linked, "unlink"])).toContain(`removed ${linked}`);
    expect(await run([process.execPath, mainPath, "unlink"])).toContain("nothing linked");
  });

  test("a machine linked before the rename moves over with one link through its old name", async () => {
    const legacy = join(bin, "seanced");
    await symlink(mainPath, legacy);
    const out = await run([legacy, "link"]);
    expect(out).toContain(`linked ${join(bin, "seance")}`);
    expect(out).toContain(`removed ${legacy}, the old name`);
    expect(await lstat(legacy).catch(() => null)).toBeNull();
  });

  test("unlink also takes this checkout's link under the old name", async () => {
    const legacy = join(bin, "seanced");
    await symlink(mainPath, legacy);
    expect(await run([process.execPath, mainPath, "unlink"])).toContain(`removed ${legacy}`);
  });
});
