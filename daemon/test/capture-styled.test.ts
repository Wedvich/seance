import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputBoxDraft, inputBoxText } from "../src/drain-ask.ts";
import { capturePane, tmuxOk } from "../src/tmux.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * What `capture-pane -e` hands `inputBoxDraft`, from a real tmux: a suggestion drawn faint with its first cell as the
 * cursor reads as an empty box, typed text beside it does not, and the plain capture of the same pane (what the drain
 * ask and the screen sampler read) still reads the suggestion as text.
 */

const RULE = "─".repeat(40);
let base: string;
let privateTmux: PrivateTmux | undefined;
let ghost: string;
let typed: string;

/** A window whose process draws `box` (printf escapes allowed) between two rules, then idles. */
async function drawBox(name: string, box: string): Promise<string> {
  return (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "sty:",
      "-n",
      name,
      `printf 'earlier output\\n${RULE}\\n${box}\\n${RULE}\\n  ? for shortcuts\\n'; exec sleep 600`,
    ])
  ).trim();
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-sty-")));
  privateTmux = usePrivateTmux(base, "sty");
  await tmuxOk(["new-session", "-d", "-s", "sty", "-c", base, "sleep", "600"]);
  ghost = await drawBox("ghost", "❯ \\033[7mc\\033[0m\\033[2mommit and push the changes\\033[0m");
  typed = await drawBox("typed", "❯ half a reply\\033[2m and a suggestion\\033[0m");
});

afterAll(async () => {
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

test("tmux's styled capture keeps the faint cells apart from typed text", async () => {
  for (const pane of [ghost, typed]) {
    await pollUntil(
      async () => (await capturePane(pane, { history: false }))?.includes("shortcuts") === true,
      "the box was drawn",
    );
  }
  expect(inputBoxDraft((await capturePane(ghost, { history: false, styled: true })) ?? "")).toBe("");
  expect(inputBoxDraft((await capturePane(typed, { history: false, styled: true })) ?? "")).toBe("half a reply");
  // The plain capture, which the drain's input check keeps reading, has no attributes to tell them apart by.
  expect(inputBoxText((await capturePane(ghost, { history: false })) ?? "")).toBe("commit and push the changes");
});
