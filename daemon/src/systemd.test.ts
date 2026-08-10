import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logPath } from "./paths.ts";
import {
  noSystemdMessage,
  pinTaskCommand,
  systemUnitDeliversPsk,
  unitBunPath,
  unitContent,
  unitPath,
  userInstanceMissingMessage,
} from "./systemd.ts";

describe("unitContent", () => {
  test("runs the checkout via the bun it is given, with captured PATH and the shared log file", () => {
    const unit = unitContent("/opt/bun", "/repo/daemon/src/main.ts", "/usr/bin:/mnt/c/Windows/system32");
    expect(unit).toContain('ExecStart="/opt/bun" "/repo/daemon/src/main.ts"');
    expect(unit).toContain('Environment="PATH=/usr/bin:/mnt/c/Windows/system32"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`StandardOutput=append:${logPath()}`);
    expect(unit).toContain(`StandardError=append:${logPath()}`);
    expect(unit).toContain("WantedBy=default.target");
  });

  test("escapes % so systemd specifiers stay literal", () => {
    const unit = unitContent("/opt/bun", "/repo/main.ts", "/path/with%h");
    expect(unit).toContain("/path/with%%h");
    expect(unit).not.toContain("PATH=/path/with%h");
  });
});

describe("unitBunPath", () => {
  test("round-trips unitContent, % escaping included", () => {
    expect(unitBunPath(unitContent("/opt/bun", "/repo/main.ts", "/bin"))).toBe("/opt/bun");
    expect(unitBunPath(unitContent("/opt/100%bun", "/repo/main.ts", "/bin"))).toBe("/opt/100%bun");
  });

  test("null when ExecStart isn't quoted the way we write it", () => {
    expect(unitBunPath("[Service]\nExecStart=/opt/bun /repo/main.ts\n")).toBeNull();
  });
});

describe("pin task", () => {
  test("boots the distro with no console window and pins the VM", () => {
    expect(pinTaskCommand("Ubuntu")).toBe("conhost.exe --headless wsl.exe -d Ubuntu --exec sleep infinity");
  });
});

describe("preflight messages", () => {
  test("missing user instance names linger on both platforms, WSL cause only on WSL", () => {
    const wsl = userInstanceMissingMessage(true, "ada");
    const linux = userInstanceMissingMessage(false, "ada");
    for (const msg of [wsl, linux]) {
      expect(msg).toContain("sudo loginctl enable-linger ada");
      expect(msg).toContain("re-run `seanced install`");
    }
    expect(wsl).toContain("don't register with logind");
    expect(linux).toContain("headless box");
    expect(linux).not.toContain("WSL");
  });

  test("no systemd points WSL at wsl.conf and plain Linux at a manual supervisor", () => {
    expect(noSystemdMessage(true)).toContain("[boot] systemd=true");
    expect(noSystemdMessage(false)).toContain("your own supervisor");
    expect(noSystemdMessage(false)).not.toContain("wsl");
  });
});
describe("unitPath", () => {
  test("lands in the XDG systemd user directory", () => {
    expect(unitPath()).toMatch(/\/systemd\/user\/seanced\.service$/u);
  });
});

describe("systemUnitDeliversPsk", () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function unitFile(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "seance-unit-"));
    cleanups.push(dir);
    const path = join(dir, "seanced.service");
    await writeFile(path, body);
    return path;
  }

  test("no system unit — the user-unit boxes, which is most of them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-unit-"));
    cleanups.push(dir);
    expect(await systemUnitDeliversPsk(join(dir, "seanced.service"))).toBe(false);
  });

  test("recognises the delivery line docs/platform-notes.md prescribes", async () => {
    const path = await unitFile(
      "[Service]\nUser=me\nLoadCredentialEncrypted=seance-psk:/home/me/.local/state/seance/psk.cred\n",
    );
    expect(await systemUnitDeliversPsk(path)).toBe(true);
  });

  test("a system unit that delivers nothing, or delivers under another id, does not count", async () => {
    expect(await systemUnitDeliversPsk(await unitFile("[Service]\nUser=me\nExecStart=/bin/true\n"))).toBe(false);
    expect(await systemUnitDeliversPsk(await unitFile("[Service]\nLoadCredentialEncrypted=other:/tmp/x\n"))).toBe(
      false,
    );
  });
});
