import { describe, expect, test } from "bun:test";
import type { NeedsInputReason, SessionState } from "@seance/shared";
import type { DrainAskOutcome } from "./audit.ts";
import { createDrainAsk, DRAIN_PROMPT, inputBoxShows, type DrainAsk } from "./drain-ask.ts";
import type { BoundPane } from "./session-events.ts";

const CL = 1_000_000;
const INTERRUPT_MS = 300_000;
const SKIP_MS = 30_000;

const pane = (id: string, taskId: string | null, extra: Partial<BoundPane> = {}): BoundPane => ({
  id,
  pid: 100,
  dead: false,
  taskId,
  path: "/work",
  ...extra,
});

/** Fake timers: `advance` runs what has come due, in order. */
function clock(): {
  readonly now: () => number;
  readonly after: (ms: number, fn: () => void) => () => void;
  readonly advance: (ms: number) => void;
} {
  let at = CL;
  let nextId = 0;
  const timers = new Map<number, { readonly due: number; readonly fn: () => void }>();
  return {
    now: () => at,
    after: (ms, fn) => {
      const id = nextId++;
      timers.set(id, { due: at + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    advance: (ms) => {
      const target = at + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.due <= target)
          .toSorted((a, b) => a[1].due - b[1].due)[0];
        if (next === undefined) break;
        timers.delete(next[0]);
        at = Math.max(at, next[1].due);
        next[1].fn();
      }
      at = target;
    },
  };
}

interface Rig {
  readonly ask: DrainAsk;
  readonly keys: { pane: string; args: readonly string[] }[];
  readonly audits: { taskId: string; outcome: DrainAskOutcome }[];
  readonly clock: ReturnType<typeof clock>;
  panes: BoundPane[];
  cl: number | null;
  askable: Set<string> | "all";
  marked: Set<string>;
  shown: boolean;
  /** Runs once the `-l` text has gone in, before the screen is read: a frame landing mid-sequence. */
  onTyped: (() => void) | undefined;
  /** Runs once the screen has been read, before Enter. */
  afterScreen: (() => void) | undefined;
  failKey: string | undefined;
  /** A key whose send throws, as a failed spawn does. */
  throwKey: string | undefined;
}

function rig(): Rig {
  const c = clock();
  const r: Rig = {
    keys: [],
    audits: [],
    clock: c,
    panes: [pane("%1", "t-1")],
    cl: CL,
    askable: "all",
    marked: new Set(),
    shown: true,
    onTyped: undefined,
    afterScreen: undefined,
    failKey: undefined,
    throwKey: undefined,
    ask: undefined as never,
  };
  const ask = createDrainAsk({
    closed: () => r.cl,
    panes: () => Promise.resolve(r.panes),
    askable: (taskId) => r.askable === "all" || r.askable.has(taskId),
    marked: (p) => r.marked.has(p),
    keys: (p, args) => {
      if (r.throwKey !== undefined && args[0] === r.throwKey) return Promise.reject(new Error("spawn failed"));
      if (r.failKey !== undefined && args[0] === r.failKey) return Promise.resolve(false);
      r.keys.push({ pane: p, args });
      if (args[0] === "-l") r.onTyped?.();
      return Promise.resolve(true);
    },
    inputShows: () => {
      const answer = r.shown;
      r.afterScreen?.();
      return Promise.resolve(answer);
    },
    audit: (taskId, outcome) => {
      r.audits.push({ taskId, outcome });
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    after: c.after,
    now: c.now,
    interruptMs: INTERRUPT_MS,
    skipMs: SKIP_MS,
  });
  return Object.assign(r, { ask });
}

const frame = (
  r: Rig,
  state: SessionState,
  opts: { pane?: string; taskId?: string; turnEnded?: boolean; reason?: NeedsInputReason; closing?: boolean } = {},
): void =>
  r.ask.observe(
    opts.pane ?? "%1",
    opts.taskId ?? "t-1",
    state,
    opts.turnEnded ?? false,
    opts.reason,
    opts.closing ?? false,
  );

const turnEnd = (r: Rig, opts: { pane?: string; taskId?: string } = {}): void =>
  frame(r, "idle", { ...opts, turnEnded: true });

/** Lets the detached typing sequence run to its end. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const TYPING = [["C-c"], ["-l", DRAIN_PROMPT], ["Enter"]];
const argsOf = (r: Rig): (readonly string[])[] => r.keys.map((k) => k.args);

describe("DRAIN_PROMPT", () => {
  test("is one line, never a flag, digit-free and names the tool", () => {
    expect(DRAIN_PROMPT).not.toMatch(/[\n\r]/u);
    expect(DRAIN_PROMPT.startsWith("-")).toBe(false);
    expect(DRAIN_PROMPT).not.toMatch(/\d/u);
    expect(DRAIN_PROMPT).toContain("pass_to_successor");
  });
});

describe("typing", () => {
  test("a pane whose last frame was a turn-ended idle gets C-c, the text, then Enter, and never an Escape", async () => {
    const r = rig();
    turnEnd(r);
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual(TYPING);
    expect(r.audits).toEqual([{ taskId: "t-1", outcome: "typed" }]);
  });

  test("a screen that does not show the prompt gets no Enter, audits skipped and is not asked again", async () => {
    const r = rig();
    turnEnd(r);
    r.shown = false;
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"], ["-l", DRAIN_PROMPT]]);
    expect(r.audits).toEqual([{ taskId: "t-1", outcome: "skipped" }]);
    r.shown = true;
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"], ["-l", DRAIN_PROMPT]]);
  });

  test("a throwing key drops the pane without a second Ctrl+C, and audits skipped", async () => {
    const r = rig();
    turnEnd(r);
    r.throwKey = "-l";
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"]]);
    expect(r.audits).toEqual([{ taskId: "t-1", outcome: "skipped" }]);
    r.throwKey = undefined;
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"]]);
  });

  test("a repeated close at the same cl asks no pane again, typed or skipped, even past the deadline", async () => {
    const r = rig();
    r.panes = [pane("%1", "t-1"), pane("%2", "t-2")];
    turnEnd(r);
    turnEnd(r, { pane: "%2", taskId: "t-2" });
    // %1 is typed; %2's screen then never shows the prompt, so it is skipped.
    r.afterScreen = () => {
      r.afterScreen = undefined;
      r.shown = false;
    };
    await r.ask.closed(CL, false);
    await settle();
    expect(r.audits.map((a) => `${a.taskId}:${a.outcome}`).toSorted()).toEqual(["t-1:typed", "t-2:skipped"]);
    const before = argsOf(r).length;
    frame(r, "busy");
    frame(r, "busy", { pane: "%2", taskId: "t-2" });
    r.clock.advance(INTERRUPT_MS * 2);
    await r.ask.closed(CL, false);
    await r.ask.closed(CL, true);
    await settle();
    expect(argsOf(r)).toHaveLength(before);
    expect(r.audits.map((a) => a.outcome)).not.toContain("interrupted");
  });

  test("a busy pane gets nothing until a turn-ended idle arrives; a plain idle never types", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    await settle();
    expect(r.keys).toEqual([]);
    frame(r, "idle");
    await settle();
    expect(r.keys).toEqual([]);
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual(TYPING);
  });

  test("a frame landing between the text and Enter sends no Enter; a later turn-ended idle types again", async () => {
    const r = rig();
    turnEnd(r);
    r.onTyped = () => {
      r.onTyped = undefined;
      frame(r, "busy");
    };
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"], ["-l", DRAIN_PROMPT]]);
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([...TYPING.slice(0, 2), ...TYPING]);
    expect(r.keys.filter((k) => k.args[0] === "C-c")).toHaveLength(2);
  });

  test("a duplicate turn-ended idle during the sequence runs it again once, not twice at once", async () => {
    const r = rig();
    turnEnd(r);
    r.onTyped = () => {
      r.onTyped = undefined;
      turnEnd(r);
    };
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([...TYPING.slice(0, 2), ...TYPING]);
    expect(r.audits).toEqual([{ taskId: "t-1", outcome: "typed" }]);
  });

  test("a pass mark set while waiting means the next turn-ended idle gets no keys at all", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    r.marked.add("%1");
    turnEnd(r);
    await settle();
    expect(r.keys).toEqual([]);
    expect(r.audits).toEqual([]);
  });

  test("a task that became unaskable while waiting is not typed into", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    r.askable = new Set();
    turnEnd(r);
    await settle();
    expect(r.keys).toEqual([]);
  });

  test("a mark set between the text and Enter withholds Enter", async () => {
    const r = rig();
    turnEnd(r);
    r.afterScreen = () => r.marked.add("%1");
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"], ["-l", DRAIN_PROMPT]]);
  });

  test("a failed text key drops the pane without an Enter or a second C-c, and audits skipped", async () => {
    const r = rig();
    turnEnd(r);
    r.failKey = "-l";
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"]]);
    expect(r.audits).toEqual([{ taskId: "t-1", outcome: "skipped" }]);
    r.failKey = undefined;
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"]]);
  });
});

describe("the interrupt", () => {
  test("an open question gets Esc at once and the text only at the next turn-ended idle", async () => {
    const r = rig();
    frame(r, "needs-input", { reason: "question" });
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
    expect(r.audits).toEqual([{ taskId: "t-1", outcome: "interrupted" }]);
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"], ...TYPING]);
    expect(r.audits.map((a) => a.outcome)).toEqual(["interrupted", "typed"]);
  });

  test("a question that opens while waiting gets Esc at once", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    frame(r, "needs-input", { reason: "question" });
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
  });

  test("a permission wait is treated as busy: no Esc before the deadline, never text while it waits", async () => {
    const r = rig();
    frame(r, "needs-input", { reason: "permission" });
    await r.ask.closed(CL, false);
    await settle();
    expect(r.keys).toEqual([]);
    frame(r, "needs-input");
    await settle();
    expect(r.keys).toEqual([]);
    r.clock.advance(INTERRUPT_MS);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
  });

  test("no text while needs-input, whatever the reason", async () => {
    const r = rig();
    frame(r, "needs-input", { reason: "question" });
    await r.ask.closed(CL, false);
    frame(r, "needs-input", { reason: "permission" });
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
  });

  test("no turn-ended idle within the skip window skips the pane, with no further keys", async () => {
    const r = rig();
    frame(r, "needs-input", { reason: "question" });
    await r.ask.closed(CL, false);
    r.clock.advance(SKIP_MS);
    await settle();
    expect(r.audits.map((a) => a.outcome)).toEqual(["interrupted", "skipped"]);
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
  });

  test("a busy pane gets Esc at cl + the interrupt wait, then the text at the turn-ended idle", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    r.clock.advance(INTERRUPT_MS - 1);
    await settle();
    expect(r.keys).toEqual([]);
    r.clock.advance(1);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"], ...TYPING]);
  });

  test("now interrupts at once, on a fresh close and on an already-closed machine", async () => {
    const fresh = rig();
    frame(fresh, "busy");
    await fresh.ask.closed(CL, true);
    await settle();
    expect(argsOf(fresh)).toEqual([["Escape"]]);

    const later = rig();
    frame(later, "busy");
    await later.ask.closed(CL, false);
    await settle();
    expect(later.keys).toEqual([]);
    await later.ask.closed(CL, true);
    await settle();
    expect(argsOf(later)).toEqual([["Escape"]]);
    // Once per entry.
    await later.ask.closed(CL, true);
    await settle();
    expect(argsOf(later)).toEqual([["Escape"]]);
  });

  test("a pane whose state was never seen is interrupted at the deadline and skipped after", async () => {
    const r = rig();
    await r.ask.closed(CL, false);
    r.clock.advance(INTERRUPT_MS);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
    r.clock.advance(SKIP_MS);
    await settle();
    expect(r.audits.map((a) => a.outcome)).toEqual(["interrupted", "skipped"]);
  });

  test("the deadline never Escapes a pane whose last frame is a turn's end", async () => {
    const r = rig();
    turnEnd(r);
    r.failKey = "C-c";
    await r.ask.closed(CL, false);
    await settle();
    r.clock.advance(INTERRUPT_MS);
    await settle();
    expect(r.keys).toEqual([]);
  });

  test("a pane that turns busy after the deadline passed over its idle is Escaped then", async () => {
    const r = rig();
    turnEnd(r);
    r.failKey = "C-c";
    await r.ask.closed(CL, false);
    await settle();
    r.clock.advance(INTERRUPT_MS);
    await settle();
    expect(r.keys).toEqual([]);
    frame(r, "busy");
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
  });

  test("typing that ends without Enter past the deadline, on a pane no longer at a turn's end, Escapes it", async () => {
    const r = rig();
    turnEnd(r);
    r.onTyped = () => {
      r.onTyped = undefined;
      frame(r, "busy");
    };
    await r.ask.closed(CL, true);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"], ["-l", DRAIN_PROMPT], ["Escape"]]);
  });

  test("no Escape once the machine reads as open, before the reopen reaches the ask", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    r.cl = null;
    r.clock.advance(INTERRUPT_MS);
    frame(r, "needs-input", { reason: "question" });
    await settle();
    expect(r.keys).toEqual([]);
    expect(r.audits).toEqual([]);
  });

  test("a failed Escape drops the pane and audits skipped; a throwing one the same", async () => {
    for (const mode of ["failKey", "throwKey"] as const) {
      const r = rig();
      frame(r, "needs-input", { reason: "question" });
      r[mode] = "Escape";
      await r.ask.closed(CL, false);
      await settle();
      expect(r.keys).toEqual([]);
      expect(r.audits).toEqual([{ taskId: "t-1", outcome: "skipped" }]);
    }
  });
});

describe("lifecycle", () => {
  test("reopening before the deadline sends nothing further and cancels the skip timer", async () => {
    const r = rig();
    frame(r, "needs-input", { reason: "question" });
    await r.ask.closed(CL, false);
    await settle();
    r.cl = null;
    r.ask.reopened();
    r.clock.advance(INTERRUPT_MS * 2);
    turnEnd(r);
    await settle();
    expect(argsOf(r)).toEqual([["Escape"]]);
    expect(r.audits.map((a) => a.outcome)).toEqual(["interrupted"]);
  });

  test("a reopen between the text and Enter withholds Enter", async () => {
    const r = rig();
    turnEnd(r);
    r.afterScreen = () => {
      r.cl = null;
      r.ask.reopened();
    };
    await r.ask.closed(CL, false);
    await settle();
    expect(argsOf(r)).toEqual([["C-c"], ["-l", DRAIN_PROMPT]]);
  });

  test("a pane reused for another task, or ended, drops its entry with no keys", async () => {
    const reused = rig();
    frame(reused, "busy");
    await reused.ask.closed(CL, false);
    turnEnd(reused, { taskId: "t-2" });
    await settle();
    expect(reused.keys).toEqual([]);

    const ended = rig();
    frame(ended, "busy");
    await ended.ask.closed(CL, false);
    frame(ended, "ended");
    turnEnd(ended);
    await settle();
    expect(ended.keys).toEqual([]);
  });

  test("a hand-off or pass close starting on that very frame drops the entry", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    frame(r, "idle", { turnEnded: true, closing: true });
    await settle();
    expect(r.keys).toEqual([]);
    turnEnd(r);
    await settle();
    expect(r.keys).toEqual([]);
  });

  test("panes it must not touch: unaskable, marked, dead, a non-pane id, untasked", async () => {
    const r = rig();
    r.panes = [
      pane("%1", "t-1"),
      pane("%2", "t-2"),
      pane("%3", "t-3", { dead: true }),
      pane("main:1.0", "t-4"),
      pane("%5", null),
    ];
    r.askable = new Set(["t-2", "t-3", "t-4"]);
    r.marked.add("%2");
    for (const [id, taskId] of [
      ["%1", "t-1"],
      ["%2", "t-2"],
      ["%3", "t-3"],
      ["main:1.0", "t-4"],
    ] as const) {
      turnEnd(r, { pane: id, taskId });
    }
    await r.ask.closed(CL, false);
    await settle();
    expect(r.keys).toEqual([]);
  });

  test("start() while closed past the deadline interrupts every enumerated pane", async () => {
    const r = rig();
    r.panes = [pane("%1", "t-1"), pane("%2", "t-2")];
    r.clock.advance(INTERRUPT_MS + 1);
    r.ask.start();
    await settle();
    expect(r.keys.map((k) => k.pane).toSorted()).toEqual(["%1", "%2"]);
    expect(argsOf(r)).toEqual([["Escape"], ["Escape"]]);
  });

  test("start() while open does nothing", async () => {
    const r = rig();
    r.cl = null;
    r.ask.start();
    await settle();
    expect(r.keys).toEqual([]);
  });

  test("a later close with a new cl asks afresh", async () => {
    const r = rig();
    turnEnd(r);
    await r.ask.closed(CL, false);
    await settle();
    expect(r.audits).toHaveLength(1);
    r.cl = CL + 10;
    turnEnd(r);
    await r.ask.closed(CL + 10, false);
    await settle();
    expect(r.audits).toHaveLength(2);
  });

  test("after stop() nothing is sent", async () => {
    const r = rig();
    frame(r, "busy");
    await r.ask.closed(CL, false);
    r.ask.stop();
    r.clock.advance(INTERRUPT_MS * 2);
    turnEnd(r);
    await r.ask.closed(CL, true);
    await settle();
    expect(r.keys).toEqual([]);
  });
});

describe("inputBoxShows", () => {
  const RULE = "─".repeat(60);
  const screen = (...box: string[]): string =>
    ["Some transcript above", "", RULE, ...box, RULE, "  ? for shortcuts"].join("\n");

  test("the prompt in the input box", () => {
    expect(inputBoxShows(screen(`❯ ${DRAIN_PROMPT}`), DRAIN_PROMPT)).toBe(true);
  });

  test("the prompt wrapped over several lines", () => {
    const words = DRAIN_PROMPT.split(" ");
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if ((current + word).length > 50) {
        lines.push(current.trimEnd());
        current = "";
      }
      current += `${word} `;
    }
    lines.push(current.trimEnd());
    const box = lines.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`));
    expect(lines.length).toBeGreaterThan(2);
    expect(inputBoxShows(screen(...box), DRAIN_PROMPT)).toBe(true);
  });

  test("a prompt with something extra or missing is not the prompt", () => {
    expect(inputBoxShows(screen(`❯ ${DRAIN_PROMPT} and more`), DRAIN_PROMPT)).toBe(false);
    expect(inputBoxShows(screen(`❯ ${DRAIN_PROMPT.slice(0, -10)}`), DRAIN_PROMPT)).toBe(false);
  });

  test("a permission dialog is not the box", () => {
    const dialog = [
      "Some transcript above",
      RULE,
      " Bash command",
      "   touch b.txt",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      RULE,
    ].join("\n");
    expect(inputBoxShows(dialog, DRAIN_PROMPT)).toBe(false);
  });

  test("an AskUserQuestion is not the box", () => {
    const question = [RULE, " Which one?", " ❯ 1. A", "   2. B", "   3. Type something.", RULE].join("\n");
    expect(inputBoxShows(question, DRAIN_PROMPT)).toBe(false);
  });

  test("the Rewind menu is not the box", () => {
    const rewind = [
      "Rewind",
      "Restore the conversation to the point before…",
      RULE,
      "  ❯ (current)",
      `    ${DRAIN_PROMPT}`,
    ].join("\n");
    expect(inputBoxShows(rewind, DRAIN_PROMPT)).toBe(false);
  });

  test("the prompt only in the transcript above an empty box is not in it", () => {
    const transcript = [`❯ ${DRAIN_PROMPT}`, "", "  Working on it.", "", RULE, "❯ ", RULE, "  ? for shortcuts"].join(
      "\n",
    );
    expect(inputBoxShows(transcript, DRAIN_PROMPT)).toBe(false);
  });

  test("a screen with fewer than two rules is not the box", () => {
    expect(inputBoxShows(`${RULE}\n❯ ${DRAIN_PROMPT}`, DRAIN_PROMPT)).toBe(false);
    expect(inputBoxShows(`❯ ${DRAIN_PROMPT}`, DRAIN_PROMPT)).toBe(false);
  });
});
