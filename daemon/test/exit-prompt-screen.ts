/**
 * The visible screen of Claude Code 2.1.295 at `/exit` in a named worktree
 * session, captured from a real one (2026-10-09) — the dialog replaces the
 * input box, so the hint line is the bottom of the screen. The classifier's unit
 * tests read it and the TUI stub draws it, so the two can't drift.
 */
export const EXIT_PROMPT_SCREEN = [
  "> fix the flaky test",
  "⏺ Done — the test now polls instead of sleeping.",
  "─".repeat(80),
  "   Exiting worktree session",
  "",
  '   This session was named "flaky test (mac)". Keep the worktree to resume it later, or remove it to clean up.',
  "",
  "   ❯ 1. Keep worktree    Stays at /Users/m/repos/seance/.claude/worktrees/flaky-test",
  "     2. Remove worktree  Clean up the worktree directory.",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");
