import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpName, Plain, RepoEntry } from "@seance/shared";
import { createHandler, type HandlerContext } from "./handlers.ts";

// stdout is the audit trail's transport (launchd redirects it to seanced.log),
// so capturing the console is capturing the artifact under test.
const lines: string[] = [];
let realLog: typeof console.log;
let realError: typeof console.error;

beforeEach(() => {
  lines.length = 0;
  realLog = console.log;
  realError = console.error;
  console.log = (line: string): void => void lines.push(line);
  console.error = (line: string): void => void lines.push(line);
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
});

const REPOS: readonly RepoEntry[] = [{ name: "myrepo", path: "/repos/myrepo", defaultBranch: "main" }];

const ctx: HandlerContext = {
  tmuxSession: "main",
  getRepos: () => REPOS,
  rescan: () => Promise.resolve(REPOS),
};

const request = (op: OpName, payload: unknown): Plain => ({ id: "req-1", ts: Date.now(), op, payload });

const logged = (): string => lines.join("\n");

describe("audit trail", () => {
  test("every op is recorded, not just spawn — enumeration at 3am is the same signal", async () => {
    await createHandler(ctx)(request("rescan", {}));
    expect(logged()).toContain('audit request op="rescan" id="req-1"');
  });

  test("a spawn records its parameters with the prompt hashed, never quoted", async () => {
    // "nope" fails the repo lookup before any git or tmux work, so this
    // exercises the audit path without a machine underneath it.
    await createHandler(ctx)(request("spawn", { repo: "nope", mode: "worktree", prompt: "deploy the thing" }));
    expect(logged()).toContain('audit spawn repo="nope" mode=worktree');
    expect(logged()).toContain("promptLen=16");
    expect(logged()).toMatch(/promptSha=[0-9a-f]{8}/u);
    expect(logged()).not.toContain("deploy the thing");
  });

  test("an absent prompt is recorded as such rather than as an empty hash", async () => {
    await createHandler(ctx)(request("spawn", { repo: "nope", mode: "here" }));
    expect(logged()).toContain("prompt=none");
  });

  test("defaults are recorded as they will be applied, not as absent", async () => {
    await createHandler(ctx)(request("spawn", { repo: "nope", mode: "here" }));
    expect(logged()).toContain('model="opus" effort="medium"');
  });

  test("the outcome carries the structured failure code", async () => {
    await createHandler(ctx)(request("spawn", { repo: "nope", mode: "worktree" }));
    expect(logged()).toContain("audit spawn failed code=repo_not_found");
  });

  test("a malformed payload is recorded as rejected rather than passing silently", async () => {
    await createHandler(ctx)(request("spawn", { repo: "", mode: "nonsense" }));
    expect(logged()).toContain("audit spawn rejected");
  });

  test("a newline in a wire value cannot forge an audit line", async () => {
    await createHandler(ctx)(request("spawn", { repo: 'x\ninfo audit spawn ok window="gotcha"', mode: "here" }));
    expect(logged()).not.toContain('window="gotcha"');
    expect(logged()).toContain("\\n");
  });
});
