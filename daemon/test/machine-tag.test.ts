import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionBackend } from "../src/backend.ts";
import { createBackend } from "../src/backend-default.ts";
import type { Config } from "../src/config.ts";
import { tmux } from "../src/tmux.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

const CONFIG: Config = {
  name: "TagMac",
  relayUrl: "ws://localhost/daemon",
  bearerToken: "test-bearer",
  psk: "",
  repoRoots: [],
  tmuxSession: "main",
  machineTag: "WSL Box",
};
/** Short, so the positive test polls a few ticks; the negative ones sleep several. */
const REPUBLISH_MS = 20;

let base: string;
let privateTmux: PrivateTmux | undefined;
let backend: SessionBackend | null = null;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-tag-"));
  privateTmux = usePrivateTmux(base, "tag");
});

afterAll(async () => {
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

afterEach(async () => {
  backend?.stop?.();
  backend = null;
  await tmux(["kill-server"]);
  // `kill-server` returns before the server exits; the next test's start would reach the dying one (macOS CI).
  await pollUntil(async () => !(await serverUp()), "the tmux server gone");
});

async function started(): Promise<SessionBackend> {
  backend = createBackend(CONFIG, { home: join(tmpdir(), "seance-no-home"), republishTagMs: REPUBLISH_MS });
  await backend.start?.();
  return backend;
}

async function tagInTmux(): Promise<string> {
  return (await tmux(["show-environment", "-g", "SEANCE_MACHINE_TAG"])).stdout.trim();
}

/**
 * `kill-server` returns before the server has exited, and a `new-session` that
 * reaches it meanwhile fails (exit 1, Linux CI), so it is retried until a new
 * server takes it.
 */
async function restartServer(): Promise<void> {
  await tmux(["kill-server"]);
  await pollUntil(async () => (await tmux(["new-session", "-d", "-s", "later"])).exitCode === 0, "a new tmux server");
}

async function serverUp(): Promise<boolean> {
  return (await tmux(["list-sessions"])).exitCode === 0;
}

describe("machine tag on the tmux server", () => {
  test("a server started after the daemon gets the tag", async () => {
    await started();
    await restartServer();
    await pollUntil(async () => (await tagInTmux()) === "SEANCE_MACHINE_TAG=wsl-box", "the tag republished");
  });

  test("the republish never starts a server of its own", async () => {
    await started();
    await tmux(["kill-server"]);
    await Bun.sleep(REPUBLISH_MS * 5);
    expect(await serverUp()).toBe(false);
  });

  test("a stopped daemon stops republishing", async () => {
    (await started()).stop?.();
    await restartServer();
    // A sentinel, so a failed query (empty stdout) can't pass for "left alone".
    await tmux(["set-environment", "-g", "SEANCE_MACHINE_TAG", "sentinel"]);
    await Bun.sleep(REPUBLISH_MS * 5);
    expect(await tagInTmux()).toBe("SEANCE_MACHINE_TAG=sentinel");
  });
});
