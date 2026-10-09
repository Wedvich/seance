import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DespawnFailure } from "../src/backend.ts";
import { despawnSession } from "../src/despawn.ts";
import { isRegistered, listPanes } from "../src/sessions.ts";
import { resolveTargetSession, tmuxOk } from "../src/tmux.ts";
import { makeClaudeStub, pollUntil, usePrivateTmux, type ClaudeStub, type PrivateTmux } from "./fixtures.ts";

let base: string;
let privateTmux: PrivateTmux | undefined;
let stub: ClaudeStub;
let session: string;
let records = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "seance-despawn-"));
  privateTmux = usePrivateTmux(base, "despawn");
  stub = await makeClaudeStub(base);
  session = await resolveTargetSession("main");
});

afterAll(async () => {
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

interface Launched {
  readonly paneId: string;
  /** What reached the stub: `pid <n>`, then one line per event. */
  readonly events: () => Promise<readonly string[]>;
  /** The stub's own pid, once it has started. */
  readonly pid: () => Promise<number>;
}

async function open(command: string): Promise<string> {
  const paneId = await tmuxOk(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-c", base, command]);
  return paneId.trim();
}

/**
 * A stub in a window séance would recognise as its own, recording to a file of
 * its own. Returns once the pane registers, as a session list would offer it.
 */
async function launch(
  wrapper: string,
  opts: { readonly worktree?: boolean; readonly via?: string } = {},
): Promise<Launched> {
  records += 1;
  const record = join(base, `record-${records}`);
  const flags = `--remote-control${opts.worktree === true ? " --worktree wt" : ""} --stub-record ${record}`;
  const paneId = await open(`exec ${opts.via ?? ""}${wrapper} ${flags}`);
  const events = async (): Promise<readonly string[]> =>
    (
      await Bun.file(record)
        .text()
        .catch(() => "")
    )
      .split("\n")
      .filter((line) => line !== "");
  const pid = async (): Promise<number> => {
    await pollUntil(async () => (await events()).length > 0, `stub pid in ${record}`);
    return Number((await events())[0]?.replace("pid ", ""));
  };
  await registered(paneId);
  return { paneId, events, pid };
}

/** The session list's predicate: what despawn will accept as a target. */
async function registered(paneId: string): Promise<void> {
  await pollUntil(async () => {
    const pane = (await listPanes()).find((candidate) => candidate.paneId === paneId);
    return pane !== undefined && isRegistered(pane);
  }, `${paneId} to register`);
}

async function paneExists(paneId: string): Promise<boolean> {
  return (await listPanes()).some((pane) => pane.paneId === paneId);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function failure(promise: Promise<unknown>): Promise<DespawnFailure> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof DespawnFailure) return err;
    throw err;
  }
  throw new Error("expected a DespawnFailure");
}

describe("despawnSession (real tmux, stub claude)", () => {
  test("an idle session is asked to exit and does — its window closes", async () => {
    const launched = await launch(stub.repl);
    const result = await despawnSession(launched.paneId, { force: false });
    expect(result.outcome).toBe("exited");
    expect(await paneExists(launched.paneId)).toBe(false);
  });

  test("a draft in the box is cleared, never sent as a prompt", async () => {
    const launched = await launch(stub.repl);
    await tmuxOk(["send-keys", "-t", launched.paneId, "-l", "half a thought"]);
    expect((await despawnSession(launched.paneId, { force: false })).outcome).toBe("exited");
    expect((await launched.events()).filter((event) => event.startsWith("submitted"))).toEqual([]);
  });

  test("a worktree session's exit prompt is answered with Keep, and it exits", async () => {
    const launched = await launch(stub.repl, { worktree: true });
    expect((await despawnSession(launched.paneId, { force: false })).outcome).toBe("exited");
    expect(await paneExists(launched.paneId)).toBe(false);
  });

  test("a session already on the exit prompt gets Enter alone — Esc would cancel the exit", async () => {
    const launched = await launch(stub.exitPrompt);
    expect((await despawnSession(launched.paneId, { force: false })).outcome).toBe("exited");
    expect(await launched.events()).not.toContain("esc");
  });

  test("a hand-started claude exits back to its shell, and the pane goes with it", async () => {
    records += 1;
    const record = join(base, `record-${records}`);
    const paneId = await open("bash --noprofile --norc -i");
    await tmuxOk(["send-keys", "-t", paneId, "-l", `${stub.repl} --stub-record ${record}`]);
    await tmuxOk(["send-keys", "-t", paneId, "Enter"]);
    await registered(paneId);
    expect((await despawnSession(paneId, { force: false })).outcome).toBe("exited");
    expect(await paneExists(paneId)).toBe(false);
  });

  test("a session that won't exit is killed once the grace runs out, process and all", async () => {
    const launched = await launch(stub.deaf);
    const pid = await launched.pid();
    const result = await despawnSession(launched.paneId, { force: false, graceMs: 500 });
    expect(result.outcome).toBe("killed");
    expect(await paneExists(launched.paneId)).toBe(false);
    // It ignores the SIGHUP the pane's close sends: only the escalation ends it.
    await pollUntil(() => !alive(pid), `deaf stub ${pid} to die`);
  });

  test("force kills without a keystroke", async () => {
    const launched = await launch(stub.repl);
    expect((await despawnSession(launched.paneId, { force: true })).outcome).toBe("killed");
    expect(await paneExists(launched.paneId)).toBe(false);
    expect(await launched.events()).not.toContain("esc");
  });

  // macOS spawns wrap claude in `caffeinate -is`, so the pane's process is
  // caffeinate and claude its child — the shape that orphans a claude which
  // ignores SIGHUP when only the pane's own process is dealt with.
  test.skipIf(process.platform !== "darwin")("killing a caffeinate-wrapped pane leaves no claude behind", async () => {
    const launched = await launch(stub.deaf, { via: "caffeinate -is " });
    const pid = await launched.pid();
    expect((await despawnSession(launched.paneId, { force: true })).outcome).toBe("killed");
    await pollUntil(() => !alive(pid), `caffeinated stub ${pid} to die`);
  });

  test("anything but a pane id is refused before tmux sees it", async () => {
    const bystander = await launch(stub.repl);
    for (const target of ["main:1", "{marked}", "=main", "", `${bystander.paneId} `, "%1;kill-server"]) {
      // oxlint-disable-next-line no-await-in-loop
      expect((await failure(despawnSession(target, { force: true }))).code).toBe("invalid_target");
    }
    expect(await paneExists(bystander.paneId)).toBe(true);
  });

  test("a pane that holds no session is not found — nor is one claude hasn't registered in yet", async () => {
    expect((await failure(despawnSession("%99999", { force: true }))).code).toBe("session_not_found");
    const starting = await open(`exec ${stub.stuck} --remote-control`);
    expect((await failure(despawnSession(starting, { force: true }))).code).toBe("session_not_found");
    expect(await paneExists(starting)).toBe(true);
  });
});
