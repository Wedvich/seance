import { describe, expect, test } from "bun:test";
import { logPath } from "./paths.ts";
import { pinTaskCommand, unitContent, unitPath } from "./systemd.ts";

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

describe("unitPath", () => {
  test("lands in the XDG systemd user directory", () => {
    expect(unitPath()).toMatch(/\/systemd\/user\/seanced\.service$/u);
  });
});
