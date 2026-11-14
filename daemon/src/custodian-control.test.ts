import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropRoundRequest,
  pausedAt,
  peekRoundRequest,
  readControl,
  readSeatView,
  requestRound,
  ROUND_REQUEST_TTL_MS,
  writePause,
  writeSeatView,
} from "./custodian-control.ts";

let dir: string;
let statePath: string;
let requestPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-control-"));
  statePath = join(dir, "custodian", "state.json");
  requestPath = join(dir, "custodian", "round-request");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("the pause file", () => {
  test("a missing file is not paused", async () => {
    expect(await readControl(statePath)).toEqual({ pause: null, unreadable: false });
  });

  test("a file it cannot read loads as paused indefinitely, and `resume` rewrites it readable", async () => {
    await writePause(null, statePath);
    for (const text of ["{nope", "[]", '{"pause":{"at":"x","until":null}}', '{"pause":5}']) {
      await writeFile(statePath, text);
      const read = await readControl(statePath);
      expect(read.unreadable).toBe(true);
      expect(pausedAt(read, Date.now())).toBe(true);
      expect(read.pause?.until).toBeNull();
    }
    await writePause(null, statePath);
    const resumed = await readControl(statePath);
    expect(resumed).toEqual({ pause: null, unreadable: false });
    expect(pausedAt(resumed, Date.now())).toBe(false);
  });

  test("a pause holds until its `until`, or until resume with none", async () => {
    await writePause({ at: 1_000, until: 5_000 }, statePath);
    const read = await readControl(statePath);
    expect(pausedAt(read, 4_999)).toBe(true);
    expect(pausedAt(read, 5_000)).toBe(false);
    await writePause({ at: 1_000, until: null }, statePath);
    expect(pausedAt(await readControl(statePath), 9e12)).toBe(true);
  });

  test("a write keeps unknown keys, is 0600 in a 0700 dir", async () => {
    await seedState(statePath, '{"counters":{"a":1}}');
    await writePause({ at: 1, until: null }, statePath);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      counters: { a: 1 },
      pause: { at: 1, until: null },
    });
    await writePause(null, statePath);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ counters: { a: 1 } });
    expect(await mode(statePath)).toBe(0o600);
    expect(await mode(join(dir, "custodian"))).toBe(0o700);
  });
});

async function seedState(path: string, text: string): Promise<void> {
  await writePause(null, path);
  await writeFile(path, text);
}

describe("the round request", () => {
  test("none, fresh, and stale by age, future time or malformed content", async () => {
    expect(await peekRoundRequest(1_000_000, requestPath)).toBe("none");
    await requestRound(1_000_000, requestPath);
    expect(await mode(requestPath)).toBe(0o600);
    expect(await peekRoundRequest(1_000_000, requestPath)).toBe("fresh");
    expect(await peekRoundRequest(1_000_000 + ROUND_REQUEST_TTL_MS, requestPath)).toBe("fresh");
    expect(await peekRoundRequest(1_000_001 + ROUND_REQUEST_TTL_MS, requestPath)).toBe("stale");
    expect(await peekRoundRequest(999_999, requestPath)).toBe("stale");
    for (const text of ["{nope", "[]", '{"at":"x"}', "{}"]) {
      await writeFile(requestPath, text);
      expect(await peekRoundRequest(1_000_000, requestPath)).toBe("stale");
    }
  });

  test("dropping it removes it, and dropping none is fine", async () => {
    await requestRound(1, requestPath);
    await dropRoundRequest(requestPath);
    expect(await peekRoundRequest(1, requestPath)).toBe("none");
    await dropRoundRequest(requestPath);
  });
});

describe("the seat's published view", () => {
  test("round-trips, and anything unreadable is null", async () => {
    const path = join(dir, "custodian", "seat.json");
    expect(await readSeatView(path)).toBeNull();
    const view = { s: "paused", e: 5, n: [1, 0, 0], at: 9, held: false, failed: false, version: "1.2.3" } as const;
    await writeSeatView(view, path);
    expect(await readSeatView(path)).toEqual(view);
    expect(await mode(path)).toBe(0o600);
    await writeFile(path, "{nope");
    expect(await readSeatView(path)).toBeNull();
  });
});
