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
    expect(taskFailureText("session_failed", 143)).toBe(
      "its session ended on SIGTERM (status 143) and reported no pull request",
    );
    expect(taskFailureText("session_failed", 1)).toBe("its session exited with status 1 and reported no pull request");
    expect(taskFailureText("session_failed")).toBe("its session exited with an error and reported no pull request");
    // 0 is no failure, and nothing else outside 1–255 or non-integer is a status: all read as no status.
    for (const exit of [0, -1, 256, 1.5, Number.NaN]) {
      expect(taskFailureText("session_failed", exit)).toBe(taskFailureText("session_failed"));
    }
    expect(taskFailureText("merge_expired", 137)).toBe(taskFailureText("merge_expired"));
    expect(taskFailureText("repo_not_found", 137)).toBeNull();
  });

  test("under until reported, the missing thing is the done report, not a pull request", () => {
    expect(taskFailureText("session_failed", 1, "reported")).toBe(
      "its session exited with status 1 and did not report done",
    );
    expect(taskFailureText("session_failed", undefined, "reported")).toBe(
      "its session exited with an error and did not report done",
    );
    expect(taskFailureText("session_failed", 1, "merged")).toBe(taskFailureText("session_failed", 1));
    expect(taskFailureText("merge_expired", undefined, "reported")).toBe(taskFailureText("merge_expired"));
  });
});

describe("sessionExit", () => {
  test("names a signal death only where macOS and Linux number it alike, and claims a kill and a memory hint only for SIGKILL", () => {
    expect(sessionExit(137)).toEqual({ clause: "was killed (SIGKILL)", hint: "possibly out of memory" });
    expect(sessionExit(139)).toEqual({ clause: "ended on SIGSEGV (status 139)" });
    expect(sessionExit(130)).toEqual({ clause: "ended on SIGINT (status 130)" });
    expect(sessionExit(143)).toEqual({ clause: "ended on SIGTERM (status 143)" });
    // 128 + 10: SIGUSR1 on Linux, SIGBUS on macOS — the status is all that is certain.
    expect(sessionExit(138)).toEqual({ clause: "exited with status 138" });
    expect(sessionExit(128)).toEqual({ clause: "exited with status 128" });
    expect(sessionExit(1)).toEqual({ clause: "exited with status 1" });
    expect(sessionExit(9)).toEqual({ clause: "exited with status 9" });
  });

  test("a SIGKILL says out of memory only on the kernel's count, rules out only the kernel's killer, and stays hedged without either", () => {
    expect(sessionExit(137, true)).toEqual({
      clause: "was killed (SIGKILL)",
      hint: "out of memory (the kernel's OOM killer fired as it died)",
    });
    expect(sessionExit(137, false)).toEqual({ clause: "was killed (SIGKILL)", hint: "not by the kernel's OOM killer" });
    expect(sessionExit(137, undefined)).toEqual(sessionExit(137));
    // Noted only beside a SIGKILL; any other status ignores it.
    expect(sessionExit(143, true)).toEqual(sessionExit(143));
    expect(sessionExit(1, true)).toEqual(sessionExit(1));
    expect(taskFailureText("session_failed", 137, "reported", true)).toBe(
      "its session was killed (SIGKILL), out of memory (the kernel's OOM killer fired as it died), and did not report done",
    );
    expect(taskFailureText("merge_expired", 137, undefined, true)).toBe(taskFailureText("merge_expired"));
  });

  test("a value outside 1–255, or none, is no status", () => {
    for (const exit of [undefined, 0, -1, 256, 1.5, Number.NaN]) {
      expect(sessionExit(exit)).toEqual({ clause: "exited with an error" });
    }
  });
});

describe("reasonText", () => {
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
