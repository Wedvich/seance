import { describe, expect, test } from "bun:test";
import { logPath } from "./paths.ts";
import {
  noSystemdMessage,
  pinTaskCommand,
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
