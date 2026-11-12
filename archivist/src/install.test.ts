import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireRoot } from "../../daemon/src/target-user.ts";
import { checkoutRefusal, daemonUserRefusal, SUDO_ARCHIVIST, untrustedCode } from "./install.ts";

const SEANCED_UNIT = '[Service]\nUser=martin\nExecStart="/usr/bin/bun" "/home/martin/seance/daemon/src/main.ts"\n';

describe("install --system refusals", () => {
  test("the user a seanced system unit runs as is refused", () => {
    expect(daemonUserRefusal("martin", SEANCED_UNIT, false)).toMatch(/seanced\.service runs seanced as .*A27a/u);
  });

  test("a user with a seanced user unit is refused", () => {
    expect(daemonUserRefusal("martin", null, true)).toMatch(/seanced user unit/u);
  });

  test("a user of its own passes, beside a daemon or on a box with none", () => {
    expect(daemonUserRefusal("archivist", SEANCED_UNIT, false)).toBeNull();
    expect(daemonUserRefusal("archivist", null, false)).toBeNull();
  });

  test("a checkout the archivist's user does not own is refused", () => {
    const user = { name: "archivist", uid: 1001 };
    expect(checkoutRefusal("/home/martin/seance", 1000, user)).toMatch(/not archivist's \(owner uid 1000\)/u);
    expect(checkoutRefusal("/home/archivist/seance", 1001, user)).toBeNull();
  });

  test("not root names the archivist's own sudo form", () => {
    expect(SUDO_ARCHIVIST).toMatch(/^sudo "\$\(command -v bun\)" ".*\/archivist\/src\/main\.ts"$/u);
    expect(() => requireRoot(1000, "install --system", SUDO_ARCHIVIST)).toThrow(
      `\`${SUDO_ARCHIVIST} install --system\``,
    );
  });
});

describe("code the units would run", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ root: string; bin: string }> {
    const base = await mkdtemp(join(tmpdir(), "archivist-install-"));
    dirs.push(base);
    const root = join(base, "seance");
    const bin = join(base, "bin");
    await mkdir(join(root, "archivist"), { recursive: true });
    await mkdir(bin);
    await writeFile(join(root, "archivist", "main.ts"), "x");
    await writeFile(join(bin, "bun"), "x");
    await chmod(join(bin, "bun"), 0o755);
    return { root, bin };
  }

  const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

  test("a checkout, bun and PATH only its user can write pass", async () => {
    const { root, bin } = await fixture();
    expect(await untrustedCode(me, root, [join(bin, "bun")], [bin])).toEqual([]);
  });

  test("a source file, a bun or a PATH dir someone else can write is named", async () => {
    const { root, bin } = await fixture();
    await chmod(join(root, "archivist", "main.ts"), 0o666);
    await chmod(bin, 0o777);
    const found = (await untrustedCode(me, root, [join(bin, "bun")], [bin])).join("\n");
    expect(found).toContain("main.ts (writable by anyone)");
    expect(found).toContain(`${bin} (writable by anyone)`);
  });

  test("another uid's file in the checkout is named", async () => {
    const { root, bin } = await fixture();
    const found = await untrustedCode({ uid: me.uid + 1, gid: me.gid }, root, [], [bin]);
    expect(found.join("\n")).toContain(`owned by uid ${me.uid}`);
  });
});
