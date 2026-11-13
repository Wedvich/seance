import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoTrusted, isDirTrusted } from "./trust.ts";

let dir: string;

// A fresh config dir per test: the module memoizes per (config, repo) pair,
// so unique paths also keep the memo from leaking between tests.
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-trust-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function configPath(): string {
  return join(dir, ".claude.json");
}

interface TestConfig {
  readonly projects?: Record<string, Record<string, unknown> | undefined>;
  readonly [key: string]: unknown;
}

async function readConfig(): Promise<TestConfig> {
  return JSON.parse(await readFile(configPath(), "utf8")) as TestConfig;
}

describe("ensureRepoTrusted", () => {
  test("never creates claude's config — a machine claude hasn't run on is left alone", async () => {
    await ensureRepoTrusted(join(dir, "repo"), configPath());
    expect(await Bun.file(configPath()).exists()).toBe(false);
  });

  test("sets the flag, preserving unrelated config and the repo's other keys", async () => {
    const repo = join(dir, "repo");
    const other = join(dir, "other");
    await writeFile(
      configPath(),
      JSON.stringify({
        numStartups: 5,
        projects: {
          [repo]: { allowedTools: ["Bash"] },
          [other]: { hasTrustDialogAccepted: false },
        },
      }),
    );

    await ensureRepoTrusted(repo, configPath());

    const config = await readConfig();
    expect(config.projects?.[repo]?.["hasTrustDialogAccepted"]).toBe(true);
    expect(config.projects?.[repo]?.["allowedTools"]).toEqual(["Bash"]);
    expect(config["numStartups"]).toBe(5);
    expect(config.projects?.[other]?.["hasTrustDialogAccepted"]).toBe(false);
  });

  test("creates the projects map and entry for a repo claude has never opened", async () => {
    const repo = join(dir, "repo");
    await writeFile(configPath(), JSON.stringify({ firstStartTime: "2026-01-01" }));

    await ensureRepoTrusted(repo, configPath());

    const config = await readConfig();
    expect(config.projects?.[repo]?.["hasTrustDialogAccepted"]).toBe(true);
    expect(config["firstStartTime"]).toBe("2026-01-01");
  });

  test("already trusted: the file is not rewritten", async () => {
    const repo = join(dir, "repo");
    // compact JSON — any rewrite would re-indent, so byte equality proves no write
    const original = JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } });
    await writeFile(configPath(), original);

    await ensureRepoTrusted(repo, configPath());

    expect(await readFile(configPath(), "utf8")).toBe(original);
  });

  test("memoized per run: an external revert is not fought until restart", async () => {
    const repo = join(dir, "repo");
    await writeFile(configPath(), JSON.stringify({ projects: {} }));
    await ensureRepoTrusted(repo, configPath());

    await writeFile(configPath(), JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: false } } }));
    await ensureRepoTrusted(repo, configPath());

    expect((await readConfig()).projects?.[repo]?.["hasTrustDialogAccepted"]).toBe(false);
  });

  test("corrupt config is left untouched and nothing throws", async () => {
    const repo = join(dir, "repo");
    await writeFile(configPath(), "not json {{{");

    await ensureRepoTrusted(repo, configPath());

    expect(await readFile(configPath(), "utf8")).toBe("not json {{{");
  });

  test("preserves the file's mode (claude keeps it 0600)", async () => {
    const repo = join(dir, "repo");
    await writeFile(configPath(), JSON.stringify({ projects: {} }));
    await chmod(configPath(), 0o600);

    await ensureRepoTrusted(repo, configPath());

    expect((await stat(configPath())).mode & 0o777).toBe(0o600);
    expect((await readConfig()).projects?.[repo]?.["hasTrustDialogAccepted"]).toBe(true);
  });

  test("concurrent spawns of different repos both land — writes are serialized", async () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await writeFile(configPath(), JSON.stringify({ projects: {} }));

    await Promise.all([ensureRepoTrusted(a, configPath()), ensureRepoTrusted(b, configPath())]);

    const config = await readConfig();
    expect(config.projects?.[a]?.["hasTrustDialogAccepted"]).toBe(true);
    expect(config.projects?.[b]?.["hasTrustDialogAccepted"]).toBe(true);
  });
});

describe("isDirTrusted", () => {
  const roundDir = (): string => join(dir, "root", ".seance-custodian");

  async function write(projects: unknown): Promise<void> {
    await writeFile(configPath(), JSON.stringify({ projects }), { mode: 0o600 });
  }

  test("the dir's own entry, or an ancestor's, counts; neither does not", async () => {
    await write({ [roundDir()]: { hasTrustDialogAccepted: true } });
    expect(await isDirTrusted(roundDir(), configPath())).toBe(true);
    await write({ [join(dir, "root")]: { hasTrustDialogAccepted: true } });
    expect(await isDirTrusted(roundDir(), configPath())).toBe(true);
    await write({
      [roundDir()]: { hasTrustDialogAccepted: false },
      [join(dir, "other")]: { hasTrustDialogAccepted: true },
    });
    expect(await isDirTrusted(roundDir(), configPath())).toBe(false);
    await write({ "/": { hasTrustDialogAccepted: true } });
    expect(await isDirTrusted(roundDir(), configPath())).toBe(true);
  });

  test("a missing file, malformed JSON and an unexpected shape are not trusted", async () => {
    expect(await isDirTrusted(roundDir(), configPath())).toBe(false);
    await writeFile(configPath(), "{not json");
    expect(await isDirTrusted(roundDir(), configPath())).toBe(false);
    await write("nope");
    expect(await isDirTrusted(roundDir(), configPath())).toBe(false);
    await write([roundDir()]);
    expect(await isDirTrusted(roundDir(), configPath())).toBe(false);
    await write({ [roundDir()]: "yes" });
    expect(await isDirTrusted(roundDir(), configPath())).toBe(false);
  });

  test("never writes: the file's bytes and mtime are unchanged", async () => {
    await write({ [roundDir()]: { hasTrustDialogAccepted: false } });
    const before = { text: await readFile(configPath(), "utf8"), mtime: (await stat(configPath())).mtimeMs };
    await isDirTrusted(roundDir(), configPath());
    expect({ text: await readFile(configPath(), "utf8"), mtime: (await stat(configPath())).mtimeMs }).toEqual(before);
  });
});
