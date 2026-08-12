import { describe, expect, test } from "bun:test";
import { cmdInstall, parseInstallArgs, parseSpawnArgs } from "./cli.ts";
import { LAUNCHD_LABEL, plistBunPath, plistContent } from "./launchd.ts";

describe("parseSpawnArgs", () => {
  test("repo only", () => {
    expect(parseSpawnArgs(["seance"])).toEqual({ repo: "seance", here: false });
  });

  test("bare words join into the prompt — -p optional, like /spawn", () => {
    expect(parseSpawnArgs(["seance", "fix", "the", "test"])).toEqual({
      repo: "seance",
      here: false,
      prompt: "fix the test",
    });
  });

  test("flags: --here, -t, -p", () => {
    expect(parseSpawnArgs(["seance", "--here", "-t", "My Task", "-p", "do it"])).toEqual({
      repo: "seance",
      here: true,
      title: "My Task",
      prompt: "do it",
    });
  });

  test("unknown flag is usage error, missing repo is usage error", () => {
    expect(() => parseSpawnArgs(["seance", "--nope"])).toThrow("usage:");
    expect(() => parseSpawnArgs([])).toThrow("usage:");
    expect(() => parseSpawnArgs(["--here"])).toThrow("usage:");
  });
});

describe("parseInstallArgs", () => {
  test("bare install stays user-scope", () => {
    expect(parseInstallArgs([])).toEqual({ system: false });
  });

  test("--system with the values a root install can't infer", () => {
    expect(parseInstallArgs(["--system", "--user", "ada", "--state-dir", "/srv/seance", "--path", "/opt/bin"])).toEqual(
      {
        system: true,
        user: "ada",
        stateDir: "/srv/seance",
        pathEnv: "/opt/bin",
      },
    );
  });

  test("a flag left without its value is usage, not an empty PATH in a unit", () => {
    expect(() => parseInstallArgs(["--system", "--path"])).toThrow("usage:");
    expect(() => parseInstallArgs(["--system", "--user"])).toThrow("usage:");
  });

  test("unknown flags, bare words, and system-only flags without --system are usage errors", () => {
    expect(() => parseInstallArgs(["--nope"])).toThrow("usage:");
    expect(() => parseInstallArgs(["system"])).toThrow("usage:");
    expect(() => parseInstallArgs(["--user", "ada"])).toThrow(/only apply to/u);
  });
});

describe("install --system as a normal user", () => {
  test.if(process.platform === "linux" && process.getuid?.() !== 0)("refuses, naming the sudo form", async () => {
    // The refusal has to land before anything is written, and it has to say what
    // to run — the whole point of folding the runbook into the CLI.
    await expect(cmdInstall(["--system"])).rejects.toThrow(/sudo --preserve-env=PATH seanced install --system/u);
  });
});

describe("plistContent", () => {
  test("contains label, program arguments, keepalive, and captured PATH", () => {
    const plist = plistContent("/opt/bun", "/repo/daemon/src/main.ts", "/opt/homebrew/bin:/usr/bin");
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/bun</string>");
    expect(plist).toContain("<string>/repo/daemon/src/main.ts</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("/opt/homebrew/bin:/usr/bin");
  });

  test("escapes XML-hostile characters in paths", () => {
    const plist = plistContent("/o<p>t/bun", "/a&b/main.ts", "/bin");
    expect(plist).toContain("/o&lt;p&gt;t/bun");
    expect(plist).toContain("/a&amp;b/main.ts");
  });
});

describe("plistBunPath", () => {
  test("round-trips plistContent, XML escaping included", () => {
    expect(plistBunPath(plistContent("/opt/bun", "/repo/daemon/src/main.ts", "/bin"))).toBe("/opt/bun");
    expect(plistBunPath(plistContent("/o<p>t/&bun", "/repo/main.ts", "/bin"))).toBe("/o<p>t/&bun");
  });

  test("null when there are no ProgramArguments — a parse miss must not read as drift", () => {
    expect(plistBunPath("<plist><dict></dict></plist>")).toBeNull();
  });
});
