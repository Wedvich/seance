import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * The name lives in the manifest and nowhere else — the CLI has to read it to
 * know which directory to watch, and the stub plays Raycast's part of writing
 * that directory. Deliberately not the real extension's name: a constant
 * anywhere in the command would make every install assertion below fail.
 */
const NAME = "seance-raycast-test";

/**
 * `raycast install/uninstall` through the real CLI, as a subprocess. What this
 * command produces is entirely argv handed to another tool and files moved
 * around a temp HOME; nothing below the process boundary can see either.
 *
 * The preflight is stubbed like everything else the command shells out to: an
 * app bundle under the temp HOME satisfies the presence probe and a `pgrep`
 * that answers "running" keeps `open` out of it. Nothing here may launch the
 * real Raycast — a suite that pops the GUI open on a dev machine, and fails on
 * a headless one, is worse than no coverage. So these run everywhere.
 */
const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const recorded = async (file: string): Promise<readonly string[]> => {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
};

describe("seanced raycast install/uninstall through the CLI", () => {
  let root: string;
  let home: string;
  let checkout: string;
  let workspace: string;
  let bin: string;
  let rayArgv: string;
  let bunArgv: string;
  let npmArgv: string;
  let openArgv: string;
  let rayTemplate: string;
  let env: Record<string, string | undefined>;

  const extensionDir = (): string => join(home, ".config", "raycast", "extensions", NAME);
  const buildArgv = ["build", "-e", "dist", "-o", "dist", "--non-interactive", "--exit-on-error"];
  const rayPath = (): string => join(workspace, "node_modules", ".bin", "ray");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "seance-raycast-cli-"));
    home = join(root, "home");
    checkout = join(root, "checkout");
    workspace = join(checkout, "raycast");
    bin = join(root, "bin");
    rayArgv = join(root, "ray-argv");
    bunArgv = join(root, "bun-argv");
    npmArgv = join(root, "npm-argv");
    openArgv = join(root, "open-argv");
    rayTemplate = join(root, "ray-template");
    await mkdir(bin, { recursive: true });
    await mkdir(join(workspace, "node_modules", ".bin"), { recursive: true });
    // Satisfies the presence probe without the real app, the way raycast.test.ts's
    // doctor cases do.
    await mkdir(join(home, "Applications", "Raycast.app"), { recursive: true });
    await Bun.write(join(workspace, "package.json"), JSON.stringify({ name: NAME }));

    // `ray develop` never exits; it imports, prints its ready line, and then
    // watches until SIGINT — at which point it removes cli.pid and dev.log,
    // leaves the rest imported, and exits 1. All of that is load-bearing.
    await Bun.write(
      rayTemplate,
      `#!/bin/sh
printf '%s\\n' "$@" >> "${rayArgv}"
[ "$1" = "develop" ] || exit 0
EXT="$HOME/.config/raycast/extensions/${NAME}"
mkdir -p "$EXT"
printf '{"name":"${NAME}"}' > "$EXT/package.json"
printf 'bundle' > "$EXT/spawn.js"
printf '%s' "$$" > "$EXT/cli.pid"
: > "$EXT/dev.log"
trap 'rm -f "$EXT/cli.pid" "$EXT/dev.log"; exit 1' INT
echo "ready - built extension successfully"
while : ; do sleep 0.1; done
`,
    );
    await Bun.write(rayPath(), await readFile(rayTemplate, "utf8"));
    await chmod(rayPath(), 0o755);

    // Only consulted for its version: @raycast/api's engine floor is the sole
    // thing about node this command cares about.
    await Bun.write(join(bin, "node"), '#!/bin/sh\n[ "$1" = "--version" ] && echo v22.22.2\nexit 0\n');
    // Stands in for the workspace install, and records where it ran.
    await Bun.write(
      join(bin, "bun"),
      `#!/bin/sh
printf '%s\\n' "$@" >> "${bunArgv}"
pwd >> "${bunArgv}"
mkdir -p "${join(workspace, "node_modules", ".bin")}"
cp "${rayTemplate}" "${rayPath()}"
chmod 755 "${rayPath()}"
exit 0
`,
    );
    // Never npm: `workspace:*` is not an npm spec, and npm would flatten the
    // isolated linker tree. Its absence is asserted, so it has to be reachable.
    await Bun.write(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${npmArgv}"\nexit 0\n`);
    // The preflight: "Raycast is already running", so the command never reaches
    // `open`. Both stubbed — a test suite must not start the real app.
    await Bun.write(join(bin, "pgrep"), "#!/bin/sh\nexit 0\n");
    await Bun.write(join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${openArgv}"\nexit 0\n`);
    for (const name of ["node", "bun", "npm", "pgrep", "open"]) await chmod(join(bin, name), 0o755);

    env = {
      ...process.env,
      HOME: home,
      SEANCE_RAYCAST_DIR: workspace,
      // Everything below is stubbed binaries and fs work against this HOME, so
      // it runs everywhere; the platform gate would otherwise refuse first.
      SEANCE_RAYCAST_ANY_PLATFORM: "1",
      // /usr/bin and /bin are real on purpose: every stub above is a shell script.
      PATH: [bin, "/usr/bin", "/bin", dirname(process.execPath)].join(delimiter),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  interface Run {
    readonly out: string;
    readonly err: string;
    readonly code: number | null;
  }

  const run = async (...argv: readonly string[]): Promise<Run> => {
    const proc = Bun.spawn([process.execPath, mainPath, "raycast", ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  };

  test("a missing or unknown subcommand is a usage error, and runs nothing", async () => {
    const bare = await run();
    expect(bare.code).toBe(1);
    expect(bare.err).toContain("usage: seanced raycast install");
    const wrong = await run("reinstall");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('unknown raycast subcommand "reinstall"');
    expect(await exists(rayArgv)).toBe(false);
  });

  test("install typechecks through ray build, then imports through ray develop", async () => {
    const { out, code } = await run("install");
    expect(code).toBe(0);
    const argv = await recorded(rayArgv);
    expect(argv).toEqual([...buildArgv, "develop"]);
    // The realpath'd bun binary must never reach another tool's argv — it stops
    // existing at the next runtime upgrade.
    expect(argv).not.toContain(process.execPath);
    expect(out).toContain(extensionDir());
    expect(await exists(join(extensionDir(), "package.json"))).toBe(true);
    // SIGINT is how the watcher is stopped, and `ray` cleans these up doing it.
    expect(await exists(join(extensionDir(), "cli.pid"))).toBe(false);
    expect(await exists(join(extensionDir(), "dev.log"))).toBe(false);
    // The bundle stays: that is what "still imported" means.
    expect(await exists(join(extensionDir(), "spawn.js"))).toBe(true);
    expect(await exists(bunArgv)).toBe(false);
    // Raycast was already running, so nothing may have tried to launch it.
    expect(await exists(openArgv)).toBe(false);
  });

  test("re-running install rebuilds and re-imports, detected by mtime", async () => {
    expect((await run("install")).code).toBe(0);
    const { out, code } = await run("install");
    expect(code).toBe(0);
    expect(out).toContain(extensionDir());
    expect(await recorded(rayArgv)).toEqual([...buildArgv, "develop", ...buildArgv, "develop"]);
  });

  // The marker only shortens the wait; the directory is the proof. Printing the
  // success line off a marker alone is the one lie this command could tell.
  test("install that builds but imports nothing warns instead of claiming success", async () => {
    await Bun.write(
      rayPath(),
      `#!/bin/sh
[ "$1" = "develop" ] || exit 0
echo "ready - built extension successfully"
while : ; do sleep 0.1; done
`,
    );
    await chmod(rayPath(), 0o755);

    const { out, err, code } = await run("install");
    expect(code).toBe(1);
    expect(out).toContain("nothing appeared at");
    expect(out).not.toContain("Raycast can now spawn");
    expect(err).toContain("nothing was imported");
    expect(await exists(extensionDir())).toBe(false);
  }, 20_000);

  test("an uninstalled workspace is installed with bun, never npm", async () => {
    await rm(rayPath());
    const { code } = await run("install");
    expect(code).toBe(0);
    expect(await recorded(bunArgv)).toEqual(["install", await realpath(checkout)]);
    expect(await exists(npmArgv)).toBe(false);
  });

  test("uninstall removes the import and this checkout's build artifacts", async () => {
    expect((await run("install")).code).toBe(0);
    await Bun.write(join(workspace, "raycast-env.d.ts"), "// generated\n");
    await mkdir(join(workspace, "dist"), { recursive: true });
    await Bun.write(join(workspace, "dist", "spawn.js"), "bundle");

    const { out, code } = await run("uninstall");
    expect(code).toBe(0);
    expect(await exists(extensionDir())).toBe(false);
    expect(await exists(join(workspace, "dist"))).toBe(false);
    expect(await exists(join(workspace, "raycast-env.d.ts"))).toBe(false);
    // The one step it cannot take, said rather than implied.
    expect(out).toContain("Manage Extensions");
  });

  test("uninstall with nothing imported is a no-op, not an error", async () => {
    const first = await run("uninstall");
    expect(first.code).toBe(0);
    expect(first.out).toContain("nothing imported");
    expect((await run("uninstall")).code).toBe(0);
  });

  test("uninstall refuses while a ray develop session is live", async () => {
    await mkdir(extensionDir(), { recursive: true });
    await Bun.write(join(extensionDir(), "package.json"), JSON.stringify({ name: NAME }));
    // A pid that is genuinely running: the file is a claim, and the command probes it.
    await Bun.write(join(extensionDir(), "cli.pid"), String(process.pid));

    const { err, code } = await run("uninstall");
    expect(code).toBe(1);
    expect(err).toContain(String(process.pid));
    expect(await exists(extensionDir())).toBe(true);
  });

  // A crash or a power loss leaves cli.pid behind; without a liveness probe
  // every uninstall after one would refuse forever.
  test("uninstall proceeds past a stale or empty cli.pid", async () => {
    const dead = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;

    const uninstallClaiming = async (pid: string): Promise<void> => {
      await mkdir(extensionDir(), { recursive: true });
      await Bun.write(join(extensionDir(), "package.json"), JSON.stringify({ name: NAME }));
      await Bun.write(join(extensionDir(), "cli.pid"), pid);
      expect((await run("uninstall")).code).toBe(0);
      expect(await exists(extensionDir())).toBe(false);
    };

    await uninstallClaiming(String(dead.pid));
    await uninstallClaiming("");
    await uninstallClaiming("   \n");
  });

  // Absence means "nothing imported"; a manifest that is there but unreadable
  // is a `ray` killed mid-write, and skipping it would never converge.
  test("uninstall refuses a half-written manifest instead of calling it absent", async () => {
    await mkdir(extensionDir(), { recursive: true });
    await Bun.write(join(extensionDir(), "package.json"), '{"name": "seance-ray');

    const { err, code } = await run("uninstall");
    expect(code).toBe(1);
    expect(err).toContain(join(extensionDir(), "package.json"));
    expect(err).toContain("unreadable");
    expect(await exists(extensionDir())).toBe(true);
  });

  test("uninstall leaves a directory that names a different extension alone", async () => {
    await mkdir(extensionDir(), { recursive: true });
    await Bun.write(join(extensionDir(), "package.json"), JSON.stringify({ name: "somebody-elses-extension" }));

    const { err, code } = await run("uninstall");
    expect(code).toBe(1);
    expect(err).toContain("does not name");
    expect(await exists(extensionDir())).toBe(true);
  });
});
