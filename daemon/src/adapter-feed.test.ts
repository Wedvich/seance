import { describe, expect, test } from "bun:test";
import { createAdapterFeed, type FeedFrame, type FeedPane } from "./adapter-feed.ts";
import { sessionKey, type ClaudeProcess } from "./claude-process.ts";
import { createConversations } from "./conversations.ts";
import { LaunchLedger } from "./launch-ledger.ts";
import { EndedTasks } from "./session-events.ts";

/**
 * The feed's read against a pane that moves while it reads, with tmux and `ps` stood in at their boundary: the pane
 * list (`panes`, also what the conversation table sweeps by) and the process descent (`claudeUnder`). A record must
 * describe one instant's pane; the real-process suite (`daemon/test/adapters.test.ts`) only hits the window under load.
 */

const TASK = "00000001-2c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "00000002-2c2d-4e5f-8a9b-0c1d2e3f4a5b";
const PANE_PID = 4100;
const CLAUDE: ClaudeProcess = { pid: 4101, start: "1795000000.000001", key: sessionKey(4101, "1795000000.000001") };

/** One pane, its task and whether its `claude` runs; `afterList` runs once each listing has been taken. */
function host(afterList: (listing: number, pane: { taskId: string | null; claude: boolean }) => void) {
  const pane = { taskId: null as string | null, claude: false };
  const listings: (string | null)[] = [];
  const feedPane = (): FeedPane => ({ id: "%1", pid: PANE_PID, taskId: pane.taskId, window: "w1", path: "/nowhere" });
  const panes = (): Promise<readonly FeedPane[]> => {
    const listed = feedPane();
    listings.push(listed.taskId);
    afterList(listings.length, pane);
    return Promise.resolve([listed]);
  };
  const conversations = createConversations({
    configDirs: () => [],
    launchSession: () => undefined,
    panes: () => Promise.resolve([{ id: "%1", pid: PANE_PID, dead: false, taskId: pane.taskId }]),
  });
  const feed = createAdapterFeed({
    conversations,
    tasks: new EndedTasks(LaunchLedger.memory()),
    exclaves: () => [],
    repos: () => [],
    panes,
    claudeUnder: (pids) => Promise.resolve(new Map(pane.claude && pids.includes(PANE_PID) ? [[PANE_PID, CLAUDE]] : [])),
    intervalMs: 3_600_000,
  });
  const frames: FeedFrame[] = [];
  feed.listen((frame) => frames.push(frame));
  const stop = (): void => {
    feed.stop();
    conversations.stop();
  };
  return { feed, frames, listings, stop };
}

const shapes = (frames: readonly FeedFrame[]): string[] =>
  frames.flatMap((frame) =>
    frame.kind === "session"
      ? [`session:${frame.session.task?.id ?? "-"}`]
      : frame.kind === "session-gone"
        ? [`gone:${frame.reason}`]
        : [],
  );

describe("a feed read across a pane that moves", () => {
  test("tagged and started between the list and the descent: one record, the task's, and no `replaced`", async () => {
    // A spawn's order: the task tag lands, then its `claude` starts — both after the read listed the pane.
    const { feed, frames, listings, stop } = host((listing, pane) => {
      if (listing !== 1) return;
      pane.taskId = TASK;
      pane.claude = true;
    });
    try {
      await feed.start();
      await feed.refresh();
      expect(shapes(frames)).toEqual([`session:${TASK}`]);
      expect(feed.current().map((session) => session.task?.id)).toEqual([TASK]);
      // The injection took effect: the first listing saw the pane untagged, with no `claude` yet.
      expect(listings[0]).toBeNull();
    } finally {
      stop();
    }
  });

  test("a pane re-tagged at every listing: no record at all, and start and refresh still resolve", async () => {
    const { feed, frames, listings, stop } = host((listing, pane) => {
      pane.claude = true;
      pane.taskId = listing % 2 === 1 ? TASK : OTHER;
    });
    try {
      await feed.start();
      await feed.refresh();
      expect(shapes(frames)).toEqual([]);
      expect(feed.current()).toEqual([]);
      // Torn reads were retried, then given up on, rather than one applied or the cycle spinning on.
      expect(listings.length).toBeGreaterThan(2);
      expect(listings.length).toBeLessThan(40);
    } finally {
      stop();
    }
  });
});
