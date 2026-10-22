import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// `mod install` / `mod uninstall` through the real CLI, as a subprocess, for the
// same reason as mcp-cli.test.ts: the argv handed to Claude's plugin CLI is the
// whole product. The stub answers `marketplace remove` with the real CLI's
// not_configured result when nothing is registered — observed on 2.1.295, and
// the one failure uninstall must read as "nothing to do" rather than an error.
// Plugins live per config dir, so the stub keys its state on CLAUDE_CONFIG_DIR
// and prefixes each record with it ("-" when unset — the default exclave).
describe("seance mod install/uninstall through the CLI", () => {
  let root: string;
  let recorded: string;
  let checkout: string;
  let work: string;
  let gone: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-mod-cli-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    recorded = join(root, "argv");
    work = join(root, ".claude-work");
    gone = join(root, ".claude-gone");
    checkout = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
    await Bun.write(
      join(bin, "claude"),
      // Builtins only: PATH is just the stub dir plus bun's. One record per call,
      // args space-joined — none of them carry spaces here.
      `#!/bin/sh
echo "\${CLAUDE_CONFIG_DIR:--} $*" >> "${recorded}"
dir="\${CLAUDE_CONFIG_DIR:-${root}/.claude}"
marker="$dir/added"
if [ -e "$dir/broken" ]; then
  echo "settings.json: unexpected token" >&2
  exit 1
elif [ "$1 $2 $3" = "plugin marketplace add" ]; then
  echo added > "$marker"
elif [ "$1 $2 $3" = "plugin marketplace remove" ]; then
  if [ ! -s "$marker" ]; then
    echo '{"command":"marketplace-remove","outcome":"failed","failureCode":"not_configured"}'
    exit 1
  fi
  : > "$marker"
fi
exit 0
`,
    );
    await chmod(join(bin, "claude"), 0o755);
    // default and work set up; gone listed but never run, so it has no config dir.
    await mkdir(join(root, ".claude"));
    await mkdir(work);
    await Bun.write(join(root, ".exclaves"), "work\ngone\n");
    env = { ...process.env, HOME: root, PATH: `${bin}${delimiter}${dirname(process.execPath)}` };
    // An inherited one is an extra, ambient target — a developer's shell would
    // install into it where CI wouldn't.
    delete env["CLAUDE_CONFIG_DIR"];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (...args: string[]): Promise<{ out: string; err: string; code: number; argv: string[] }> => {
    const proc = Bun.spawn([process.execPath, mainPath, "mod", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const argv = await readFile(recorded, "utf8").catch(() => "");
    return { out, err, code, argv: argv.split("\n").filter((line) => line !== "") };
  };

  test("install adds this checkout and every mod it lists in each exclave's config dir, skipping one never set up", async () => {
    const { out, code, argv } = await run("install");
    expect(code).toBe(0);
    const once = (dir: string): string[] => [
      `${dir} plugin marketplace add ${checkout} --scope user --json`,
      `${dir} plugin install tmux-rename@seance --scope user`,
      `${dir} plugin install session-events@seance --scope user`,
    ];
    expect(argv).toEqual([...once("-"), ...once(work)]);
    expect(out).toContain(`skipped gone — ${gone} does not exist yet`);
    for (const label of ["default", "work"]) {
      expect(out).toContain(`Claude mod tmux-rename installed in ${label}`);
      expect(out).toContain(`Claude mod session-events installed in ${label}`);
    }
  });

  test("a failing exclave is reported and fails the run, without stopping the ones after it", async () => {
    await Bun.write(join(root, ".claude", "broken"), "");
    const { out, err, code, argv } = await run("install");
    expect(code).not.toBe(0);
    expect(err).toContain("default: claude plugin marketplace add");
    expect(err).toContain("unexpected token");
    expect(argv.filter((line) => line.startsWith(work))).toHaveLength(3);
    expect(out).toContain("Claude mod session-events installed in work");
  });

  test("a repeat install never removes first — that would delete the mods' saved data", async () => {
    await run("install");
    const { code, argv } = await run("install");
    expect(code).toBe(0);
    expect(argv.filter((line) => line.includes("remove"))).toEqual([]);
  });

  test("uninstall removes the marketplace from each exclave, and says so only where there was one", async () => {
    const before = await run("uninstall");
    expect(before.code).toBe(0);
    expect(before.out).toContain("nothing installed in default");
    expect(before.out).toContain("nothing installed in work");

    await run("install");
    const after = await run("uninstall");
    expect(after.code).toBe(0);
    expect(after.out).toContain("removed the seance marketplace and its mods from default");
    expect(after.out).toContain("removed the seance marketplace and its mods from work");
    expect(after.argv.slice(-2)).toEqual([
      "- plugin marketplace remove seance --json",
      `${work} plugin marketplace remove seance --json`,
    ]);
  });

  test("an unknown subcommand fails with the usage line and touches nothing", async () => {
    const { err, code, argv } = await run("reinstall");
    expect(code).not.toBe(0);
    expect(err).toContain("usage: seance mod install");
    expect(argv).toEqual([]);
  });
});
