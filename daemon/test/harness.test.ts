import { describe, expect, test } from "bun:test";
import { startTestRelay } from "./harness.ts";

describe("the test relay", () => {
  // Bound to Bun's default dual-stack [::], macOS let a second listener take
  // 127.0.0.1 on the same port, and every dial at relay.url reached that one
  // instead: the leader's leg never opened (leader.test.ts, ~1 in 40 shard runs,
  // the port a VS Code helper's). This is that second listener.
  test("owns 127.0.0.1 on its port, so nothing else can answer its dials", () => {
    const relay = startTestRelay("harness-bearer");
    try {
      expect(relay.url).toBe(`ws://127.0.0.1:${relay.port}`);
      expect(() =>
        Bun.listen({ hostname: "127.0.0.1", port: relay.port, socket: { data: () => {} } }).stop(true),
      ).toThrow();
    } finally {
      relay.stop();
    }
  });
});
