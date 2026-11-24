import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STANDING_INSTRUCTION, type SpawnRequest } from "@seance/shared";
import { exclaveSettingsFile } from "../exclaves.ts";
import { OURS } from "../tmux.ts";
import { claudeDriver } from "./claude.ts";
import type { LaunchSpec } from "./driver.ts";

/**
 * Claude's command line, pinned byte for byte. The expected strings were captured from the spawn path before the
 * driver seam existed (docs/codex.md, "Build order" item 5), so a change here is a change to what every session
 * runs: make it on purpose, never to make this pass. The seed's own text is the spawn path's and is pinned by
 * `daemon/test/spawn.test.ts`; here only that it reaches the file the command redirects from, verbatim.
 */
const SI = `'${STANDING_INSTRUCTION.replaceAll("'", `'\\''`)}'`;
const CAFF = process.platform === "darwin" ? "caffeinate -is " : "";
const CONTINUED = "11111111-2222-4333-8444-555555555555";
const TASK = "t-0123456789abcdef";
const REPO = "/repos/my repo";
const WORKTREES = `${REPO}/.claude/worktrees`;
const SEED = 'a seed\'s "text"\n';
const READ_DIRS = ["/state/attachments/t1", "/state/attach'ments/t2"];

type Case = Omit<LaunchSpec, "name" | "home" | "exclave" | "readDirs"> & {
  readonly exclave?: string;
  readonly readDirs?: readonly string[];
};

const req = (request: Omit<SpawnRequest, "repo">): SpawnRequest => ({ repo: "myrepo", ...request });

const CASES: Record<string, Case> = {
  "here-untracked-bare": { request: req({ mode: "here" }), cwd: REPO },
  "here-untracked-prompt": { request: req({ mode: "here", prompt: "x" }), cwd: REPO, seed: SEED },
  "worktree-task": {
    request: req({ mode: "worktree", taskId: TASK, model: "sonnet", effort: "high", autonomy: "auto" }),
    cwd: `${WORKTREES}/fix-tests`,
    worktree: { clone: REPO, name: "fix-tests" },
    seed: SEED,
  },
  "worktree-untracked": {
    request: req({ mode: "worktree" }),
    cwd: `${WORKTREES}/fix-tests`,
    worktree: { clone: REPO, name: "fix-tests" },
    seed: SEED,
  },
  "stacked-task": {
    request: req({ mode: "worktree", taskId: TASK, baseBranch: "worktree-stack-a" }),
    cwd: `${WORKTREES}/stack-b`,
    worktree: { clone: REPO, name: "stack-b" },
    seed: SEED,
  },
  "unstacked-task": {
    request: req({ mode: "worktree", taskId: TASK, noBase: true }),
    cwd: `${WORKTREES}/solo`,
    worktree: { clone: REPO, name: "solo" },
    seed: SEED,
  },
  "continue-prompt": {
    request: req({ mode: "continue", taskId: TASK, continues: "t-fedcba9876543210", prompt: "go on" }),
    cwd: `${WORKTREES}/fix`,
    resume: CONTINUED,
    seed: SEED,
  },
  "continue-bare-handedoff": {
    request: req({ mode: "continue", taskId: TASK, continues: "t-fedcba9876543210" }),
    cwd: `${WORKTREES}/fix`,
    resume: CONTINUED,
    seed: SEED,
  },
  "steer-bypass": {
    request: req({ mode: "worktree", taskId: TASK, autonomy: "steer", plan: true }),
    cwd: `${WORKTREES}/plan-it`,
    worktree: { clone: REPO, name: "plan-it" },
    seed: SEED,
  },
  "steer-nobypass": {
    request: { repo: "other", mode: "worktree", taskId: TASK, autonomy: "steer", plan: true },
    cwd: "/repos/other/.claude/worktrees/plan-it",
    worktree: { clone: "/repos/other", name: "plan-it" },
    seed: SEED,
    exclave: "work",
  },
  "checkpoint-here-task": {
    request: req({ mode: "here", taskId: TASK, autonomy: "checkpoint" }),
    cwd: REPO,
    seed: SEED,
  },
  "attachments-task": {
    request: req({ mode: "worktree", taskId: TASK }),
    cwd: `${WORKTREES}/att`,
    worktree: { clone: REPO, name: "att" },
    seed: SEED,
    readDirs: READ_DIRS,
  },
  "attachments-only": { request: req({ mode: "here" }), cwd: REPO, seed: SEED, readDirs: READ_DIRS },
};

/** `<SEED>` stands for the seed file's directory, `<ID>` for the session id the driver chose. */
const EXPECTED: Record<string, { readonly command: string; readonly env: readonly string[]; readonly dir: string }> = {
  "here-untracked-bare": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium'`,
    env: [],
    dir: "/repos/my repo",
  },
  "here-untracked-prompt": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "worktree-task": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'sonnet' --effort 'high' --append-system-prompt ${SI} --worktree 'fix-tests' --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "worktree-untracked": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --worktree 'fix-tests' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "stacked-task": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --worktree 'stack-b' --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "unstacked-task": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --worktree 'solo' --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "continue-prompt": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --resume '${CONTINUED}' -- < '<SEED>/seed.txt'`,
    env: ["CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999", "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=99999999"],
    dir: "/repos/my repo/.claude/worktrees/fix",
  },
  "continue-bare-handedoff": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --resume '${CONTINUED}' -- < '<SEED>/seed.txt'`,
    env: ["CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999", "CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=99999999"],
    dir: "/repos/my repo/.claude/worktrees/fix",
  },
  "steer-bypass": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --permission-mode plan --allow-dangerously-skip-permissions --worktree 'plan-it' --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "steer-nobypass": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --permission-mode plan --worktree 'plan-it' --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/other",
  },
  "checkpoint-here-task": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --model 'opus' --effort 'medium' --append-system-prompt ${SI} --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "attachments-task": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --add-dir '/state/attachments/t1' --add-dir '/state/attach'\\''ments/t2' --model 'opus' --effort 'medium' --append-system-prompt ${SI} --worktree 'att' --session-id '<ID>' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
  "attachments-only": {
    command: `exec ${CAFF}/stub/bin/claude -n 'the-name (thad)' --remote-control --add-dir '/state/attachments/t1' --add-dir '/state/attach'\\''ments/t2' --model 'opus' --effort 'medium' -- < '<SEED>/seed.txt'`,
    env: [],
    dir: "/repos/my repo",
  },
};

describe("the Claude driver's launch", () => {
  const home = join(tmpdir(), `seance-claude-driver-${process.pid}-${crypto.randomUUID()}`);
  let savedBin: string | undefined;

  beforeAll(async () => {
    savedBin = process.env["SEANCE_CLAUDE_BIN"];
    process.env["SEANCE_CLAUDE_BIN"] = "/stub/bin/claude";
    await mkdir(home, { recursive: true });
    const settings = exclaveSettingsFile(home, "default");
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  });

  afterAll(async () => {
    if (savedBin === undefined) delete process.env["SEANCE_CLAUDE_BIN"];
    else process.env["SEANCE_CLAUDE_BIN"] = savedBin;
    await rm(home, { recursive: true, force: true });
  });

  test("every case is pinned", () => {
    expect(Object.keys(EXPECTED).toSorted()).toEqual(Object.keys(CASES).toSorted());
  });

  for (const [name, spec] of Object.entries(CASES)) {
    test(`${name}: the command line, environment and start directory are unchanged`, async () => {
      const launch = await claudeDriver.launch({
        ...spec,
        name: "the-name (thad)",
        home,
        exclave: spec.exclave ?? "default",
        readDirs: spec.readDirs ?? [],
      });
      const session = await launch.started("@1");
      const seedFile = /< '([^']+)'$/u.exec(launch.command)?.[1];
      try {
        if (spec.resume !== undefined) expect(session).toBe(spec.resume);
        else if (spec.request.taskId === undefined) expect(session).toBeUndefined();
        else expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
        expect(seedFile === undefined).toBe(spec.seed === undefined);
        let command = launch.command;
        if (seedFile !== undefined) {
          expect(await readFile(seedFile, "utf8")).toBe(spec.seed ?? "");
          command = command.replaceAll(dirname(seedFile), "<SEED>");
        }
        if (session !== undefined && spec.resume === undefined) command = command.replaceAll(session, "<ID>");
        expect({ command, env: launch.env, dir: launch.dir }).toEqual(
          EXPECTED[name] ?? { command: "", env: [], dir: "" },
        );
      } finally {
        await launch.dispose();
      }
      if (seedFile !== undefined) expect(await Bun.file(seedFile).exists()).toBe(false);
    });
  }
});

describe("Claude's panes", () => {
  test("a séance pane is marked by --remote-control in its start command, as before the seam", () => {
    expect(OURS).toBe("#{m:*--remote-control*,#{pane_start_command}}");
  });

  test("a hand-started claude is known by its process name: the symlink or the versioned binary", () => {
    for (const name of ["claude", "2.1.267"]) expect(claudeDriver.panes.command.test(name)).toBe(true);
    for (const name of ["node", "zsh", "claude-code", "bwrap"])
      expect(claudeDriver.panes.command.test(name)).toBe(false);
  });
});
