import { describe, expect, test } from "bun:test";
import { sessionChange, waitsForExit } from "../src/settle.ts";
import type { Task } from "../src/index.ts";
import { NOW, spec } from "./fixtures.ts";

/** `sessionChange` with `awaitsExit`: an `ended` that waits for the machine's exit status settles nothing itself. */

const ON_A = { deviceId: "a", exclave: "main", clone: "app", pane: "%1" } as const;
const FROM_A = { deviceId: "a", pane: "%1" } as const;
const task = (fields: Partial<Task> = {}): Task => ({
  id: "t",
  spec: spec(),
  state: "running",
  createdAt: NOW,
  assignment: ON_A,
  ...fields,
});

describe("sessionChange awaiting an exit", () => {
  test("a placed task holding its pane is left as it is; a needs-input one too", () => {
    for (const state of ["running", "needs-input"] as const) {
      expect(sessionChange(task({ state }), "ended", FROM_A, undefined, true)).toBeNull();
    }
  });

  test("a placed task with no pane takes the event's, and stays placed", () => {
    const { pane: _pane, ...bare } = ON_A;
    expect(sessionChange(task({ assignment: bare }), "ended", FROM_A, undefined, true)).toMatchObject({
      state: "running",
      assignment: { pane: "%1" },
    });
  });

  test("a lost task whose machine speaks is not settled by the event either", () => {
    expect(sessionChange(task({ state: "lost" }), "ended", FROM_A, undefined, true)).toBeNull();
  });

  test("a PR on the event or the record settles it as ever", () => {
    const pr = "https://github.com/acme/app/pull/7";
    expect(sessionChange(task(), "ended", FROM_A, pr, true)?.state).toBe("awaiting-merge");
    expect(sessionChange(task({ prUrl: pr }), "ended", FROM_A, undefined, true)?.state).toBe("awaiting-merge");
  });
});

describe("sessionChange done (#21)", () => {
  const reported = { spec: spec({ until: "reported" }) } as const;
  const { pane: _pane, ...target } = ON_A;

  test("a placed task settles done by reported, from the machine it is on", () => {
    expect(sessionChange(task(reported), "done", FROM_A)).toMatchObject({ state: "done", doneBy: "reported" });
    expect(sessionChange(task({ ...reported, state: "needs-input" }), "done", FROM_A)?.state).toBe("done");
  });

  test("an awaiting-merge task settles too, and a PR on the report is kept", () => {
    const pr = "https://github.com/acme/app/pull/7";
    expect(sessionChange(task({ ...reported, state: "awaiting-merge" }), "done", FROM_A, pr)).toMatchObject({
      state: "done",
      doneBy: "reported",
      prUrl: pr,
    });
  });

  test("a reserved task settles on the reservation's machine, taking the pane", () => {
    const held = task({
      ...reported,
      state: "reserved",
      assignment: undefined,
      reservation: { ...target, expiresAt: NOW + 60_000 },
    });
    expect(sessionChange(held, "done", FROM_A)).toMatchObject({
      state: "done",
      doneBy: "reported",
      assignment: { deviceId: "a", pane: "%1" },
    });
    expect(sessionChange(held, "done", { deviceId: "b", pane: "%1" })).toBeNull();
  });

  test("a foreign machine, an unnamed sender and an app cannot settle it", () => {
    expect(sessionChange(task(reported), "done", { deviceId: "b", pane: "%1" })).toBeNull();
    expect(sessionChange(task(reported), "done", { deviceId: "app", pane: "%1" })).toBeNull();
    expect(sessionChange(task(reported), "done", undefined)).toBeNull();
  });

  test("under until: merged (or absent) it is ignored", () => {
    expect(sessionChange(task(), "done", FROM_A)).toBeNull();
    expect(sessionChange(task({ spec: spec({ until: "merged" }) }), "done", FROM_A)).toBeNull();
  });

  test("a placed task with no pane takes the report's, as an event does", () => {
    expect(sessionChange(task({ ...reported, assignment: target }), "done", FROM_A)).toMatchObject({
      state: "done",
      assignment: { deviceId: "a", pane: "%1" },
    });
    expect(sessionChange(task({ ...reported, assignment: { ...ON_A, pane: "%9" } }), "done", FROM_A)).toMatchObject({
      assignment: { pane: "%9" },
    });
  });

  test("a task that was never placed is left alone", () => {
    for (const state of ["queued", "blocked", "ready"] as const) {
      expect(sessionChange(task({ ...reported, state, assignment: undefined }), "done", FROM_A)).toBeNull();
    }
  });
});

describe("waitsForExit", () => {
  test("only the machine the task is on, and only a PR-less end", () => {
    expect(waitsForExit(task(), "ended", FROM_A, undefined, true)).toBe(true);
    expect(waitsForExit(task(), "ended", { deviceId: "b", pane: "%1" }, undefined, true)).toBe(false);
    expect(waitsForExit(task(), "ended", undefined, undefined, true)).toBe(false);
    expect(waitsForExit(task(), "ended", FROM_A, undefined, false)).toBe(false);
    expect(waitsForExit(task(), "busy", FROM_A, undefined, true)).toBe(false);
    expect(waitsForExit(task({ state: "queued", assignment: undefined }), "ended", FROM_A, undefined, true)).toBe(
      false,
    );
  });
});
