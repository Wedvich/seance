import { describe, expect, test } from "bun:test";
import { reasonText, sessionExit, storeErrorText, taskFailureText } from "./scheduler-text.ts";
import { STORE_ERROR_CODES, TASK_FAILURE_CODES } from "./types.ts";

describe("taskFailureText", () => {
  test("words every scheduler-set code apart, and leaves a daemon's or a later code to the caller", () => {
    // Not `.map(taskFailureText)`: the index would ride in as an exit status.
    const texts = TASK_FAILURE_CODES.map((code) => taskFailureText(code));
    expect(texts.every((t) => t !== null && t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(TASK_FAILURE_CODES.length);
    expect(taskFailureText("queue_expired")).toContain("30 days");
    expect(taskFailureText("lost_expired")).toContain("may still be running");
    expect(taskFailureText("repo_not_found")).toBeNull();
    expect(taskFailureText("minted_later")).toBeNull();
  });

  test("a session_failed with its exit status says how the session ended; every other code ignores it", () => {
    expect(taskFailureText("session_failed", 137)).toBe(
      "its session was killed (SIGKILL), possibly out of memory, and reported no pull request",
    );
    expect(taskFailureText("session_failed", 143)).toBe("its session was killed (SIGTERM) and reported no pull request");
    expect(taskFailureText("session_failed", 1)).toBe("its session exited with status 1 and reported no pull request");
    expect(taskFailureText("session_failed")).toBe("its session exited with an error and reported no pull request");
    expect(taskFailureText("merge_expired", 137)).toBe(taskFailureText("merge_expired"));
    expect(taskFailureText("repo_not_found", 137)).toBeNull();
  });
});

describe("sessionExit", () => {
  test("names a signal death only where macOS and Linux number it alike, and hints at memory only for SIGKILL", () => {
    expect(sessionExit(137)).toEqual({ clause: "was killed (SIGKILL)", hint: "possibly out of memory" });
    expect(sessionExit(139)).toEqual({ clause: "was killed (SIGSEGV)" });
    expect(sessionExit(130)).toEqual({ clause: "was killed (SIGINT)" });
    expect(sessionExit(143)).toEqual({ clause: "was killed (SIGTERM)" });
    // 128 + 10: SIGUSR1 on Linux, SIGBUS on macOS — the status is all that is certain.
    expect(sessionExit(138)).toEqual({ clause: "exited with status 138" });
    expect(sessionExit(128)).toEqual({ clause: "exited with status 128" });
    expect(sessionExit(1)).toEqual({ clause: "exited with status 1" });
    expect(sessionExit(9)).toEqual({ clause: "exited with status 9" });
  });
});

describe("reasonText", () => {
  test("batch_order names the member it waits for by the spec's own index, without claiming it started", () => {
    const text = reasonText({ code: "batch_order", index: 0 });
    expect(text).toContain("#0");
    expect(text).not.toContain("ended");
  });

  test("a placement restriction says which one turned the candidate away", () => {
    expect(reasonText({ code: "pin_mismatch", field: "deviceId" })).toBe("not the pinned machine");
    expect(reasonText({ code: "pin_mismatch", field: "account" })).toBe("not the pinned account");
    expect(reasonText({ code: "avoided" })).toBe("the task avoids this machine");
  });
});

describe("storeErrorText", () => {
  test("words every store refusal, apart where the cause differs, and names a code it does not know", () => {
    for (const code of STORE_ERROR_CODES) expect(storeErrorText(code).length).toBeGreaterThan(0);
    expect(storeErrorText("version_conflict")).toContain("earlier attempt");
    expect(storeErrorText("too_large")).toContain("shorten");
    expect(storeErrorText("rate_limited")).toContain("wait a minute");
    expect(storeErrorText("store_full")).toContain("queue is full");
    expect(storeErrorText("minted_later")).toContain("minted_later");
  });
});
