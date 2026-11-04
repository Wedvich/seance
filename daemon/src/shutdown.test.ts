import { describe, expect, test } from "bun:test";
import { pollUntil } from "../test/fixtures.ts";
import { createShutdown, type ShutdownSeams } from "./shutdown.ts";

function seams(over: Partial<ShutdownSeams> = {}): { readonly calls: string[]; readonly seams: ShutdownSeams } {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      info: () => {},
      stopPower: () => void calls.push("stopPower"),
      drain: () => {
        calls.push("drain");
        return Promise.resolve(true);
      },
      stop: () => void calls.push("stop"),
      exit: (code) => void calls.push(`exit ${code}`),
      ...over,
    },
  };
}

describe("createShutdown", () => {
  test("drains before it stops, and exits after", async () => {
    const gate = Promise.withResolvers<boolean>();
    const { calls, seams: s } = seams({
      drain: () => {
        calls.push("drain");
        return gate.promise;
      },
    });
    createShutdown(s)("SIGTERM");
    await Bun.sleep(20); // a non-event can't be polled
    expect(calls).toEqual(["stopPower", "drain"]);
    gate.resolve(true);
    await pollUntil(() => calls.includes("exit 0"), "the exit");
    expect(calls).toEqual(["stopPower", "drain", "stop", "exit 0"]);
  });

  test("exits even when the drain rejects or stop throws", async () => {
    const { calls, seams: s } = seams({
      drain: () => Promise.reject(new Error("drain broke")),
      stop: () => {
        calls.push("stop");
        throw new Error("stop broke");
      },
    });
    createShutdown(s)("SIGINT");
    await pollUntil(() => calls.includes("exit 0"), "the exit despite the throw");
    expect(calls).toEqual(["stopPower", "stop", "exit 0"]);
  });

  test("exits even when stopping the power loop throws", async () => {
    const { calls, seams: s } = seams({
      stopPower: () => {
        calls.push("stopPower");
        throw new Error("power broke");
      },
    });
    createShutdown(s)("SIGTERM");
    await pollUntil(() => calls.includes("exit 0"), "the exit despite the throw");
    expect(calls).toEqual(["stopPower", "drain", "stop", "exit 0"]);
  });

  test("a second signal exits at once, without waiting for the drain or stopping again", async () => {
    const gate = Promise.withResolvers<boolean>();
    const { calls, seams: s } = seams({
      drain: () => {
        calls.push("drain");
        return gate.promise;
      },
    });
    const shutdown = createShutdown(s);
    shutdown("SIGTERM");
    shutdown("SIGTERM");
    expect(calls).toEqual(["stopPower", "drain", "exit 0"]);
    gate.resolve(true);
    await pollUntil(() => calls.includes("stop"), "the first shutdown's own stop");
  });
});
