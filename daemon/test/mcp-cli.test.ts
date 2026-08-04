import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// `mcp install` through the real CLI, as a subprocess: the argv handed to
// `claude mcp add` is this command's entire product, and nothing below the
// process boundary can see it. Two things it has to get right. It must name
// PATH's bun — a realpath'd Homebrew keg stops existing at the next `brew
// upgrade bun`, and no later run rewrites ~/.claude.json on its own. And it must
// stay repeatable, because the machines needing a repoint are the registered
// ones. The claude stub refuses a duplicate `add` the way the real CLI was
// observed to ("MCP server seance already exists in user config", exit 1); that
// refusal is the whole reason install clears the name first.
describe("seanced mcp install/uninstall through the CLI", () => {
  let root: string;
  let bin: string;
  let recorded: string;
  let env: Record<string, string | undefined>;

  const removeArgv = ["mcp", "remove", "--scope", "user", "seance"];
  const addArgv = async (): Promise<readonly string[]> => [
    "mcp",
    "add",
    "--scope",
    "user",
    "seance",
    "--",
    join(bin, "bun"),
    await realpath(mainPath),
    "mcp",
  ];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-mcp-cli-"));
    bin = join(root, "bin");
    await mkdir(bin);
    recorded = join(root, "argv");
    const marker = join(root, "registered");
    // The bun stub is never executed — the child is spawned through
    // process.execPath. It only has to be what the child's `Bun.which("bun")`
    // finds, which is exactly what's under test.
    await Bun.write(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
    await Bun.write(
      join(bin, "claude"),
      // Builtins only — PATH here is deliberately just the stub dir plus bun's,
      // so anything external (`rm`) would silently not run. Non-empty marker
      // means registered; `remove` truncates rather than deletes for the same
      // reason.
      `#!/bin/sh
printf '%s\\n' "$@" >> "${recorded}"
if [ "$1 $2" = "mcp add" ]; then
  if [ -s "${marker}" ]; then
    echo "MCP server seance already exists in user config" >&2
    exit 1
  fi
  echo registered > "${marker}"
elif [ "$1 $2" = "mcp remove" ]; then
  : > "${marker}"
fi
exit 0
`,
    );
    await chmod(join(bin, "bun"), 0o755);
    await chmod(join(bin, "claude"), 0o755);
    env = { ...process.env, HOME: root, PATH: `${bin}${delimiter}${dirname(process.execPath)}` };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  interface Run {
    readonly out: string;
    readonly code: number | null;
    readonly argv: readonly string[];
  }

  const run = async (sub: string): Promise<Run> => {
    const proc = Bun.spawn([process.execPath, mainPath, "mcp", sub], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const argv = await readFile(recorded, "utf8").catch(() => "");
    return { out, code, argv: argv.split("\n").filter((line) => line !== "") };
  };

  test("install registers PATH's bun, never the running binary", async () => {
    const { out, code, argv } = await run("install");
    expect(code).toBe(0);
    expect(argv).toEqual([...removeArgv, ...(await addArgv())]);
    expect(argv).not.toContain(process.execPath);
    expect(out).toContain("registered");
  });

  test("install repeats cleanly over an existing entry", async () => {
    await run("install");
    const { out, code, argv } = await run("install");
    expect(code).toBe(0);
    expect(out).toContain("registered");
    const once = [...removeArgv, ...(await addArgv())];
    expect(argv).toEqual([...once, ...once]);
  });

  test("uninstall removes the entry by name, without an add", async () => {
    const { code, argv } = await run("uninstall");
    expect(code).toBe(0);
    expect(argv).toEqual(removeArgv);
  });
});
