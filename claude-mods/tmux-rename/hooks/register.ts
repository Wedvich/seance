import type { Register } from "claude-code";

/**
 * Séance names a spawned session `slug (machineTag)` but its window just
 * `slug` (DESIGN.md, "Session name vs window name"). The daemon hands the
 * session its tag as SEANCE_MACHINE_TAG, so only that exact suffix is
 * dropped: a name that merely ends in a parenthetical keeps it.
 */
export function windowName(sessionName: string, tag: string | undefined): string {
  const name = sessionName.trim();
  if (tag === undefined || tag === "") return name;
  const suffix = ` (${tag})`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length).trimEnd() : name;
}

export const register: Register = (on) => {
  on("command.run", { command: "rename" }, async ($, e, next) => {
    const result = await next(e);
    // bare /rename lets Claude pick the name, which this hook can't see
    if (e.args.trim() === "") return result;

    const pane = await $.env.get("TMUX_PANE");
    if (pane === undefined || pane === "") return result;
    const name = windowName(e.args, await $.env.get("SEANCE_MACHINE_TAG"));
    if (name === "") return result;

    // -t pane id: rename Claude's own window, not whichever has focus;
    // `--` so a name like `-wip fix` isn't read as tmux flags
    try {
      const ran = await $.process.run(["tmux", "rename-window", "-t", pane, "--", name]);
      if (ran.exitCode !== 0) $.ui.toast(`tmux rename-window failed: ${ran.stderr.trim()}`);
    } catch (err) {
      // rejects when tmux can't start or outlives the timeout
      $.ui.toast(`tmux rename-window failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  })
    // fail open: whatever else throws must never cost the rename itself
    // oxlint-disable-next-line promise/no-callback-in-promise -- a hook registration's `.catch`, not a Promise's
    .catch(($, e, next) => next(e));
};
