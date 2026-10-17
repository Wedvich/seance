import { describe, expect, test } from "bun:test";
import { pollUntil } from "../test/fixtures.ts";
import { ancestorIn, bsdParent } from "./peer.ts";

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
