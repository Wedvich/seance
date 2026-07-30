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
