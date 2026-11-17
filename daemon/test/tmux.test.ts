import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxError, tmuxOk } from "../src/tmux.ts";
import { scriptStub } from "./fixtures.ts";

/**
 * macOS fails a pty open now and then in a way that succeeds a moment later (`PTY_RACE` in `tmux.ts`): a stub `tmux`
 * first on PATH stands in for the kernel, failing a set number of calls with a set message before it succeeds.
 */

let base: string;
let shimDir: string;
let calls: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-tmux-")));
  shimDir = join(base, "shim");
  calls = join(base, "calls");
  await mkdir(shimDir, { recursive: true });
  await scriptStub(
    shimDir,
    "tmux",
    [
      `printf '%s\\n' "$1" >> '${calls}'`,
      `if [ "$(wc -l < '${calls}')" -le "$(cat '${base}/fails')" ]; then`,
      `  printf '%s\\n' "$(cat '${base}/error')" >&2`,
      "  exit 1",
      "fi",
      "echo '%1 4242'",
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Runs `args` through `tmuxOk` against the stub, failing its first `fails` calls with `error`; returns the subcommands it saw. */
async function run(
  args: readonly string[],
  fails: number,
  error: string,
): Promise<{ readonly out: string | TmuxError; readonly calls: readonly string[] }> {
  await rm(calls, { force: true });
  await writeFile(join(base, "fails"), String(fails));
  await writeFile(join(base, "error"), error);
  const path = process.env["PATH"];
  const socket = process.env["SEANCE_TMUX_SOCKET"];
  process.env["PATH"] = `${shimDir}:${path ?? ""}`;
  delete process.env["SEANCE_TMUX_SOCKET"];
  let out: string | TmuxError;
  try {
    out = await tmuxOk(args).catch((err: unknown) => {
      if (err instanceof TmuxError) return err;
      throw err;
    });
  } finally {
    process.env["PATH"] = path;
    if (socket !== undefined) process.env["SEANCE_TMUX_SOCKET"] = socket;
  }
  const seen = (await readFile(calls, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  return { out, calls: seen };
}

const ENXIO = "create window failed: fork failed: Device not configured";
const REDRIVE = "create window failed: fork failed: Unknown error: -6";

describe("a pty open macOS fails transiently", () => {
  test.each([ENXIO, REDRIVE])("is retried until it lands: %s", async (error) => {
    const { out, calls: seen } = await run(["new-window", "-d", "-P"], 2, error);
    expect(out).toBe("%1 4242\n");
    expect(seen).toEqual(["new-window", "new-window", "new-window"]);
  });

  test.each(["new-session", "split-window", "respawn-pane", "respawn-window"])(
    "is retried for %s too, every subcommand that opens a pty",
    async (subcommand) => {
      const { out, calls: seen } = await run([subcommand], 1, ENXIO);
      expect(out).toBe("%1 4242\n");
      expect(seen).toEqual([subcommand, subcommand]);
    },
  );

  test("still failing after three retries, throws the kernel's message", async () => {
    const { out, calls: seen } = await run(["new-window"], 10, ENXIO);
    expect(out).toBeInstanceOf(TmuxError);
    expect(String(out)).toContain("tmux new-window failed: create window failed: fork failed: Device not configured");
    expect(seen).toHaveLength(4);
  });
});

describe("anything else", () => {
  test("another failure of a pty-opening subcommand is not retried", async () => {
    const { out, calls: seen } = await run(["new-window"], 1, "can't find session: msg");
    expect(String(out)).toContain("can't find session: msg");
    expect(seen).toEqual(["new-window"]);
  });

  test("a subcommand that opens no pty is not retried, whatever it says", async () => {
    const { out, calls: seen } = await run(["display-message", "-p"], 1, ENXIO);
    expect(out).toBeInstanceOf(TmuxError);
    expect(seen).toEqual(["display-message"]);
  });
});
