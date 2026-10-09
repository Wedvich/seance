import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { windowName } from "./register.ts";

function recordTmux(on: On, env: Readonly<Record<string, string>>, exitCode = 0): string[][] {
  const runs: string[][] = [];
  mock.env(on, env);
  on("command.run", () => ({ text: "renamed" }));
  on("process.run", (_$, e) => {
    runs.push([...e.argv]);
    return {
      value: { exitCode, stdout: "", stderr: "no such pane", isStdoutTruncated: false, isStderrTruncated: false },
    };
  });
  return runs;
}

async function rename($: Engine, args: string): Promise<unknown> {
  return $.command.run({
    command: "rename",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });
}

describe("windowName", () => {
  test("drops exactly the machine tag", () => {
    expect(windowName("bla-bla (wsl-box)", "wsl-box")).toBe("bla-bla");
    expect(windowName("  bla-bla (wsl-box)  ", "wsl-box")).toBe("bla-bla");
  });

  test("keeps any other parenthetical", () => {
    expect(windowName("fix login (urgent)", "wsl-box")).toBe("fix login (urgent)");
    expect(windowName("fix login (urgent)", undefined)).toBe("fix login (urgent)");
    expect(windowName("bla-bla(wsl-box)", "wsl-box")).toBe("bla-bla(wsl-box)");
  });
});

describe("/rename", () => {
  test("renames the pane's own window to the bare slug", async ($, on) => {
    const runs = recordTmux(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "wsl-box" });
    expect(await rename($, "bla-bla (wsl-box)")).toEqual({ text: "renamed" });
    expect(runs).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla"]]);
  });

  test("outside a séance spawn the name passes through whole", async ($, on) => {
    const runs = recordTmux(on, { TMUX_PANE: "%7" });
    await rename($, "bla-bla (wsl-box)");
    expect(runs).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla (wsl-box)"]]);
  });

  test("a dash-led name reaches tmux as the name, not as flags", async ($, on) => {
    const runs = recordTmux(on, { TMUX_PANE: "%7" });
    await rename($, "-wip fix");
    expect(runs).toEqual([["tmux", "rename-window", "-t", "%7", "--", "-wip fix"]]);
  });

  test("leaves tmux alone outside tmux", async ($, on) => {
    const runs = recordTmux(on, { SEANCE_MACHINE_TAG: "wsl-box" });
    await rename($, "bla-bla (wsl-box)");
    expect(runs).toEqual([]);
  });

  test("leaves tmux alone on a bare /rename", async ($, on) => {
    const runs = recordTmux(on, { TMUX_PANE: "%7" });
    await rename($, "  ");
    expect(runs).toEqual([]);
  });

  test("a failing tmux still lets the rename through", async ($, on) => {
    recordTmux(on, { TMUX_PANE: "%7" }, 1);
    expect(await rename($, "bla-bla")).toEqual({ text: "renamed" });
  });
});
