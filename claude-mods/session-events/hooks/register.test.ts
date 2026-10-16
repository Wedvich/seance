import { describe, expect, test } from "claude-code/testing";
import type { On } from "claude-code";
import { notificationState, prUrlFrom } from "./register.ts";

type Sent = { readonly argv: readonly string[]; readonly report: unknown }[];

/** Records every `seanced session-event` the mod runs, answering as seanced does: silently. */
function record(on: On, { fail = false }: { readonly fail?: boolean } = {}): Sent {
  const sent: Sent = [];
  // The engine's own step beneath each event; the mod only observes, so any answer does.
  for (const event of [
    "classic.SessionStart",
    "classic.UserPromptSubmit",
    "classic.Stop",
    "classic.Notification",
    "classic.PostToolUse",
    "classic.SessionEnd",
  ] as const) {
    on(event, () => ({}));
  }
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  on("process.run", (_$, e) => {
    sent.push({ argv: [...e.argv], report: JSON.parse(e.init?.stdin ?? "null") });
    if (fail) throw new Error("spawn seanced ENOENT");
    return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return sent;
}

/** The sends are unawaited by design, so a test waits for them rather than for the hook. */
async function settled(sent: Sent, count: number): Promise<void> {
  for (let i = 0; i < 200 && sent.length < count; i++) {
    // oxlint-disable-next-line no-await-in-loop -- a poll, one wait at a time
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe("notificationState", () => {
  test("a permission prompt or a question needs input; an idle prompt is idle; anything else says nothing", () => {
    expect(notificationState("permission_prompt")).toBe("needs-input");
    expect(notificationState("elicitation_dialog")).toBe("needs-input");
    expect(notificationState("idle_prompt")).toBe("idle");
    expect(notificationState("auth_success")).toBeNull();
  });
});

describe("prUrlFrom", () => {
  const create = { command: "gh pr create --fill" };
  test("takes the URL gh pr create printed", () => {
    const out = { stdout: "Creating pull request\nhttps://github.com/acme/app/pull/12\n" };
    expect(prUrlFrom("Bash", create, out)).toBe("https://github.com/acme/app/pull/12");
  });

  test("ignores other tools, other commands, and anything that is not an https PR URL", () => {
    expect(prUrlFrom("Read", create, { stdout: "https://github.com/acme/app/pull/12" })).toBeNull();
    expect(prUrlFrom("Bash", { command: "gh pr view 12" }, { stdout: "https://github.com/a/b/pull/12" })).toBeNull();
    expect(prUrlFrom("Bash", create, { stdout: "http://github.com/acme/app/pull/12" })).toBeNull();
    expect(prUrlFrom("Bash", create, { stdout: "no url here" })).toBeNull();
  });
});

describe("reports", () => {
  test("each lifecycle hook sends its state through seanced, never naming a session", async ($, on) => {
    const sent = record(on);
    await $.classic.SessionStart({ source: "startup" });
    await $.classic.UserPromptSubmit({ prompt: "hi" });
    await $.classic.Notification({ message: "allow?", notification_type: "permission_prompt" });
    await $.classic.Notification({ message: "ok", notification_type: "auth_success" });
    await $.classic.Stop({ stop_hook_active: false });
    await $.classic.SessionEnd({ reason: "prompt_input_exit" });
    await settled(sent, 5);
    expect(sent.map((s) => s.argv)).toEqual(Array.from({ length: 5 }, () => ["seanced", "session-event"]));
    expect(sent.map((s) => s.report)).toEqual([
      { state: "idle" },
      { state: "busy" },
      { state: "needs-input" },
      { state: "idle" },
      { state: "ended" },
    ]);
  });

  test("a /clear, a /resume or a compaction is neither an end nor idleness", async ($, on) => {
    const sent = record(on);
    await $.classic.SessionEnd({ reason: "clear" });
    await $.classic.SessionStart({ source: "clear" });
    await $.classic.SessionEnd({ reason: "resume" });
    await $.classic.SessionStart({ source: "compact" });
    await settled(sent, 2);
    expect(sent.map((s) => s.report)).toEqual([{ state: "idle" }]);
  });

  test("a PR opened through gh is reported with its URL", async ($, on) => {
    const sent = record(on);
    await $.classic.PostToolUse({
      tool_name: "Bash",
      tool_input: { command: "gh pr create --fill" },
      tool_response: { stdout: "https://github.com/acme/app/pull/12\n" },
      tool_use_id: "t1",
    });
    await settled(sent, 1);
    expect(sent.map((s) => s.report)).toEqual([{ state: "busy", prUrl: "https://github.com/acme/app/pull/12" }]);
  });

  test("rate limits go out when they changed, as the status line has them", async ($, on) => {
    const sent = record(on);
    const rateLimits = [
      { kind: "five_hour", percentUsed: 23.5, resetsAt: "2026-10-16T18:00:00Z" },
      { kind: "seven_day", percentUsed: 7 },
    ];
    const context = { window: 200_000 } as const;
    await $.session.measure({ context, rateLimits, changed: ["context"] });
    await $.session.measure({ context, rateLimits, changed: ["rateLimits"] });
    await settled(sent, 1);
    expect(sent.map((s) => s.report)).toEqual([{ rateLimits }]);
  });

  test("seanced missing costs the session nothing", async ($, on) => {
    const sent = record(on, { fail: true });
    await $.classic.Stop({ stop_hook_active: false });
    await settled(sent, 1);
    expect(sent).toHaveLength(1);
  });
});
