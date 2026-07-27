import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpName, Plain, RepoEntry } from "@seance/shared";
import { createHandler, type HandlerContext } from "./handlers.ts";

// stdout is the daemon's audit transport (launchd redirects it into
// seanced.log), so capturing the console is capturing the artifact under test.
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

// "nope" fails the repo lookup before any git or tmux work, so the audit path
// is exercised without a machine underneath it.
const spawnNope = (extra: Record<string, unknown> = {}): Plain =>
  request("spawn", { repo: "nope", mode: "worktree", ...extra });

describe("relay ops are audited", () => {
  test("every op is recorded, not just spawn — enumeration at 3am is the same signal", async () => {
    await createHandler(ctx)(request("rescan", {}));
    expect(logged()).toContain('audit request op="rescan" id="req-1"');
  });

  test("a relay spawn is tagged as such, so it is distinguishable from one typed at the machine", async () => {
    await createHandler(ctx)(spawnNope());
    expect(logged()).toContain('audit spawn origin=relay repo="nope" mode=worktree');
  });

  test("the outcome carries the structured failure code", async () => {
    await createHandler(ctx)(spawnNope());
    expect(logged()).toContain("audit spawn origin=relay failed code=repo_not_found");
  });

  test("a malformed payload is recorded as rejected rather than passing silently", async () => {
    await createHandler(ctx)(request("spawn", { repo: "", mode: "nonsense" }));
    expect(logged()).toContain("audit spawn origin=relay rejected");
  });

  test("a newline in a wire value cannot forge an audit line", async () => {
    await createHandler(ctx)(request("spawn", { repo: 'x\ninfo audit spawn ok window="gotcha"', mode: "here" }));
    expect(logged()).not.toContain('window="gotcha"');
    expect(logged()).toContain("\\n");
  });
});
