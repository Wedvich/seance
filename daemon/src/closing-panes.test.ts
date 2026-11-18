import { describe, expect, test } from "bun:test";
import { CLOSING_TTL_MS, closedBySeance, noteClosing } from "./closing-panes.ts";

describe("a closing note", () => {
  // A pane id is unique within one tmux server only: a restarted server reuses `%3`, and a test process runs one server
  // per file, so `%3` closed on one is not `%3` exiting on its own on the other.
  test("names the pane's process: the same id under another pid was not closed by Séance", () => {
    const now = 1_000_000;
    noteClosing("%3", 4101, now);
    expect(closedBySeance("%3", 4202, now)).toBe(false);
    expect(closedBySeance("%3", 4101, now)).toBe(true);
  });

  test("lasts CLOSING_TTL_MS from the close's start", () => {
    const now = 2_000_000;
    noteClosing("%4", 4303, now);
    expect(closedBySeance("%4", 4303, now + CLOSING_TTL_MS)).toBe(true);
    expect(closedBySeance("%4", 4303, now + CLOSING_TTL_MS + 1)).toBe(false);
  });
});
