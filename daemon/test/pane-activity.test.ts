import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaneActivity, type PaneActivityTracker } from "../src/pane-activity.ts";
import { readPanePids } from "../src/session-events.ts";
import { capturePane, CUSTODIAN_OPTION, tmuxOk } from "../src/tmux.ts";
import { pollUntil, usePrivateTmux, type PrivateTmux } from "./fixtures.ts";

/**
 * The sampler against a real tmux: `readPanePids` tells séance's panes (`--remote-control` in the start command)
 * from hand-started ones, and `capture-pane` of the visible screen is what moves `screenSince`.
 */

let base: string;
let privateTmux: PrivateTmux | undefined;
let clock = 1_000;
let tracker: PaneActivityTracker;
let foreign: string;
let ours: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-act-")));
  privateTmux = usePrivateTmux(base, "act");
  foreign = (
    await tmuxOk(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "act", "-c", base, "sleep", "600"])
  ).trim();
  // `:` is a no-op in every shell a developer's tmux.conf might make the default; it carries the marker.
  ours = (
    await tmuxOk([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "act:",
      "-n",
      "ours",
      ": --remote-control; printf 'first\\n'; exec sleep 600",
    ])
  ).trim();
  tracker = createPaneActivity({
    panes: readPanePids,
    capture: (paneId) => capturePane(paneId, { history: false }),
    now: () => clock,
  });
});

afterAll(async () => {
  tracker.stop();
  await privateTmux?.dispose();
  await rm(base, { recursive: true, force: true });
});

async function screenShows(pane: string, text: string): Promise<boolean> {
  return (await capturePane(pane, { history: false }))?.includes(text) === true;
}

test("an ours pane is sampled and a hand-started one is not; a screen change moves its time; a closed pane goes", async () => {
  await pollUntil(() => screenShows(ours, "first"), "the ours pane printed its first line");
  await tracker.sample();
  expect(tracker.activity(foreign)).toBeNull();
  expect(tracker.activity(ours)).toEqual({
    state: null,
    stateSince: null,
    turnEnded: false,
    screenSince: 1_000,
    sampledAt: 1_000,
  });

  clock += 60_000;
  await tracker.sample();
  expect(tracker.activity(ours)).toMatchObject({ screenSince: 1_000, sampledAt: 61_000 });

  const tty = (await tmuxOk(["display-message", "-p", "-t", ours, "#{pane_tty}"])).trim();
  await appendFile(tty, "second\n");
  await pollUntil(() => screenShows(ours, "second"), "the write reached the ours pane's screen");
  clock += 60_000;
  await tracker.sample();
  expect(tracker.activity(ours)).toMatchObject({ screenSince: 121_000, sampledAt: 121_000 });

  await tmuxOk(["kill-pane", "-t", ours]);
  clock += 60_000;
  await tracker.sample();
  expect(tracker.activity(ours)).toBeNull();
});

test("a custodian round is never sampled, and all() lists exactly the tracked panes", async () => {
  const spawnOurs = async (name: string): Promise<string> =>
    (
      await tmuxOk([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "act:",
        "-n",
        name,
        `: --remote-control; printf '${name}\\n'; exec sleep 600`,
      ])
    ).trim();
  const session = await spawnOurs("session");
  const round = await spawnOurs("round");
  await tmuxOk(["set-option", "-p", "-t", round, CUSTODIAN_OPTION, "1"]);
  await pollUntil(() => screenShows(session, "session"), "the session pane printed");
  await pollUntil(() => screenShows(round, "round"), "the round pane printed");

  clock += 60_000;
  await tracker.sample();
  expect(tracker.activity(round)).toBeNull();
  expect(tracker.activity(session)).not.toBeNull();
  expect(tracker.all().map((entry) => entry.pane)).toEqual([session]);
});
