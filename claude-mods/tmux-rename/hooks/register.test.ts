import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { sessionName, windowName } from "./register.ts";

type Recorded = { readonly renames: string[]; readonly tmux: string[][] };

/**
 * `serverTag` is the tmux server's global SEANCE_MACHINE_TAG: undefined answers
 * `show-environment` the way tmux does for an unset variable. `tmux` records
 * every other tmux call — the rename-window.
 */
function record(
  on: On,
  env: Readonly<Record<string, string>>,
  { exitCode = 0, serverTag }: { readonly exitCode?: number; readonly serverTag?: string } = {},
): Recorded {
  const recorded: Recorded = { renames: [], tmux: [] };
  mock.env(on, env);
  on("command.run", (_$, e) => {
    recorded.renames.push(e.args);
    return { text: "renamed" };
  });
  on("process.run", (_$, e) => {
    const truncated = { isStdoutTruncated: false, isStderrTruncated: false };
    if (e.argv[1] === "show-environment") {
      return {
        value:
          serverTag === undefined
            ? { exitCode: 1, stdout: "", stderr: "unknown variable: SEANCE_MACHINE_TAG", ...truncated }
            : { exitCode: 0, stdout: `SEANCE_MACHINE_TAG=${serverTag}\n`, stderr: "", ...truncated },
      };
    }
    recorded.tmux.push([...e.argv]);
    return { value: { exitCode, stdout: "", stderr: "no such pane", ...truncated } };
  });
  return recorded;
}

async function rename($: Engine, args: string): Promise<unknown> {
  return $.command.run({
    command: "rename",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 },
  });
}

describe("sessionName", () => {
  test("appends the machine tag once", () => {
    expect(sessionName("bla-bla", "wsl-box")).toBe("bla-bla (wsl-box)");
    expect(sessionName("  bla-bla (wsl-box)  ", "wsl-box")).toBe("bla-bla (wsl-box)");
  });

  test("any other parenthetical isn't the tag", () => {
    expect(sessionName("fix login (urgent)", "wsl-box")).toBe("fix login (urgent) (wsl-box)");
  });

  test("untagged, the name passes through", () => {
    expect(sessionName("bla-bla", undefined)).toBe("bla-bla");
    expect(sessionName("bla-bla", "")).toBe("bla-bla");
  });
});

describe("windowName", () => {
  test("drops exactly the machine tag", () => {
    expect(windowName("bla-bla (wsl-box)", "wsl-box")).toBe("bla-bla");
    expect(windowName("  bla-bla  ", "wsl-box")).toBe("bla-bla");
  });

  test("keeps any other parenthetical", () => {
    expect(windowName("fix login (urgent)", "wsl-box")).toBe("fix login (urgent)");
    expect(windowName("bla-bla(wsl-box)", "wsl-box")).toBe("bla-bla(wsl-box)");
    expect(windowName("bla-bla (wsl-box)", undefined)).toBe("bla-bla (wsl-box)");
  });
});

describe("/rename", () => {
  test("tags the session and leaves the window bare", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "wsl-box" });
    expect(await rename($, "bla-bla")).toEqual({ text: "renamed" });
    expect(recorded.renames).toEqual(["bla-bla (wsl-box)"]);
    expect(recorded.tmux).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla"]]);
  });

  test("an already-tagged name keeps its one tag", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "wsl-box" });
    await rename($, "bla-bla (wsl-box)");
    expect(recorded.renames).toEqual(["bla-bla (wsl-box)"]);
    expect(recorded.tmux).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla"]]);
  });

  test("padding is trimmed from both names, tagged or not", async ($, on) => {
    const tagged = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "wsl-box" });
    await rename($, "  bla-bla (wsl-box)  ");
    await rename($, "  bla-bla  ");
    expect(tagged.renames).toEqual(["bla-bla (wsl-box)", "bla-bla (wsl-box)"]);
    expect(tagged.tmux.map((argv) => argv.at(-1))).toEqual(["bla-bla", "bla-bla"]);
  });

  test("untagged, padding is trimmed too", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7" });
    await rename($, "  bla-bla  ");
    expect(recorded.renames).toEqual(["bla-bla"]);
    expect(recorded.tmux).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla"]]);
  });

  test("outside a séance spawn the name passes through whole", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7" });
    await rename($, "bla-bla");
    expect(recorded.renames).toEqual(["bla-bla"]);
    expect(recorded.tmux).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla"]]);
  });

  test("a dash-led name reaches tmux as the name, not as flags", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7" });
    await rename($, "-wip fix");
    expect(recorded.tmux).toEqual([["tmux", "rename-window", "-t", "%7", "--", "-wip fix"]]);
  });

  test("outside tmux the session is still tagged", async ($, on) => {
    const recorded = record(on, { SEANCE_MACHINE_TAG: "wsl-box" });
    await rename($, "bla-bla");
    expect(recorded.renames).toEqual(["bla-bla (wsl-box)"]);
    expect(recorded.tmux).toEqual([]);
  });

  test("a bare /rename is left alone", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "wsl-box" });
    await rename($, "  ");
    expect(recorded.renames).toEqual(["  "]);
    expect(recorded.tmux).toEqual([]);
  });

  test("the tmux server's tag reaches a session launched before it was set", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7" }, { serverTag: "mac" });
    await rename($, "bla-bla (mac)");
    expect(recorded.renames).toEqual(["bla-bla (mac)"]);
    expect(recorded.tmux).toEqual([["tmux", "rename-window", "-t", "%7", "--", "bla-bla"]]);
  });

  test("the tmux server's tag beats a stale one in the process env", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "old-box" }, { serverTag: "new-box" });
    await rename($, "bla-bla");
    expect(recorded.renames).toEqual(["bla-bla (new-box)"]);
  });

  test("an empty tag on the tmux server means untagged", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "old-box" }, { serverTag: "" });
    await rename($, "bla-bla");
    expect(recorded.renames).toEqual(["bla-bla"]);
  });

  test("a failing tmux still lets the rename through", async ($, on) => {
    const recorded = record(on, { TMUX_PANE: "%7", SEANCE_MACHINE_TAG: "wsl-box" }, { exitCode: 1 });
    expect(await rename($, "bla-bla")).toEqual({ text: "renamed" });
    expect(recorded.renames).toEqual(["bla-bla (wsl-box)"]);
  });
});
