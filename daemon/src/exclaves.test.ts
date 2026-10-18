import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeConfigTargets,
  describeExclave,
  exclaveOf,
  listExclaves,
  scanExclaves,
  tagExclaves,
  userScopeTargets,
} from "./exclaves.ts";

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A home dir; returned lexical, like `homedir()` — the tests check the daemon canonicalises. */
async function makeHome(exclavesFile?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "seance-home-"));
  cleanups.push(home);
  if (exclavesFile !== undefined) await writeFile(join(home, ".exclaves"), exclavesFile);
  return home;
}

/** A skill as Claude Code resolves one: a dir under `<configDir>/skills/` holding a `SKILL.md`. */
async function skill(configDir: string, name: string): Promise<string> {
  const dir = join(configDir, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return dir;
}

async function writeClaudeJson(configDir: string, content: unknown): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, ".claude.json"), typeof content === "string" ? content : JSON.stringify(content));
}

const account = { organizationUuid: "org-1", accountUuid: "acct-1", hasExtraUsageEnabled: true, emailAddress: "x@y" };
const seated = { ...account, seatTier: "team_tier_1" };

describe("listExclaves", () => {
  test("default is always first, then the file's names in order, canonical roots", async () => {
    const home = await makeHome("work\nplay\n");
    await mkdir(join(home, "work"));
    const { exclaves, rejected } = await listExclaves(home);
    expect(rejected).toEqual([]);
    expect(exclaves.map((e) => e.id)).toEqual(["default", "work", "play"]);
    expect(exclaves[0]?.root).toBe(await realpath(home));
    expect(exclaves[0]?.configDir).toBe(join(home, ".claude"));
    expect(exclaves[0]?.configFile).toBe(join(home, ".claude.json"));
    expect(exclaves[1]?.root).toBe(await realpath(join(home, "work")));
    expect(exclaves[1]?.configDir).toBe(join(home, ".claude-work"));
    expect(exclaves[1]?.configFile).toBe(join(home, ".claude-work", ".claude.json"));
    // A tree that doesn't exist yet still names an exclave; its root stays lexical.
    expect(exclaves[2]?.root).toBe(join(home, "play"));
  });

  test("a stray line costs one exclave, not the scan — and `default` is a stray line", async () => {
    const home = await makeHome("ok\n# comment\nBad Name\n-leading\ndefault\n\n  padded  \r\nok\n");
    const { exclaves, rejected } = await listExclaves(home);
    expect(exclaves.map((e) => e.id)).toEqual(["default", "ok", "padded"]);
    expect(rejected).toEqual(["# comment", "Bad Name", "-leading", "default"]);
  });

  test("no file, no trailing newline", async () => {
    expect((await listExclaves(await makeHome())).exclaves.map((e) => e.id)).toEqual(["default"]);
    expect((await listExclaves(await makeHome("solo"))).exclaves.map((e) => e.id)).toEqual(["default", "solo"]);
  });
});

/** A named exclave as `listExclaves` builds it. */
function named(home: string, name: string): { id: string; root: string; configDir: string; configFile: string } {
  const configDir = join(home, `.claude-${name}`);
  return { id: name, root: join(home, name), configDir, configFile: join(configDir, ".claude.json") };
}

describe("describeExclave", () => {
  test("reads account ids, email, the extra-usage flag and the seat tier, never the rest", async () => {
    const home = await makeHome();
    await writeClaudeJson(join(home, ".claude-work"), { oauthAccount: seated, cachedUsageUtilization: {} });
    await skill(join(home, ".claude-work"), "dataviz");
    await skill(join(home, ".claude-work"), "alpha");
    const info = await describeExclave(named(home, "work"));
    expect(info).toEqual({
      id: "work",
      accountId: "org-1:acct-1",
      email: "x@y",
      extraUsageEnabled: true,
      seatTier: "team_tier_1",
      authOk: true,
      skills: ["alpha", "dataviz"],
    });
  });

  test("a skill is a dir, or a symlink to one, holding a SKILL.md; everything else is skipped", async () => {
    const home = await makeHome();
    const configDir = join(home, ".claude-work");
    const skills = join(configDir, "skills");
    await skill(configDir, "kept");
    await skill(configDir, ".hidden");
    // A dotfiles checkout elsewhere, linked in — counted through the link.
    const target = await skill(join(home, "dotfiles"), "linked");
    await symlink(target, join(skills, "linked"));
    await symlink(join(home, "dotfiles", "skills", "gone"), join(skills, "dangling"));
    await mkdir(join(skills, "synced"));
    await writeFile(join(skills, "synced", "notes.md"), "");
    await mkdir(join(skills, "odd", "SKILL.md"), { recursive: true });
    await writeFile(join(skills, "README.md"), "");
    const info = await describeExclave(named(home, "work"));
    expect(info.skills).toEqual(["kept", "linked"]);
  });

  test("a SKILL.md that is a symlink to a regular file counts: stat follows it", async () => {
    const home = await makeHome();
    const configDir = join(home, ".claude-work");
    const dir = join(configDir, "skills", "linked-md");
    await mkdir(dir, { recursive: true });
    await writeFile(join(home, "real-skill.md"), "");
    await symlink(join(home, "real-skill.md"), join(dir, "SKILL.md"));
    const info = await describeExclave(named(home, "work"));
    expect(info.skills).toEqual(["linked-md"]);
  });

  test("signed out: no config dir, unparsable json, or no oauthAccount", async () => {
    const home = await makeHome();
    const signedOut = { accountId: null, extraUsageEnabled: null, authOk: false, skills: [] };
    expect(await describeExclave(named(home, "missing"))).toEqual({ id: "missing", ...signedOut });
    await writeClaudeJson(join(home, ".claude-garbled"), "{not json");
    expect(await describeExclave(named(home, "garbled"))).toEqual({ id: "garbled", ...signedOut });
    await writeClaudeJson(join(home, ".claude-fresh"), { numStartups: 3 });
    expect(await describeExclave(named(home, "fresh"))).toEqual({ id: "fresh", ...signedOut });
  });

  test("a torn read keeps the previous account, skills read fresh; a missing file does not", async () => {
    const home = await makeHome("busy\n");
    await writeClaudeJson(join(home, ".claude-busy"), { oauthAccount: seated });
    const first = await scanExclaves(home);
    await writeClaudeJson(join(home, ".claude-busy"), '{"oauthAccount": {"organizationUuid": "or');
    await skill(join(home, ".claude-busy"), "alpha");
    const torn = await scanExclaves(home, first.info);
    expect(torn.info[1]).toEqual({
      id: "busy",
      accountId: "org-1:acct-1",
      email: "x@y",
      extraUsageEnabled: true,
      seatTier: "team_tier_1",
      authOk: true,
      skills: ["alpha"],
    });
    await rm(join(home, ".claude-busy", ".claude.json"));
    const gone = await scanExclaves(home, torn.info);
    expect(gone.info[1]).toEqual({
      id: "busy",
      accountId: null,
      extraUsageEnabled: null,
      authOk: false,
      skills: ["alpha"],
    });
  });

  test("an account with ids missing is signed in with no id, extra usage unknown, a mistyped tier left out", async () => {
    const home = await makeHome();
    await writeClaudeJson(join(home, ".claude-partial"), { oauthAccount: { emailAddress: "x@y", seatTier: 7 } });
    const info = await describeExclave(named(home, "partial"));
    expect(info).toEqual({
      id: "partial",
      accountId: null,
      email: "x@y",
      extraUsageEnabled: null,
      authOk: true,
      skills: [],
    });
  });

  test("a missing, empty or mistyped email is left out, not reported", async () => {
    const home = await makeHome();
    const { emailAddress: _, ...noEmail } = account;
    for (const [name, oauthAccount] of [
      ["none", noEmail],
      ["empty", { ...account, emailAddress: "" }],
      ["typed", { ...account, emailAddress: 7 }],
    ] as const) {
      await writeClaudeJson(join(home, `.claude-${name}`), { oauthAccount });
      expect(await describeExclave(named(home, name))).not.toHaveProperty("email");
    }
  });
});

describe("exclaveOf", () => {
  const exclaves = [
    { id: "default", root: "/home/u", configDir: "/home/u/.claude", configFile: "/home/u/.claude.json" },
    {
      id: "work",
      root: "/home/u/work",
      configDir: "/home/u/.claude-work",
      configFile: "/home/u/.claude-work/.claude.json",
    },
    {
      id: "work-2",
      root: "/home/u/work-2",
      configDir: "/home/u/.claude-work-2",
      configFile: "/home/u/.claude-work-2/.claude.json",
    },
  ];

  test("longest named root wins; the rest of home and anything outside it is default", () => {
    expect(exclaveOf("/home/u/work/repo", exclaves)).toBe("work");
    expect(exclaveOf("/home/u/work", exclaves)).toBe("work");
    expect(exclaveOf("/home/u/work-2/org/repo", exclaves)).toBe("work-2");
    expect(exclaveOf("/home/u/work-23/repo", exclaves)).toBe("default"); // prefix, not a path component
    expect(exclaveOf("/home/u/repos/x", exclaves)).toBe("default");
    expect(exclaveOf("/srv/repos/x", exclaves)).toBe("default");
  });

  test("tagExclaves stamps every entry and keeps the rest", () => {
    const repos = [
      { name: "a", path: "/home/u/work/a", defaultBranch: "main", origin: "github.com/o/a" },
      { name: "b", path: "/home/u/b", defaultBranch: null },
    ];
    expect(tagExclaves(repos, exclaves)).toEqual([
      { ...repos[0]!, exclave: "work" },
      { ...repos[1]!, exclave: "default" },
    ]);
  });
});

describe("scanExclaves", () => {
  test("info lines up with exclaves by position, through a symlinked home", async () => {
    const real = await makeHome("work\n");
    await writeFile(join(real, ".claude.json"), JSON.stringify({ oauthAccount: account }));
    await mkdir(join(real, "work"));
    const link = join(await makeHome(), "home-link");
    await symlink(real, link);

    const scan = await scanExclaves(link);
    expect(scan.exclaves.map((e) => e.id)).toEqual(["default", "work"]);
    expect(scan.info.map((i) => i.id)).toEqual(["default", "work"]);
    expect(scan.info[0]?.authOk).toBe(true);
    expect(scan.info[1]?.authOk).toBe(false);
    // Roots are canonical, so the scan's realpath'd repo paths map.
    expect(exclaveOf(join(await realpath(real), "work", "repo"), scan.exclaves)).toBe("work");
  });

  test("default's account is ~/.claude.json, not the stub that can sit in ~/.claude", async () => {
    const home = await makeHome();
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: account }));
    await writeClaudeJson(join(home, ".claude"), { numStartups: 1 });
    await skill(join(home, ".claude"), "alpha");
    const { info } = await scanExclaves(home);
    expect(info).toEqual([
      {
        id: "default",
        accountId: "org-1:acct-1",
        email: "x@y",
        extraUsageEnabled: true,
        authOk: true,
        skills: ["alpha"],
      },
    ]);
  });
});

describe("claudeConfigTargets", () => {
  test("default unsets CLAUDE_CONFIG_DIR, each named exclave sets its own dir", async () => {
    const home = await makeHome("work\n");
    const { exclaves } = await listExclaves(home);
    expect(claudeConfigTargets(exclaves, undefined)).toEqual([
      { label: "default", configDir: join(home, ".claude"), env: { CLAUDE_CONFIG_DIR: undefined } },
      { label: "work", configDir: join(home, ".claude-work"), env: { CLAUDE_CONFIG_DIR: join(home, ".claude-work") } },
    ]);
  });

  test("an ambient dir is added once, only when no exclave owns it", async () => {
    const home = await makeHome("work\n");
    const { exclaves } = await listExclaves(home);
    expect(claudeConfigTargets(exclaves, join(home, ".claude-work"))).toHaveLength(2);
    expect(claudeConfigTargets(exclaves, "")).toHaveLength(2);
    const extra = claudeConfigTargets(exclaves, "/elsewhere/claude");
    expect(extra.map((t) => t.label)).toEqual(["default", "work", "/elsewhere/claude"]);
    expect(extra[2]?.env).toEqual({ CLAUDE_CONFIG_DIR: "/elsewhere/claude" });
  });
});

describe("userScopeTargets", () => {
  test("every exclave whose config dir exists is present; one never set up is missing, not created", async () => {
    const home = await makeHome("work\ngone\n");
    await mkdir(join(home, ".claude"));
    await mkdir(join(home, ".claude-work"));
    // An inherited one would be an extra, ambient target — a developer's shell has it where CI doesn't.
    const ambient = process.env["CLAUDE_CONFIG_DIR"];
    delete process.env["CLAUDE_CONFIG_DIR"];
    try {
      const { present, missing } = await userScopeTargets(home);
      expect(present.map((t) => t.label)).toEqual(["default", "work"]);
      expect(present[1]?.env).toEqual({ CLAUDE_CONFIG_DIR: join(home, ".claude-work") });
      expect(missing.map((t) => t.configDir)).toEqual([join(home, ".claude-gone")]);
    } finally {
      if (ambient !== undefined) process.env["CLAUDE_CONFIG_DIR"] = ambient;
    }
  });
});
