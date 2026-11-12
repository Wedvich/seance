import { describe, expect, test } from "bun:test";
import { TASK_REQUEST_LIMITS, TASK_SPEC_LIMITS } from "@seance/shared";
import { machine } from "../test/fake-app-relay.ts";
import { specError, traitsRefusal, usesReported, type AutoSpec } from "./auto.ts";

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
        batch: { id: ID, index: 1 },
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
        batch: { id: ID, index: TASK_SPEC_LIMITS.batchIndex + 1 },
      }),
    ).toBe("invalid task spec");
  });
});

describe("specError, requires", () => {
  test("a bounded list of trait names is accepted", () => {
    expect(specError({ ...BASE, requires: ["atlas", "gpu-2"] })).toBeNull();
    expect(specError({ ...BASE, requires: ["a", "b", "c", "d"] })).toBeNull();
  });

  test("each bound is named, since the parser would only null the whole spec", () => {
    expect(specError({ ...BASE, requires: [] })).toContain("requires is empty");
    expect(specError({ ...BASE, requires: ["a", "b", "c", "d", "e"] })).toContain(
      `at most ${TASK_SPEC_LIMITS.requires}`,
    );
    expect(specError({ ...BASE, requires: ["Atlas"] })).toContain('"Atlas" is not a trait name');
    expect(specError({ ...BASE, requires: ["-x"] })).toContain("is not a trait name");
    expect(specError({ ...BASE, requires: ["a".repeat(33)] })).toContain("is not a trait name");
    expect(specError({ ...BASE, requires: ["atlas", "atlas"] })).toBe("requires names a trait twice");
  });
});

describe("traitsRefusal", () => {
  const exclave = (id: string, traits: readonly string[], accountId = `org:${id}`) => ({
    id,
    accountId,
    extraUsageEnabled: false,
    authOk: true,
    skills: [],
    ...(traits.length === 0 ? {} : { traits }),
  });
  const fleet = [
    machine({ deviceId: "d-1", name: "Thad", exclaves: [exclave("default", ["atlas"]), exclave("work", ["az"])] }),
    machine({ deviceId: "d-2", name: "WSL", exclaves: [exclave("default", ["atlas", "az"], "org:wsl")] }),
    machine({ deviceId: "d-3", name: "Mac", exclaves: [exclave("default", ["gpu"])] }),
  ];

  test("a name no machine declares is unknown, counted, and listed with the names that exist", () => {
    const refusal = traitsRefusal({ requires: ["atlas", "nope", "nada"] }, fleet);
    expect(refusal).toEqual({
      kind: "unknown_trait",
      text: "no machine declares the traits nope, nada — known: atlas, az, gpu",
      count: 2,
    });
  });

  test("a typo is reported before reachability, even where the pin would also have refused it", () => {
    expect(traitsRefusal({ requires: ["nope"], pin: { deviceId: "d-3" } }, fleet)?.kind).toBe("unknown_trait");
  });

  test("(a) a pin to a machine whose exclaves each carry one of the traits, (b) the avoid of the only holder", () => {
    expect(traitsRefusal({ requires: ["atlas", "az"], pin: { deviceId: "d-1" } }, fleet)?.kind).toBe(
      "unreachable_trait",
    );
    expect(traitsRefusal({ requires: ["gpu"], avoid: ["d-3"] }, fleet)).toMatchObject({
      kind: "unreachable_trait",
      count: 1,
    });
    expect(traitsRefusal({ requires: ["atlas"], pin: { account: "org:wsl" }, avoid: ["d-2"] }, fleet)?.kind).toBe(
      "unreachable_trait",
    );
  });

  test("(c) the same specs without the restriction place, and a spec requiring nothing is never checked", () => {
    expect(traitsRefusal({ requires: ["atlas", "az"] }, fleet)).toBeNull();
    expect(traitsRefusal({ requires: ["gpu"] }, fleet)).toBeNull();
    expect(traitsRefusal({ requires: ["atlas"], pin: { account: "org:wsl" } }, fleet)).toBeNull();
    expect(traitsRefusal({ pin: { deviceId: "d-3" }, avoid: ["d-3"] }, [])).toBeNull();
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
