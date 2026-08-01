import { describe, expect, test } from "bun:test";
import { cliOnPathCheck, parseSpawnArgs } from "./cli.ts";
import { LAUNCHD_LABEL, plistContent } from "./launchd.ts";

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

describe("cliOnPathCheck", () => {
  const main = "/repo/daemon/src/main.ts";

  test("not on PATH is a warn carrying both remedies, never a fail", () => {
    const check = cliOnPathCheck(null, null, main);
    expect(check.level).toBe("warn");
    expect(check.message).toContain("cd /repo/daemon && bun link");
    expect(check.message).toContain(`alias seanced='bun ${main}'`);
  });

  test("resolving to this checkout is ok", () => {
    expect(cliOnPathCheck("/home/u/.bun/bin/seanced", main, main)).toEqual({
      level: "ok",
      message: "seanced on PATH at /home/u/.bun/bin/seanced",
    });
  });

  test("resolving to another checkout warns with both paths", () => {
    const check = cliOnPathCheck("/home/u/.bun/bin/seanced", "/old-clone/daemon/src/main.ts", main);
    expect(check.level).toBe("warn");
    expect(check.message).toContain("/old-clone/daemon/src/main.ts");
    expect(check.message).toContain(main);
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
