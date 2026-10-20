import { describe, expect, test } from "bun:test";
import { exec } from "./exec.ts";

// Big enough to overflow the pipe buffer, so a child that never reads stdin
// leaves the flush blocked (timeout case) or rejected with EPIPE (exit case).
const OVERFLOW = "x".repeat(4 * 1024 * 1024);

describe("exec stdin", () => {
  test("delivers stdin to the child", async () => {
    const result = await exec(["cat"], { stdin: "hello\n" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  test("a child that exits without draining stdin yields a result, not a throw", async () => {
    const result = await exec(["true"], { stdin: OVERFLOW });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("the stdin flush phase is bounded by the timeout", async () => {
    const result = await exec(["sleep", "30"], { stdin: OVERFLOW, timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("exec timeout", () => {
  // What a fetch on a dead network looks like: git killed, its transport child
  // still alive and still holding the pipes the result reads to EOF.
  test("killGroup ends at the timeout even when a grandchild holds the pipes", async () => {
    const started = Date.now();
    const result = await exec(["sh", "-c", "sleep 30 & wait"], { timeoutMs: 250, killGroup: true });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("exec environment", () => {
  // The tmux server the daemon may cold-boot inherits this env, and every
  // Claude session on the box inherits it from there — so a leak here is a leak
  // to semi-trusted sessions, not just to one child.
  test("strips the delivered credential path, keeping the rest of the environment", async () => {
    process.env["CREDENTIALS_DIRECTORY"] = "/run/credentials/seanced.service";
    process.env["SEANCE_EXEC_CANARY"] = "kept";
    try {
      const result = await exec(["sh", "-c", 'echo "${CREDENTIALS_DIRECTORY-absent}/${SEANCE_EXEC_CANARY-absent}"']);
      expect(result.stdout.trim()).toBe("absent/kept");
    } finally {
      delete process.env["CREDENTIALS_DIRECTORY"];
      delete process.env["SEANCE_EXEC_CANARY"];
    }
  });

  // `default`'s Claude config is the one reached with CLAUDE_CONFIG_DIR unset, so
  // pointing a child at it from inside an exclave session means removing the var.
  test("an undefined override unsets the variable; a string one sets it", async () => {
    process.env["SEANCE_EXEC_UNSET"] = "inherited";
    try {
      const result = await exec(["sh", "-c", 'echo "${SEANCE_EXEC_UNSET-absent}/${SEANCE_EXEC_SET-absent}"'], {
        env: { SEANCE_EXEC_UNSET: undefined, SEANCE_EXEC_SET: "set" },
      });
      expect(result.stdout.trim()).toBe("absent/set");
      expect(process.env["SEANCE_EXEC_UNSET"]).toBe("inherited");
    } finally {
      delete process.env["SEANCE_EXEC_UNSET"];
    }
  });

  test("bareEnv hands the child its env alone: nothing of the daemon's, never the credential path", async () => {
    process.env["SEANCE_EXEC_CANARY"] = "daemon's";
    try {
      const result = await exec(["/usr/bin/env"], {
        env: { ONLY: "this", CREDENTIALS_DIRECTORY: "/run/credentials/seanced.service" },
        bareEnv: true,
      });
      expect(result.stdout.trim().split("\n")).toEqual(["ONLY=this"]);
    } finally {
      delete process.env["SEANCE_EXEC_CANARY"];
    }
  });
});
