import { describe, expect, test } from "bun:test";
import { BATCH_STRATEGY, TASK_REQUEST_LIMITS, TASK_SPEC_LIMITS } from "@seance/shared";
import { specError, usesReported, type AutoSpec } from "./auto.ts";

const BASE: AutoSpec = { repo: "github.com/m/seance", mode: "worktree" };
const ID = "3f1c2b7e-9d4a-4c1e-8a55-0b6f2d9e7a10";

describe("specError", () => {
  test("a spec within every bound is accepted, authoring fields included", () => {
    expect(
      specError({
        ...BASE,
        prompt: "go",
        deps: [{ task: ID, after: "done" }],
        until: "reported",
        linear: { issue: "ENG-1", url: "https://linear.app/x/issue/ENG-1" },
        batch: { id: ID, index: 1, strategy: BATCH_STRATEGY },
      }),
    ).toBeNull();
  });

  test("the request bounds keep their wording", () => {
    expect(specError({ ...BASE, prompt: "x".repeat(TASK_REQUEST_LIMITS.prompt + 1) })).toStartWith("the prompt is");
  });

  test("each authoring bound is named, since the parser would only null the whole spec", () => {
    const tooMany = Array.from({ length: TASK_SPEC_LIMITS.deps + 1 }, () => ({ task: ID, after: "opened" as const }));
    expect(specError({ ...BASE, deps: tooMany })).toContain(`at most ${TASK_SPEC_LIMITS.deps}`);
    expect(specError({ ...BASE, deps: [{ task: "has a space", after: "opened" }] })).toContain("is not a task id");
    expect(specError({ ...BASE, linear: { issue: "" } })).toBe("linear.issue is empty");
    expect(specError({ ...BASE, linear: { issue: " \t " } })).toBe("linear.issue is empty");
    expect(specError({ ...BASE, linear: { issue: "E".repeat(TASK_SPEC_LIMITS.linearIssue + 1) } })).toContain(
      `at most ${TASK_SPEC_LIMITS.linearIssue}`,
    );
    expect(specError({ ...BASE, linear: { issue: "ENG-1", url: "http://linear.app/x" } })).toBe(
      "linear.url must be an https: URL",
    );
  });

  test("a batch the parser would refuse is caught by the backstop", () => {
    expect(
      specError({
        ...BASE,
        batch: { id: ID, index: TASK_SPEC_LIMITS.batchIndex + 1, strategy: BATCH_STRATEGY },
      }),
    ).toBe("invalid task spec");
  });
});

describe("usesReported", () => {
  test("only until reported or a done edge needs a leader that knows them", () => {
    expect(usesReported(BASE)).toBe(false);
    expect(usesReported({ deps: [{ task: ID, after: "merged" }] })).toBe(false);
    expect(usesReported({ until: "reported" })).toBe(true);
    expect(
      usesReported({
        deps: [
          { task: ID, after: "opened" },
          { task: ID, after: "done" },
        ],
      }),
    ).toBe(true);
  });
});
