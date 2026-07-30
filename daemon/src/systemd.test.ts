import { describe, expect, test } from "bun:test";
import { logPath } from "./paths.ts";
import { noSystemdMessage, pinTaskCommand, unitContent, unitPath, userInstanceMissingMessage } from "./systemd.ts";

describe("unitContent", () => {
  test("runs the checkout via the installing bun, with captured PATH and the shared log file", () => {
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
