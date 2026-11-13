import { describe, expect, test } from "bun:test";
import { parseCommand, UsageError } from "./args.ts";

describe("parseCommand", () => {
  test("the bare commands", () => {
    expect(parseCommand(["run"])).toEqual({ kind: "run" });
    expect(parseCommand(["status"])).toEqual({ kind: "status" });
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["update"])).toEqual({ kind: "update", requested: false });
    expect(parseCommand(["update", "--requested"])).toEqual({ kind: "update", requested: true });
    expect(parseCommand(["uninstall", "--system"])).toEqual({ kind: "uninstall" });
  });

  test("install takes --system, --user and --path in any order", () => {
    expect(parseCommand(["install", "--system"])).toEqual({ kind: "install" });
    expect(parseCommand(["install", "--user", "archivist", "--system", "--path", "/a:/b"])).toEqual({
      kind: "install",
      user: "archivist",
      pathEnv: "/a:/b",
    });
  });

  test("refusals are usage errors", () => {
    const refused = (argv: readonly string[]): unknown => {
      try {
        parseCommand(argv);
      } catch (err) {
        return err;
      }
      return null;
    };
    for (const argv of [
      [],
      ["spawn"],
      ["run", "--now"],
      ["install"],
      ["install", "--system", "--user"],
      ["install", "--system", "--force"],
      ["uninstall"],
      ["update", "--force"],
    ]) {
      expect(refused(argv)).toBeInstanceOf(UsageError);
    }
    expect(String(refused(["install", "--user", "archivist"]))).toContain("--system");
  });
});
