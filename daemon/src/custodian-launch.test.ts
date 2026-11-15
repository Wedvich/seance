import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dedupeNested,
  ensureRoundDir,
  existingPaths,
  PROTECTED_DIRS,
  PROTECTED_NAMES,
  roundCommand,
  roundDirPlanted,
  roundEnv,
  roundReadDenies,
  roundSandboxPaths,
  roundScript,
  sandboxMasks,
  seancedShim,
  toolchainProblem,
  type RoundToolchain,
} from "./custodian-launch.ts";
import { DEFAULT_EXCLAVE } from "./exclaves.ts";
import { shq } from "./spawn.ts";
import { scriptStub } from "../test/fixtures.ts";

let base = "";
let stubs = "";

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "custodian-launch-")));
  stubs = join(base, "stubs");
  await mkdir(stubs);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const toolchain = {
  bun: "/home/u/.bun/bin/bun",
  bunReal: "/home/u/.bun/bin/bun",
  bunShim: false,
  checkout: "/home/u/seance",
} as const;

const entries = (...names: readonly string[]): { name: string; real: string }[] =>
  names.map((name) => ({ name: name.slice(1), real: name }));

describe("dedupeNested", () => {
  test("drops a path under another and a repeat; keeps a sibling sharing only a name prefix", () => {
    expect(dedupeNested(["/a/b", "/a", "/ab", "/a/b/c", "/ab"])).toEqual(["/a", "/ab"]);
  });
});

describe("roundSandboxPaths", () => {
  const common = {
    home: "/home/u",
    state: "/home/u/.local/state/seance",
    config: "/home/u/.config/seance",
    tmuxSocketDir: "/tmp/tmux-1000",
    roundDir: "/home/u/.local/state/seance/custodian/cwd",
    tmpDir: "/tmp/seance-cu-abc",
    socketDir: "/tmp/seance-cu-s-abc",
    toolchain,
    extraMasks: ["/home/u/code", toolchain.checkout],
  } as const;

  test("Linux masks every top-level entry but the system dirs, judged by where a symlink lands", () => {
    const { denyRead } = roundSandboxPaths({
      ...common,
      platform: "linux",
      rootEntries: [
        ...entries("/usr", "/etc", "/proc", "/dev", "/sys", "/home", "/var", "/tmp", "/run", "/mnt", "/opt", "/nix"),
        { name: "bin", real: "/usr/bin" },
        { name: "lib", real: "/usr/lib" },
        { name: "srv", real: "/srv" },
      ],
    });
    for (const masked of ["/home", "/var", "/tmp", "/run", "/mnt", "/opt", "/nix", "/srv"]) {
      expect(denyRead).toContain(masked);
    }
    for (const open of ["/usr", "/etc", "/proc", "/dev", "/sys", "/usr/bin", "/usr/lib"]) {
      expect(denyRead).not.toContain(open);
    }
    // Everything under a masked entry is nested, so none is listed beside it.
    expect(denyRead).not.toContain("/home/u");
    expect(denyRead).not.toContain("/tmp/tmux-1000");
  });

  test("macOS names its roots and keeps the machine's own paths", () => {
    const { denyRead } = roundSandboxPaths({
      ...common,
      platform: "darwin",
      home: "/Users/u",
      extraMasks: ["/Users/u/code"],
      rootEntries: [],
    });
    expect(denyRead).toEqual(
      expect.arrayContaining([
        "/Users",
        "/opt",
        "/usr/local",
        "/private/tmp",
        "/private/var/folders",
        "/private/var/tmp",
        "/Library/Keychains",
        "/Volumes",
      ]),
    );
    // `/Users/u` and `/Users/u/code` sit under `/Users`.
    expect(denyRead).not.toContain("/Users/u");
    expect(denyRead).not.toContain("/Users/u/code");
  });

  test("macOS masks and re-allows every path under the Data volume's mount point too, and Linux does not", () => {
    const darwin = roundSandboxPaths({
      ...common,
      platform: "darwin",
      home: "/Users/u",
      state: "/Users/u/.local/state/seance",
      toolchain: { ...toolchain, bun: "/opt/homebrew/bin/bun", bunReal: "/opt/homebrew/Cellar/bun/1.4.4/bin/bun" },
      extraMasks: ["/Users/u/code"],
      rootEntries: [],
    });
    // The user's paths sit under `/Users`' alias; the system masks are aliased too (their own entries, not just a copy).
    expect(darwin.denyRead).toContain("/System/Volumes/Data/Users");
    expect(darwin.denyRead).not.toContain("/System/Volumes/Data/Users/u/code");
    for (const root of ["/opt", "/usr/local", "/private/tmp", "/private/var/folders", "/private/var/tmp"]) {
      expect(darwin.denyRead).toContain(`/System/Volumes/Data${root}`);
    }
    // An allow entry is in both forms as well, so it beats its mask in whichever one Seatbelt matches.
    expect(darwin.allowRead).toEqual(
      expect.arrayContaining(["/opt/homebrew/bin", "/System/Volumes/Data/opt/homebrew/bin"]),
    );
    // The guarded list is the masks before any entry is dropped as nested: the home is there beside `/Users`.
    expect(darwin.guarded).toEqual(expect.arrayContaining(["/Users/u", "/System/Volumes/Data/Users/u/code"]));
    const linux = roundSandboxPaths({ ...common, platform: "linux", rootEntries: entries("/usr", "/etc") });
    expect(linux.denyRead.some((path) => path.startsWith("/System/Volumes"))).toBe(false);
    expect(linux.allowRead.some((path) => path.startsWith("/System/Volumes"))).toBe(false);
  });

  test("with no root entry covering them, the home and the tmux dir are masked, and the paths under the home are nested", () => {
    const { denyRead } = roundSandboxPaths({ ...common, platform: "linux", rootEntries: entries("/usr", "/etc") });
    expect(denyRead).toEqual(["/home/u", "/tmp/tmux-1000"]);
  });

  test("allows the round's dirs and the checkout's loaded parts, never the whole checkout, never relay/", () => {
    const { allowRead } = roundSandboxPaths({ ...common, platform: "linux", rootEntries: entries("/usr", "/home") });
    expect(allowRead).toContain(common.roundDir);
    expect(allowRead).toContain(common.tmpDir);
    expect(allowRead).toContain(common.socketDir);
    expect(allowRead).toContain(join(toolchain.checkout, "daemon"));
    expect(allowRead).toContain(join(toolchain.checkout, "shared"));
    expect(allowRead).toContain(join(toolchain.checkout, "node_modules"));
    expect(allowRead).toContain("/home/u/.bun/bin");
    expect(allowRead).not.toContain(toolchain.checkout);
    expect(allowRead.some((path) => path.includes("relay"))).toBe(false);
    expect(allowRead.some((path) => path === common.home)).toBe(false);
  });
});

describe("roundReadDenies", () => {
  const o = {
    home: "/home/u",
    state: "/home/u/.local/state/seance",
    config: "/home/u/.config/seance",
    tmpDirs: ["/tmp/seance-cu-abc", "/private/tmp/seance-cu-abc"],
    flagsPaths: ["/home/u/.local/state/seance/custodian/sessions.json"],
  } as const;
  const paths = (list: readonly { path: string }[]): string[] => list.map((entry) => entry.path);

  test("the default exclave: the daemon's secrets, the home's and its own credentials; no state dir deny", () => {
    const denies = roundReadDenies({
      ...o,
      platform: "linux",
      exclave: { id: DEFAULT_EXCLAVE, configDir: "/home/u/.claude" },
    });
    expect(paths(denies)).toEqual(
      expect.arrayContaining([
        "/home/u/.local/state/seance/state.json",
        "/home/u/.config/seance",
        "/home/u/.ssh",
        "/home/u/.gnupg",
        "/home/u/.config/gh",
        "/home/u/.netrc",
        "/home/u/.claude/.credentials.json",
        "/home/u/.claude/projects",
        ...o.tmpDirs,
      ]),
    );
    // The flags file's notes quote pane text: the Read tool does not read them back.
    expect(denies).toContainEqual({ path: o.flagsPaths[0], dir: false });
    // The default exclave's round dir lives under the state dir, and a deny beats an allow.
    expect(denies).not.toContainEqual({ path: o.state, dir: true });
    expect(paths(denies)).not.toContain("/home/u/Library/Keychains");
  });

  test("a named exclave also denies the default's credentials; macOS adds the keychains", () => {
    const denies = roundReadDenies({
      ...o,
      platform: "darwin",
      exclave: { id: "work", configDir: "/home/u/.claude-work" },
    });
    expect(paths(denies)).toEqual(
      expect.arrayContaining([
        "/home/u/.claude-work/.credentials.json",
        "/home/u/.claude/.credentials.json",
        "/home/u/Library/Keychains",
      ]),
    );
    expect(denies.find((entry) => entry.path === "/home/u/Library/Keychains")?.dir).toBe(true);
    expect(denies.find((entry) => entry.path === "/home/u/.netrc")?.dir).toBe(false);
  });
});

describe("toolchainProblem", () => {
  const ok: RoundToolchain = { ...toolchain, main: "/home/u/seance/daemon/src/main.ts" };
  const guarded = ["/home/u", "/home/u/.local/state/seance", "/home/u/.config/seance", "/home/u/code"];

  test("null when bun and main.ts sit under what the sandbox re-allows and cover nothing guarded", () => {
    expect(toolchainProblem(ok, guarded)).toBeNull();
  });

  test("a main outside <checkout>/daemon/ is a problem", () => {
    expect(toolchainProblem({ ...ok, main: "/home/u/seance/relay/src/main.ts" }, guarded)).toMatch(
      /daemon\/src\/main\.ts/u,
    );
    expect(toolchainProblem({ ...ok, main: "/home/u/main.ts" }, guarded)).not.toBeNull();
  });

  test("a bun that is a version manager's shim is refused: its real binary is outside every allow entry", () => {
    const shim = { ...ok, bunReal: "/home/u/.local/bin/mise", bunShim: true };
    expect(toolchainProblem(shim, guarded)).toMatch(/shim.*mise|mise.*shim/u);
  });

  test("an allow entry that is, or holds, a guarded path would undo the mask and is refused", () => {
    // bun installed as ~/bun: its dir is the home itself.
    const inHome = { ...ok, bun: "/home/u/bun", bunReal: "/home/u/bun" };
    expect(toolchainProblem(inHome, guarded)).toMatch(/\/home\/u\b/u);
    // bun's real path directly in a repo root.
    const inRepoRoot = { ...ok, bunReal: "/home/u/code/bun" };
    expect(toolchainProblem(inRepoRoot, guarded)).toMatch(/\/home\/u\/code/u);
    // Only an entry above a guarded path counts: a dir beside or below them is the normal layout.
    expect(toolchainProblem({ ...ok, bun: "/home/u/.bun/bin/bun" }, guarded)).toBeNull();
  });

  test("the guarded list is the fence's own masks: the checkout, the tmux dir and a system root count too", () => {
    const inputs = {
      platform: "linux",
      home: "/home/u",
      state: "/home/u/.local/state/seance",
      config: "/home/u/.config/seance",
      tmuxSocketDir: "/tmp/tmux-1000",
      extraMasks: ["/home/u/code", ok.checkout],
      rootEntries: entries("/usr", "/etc", "/tmp", "/opt"),
    } as const;
    const masks = sandboxMasks(inputs);
    // bun at <checkout>/bun: its dir is the checkout, which holds relay/.dev.vars (nested under the home, so no
    // `denyRead` entry of its own).
    expect(toolchainProblem({ ...ok, bun: "/home/u/seance/bun", bunReal: "/home/u/seance/bun" }, masks)).toMatch(
      /\/home\/u\/seance/u,
    );
    // bun at /tmp/bun: its dir is a masked root that also holds the tmux socket dir and the rounds' tmp dirs.
    expect(toolchainProblem({ ...ok, bun: "/tmp/bun", bunReal: "/tmp/bun" }, masks)).toMatch(/\/tmp/u);
    expect(toolchainProblem({ ...ok, bun: "/opt/bun", bunReal: "/opt/bun" }, masks)).toMatch(/\/opt/u);
    // A subdirectory of a masked root, as a package manager lays it out, is fine.
    expect(toolchainProblem({ ...ok, bun: "/opt/bun/bin/bun", bunReal: "/opt/bun/bin/bun" }, masks)).toBeNull();
    // A bun at /tmp/tmux-1000/bun re-opens the socket dir alone.
    expect(
      toolchainProblem({ ...ok, bun: "/tmp/tmux-1000/bun", bunReal: "/tmp/tmux-1000/bun" }, [
        ...masks.filter((path) => path !== "/tmp"),
      ]),
    ).toMatch(/tmux-1000/u);
  });
});

describe("seancedShim", () => {
  const readable = process.getuid?.() !== 0;

  test.skipIf(!readable)("an unreadable main stops at the guard: exit 2, and bun never runs", async () => {
    const dir = await mkdtemp(join(base, "shim-"));
    const main = join(dir, "main.ts");
    const marker = join(dir, "ran");
    await writeFile(main, "");
    await chmod(main, 0o000);
    const bun = await scriptStub(stubs, "fake-bun-guard", `echo ran > ${JSON.stringify(marker)}`);
    const shim = join(dir, "seanced");
    await writeFile(shim, seancedShim(bun, main), { mode: 0o700 });
    const run = Bun.spawn([shim, "custodian", "done"], { stdout: "pipe", stderr: "pipe" });
    expect(await run.exited).toBe(2);
    expect(await Bun.file(marker).exists()).toBe(false);
    await chmod(main, 0o600);
  });

  test("a readable main execs bun with it and the arguments, whatever they hold", async () => {
    const dir = await mkdtemp(join(base, "shim-"));
    const main = join(dir, "main.ts");
    await writeFile(main, "");
    const bun = await scriptStub(stubs, "fake-bun-args", `printf '%s\\n' "$@"`);
    const shim = join(dir, "seanced");
    await writeFile(shim, seancedShim(bun, main), { mode: 0o700 });
    const run = Bun.spawn([shim, "custodian", "a b", "$HOME"], { stdout: "pipe", stderr: "pipe" });
    expect(await run.exited).toBe(0);
    expect((await new Response(run.stdout).text()).split("\n")).toEqual([main, "custodian", "a b", "$HOME", ""]);
  });
});

describe("roundEnv", () => {
  const exclave = { id: DEFAULT_EXCLAVE, configDir: "/home/u/.claude" };
  const given = {
    home: "/home/u",
    user: "u",
    tmpDir: "/tmp/seance-cu-abc",
    socket: "/tmp/seance-cu-s-abc/c.sock",
    exclave,
  };

  test("the built names, TMPDIR and CLAUDE_CODE_TMPDIR both the round's tmp dir, no CLAUDE_CONFIG_DIR for default", () => {
    const env = new Map(roundEnv(given));
    expect(env.get("HOME")).toBe("/home/u");
    expect(env.get("USER")).toBe("u");
    expect(env.get("LOGNAME")).toBe("u");
    expect(env.get("TMPDIR")).toBe(given.tmpDir);
    expect(env.get("CLAUDE_CODE_TMPDIR")).toBe(given.tmpDir);
    expect(env.get("SEANCE_CUSTODIAN_SOCKET")).toBe(given.socket);
    expect(env.has("CLAUDE_CONFIG_DIR")).toBe(false);
  });

  test("a named exclave sets its config dir; an unknown login name sets neither USER nor LOGNAME", () => {
    const env = new Map(roundEnv({ ...given, user: null, exclave: { id: "work", configDir: "/home/u/.claude-work" } }));
    expect(env.get("CLAUDE_CONFIG_DIR")).toBe("/home/u/.claude-work");
    expect(env.has("USER")).toBe(false);
    expect(env.has("LOGNAME")).toBe(false);
  });
});

describe("roundCommand", () => {
  /** Runs the command's shell for real against a stub standing in for claude, which dumps the environment it got. */
  async function run(extraEnv: Record<string, string>, claudeArgs = ""): Promise<Map<string, string>> {
    const dir = await mkdtemp(join(base, "cmd-"));
    const out = join(dir, "env.txt");
    const seed = join(dir, "seed.txt");
    await writeFile(seed, "seed text\n");
    const claude = await scriptStub(
      stubs,
      `claude-${dir.slice(-6)}`,
      `env > ${JSON.stringify(out)}\ncat >> ${JSON.stringify(out)}.stdin`,
    );
    const scriptPath = join(dir, "run.sh");
    await writeFile(
      scriptPath,
      roundScript({
        claude,
        caffeinate: false,
        env: roundEnv({
          home: "/home/u",
          user: "u",
          tmpDir: "/tmp/seance-cu-abc",
          socket: "/tmp/seance-cu-s-abc/c.sock",
          exclave: { id: DEFAULT_EXCLAVE, configDir: "/home/u/.claude" },
        }),
        binDir: "/round/bin",
        args: claudeArgs,
        seed,
      }),
    );
    const child = Bun.spawn(["/bin/sh", "-c", `unset TERM; ${roundCommand(scriptPath)}`], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        GH_TOKEN: "ghp_secret",
        GPG_AGENT_INFO: "x",
        ANTHROPIC_API_KEY: "sk-secret",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    const lines = (await readFile(out, "utf8")).split("\n").filter((line) => line.includes("="));
    expect(await readFile(`${out}.stdin`, "utf8")).toBe("seed text\n");
    return new Map(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  }

  test("the environment is built: nothing of the caller's secrets arrives, the round's names do", async () => {
    const env = await run({});
    for (const leaked of ["SSH_AUTH_SOCK", "GH_TOKEN", "GPG_AGENT_INFO", "ANTHROPIC_API_KEY"]) {
      expect(env.has(leaked)).toBe(false);
    }
    expect(env.get("SEANCE_CUSTODIAN_SOCKET")).toBe("/tmp/seance-cu-s-abc/c.sock");
    expect(env.get("TMPDIR")).toBe("/tmp/seance-cu-abc");
    expect(env.get("HOME")).toBe("/home/u");
    expect(env.get("PATH")?.startsWith("/round/bin:")).toBe(true);
    // TERM is unset here (tmux always sets one); a `/bin/sh` that is bash exports `dumb` itself on start when unset.
    expect(["xterm-256color", "dumb"]).toContain(env.get("TERM") ?? "");
    // Anything else is what bash itself sets on start.
    const allowed = new Set([
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "CLAUDE_CODE_TMPDIR",
      "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
      "SEANCE_CUSTODIAN_SOCKET",
      "PATH",
      "TERM",
      "PWD",
      "OLDPWD",
      "SHLVL",
      "_",
    ]);
    expect([...env.keys()].filter((key) => !allowed.has(key))).toEqual([]);
  });

  test("a pass-through value with spaces and quotes stays one word; an unset one is absent, not empty", async () => {
    const env = await run({ LANG: "a b'c", HTTPS_PROXY: "http://proxy:3128", no_proxy: "localhost,127.0.0.1" });
    expect(env.get("LANG")).toBe("a b'c");
    expect(env.get("HTTPS_PROXY")).toBe("http://proxy:3128");
    expect(env.get("no_proxy")).toBe("localhost,127.0.0.1");
    expect(env.has("LC_ALL")).toBe(false);
    expect(env.has("HTTP_PROXY")).toBe(false);
  });

  test("an empty pass-through value is passed as empty (set is set)", async () => {
    const env = await run({ LC_ALL: "" });
    expect(env.get("LC_ALL")).toBe("");
  });

  test("the CA bundle goes with the proxy, and no credential or provider name is passed whatever the caller has", async () => {
    const env = await run({
      NODE_EXTRA_CA_CERTS: "/etc/corp ca.pem",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_SECRET_ACCESS_KEY: "aws",
    });
    expect(env.get("NODE_EXTRA_CA_CERTS")).toBe("/etc/corp ca.pem");
    for (const leaked of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_SECRET_ACCESS_KEY"]) {
      expect(env.has(leaked)).toBe(false);
    }
  });

  test("a proxy URL with userinfo is dropped, one without is passed, whichever case it is spelled in", async () => {
    const env = await run({
      HTTPS_PROXY: "http://user:tok@proxy:3128",
      http_proxy: "http://u:p@proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128/",
      NO_PROXY: "a@b",
    });
    expect(env.has("HTTPS_PROXY")).toBe(false);
    expect(env.has("http_proxy")).toBe(false);
    expect(env.get("HTTP_PROXY")).toBe("http://proxy:3128");
    expect(env.get("https_proxy")).toBe("http://proxy:3128/");
    // Not a URL: passed as it is.
    expect(env.get("NO_PROXY")).toBe("a@b");
  });

  test("an apostrophe in an argument reaches claude intact: the script holds one level of quoting, not two", async () => {
    const claudeArgs = `--agents ${shq(`{"a":"this machine's notes, and the owner's"}`)}`;
    const dir = await mkdtemp(join(base, "args-"));
    const out = join(dir, "argv.txt");
    const claude = await scriptStub(
      stubs,
      `claude-argv-${dir.slice(-6)}`,
      `printf '%s\\n' "$@" > ${JSON.stringify(out)}`,
    );
    const script = roundScript({
      claude,
      caffeinate: false,
      env: [],
      binDir: "/b",
      args: claudeArgs,
      seed: "/dev/null",
    });
    const scriptPath = join(dir, "run.sh");
    await writeFile(scriptPath, script);
    const child = Bun.spawn(["/bin/sh", scriptPath], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await readFile(out, "utf8")).toBe(`--agents\n{"a":"this machine's notes, and the owner's"}\n`);
    // One level: the only backslash is the one in each `'\''`. A second `shq` over it leaves a backslash inside a
    // single-quoted run, where fish and the POSIX shells part ways.
    expect(script.replaceAll("'\\''", "")).not.toContain("\\");
  });

  test("the window's command is one `exec /bin/sh '<script>'` with no expansion, backslash or nested quote, which any default-shell parses", async () => {
    const command = roundCommand("/tmp/seance-cu-abc123/run.sh");
    expect(command).toBe("exec /bin/sh '/tmp/seance-cu-abc123/run.sh'");
    expect(command).not.toMatch(/[\\$`]/u);
    // Fish where it is installed, parsing it as tmux's `default-shell` would.
    const fish = Bun.which("fish");
    if (fish === null) return;
    const dir = await mkdtemp(join(base, "fish-"));
    const marker = join(dir, "ran");
    const scriptPath = join(dir, "run.sh");
    await writeFile(scriptPath, `#!/bin/sh\necho ok > ${JSON.stringify(marker)}\n`);
    const child = Bun.spawn([fish, "-c", roundCommand(scriptPath)], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("ok\n");
  });

  test("caffeinate goes in front on macOS", () => {
    const script = roundScript({ claude: "claude", caffeinate: true, env: [], binDir: "/b", args: "--", seed: "/s" });
    expect(script).toContain("\nexec caffeinate -is /usr/bin/env -i ");
    expect(script.endsWith("< '/s'\n")).toBe(true);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("Linux, in either bwrap mode, runs the command under bwrap --seccomp with the filter file on fd 3", () => {
    const script = roundScript({
      claude: "claude",
      caffeinate: false,
      seccomp: "/tmp/seance-cu-abc/seccomp.bpf",
      env: [],
      binDir: "/b",
      args: "--",
      seed: "/s",
    });
    expect(script).toContain("\nexec bwrap --dev-bind / / --seccomp 3 -- /usr/bin/env -i ");
    expect(script.endsWith("< '/s' 3< '/tmp/seance-cu-abc/seccomp.bpf'\n")).toBe(true);
    const plain = roundScript({ claude: "claude", caffeinate: false, env: [], binDir: "/b", args: "--", seed: "/s" });
    expect(plain).not.toContain("bwrap");
    expect(plain).not.toContain("3<");
  });
});

describe("ensureRoundDir", () => {
  test("makes every protected name and nothing under .claude/", async () => {
    const dir = join(base, "round-a");
    const real = await ensureRoundDir(dir);
    expect(real).toBe(dir);
    expect(PROTECTED_NAMES).toHaveLength(37);
    const names = await readdir(real);
    for (const name of [...PROTECTED_NAMES, ...PROTECTED_DIRS]) expect(names).toContain(name);
    expect(names).not.toContain(".claude");
    expect((await lstat(join(real, ".vscode"))).isDirectory()).toBe(true);
    expect(await readFile(join(real, ".mcp.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(real, ".gitconfig"), "utf8")).toBe("");
    expect((await lstat(real)).mode & 0o777).toBe(0o700);
    expect(await roundDirPlanted(real)).toBe(false);
  });

  test("a second call leaves content alone", async () => {
    const dir = join(base, "round-b");
    const real = await ensureRoundDir(dir);
    await writeFile(join(real, ".npmrc"), "kept\n");
    await ensureRoundDir(dir);
    expect(await readFile(join(real, ".npmrc"), "utf8")).toBe("kept\n");
  });

  test("a planted symlink under a protected name is not followed, and the dir is planted: the Read tool could be steered by it", async () => {
    const dir = join(base, "round-c");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(base, "round-c-target");
    await writeFile(target, "untouched\n");
    await symlink(target, join(dir, ".bashrc"));
    const real = await ensureRoundDir(dir);
    expect(await readFile(target, "utf8")).toBe("untouched\n");
    expect((await lstat(join(real, ".bashrc"))).isSymbolicLink()).toBe(true);
    expect(await roundDirPlanted(real)).toBe(true);
  });

  test("a hardlink to a file elsewhere is a plant (a regular file, shown only by its link count), at the top or nested", async () => {
    const secret = join(base, "round-d-secret");
    await writeFile(secret, "secret\n");
    const top = await ensureRoundDir(join(base, "round-d"));
    await link(secret, join(top, "creds"));
    expect(await roundDirPlanted(top)).toBe(true);
    const nested = await ensureRoundDir(join(base, "round-e"));
    await link(secret, join(nested, ".vscode", "creds"));
    expect(await roundDirPlanted(nested)).toBe(true);
  });

  test("a symlink nested in a protected dir or under .claude/ is a plant; real files and dirs there are not", async () => {
    const target = join(base, "round-f-target");
    await writeFile(target, "x\n");
    const dir = await ensureRoundDir(join(base, "round-f"));
    await mkdir(join(dir, ".claude", "cache"), { recursive: true });
    await writeFile(join(dir, ".claude", "cache", "own.json"), "{}\n");
    await writeFile(join(dir, ".vscode", "settings-copy"), "copy\n");
    expect(await roundDirPlanted(dir)).toBe(false);
    await symlink(target, join(dir, ".claude", "cache", "link"));
    expect(await roundDirPlanted(dir)).toBe(true);
  });
});

describe("existingPaths", () => {
  test("real paths of what exists, the rest dropped; an alias under the volume is kept as written, not resolved back", async () => {
    const real = join(base, "real-dir");
    await mkdir(real);
    await symlink(real, join(base, "link-dir"));
    // The volume's mount point stands in as a dir of our own whose entries are links back to the short form, as macOS's are.
    const volume = join(base, "vol");
    await mkdir(volume);
    await symlink(real, join(volume, "real-dir"));
    const found = await existingPaths(
      [join(base, "link-dir"), join(base, "absent"), join(volume, "real-dir"), join(volume, "absent")],
      volume,
    );
    expect(found).toEqual([real, join(volume, "real-dir")]);
  });
});
