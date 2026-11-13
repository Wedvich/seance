import { describe, expect, test } from "bun:test";
import type { ArchivistEntry, ArchivistSilence } from "@seance/shared";
import { ARCHIVIST_SILENCE_MS, archivistSilenceStep } from "../src/archivist-silence.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const seat = (connected: boolean, lastSeen = NOW): ArchivistEntry => ({
  deviceId: "arch",
  name: "archive-box",
  platform: "linux",
  connected,
  lastSeen,
});

/** Runs the step as the watch does: the record holds whatever the last step wrote. */
function run(
  steps: readonly { readonly entry: ArchivistEntry | null; readonly at: number }[],
  start?: ArchivistSilence,
) {
  let held = start;
  const alerts: number[] = [];
  const writes: (ArchivistSilence | undefined)[] = [];
  for (const { entry, at } of steps) {
    const step = archivistSilenceStep(entry, held, at);
    for (const alert of step.alerts) {
      if (alert.kind !== "archivist") throw new Error(`unexpected alert kind ${alert.kind}`);
      expect(alert).toEqual({ v: 1, kind: "archivist", at, since: alert.since });
      alerts.push(alert.since);
    }
    if (step.next !== null) {
      held = step.next;
      writes.push(held);
    }
  }
  return { held, alerts, writes };
}

describe("archivistSilenceStep", () => {
  test("a registry that never held an archivist is never alerted, nor written, however long", () => {
    const { alerts, writes } = run([0, 1, 25, 24 * 30].map((h) => ({ entry: null, at: NOW + h * HOUR })));
    expect(alerts).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("a connected seat is recorded present once; a later reading writes nothing", () => {
    const { writes } = run([
      { entry: seat(true), at: NOW },
      { entry: seat(true), at: NOW + HOUR },
    ]);
    expect(writes).toEqual([{ state: "present" }]);
  });

  test("absent under 24 h alerts nothing; past 24 h alerts once, and later checks repeat nothing", () => {
    const left = NOW + HOUR + 1000;
    const { alerts, writes, held } = run([
      { entry: seat(true), at: NOW },
      { entry: seat(false, NOW + HOUR), at: left },
      { entry: seat(false, NOW + HOUR), at: left + ARCHIVIST_SILENCE_MS - 1 },
      { entry: seat(false, NOW + HOUR), at: left + ARCHIVIST_SILENCE_MS },
      { entry: seat(false, NOW + HOUR), at: left + 2 * ARCHIVIST_SILENCE_MS },
      { entry: null, at: left + 3 * ARCHIVIST_SILENCE_MS },
    ]);
    expect(alerts).toEqual([left]);
    expect(writes).toEqual([{ state: "present" }, { state: "absent", since: left }, { state: "alerted", since: left }]);
    expect(held).toEqual({ state: "alerted", since: left });
  });

  test("a return re-arms it: gone again past 24 h is a second alert, measured from the second absence", () => {
    const back = NOW + 30 * HOUR;
    const second = back + HOUR;
    const { alerts } = run(
      [
        { entry: seat(true, back), at: back },
        { entry: seat(false, second), at: second },
        { entry: seat(false, second), at: second + 23 * HOUR },
        { entry: seat(false, second), at: second + 24 * HOUR },
      ],
      { state: "alerted", since: NOW },
    );
    expect(alerts).toEqual([second]);
  });

  test("an entry that vanishes (forgotten, the seat moved) is absent from the leader's own clock", () => {
    const { alerts, writes } = run(
      [
        { entry: null, at: NOW },
        { entry: null, at: NOW + ARCHIVIST_SILENCE_MS },
      ],
      { state: "present" },
    );
    expect(writes[0]).toEqual({ state: "absent", since: NOW });
    expect(alerts).toEqual([NOW]);
  });

  test("a record with no state but a kept, disconnected entry is a held archivist, measured from its lastSeen", () => {
    const died = NOW - 25 * HOUR;
    const { alerts, writes } = run([{ entry: seat(false, died), at: NOW }]);
    expect(alerts).toEqual([died]);
    expect(writes).toEqual([{ state: "alerted", since: died }]);
    const recent = run([{ entry: seat(false, NOW - HOUR), at: NOW }]);
    expect(recent.alerts).toEqual([]);
    expect(recent.writes).toEqual([{ state: "absent", since: NOW - HOUR }]);
  });

  test("a relay lastSeen ahead of this clock is clamped to it", () => {
    const { writes } = run([{ entry: seat(false, NOW + 10 * HOUR), at: NOW }]);
    expect(writes).toEqual([{ state: "absent", since: NOW }]);
  });

  test("after an observed present, a stale lastSeen (a relay redeploy dropped the sockets) does not alert at once", () => {
    const registered = NOW - 3 * 24 * HOUR;
    const { alerts, writes } = run(
      [
        { entry: seat(false, registered), at: NOW },
        { entry: seat(false, registered), at: NOW + ARCHIVIST_SILENCE_MS - 1 },
        { entry: seat(false, registered), at: NOW + ARCHIVIST_SILENCE_MS },
      ],
      { state: "present" },
    );
    expect(writes).toEqual([
      { state: "absent", since: NOW },
      { state: "alerted", since: NOW },
    ]);
    expect(alerts).toEqual([NOW]);
  });
});
