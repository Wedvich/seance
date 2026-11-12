import { describe, expect, test } from "bun:test";
import { amendedFields, amendedPromptFits, amendSpec, appendToPrompt, isPromptBasis, promptBasis } from "./amend.ts";
import { ATTACHMENT_LIMITS, SUCCESSOR_PROMPT_BYTES, TASK_REQUEST_LIMITS, type TaskSpec } from "./types.ts";

const BASIS = "a".repeat(64);

function spec(fields: Partial<TaskSpec> = {}): TaskSpec {
  return { repo: "github.com/acme/app", mode: "worktree", prompt: "do it", ...fields };
}

const ATTACHMENT = {
  id: "0b6f0c9e-1a2b-4c3d-8e9f-000000000001",
  name: "shot.png",
  type: "image/png",
  size: 1024,
  hash: "A".repeat(43),
} as const;

describe("promptBasis", () => {
  test("is SHA-256 of the UTF-8 text in lowercase hex, an absent prompt hashing as empty", async () => {
    // The well-known digest of the empty string.
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(await promptBasis(undefined)).toBe(empty);
    expect(await promptBasis("")).toBe(empty);
    const basis = await promptBasis("do it");
    expect(isPromptBasis(basis)).toBe(true);
    expect(basis).not.toBe(await promptBasis("do it "));
    expect(await promptBasis("blåbær")).toBe(await promptBasis("blåbær"));
  });

  test("isPromptBasis takes 64 lowercase hex characters only", () => {
    expect(isPromptBasis(BASIS)).toBe(true);
    expect(isPromptBasis("A".repeat(64))).toBe(false);
    expect(isPromptBasis("a".repeat(65))).toBe(false);
    expect(isPromptBasis(7)).toBe(false);
  });
});

describe("appendToPrompt", () => {
  test("joins after a blank line, and is the text alone on an empty or absent prompt", () => {
    expect(appendToPrompt("do it", "also")).toBe("do it\n\nalso");
    expect(appendToPrompt("", "also")).toBe("also");
    expect(appendToPrompt(undefined, "also")).toBe("also");
  });
});

describe("amendedPromptFits", () => {
  test("holds a create's cap in UTF-16 units, the smaller one beside attachments", () => {
    expect(amendedPromptFits("x".repeat(TASK_REQUEST_LIMITS.prompt), spec())).toBe(true);
    expect(amendedPromptFits("x".repeat(TASK_REQUEST_LIMITS.prompt + 1), spec())).toBe(false);
    const attached = spec({ attachments: [ATTACHMENT] });
    expect(amendedPromptFits("x".repeat(ATTACHMENT_LIMITS.prompt), attached)).toBe(true);
    expect(amendedPromptFits("x".repeat(ATTACHMENT_LIMITS.prompt + 1), attached)).toBe(false);
  });

  test("holds the UTF-8 byte bound too, which three-byte characters reach under the unit cap", () => {
    // "€" is one UTF-16 unit and three UTF-8 bytes.
    const fits = Math.floor(SUCCESSOR_PROMPT_BYTES / 3);
    expect(amendedPromptFits("€".repeat(fits), spec())).toBe(true);
    expect(amendedPromptFits("€".repeat(fits + 1), spec())).toBe(false);
    expect(fits + 1).toBeLessThanOrEqual(TASK_REQUEST_LIMITS.prompt);
  });
});

describe("amendSpec", () => {
  test("appends after a blank line, or replaces", () => {
    expect(amendSpec(spec(), { taskId: "t", prompt: { mode: "append", text: "also" }, basis: BASIS })).toEqual(
      spec({ prompt: "do it\n\nalso" }),
    );
    expect(amendSpec(spec(), { taskId: "t", prompt: { mode: "replace", text: "new" }, basis: BASIS })).toEqual(
      spec({ prompt: "new" }),
    );
  });

  test("a replace with nothing drops the prompt", () => {
    const amended = amendSpec(spec(), { taskId: "t", prompt: { mode: "replace", text: "" }, basis: BASIS });
    expect(amended).toEqual({ repo: "github.com/acme/app", mode: "worktree" });
  });

  test("sets a field, keeps an absent one, and drops a null one", () => {
    const before = spec({ title: "t", model: "opus", effort: "high" });
    expect(amendSpec(before, { taskId: "t", title: "renamed", model: null })).toEqual({
      repo: "github.com/acme/app",
      mode: "worktree",
      prompt: "do it",
      title: "renamed",
      effort: "high",
    });
    expect(amendSpec(before, { taskId: "t", title: null, effort: null })).toEqual({
      repo: "github.com/acme/app",
      mode: "worktree",
      prompt: "do it",
      model: "opus",
    });
  });

  test("a successor takes an append only", () => {
    const succeeds = {
      task: "pred",
      account: "org:a",
      at: { deviceId: "a", exclave: "main", clone: "app" },
      trigger: "manual",
    } as const;
    const successor = spec({ succeeds });
    expect(amendSpec(successor, { taskId: "t", prompt: { mode: "replace", text: "x" }, basis: BASIS })).toBe(
      "append_only",
    );
    expect(amendSpec(successor, { taskId: "t", prompt: { mode: "append", text: "x" }, basis: BASIS })).toEqual(
      spec({ succeeds, prompt: "do it\n\nx" }),
    );
    // The fields beside the prompt are its own to change.
    expect(amendSpec(successor, { taskId: "t", title: "t" })).toEqual(spec({ succeeds, title: "t" }));
  });

  test("an amended prompt past its bound is prompt_too_long, the joining blank line counted", () => {
    const max = TASK_REQUEST_LIMITS.prompt;
    const full = spec({ prompt: "x".repeat(max - 3) });
    expect(amendSpec(full, { taskId: "t", prompt: { mode: "append", text: "y" }, basis: BASIS })).toEqual(
      spec({ prompt: `${"x".repeat(max - 3)}\n\ny` }),
    );
    expect(amendSpec(full, { taskId: "t", prompt: { mode: "append", text: "yy" }, basis: BASIS })).toBe(
      "prompt_too_long",
    );
    const attached = spec({ attachments: [ATTACHMENT] });
    expect(
      amendSpec(attached, {
        taskId: "t",
        prompt: { mode: "replace", text: "x".repeat(ATTACHMENT_LIMITS.prompt + 1) },
        basis: BASIS,
      }),
    ).toBe("prompt_too_long");
  });

  test("keeps every other field, sentinel-bearing ones included", () => {
    const before = spec({
      attachments: [ATTACHMENT],
      requires: ["atlas"],
      deps: [{ task: "a", after: "done" }],
      pin: { deviceId: "d", account: "org:a" },
      avoid: ["e"],
      autonomy: "steer",
    });
    const amended = amendSpec(before, {
      taskId: "t",
      prompt: { mode: "append", text: "also" },
      basis: BASIS,
      effort: "max",
    });
    expect(amended).toEqual({ ...before, prompt: "do it\n\nalso", effort: "max" });
  });
});

describe("amendedFields", () => {
  test("names the fields an amendment carries, null ones too, never a value", () => {
    expect(amendedFields({ taskId: "t", title: null, effort: "max" })).toEqual(["title", "effort"]);
    expect(amendedFields({ taskId: "t", prompt: { mode: "append", text: "secret" }, basis: BASIS })).toEqual([
      "prompt",
    ]);
  });
});
