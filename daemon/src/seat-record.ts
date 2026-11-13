/**
 * The custodian seat's persisted record and the round's tmp-dir shape (DESIGN.md, "The custodian's seat"). A module
 * of its own with no imports: `state.ts` validates the record, and the archivist loads `state.ts`, so these cannot
 * live beside the launch or the seat, whose closures spawn.
 *
 * `CLAUDE_CODE_TMPDIR` is `<ROUND_TMP_PREFIX><6 chars>`, 21 characters: Claude Code puts the round's `$TMPDIR` at
 * `$CLAUDE_CODE_TMPDIR/claude-<uid>` and silently falls back to the shared `/tmp/claude-<uid>` (every session's
 * scratchpad) when that path counts as long (32 characters kept, 35 fell back). So the prefix is a literal `/tmp`,
 * never `tmpdir()` (`/var/folders/…` on macOS) and never a realpath (`/private/tmp` adds 8): do not lengthen it.
 */
export const ROUND_TMP_PREFIX = "/tmp/seance-cu-";
export const ROUND_TMP = /^\/tmp\/seance-cu-[A-Za-z0-9]{6}$/u;

export interface SeatRecord {
  /** When the last round ended; due checks wait `everyMinutes` after it. */
  readonly lastEndedAt?: number;
  /** The running round, written ahead of its launch (`pane` null until it exists) so a restart or reload adopts it. */
  readonly round?: {
    readonly pane: string | null;
    readonly startedAt: number;
    readonly tmpDir: string;
    readonly exclave: string;
  };
}
