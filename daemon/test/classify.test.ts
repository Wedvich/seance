import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPane, listPanes, listStuckWindows, type PaneInfo, type PaneState } from "../src/sessions.ts";
import { resolveTargetSession, tmuxOk } from "../src/tmux.ts";
import { makeClaudeStub, pollUntil, usePrivateTmux, type ClaudeStub, type PrivateTmux } from "./fixtures.ts";

let base: string;
let privateTmux: PrivateTmux | undefined;
let stub: ClaudeStub;
let session: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-classify-"));
  privateTmux = usePrivateTmux(base, "classify");
  stub = await makeClaudeStub(base);
  session = await resolveTargetSession("main");
});

afterAll(async () => {
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

/** A window séance would recognise as its own: the start command carries `--remote-control`. */
async function ours(wrapper: string): Promise<string> {
  return open(`exec ${wrapper} --remote-control`);
}

async function open(command: string): Promise<string> {
  const paneId = await tmuxOk(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-c", base, command]);
  return paneId.trim();
}

async function pane(paneId: string): Promise<PaneInfo | undefined> {
  return (await listPanes()).find((p) => p.paneId === paneId);
}

async function stateOf(paneId: string): Promise<PaneState | "gone"> {
  const found = await pane(paneId);
  return found === undefined ? "gone" : classifyPane(found);
}

async function settlesAs(paneId: string, expected: PaneState | "gone"): Promise<void> {
  await pollUntil(async () => (await stateOf(paneId)) === expected, `${paneId} to classify as ${expected}`);
}

describe("classifyPane (real tmux, stub claude)", () => {
  test("a séance claude whose process exited is dead, with the time it died", async () => {
    const paneId = await ours(stub.failing);
    // Before the stub's 0.3s exit, as spawn.ts sets it — otherwise tmux closes the window.
    await tmuxOk(["set-option", "-w", "-t", paneId, "remain-on-exit", "on"]);
    await settlesAs(paneId, "dead");
    expect((await pane(paneId))?.deadAt).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a séance claude that never titled its pane is starting, and is what doctor calls stuck", async () => {
    const paneId = await ours(stub.stuck);
    expect(await stateOf(paneId)).toBe("starting");
    const windowName = (await pane(paneId))?.windowName;
    expect(await listStuckWindows()).toContain(windowName ?? "");
  });

  test("a titled séance claude on its ordinary screen is live", async () => {
    await settlesAs(await ours(stub.ok), "live");
  });

  test("a séance claude on the worktree exit prompt is recognised, and Esc puts it back to live", async () => {
    const paneId = await ours(stub.exitPrompt);
    await settlesAs(paneId, "exit-prompt");
    await tmuxOk(["send-keys", "-t", paneId, "Escape"]);
    await settlesAs(paneId, "live");
  });

  test("a hand-started claude that exits back to its shell reads as shell, though its title stays", async () => {
    const paneId = await open("bash --noprofile --norc -i");
    await tmuxOk(["send-keys", "-t", paneId, "-l", stub.exitPrompt]);
    await tmuxOk(["send-keys", "-t", paneId, "Enter"]);
    // Not ours, so it is the claude-named process that makes it classifiable at all.
    await settlesAs(paneId, "exit-prompt");
    await tmuxOk(["send-keys", "-t", paneId, "Enter"]);
    await settlesAs(paneId, "shell");
    expect((await pane(paneId))?.titled).toBe(true);
  });

  test("Enter on a séance claude's exit prompt exits it, and its window closes", async () => {
    const paneId = await ours(stub.exitPrompt);
    await settlesAs(paneId, "exit-prompt");
    await tmuxOk(["send-keys", "-t", paneId, "Enter"]);
    await settlesAs(paneId, "gone");
  });
});
