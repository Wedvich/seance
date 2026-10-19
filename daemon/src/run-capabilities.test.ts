import { describe, expect, test } from "bun:test";
import { startEach, type Started } from "./run-capabilities.ts";

const ctx = {};
const handle = (): Promise<never> => Promise.reject(new Error("unused"));

function recording(log: string[], name: string, local?: Started["local"]): () => Started {
  return () => {
    log.push(`start ${name}`);
    return { stop: (): void => void log.push(`stop ${name}`), ...(local === undefined ? {} : { local }) };
  };
}

describe("startEach", () => {
  test("starts in list order and stops in reverse", () => {
    const log: string[] = [];
    const started = startEach(ctx, [recording(log, "a"), recording(log, "b"), recording(log, "c")]);
    started.stop();
    expect(log).toEqual(["start a", "start b", "start c", "stop c", "stop b", "stop a"]);
  });

  test("a start that throws stops the ones already started, in reverse, and rethrows", () => {
    const log: string[] = [];
    const boom = new Error("boom");
    const failing = (): Started => {
      log.push("start c");
      throw boom;
    };
    expect(() => startEach(ctx, [recording(log, "a"), recording(log, "b"), failing, recording(log, "d")])).toThrow(
      boom,
    );
    expect(log).toEqual(["start a", "start b", "start c", "stop b", "stop a"]);
  });

  test("merges the local surfaces each capability brings", () => {
    const started = startEach(ctx, [
      recording([], "a", { broker: handle }),
      recording([], "b"),
      recording([], "c", { sessionEvents: handle }),
    ]);
    expect(Object.keys(started.local).toSorted()).toEqual(["broker", "sessionEvents"]);
  });

  test("two capabilities serving one surface throw, stopping what started", () => {
    const log: string[] = [];
    expect(() =>
      startEach(ctx, [recording(log, "a", { broker: handle }), recording(log, "b", { broker: handle })]),
    ).toThrow(/"broker" surface/u);
    expect(log).toEqual(["start a", "start b", "stop b", "stop a"]);
  });
});
