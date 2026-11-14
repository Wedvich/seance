import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roundRemoteId } from "./custodian-remote.ts";

const ID = `session_${"a".repeat(20)}`;
const STARTED = 1_800_000_000_000;
const PANE_PID = 123;

let configDir: string;
let sessions: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "seance-remote-"));
  sessions = join(configDir, "sessions");
  await mkdir(sessions);
});
afterEach(() => rm(configDir, { recursive: true, force: true }));

const file = (pid: number, over: Record<string, unknown> = {}): Promise<void> =>
  writeFile(
    join(sessions, `${pid}.json`),
    JSON.stringify({ pid, startedAt: STARTED + 1_000, bridgeSessionId: ID, ...over }),
  );
/** pid -> parent: 124 is the pane's direct child, 125 its grandchild. */
const tree = new Map([
  [124, PANE_PID],
  [125, 124],
  [456, 1],
]);
const parentOf = (pid: number): Promise<number | null> => Promise.resolve(tree.get(pid) ?? null);
const round = { panePid: PANE_PID, startedAt: STARTED };

describe("roundRemoteId", () => {
  test("reads the id of the pane's own pid, and of its direct child (macOS's caffeinate wrapper)", async () => {
    await file(PANE_PID);
    expect(await roundRemoteId(configDir, round, parentOf)).toBe(ID);
    await rm(join(sessions, `${PANE_PID}.json`));
    await file(124);
    expect(await roundRemoteId(configDir, round, parentOf)).toBe(ID);
  });

  test("never opens a .key file, and skips files of other processes and bad ids", async () => {
    await writeFile(join(sessions, `${PANE_PID}.abc.key`), "secret");
    await chmod(join(sessions, `${PANE_PID}.abc.key`), 0o000);
    await file(456);
    await file(789, { bridgeSessionId: "session_a b" });
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
    await file(PANE_PID);
    expect(await roundRemoteId(configDir, round, parentOf)).toBe(ID);
  });

  test("a grandchild's file is not the round's: a reused pid must not link another session", async () => {
    await file(125);
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
  });

  test("a stale file of a killed session whose pid was reused is refused: older than the round, or another pid inside", async () => {
    await file(PANE_PID, { startedAt: STARTED - 1 });
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
    await file(PANE_PID, { pid: 999 });
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
    await file(PANE_PID, { startedAt: "late" });
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
  });

  test("an oversized file, a missing directory and malformed JSON all give null", async () => {
    await file(PANE_PID, { pad: "x".repeat(70_000) });
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
    await writeFile(join(sessions, `${PANE_PID}.json`), "{nope");
    expect(await roundRemoteId(configDir, round, parentOf)).toBeNull();
    expect(await roundRemoteId(join(configDir, "absent"), round, parentOf)).toBeNull();
  });

  test("with the real parent lookup, this process's own pid is its own round pane", async () => {
    await file(process.pid);
    expect(await roundRemoteId(configDir, { panePid: process.pid, startedAt: STARTED })).toBe(ID);
  });
});
