import { describe, expect, test } from "bun:test";
import { pollUntil } from "../test/fixtures.ts";
import {
  ancestorBelow,
  ancestorIn,
  bsdParent,
  parseBsdInfo,
  parseProcStatStart,
  processNames,
  processStart,
} from "./peer.ts";

describe("ancestorIn", () => {
  test("walks from a grandchild up to the nearest ancestor the targets hold, and finds nothing past them", async () => {
    // `sh` stays the parent: with a second command after it, `-c` cannot exec `sleep` in place.
    const child = Bun.spawn(["sh", "-c", "sleep 30; :"], { stdout: "ignore" });
    let grandchild = 0;
    try {
      await pollUntil(() => {
        grandchild = Number(
          Bun.spawnSync(["pgrep", "-P", String(child.pid)])
            .stdout.toString()
            .trim(),
        );
        return grandchild > 0;
      }, "sh to start sleep");

      expect(await ancestorIn(grandchild, new Map([[process.pid, "test runner"]]))).toBe("test runner");
      const both = new Map([
        [child.pid, "sh"],
        [process.pid, "test runner"],
      ]);
      expect(await ancestorIn(grandchild, both)).toBe("sh");
      expect(await ancestorIn(grandchild, new Map([[-1, "nobody"]]))).toBeNull();
    } finally {
      // sh holds a signal until its foreground child exits, so the sleep goes first.
      if (grandchild > 0) process.kill(grandchild);
      child.kill();
      await child.exited;
    }
  });
});

describe("ancestorBelow", () => {
  test("names the pids between the peer and the target, peer first, and none when the peer is the target", async () => {
    const child = Bun.spawn(["sh", "-c", "sleep 30; :"], { stdout: "ignore" });
    let grandchild = 0;
    try {
      await pollUntil(() => {
        grandchild = Number(
          Bun.spawnSync(["pgrep", "-P", String(child.pid)])
            .stdout.toString()
            .trim(),
        );
        return grandchild > 0;
      }, "sh to start sleep");

      expect(await ancestorBelow(grandchild, new Map([[process.pid, "runner"]]))).toEqual({
        hit: "runner",
        below: [grandchild, child.pid],
      });
      expect(await ancestorBelow(grandchild, new Map([[child.pid, "sh"]]))).toEqual({ hit: "sh", below: [grandchild] });
      expect(await ancestorBelow(grandchild, new Map([[grandchild, "itself"]]))).toEqual({ hit: "itself", below: [] });
      expect(await ancestorBelow(grandchild, new Map([[-1, "nobody"]]))).toBeNull();
    } finally {
      if (grandchild > 0) process.kill(grandchild);
      child.kill();
      await child.exited;
    }
  });
});

describe("processNames", () => {
  test("names a running process as ps and tmux do, and nothing for one that is gone", async () => {
    const sleeper = Bun.spawn(["sleep", "30"]);
    try {
      await pollUntil(async () => (await processNames(sleeper.pid)).includes("sleep"), "sleep to exec");
    } finally {
      sleeper.kill();
      await sleeper.exited;
    }
    expect(await processNames(sleeper.pid)).toEqual([]);
  });
});

describe("bsdParent", () => {
  test.if(process.platform === "darwin")("names the kernel's parent, and null for a pid that is gone", async () => {
    expect(bsdParent(process.pid)).toBe(process.ppid);
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(bsdParent(gone.pid)).toBeNull();
  });

  test.if(process.platform !== "darwin")("is undefined off macOS, which sends the walk elsewhere", () => {
    expect(bsdParent(process.pid)).toBeUndefined();
  });
});

describe("a process's start time", () => {
  const stat = (state: string, comm: string): string =>
    `1234 (${comm}) ${state} 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 100 18446744073709551615 1 1 0`;

  test("is field 22 of /proc stat, found past a comm that holds spaces and parens, and none for a zombie", () => {
    expect(parseProcStatStart(stat("S", "claude"))).toBe("98765");
    expect(parseProcStatStart(stat("R", "my (odd) cmd"))).toBe("98765");
    expect(parseProcStatStart(stat("Z", "claude"))).toBeNull();
    expect(parseProcStatStart("garbage")).toBeNull();
  });

  test("is the same for a process every time and none once it is gone: a recycled pid is told by it", async () => {
    const own = processStart(process.pid);
    expect(own).not.toBeNull();
    expect(processStart(process.pid)).toBe(own);
    const sleeper = Bun.spawn(["sleep", "30"]);
    const born = processStart(sleeper.pid);
    expect(born).not.toBeNull();
    expect(born).not.toBe(own);
    sleeper.kill();
    await sleeper.exited;
    expect(processStart(sleeper.pid)).toBeNull();
    expect(processStart(0)).toBeNull();
    expect(processStart(-5)).toBeNull();
  });
});

describe("parseBsdInfo", () => {
  const info = (): Uint8Array => {
    const bytes = new Uint8Array(136);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 42, true);
    bytes.set(new TextEncoder().encode("claude"), 48);
    bytes.set(new TextEncoder().encode("claude-long-name"), 64);
    view.setBigUint64(120, 1_700_000_000n, true);
    view.setBigUint64(128, 123_456n, true);
    return bytes;
  };

  test("reads the parent, the kernel's two names and the start time at the offsets <sys/proc_info.h> gives", () => {
    expect(parseBsdInfo(info())).toEqual({
      ppid: 42,
      names: ["claude", "claude-long-name"],
      start: "1700000000.123456",
    });
  });

  test("keeps one name when comm and name agree, and refuses a buffer that is not the whole struct", () => {
    const same = info();
    same.fill(0, 64, 96);
    same.set(new TextEncoder().encode("claude"), 64);
    expect(parseBsdInfo(same)?.names).toEqual(["claude"]);
    expect(parseBsdInfo(info().subarray(0, 100))).toBeNull();
  });
});
