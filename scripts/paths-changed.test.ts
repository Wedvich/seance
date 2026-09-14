import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "paths-changed.sh");

let repo: string;

async function git(...args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

/** Paths are written as the workflow passes them: files nested under a watched dir. */
async function commit(paths: readonly string[], message: string): Promise<string> {
  for (const path of paths) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), `${message}\n`);
  }
  await git("add", "-A");
  await git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}

/** Runs the gate the way the workflow does, and reads back what the job would see. */
async function run(name: string, base: string, head: string, ...paths: readonly string[]) {
  const outputFile = join(repo, "github-output");
  await writeFile(outputFile, "");
  const proc = Bun.spawn([SCRIPT, name, base, head, ...paths], {
    cwd: repo,
    env: { ...process.env, GITHUB_OUTPUT: outputFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return {
    exitCode: await proc.exited,
    stdout: stdout.trim(),
    output: (await Bun.file(outputFile).text()).trim(),
  };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "paths-changed-"));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("commit", "-q", "--allow-empty", "-m", "root");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("a touched path is changed, and the job reads the same value stdout shows", async () => {
  const base = await git("rev-parse", "HEAD");
  const head = await commit(["pwa/src/app.tsx"], "app edit");

  const result = await run("pwa", base, head, "pwa", "shared");

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("pwa=true");
  expect(result.output).toBe("pwa=true");
});

test("an untouched path set is not changed", async () => {
  const base = await git("rev-parse", "HEAD");
  const head = await commit(["daemon/src/exec.ts"], "daemon edit");

  expect((await run("pwa", base, head, "pwa", "shared")).output).toBe("pwa=false");
});

test("paths are independent — any one of them matching is enough", async () => {
  const base = await git("rev-parse", "HEAD");
  const head = await commit(["shared/src/types.ts"], "shared edit");

  expect((await run("pwa", base, head, "pwa", "shared")).output).toBe("pwa=true");
});

// The three ways a base SHA can be undiffable. Each must deploy: skipping here ships
// nothing and reports success.
test.each([
  ["a branch's first push, where the base is all zeroes", "0".repeat(40)],
  ["an empty base", ""],
  ["a base the clone can't reach, as after a force-push", "0".repeat(39) + "1"],
])("%s deploys anyway", async (_name, base) => {
  const head = await commit(["daemon/src/exec.ts"], "unrelated edit");

  expect((await run("pwa", base, head, "pwa")).output).toBe("pwa=true");
});

/**
 * Regression: `--name-only | grep -q` let grep exit at the first match, and pipefail
 * turned the diff's SIGPIPE into a false answer. It only bites once the path list
 * outgrows the pipe buffer, so this needs to be a genuinely large diff — a directory
 * rename or an asset drop reaches it easily.
 */
test("a diff too large for a pipe buffer is still changed", async () => {
  const base = await git("rev-parse", "HEAD");
  const many = Array.from({ length: 500 }, (_, i) => `pwa/src/components/some-long-component-name-${i}.tsx`);
  const head = await commit(many, "big refactor");

  expect((await run("pwa", base, head, "pwa")).output).toBe("pwa=true");
});

test("the name argument keys the output, so one job can gate several components", async () => {
  const base = await git("rev-parse", "HEAD");
  const head = await commit(["relay/src/hub.ts"], "relay edit");

  expect((await run("relay", base, head, "relay", "shared")).output).toBe("relay=true");
  expect((await run("pwa", base, head, "pwa", "shared")).output).toBe("pwa=false");
});

test("too few arguments is a usage error, not a silent false", async () => {
  const head = await git("rev-parse", "HEAD");

  const result = await run("pwa", head, head);

  expect(result.exitCode).toBe(2);
  expect(result.output).toBe("");
});
