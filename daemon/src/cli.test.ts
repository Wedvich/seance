import { describe, expect, test } from "bun:test";
import {
  cmdInstall,
  parseContinueArgs,
  parseStartArgs,
  parseDespawnArgs,
  parseInstallArgs,
  parseModArgs,
  parseRaycastArgs,
  parseReapArgs,
  parseSpawnArgs,
} from "./cli.ts";
import { LAUNCHD_LABEL, plistBunPath, plistContent } from "./launchd.ts";
import { systemdRunning } from "./systemd.ts";

describe("parseReapArgs", () => {
  test("acts by default; --dry-run previews; --min-age-days overrides the configured gate", () => {
    expect(parseReapArgs([])).toEqual({ dryRun: false });
    expect(parseReapArgs(["--dry-run", "--min-age-days", "3"])).toEqual({ dryRun: true, minAgeDays: 3 });
  });

  test("a missing or nonsense age, or an unknown flag, is a usage error rather than a default", () => {
    for (const argv of [["--min-age-days"], ["--min-age-days", "soon"], ["--min-age-days", "-1"], ["--force"]]) {
      expect(() => parseReapArgs(argv)).toThrow("usage: seanced reap");
    }
  });
});

describe("parseDespawnArgs", () => {
  test("takes one id, with --force on either side of it", () => {
    expect(parseDespawnArgs(["%12"])).toEqual({ id: "%12", force: false });
    expect(parseDespawnArgs(["--force", "%12"])).toEqual({ id: "%12", force: true });
    expect(parseDespawnArgs(["%12", "--force"])).toEqual({ id: "%12", force: true });
  });

  test("no id, two ids, or an unknown flag is a usage error, not a guess", () => {
    for (const argv of [[], ["%1", "%2"], ["%1", "-f"], ["--force"]]) {
      expect(() => parseDespawnArgs(argv)).toThrow("usage: seanced despawn");
    }
  });
});

describe("parseContinueArgs", () => {
  test("takes one task id and an optional note, by flag or as bare words", () => {
    expect(parseContinueArgs(["t-1"])).toEqual({ taskId: "t-1" });
    expect(parseContinueArgs(["t-1", "-p", "retry the tests"])).toEqual({ taskId: "t-1", prompt: "retry the tests" });
    expect(parseContinueArgs(["--prompt", "go on", "t-1"])).toEqual({ taskId: "t-1", prompt: "go on" });
    expect(parseContinueArgs(["t-1", "go", "on"])).toEqual({ taskId: "t-1", prompt: "go on" });
  });

  test("no id, a dangling flag, or an unknown flag is a usage error", () => {
    for (const argv of [[], ["-p", "x"], ["t-1", "-p"], ["t-1", "--now"]]) {
      expect(() => parseContinueArgs(argv)).toThrow("usage: seanced continue");
    }
  });
});

describe("parseStartArgs", () => {
  test("takes exactly one task id", () => {
    expect(parseStartArgs(["t-1"])).toEqual({ taskId: "t-1" });
    for (const argv of [[], ["t-1", "t-2"], ["--now"]]) {
      expect(() => parseStartArgs(argv)).toThrow("usage: seanced start");
    }
  });
});

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
    expect(() => parseSpawnArgs(["--auto"])).toThrow("usage:");
  });

  test("--auto is a no-op anywhere: the same args as without it", () => {
    expect(parseSpawnArgs(["--auto", "seance", "--here", "-t", "My Task", "fix", "it"])).toEqual(
      parseSpawnArgs(["seance", "--here", "-t", "My Task", "fix", "it"]),
    );
    expect(parseSpawnArgs(["seance", "-p", "do it", "--auto"])).toEqual({
      repo: "seance",
      here: false,
      prompt: "do it",
    });
    // `-p` takes the next word as given, so a prompt that reads like the flag stays a prompt.
    expect(parseSpawnArgs(["seance", "-p", "--auto"])).toEqual({ repo: "seance", here: false, prompt: "--auto" });
  });

  test("--now parses to now: true beside --here, -t and -p", () => {
    expect(parseSpawnArgs(["--now", "seance", "--here", "-t", "My Task", "-p", "do it"])).toEqual({
      repo: "seance",
      here: true,
      title: "My Task",
      prompt: "do it",
      now: true,
    });
    expect(parseSpawnArgs(["seance", "go", "--now"])).toEqual({ repo: "seance", here: false, prompt: "go", now: true });
  });

  test("--start parses beside the pin flags, and is refused beside --now", () => {
    expect(parseSpawnArgs(["--start", "--machine", "here", "seance", "go"])).toEqual({
      repo: "seance",
      here: false,
      prompt: "go",
      machine: "here",
      start: true,
    });
    expect(() => parseSpawnArgs(["--now", "--start", "seance"])).toThrow("--now spawns here directly");
  });

  test("--machine, --account and repeatable --not need no flag, each taking the next word", () => {
    expect(
      parseSpawnArgs([
        "--machine",
        "here",
        "seance",
        "--account",
        "me@pengefix.no",
        "--not",
        "wsl",
        "--not",
        "here",
        "go",
      ]),
    ).toEqual({
      repo: "seance",
      here: false,
      prompt: "go",
      machine: "here",
      account: "me@pengefix.no",
      not: ["wsl", "here"],
    });
  });

  test("--now refuses every pin flag and --auto", () => {
    expect(() => parseSpawnArgs(["--now", "seance", "--machine", "x"])).toThrow("--now spawns on this machine now");
    expect(() => parseSpawnArgs(["--now", "seance", "--account", "a"])).toThrow("--now spawns on this machine now");
    expect(() => parseSpawnArgs(["--now", "seance", "--not", "here"])).toThrow("--now spawns on this machine now");
    expect(() => parseSpawnArgs(["--now", "--auto", "seance"])).toThrow("--now and --auto contradict");
    expect(() => parseSpawnArgs(["seance", "--auto", "--now"])).toThrow("--now and --auto contradict");
  });

  test("a placement flag without a value, or --machine / --account given twice, is a usage error", () => {
    expect(() => parseSpawnArgs(["seance", "--account"])).toThrow("usage:");
    expect(() => parseSpawnArgs(["seance", "--not"])).toThrow("usage:");
    expect(() => parseSpawnArgs(["seance", "--machine", "a", "--machine", "b"])).toThrow("usage:");
    expect(() => parseSpawnArgs(["seance", "--account", "a", "--account", "b"])).toThrow("usage:");
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

describe("parseRaycastArgs", () => {
  test("the two subcommands, allow-listed", () => {
    expect(parseRaycastArgs(["install"])).toBe("install");
    expect(parseRaycastArgs(["uninstall"])).toBe("uninstall");
  });

  // Unlike `mcp`, which serves the MCP server when invoked bare, `raycast`
  // alone names no action at all.
  test("a bare invocation is usage, not a default action", () => {
    expect(() => parseRaycastArgs([])).toThrow("usage:");
  });

  test("unknown subcommands and stray arguments are usage errors", () => {
    expect(() => parseRaycastArgs(["reinstall"])).toThrow(/unknown raycast subcommand "reinstall"/u);
    expect(() => parseRaycastArgs(["--system"])).toThrow("usage:");
    expect(() => parseRaycastArgs(["install", "--force"])).toThrow(/takes no arguments/u);
  });
});

describe("install --system as a normal user", () => {
  // Gated on a running systemd too, not just Linux: the privilege refusal comes
  // after the systemd probe, so in a container or a WSL distro without systemd the
  // message under test is the other one — and that ordering is deliberate, an
  // operator with no systemd gains nothing from being told to sudo first.
  test.if(process.platform === "linux" && process.getuid?.() !== 0 && systemdRunning())(
    "refuses, naming the sudo form",
    async () => {
      // The refusal has to land before anything is written, and it has to say what
      // to run — the whole point of folding the runbook into the CLI.
      await expect(cmdInstall(["--system"])).rejects.toThrow(
        /sudo --preserve-env=PATH "\$\(command -v seanced\)" install --system/u,
      );
    },
  );
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

describe("parseModArgs", () => {
  test("accepts exactly install or uninstall, with no extra arguments", () => {
    expect(parseModArgs(["install"])).toBe("install");
    expect(parseModArgs(["uninstall"])).toBe("uninstall");
    expect(() => parseModArgs([])).toThrow("usage:");
    expect(() => parseModArgs(["reinstall"])).toThrow(/unknown mod subcommand "reinstall"/u);
    expect(() => parseModArgs(["install", "--force"])).toThrow(/takes no arguments/u);
  });
});
