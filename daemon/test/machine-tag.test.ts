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
});

async function started(): Promise<SessionBackend> {
  backend = createBackend(CONFIG, { republishTagMs: REPUBLISH_MS });
  await backend.start?.();
  return backend;
}

async function tagInTmux(): Promise<string> {
  return (await tmux(["show-environment", "-g", "SEANCE_MACHINE_TAG"])).stdout.trim();
}

async function serverUp(): Promise<boolean> {
  return (await tmux(["list-sessions"])).exitCode === 0;
}

describe("machine tag on the tmux server", () => {
  test("a server started after the daemon gets the tag", async () => {
    await started();
    await tmux(["kill-server"]);
    await tmux(["new-session", "-d", "-s", "later"]);
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
    await tmux(["kill-server"]);
    expect((await tmux(["new-session", "-d", "-s", "later"])).exitCode).toBe(0);
    // A sentinel, so a failed query (empty stdout) can't pass for "left alone".
    await tmux(["set-environment", "-g", "SEANCE_MACHINE_TAG", "sentinel"]);
    await Bun.sleep(REPUBLISH_MS * 5);
    expect(await tagInTmux()).toBe("SEANCE_MACHINE_TAG=sentinel");
  });
});
