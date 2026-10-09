import type { Register } from "claude-code";

/**
 * Séance names a spawned session `slug (machineTag)` but its window just
 * `slug` (DESIGN.md, "Session name vs window name"), and publishes its tag as
 * SEANCE_MACHINE_TAG. A /rename keeps both shapes: the session name
 * gains the suffix when missing, the window drops it. Only the exact
 * ` (<tag>)` counts, so `fix login (urgent)` is the user's text, never the tag.
 */
function splitTag(name: string, tag: string | undefined): { readonly bare: string; readonly suffix: string } {
  const trimmed = name.trim();
  if (tag === undefined || tag === "") return { bare: trimmed, suffix: "" };
  const suffix = ` (${tag})`;
  const bare = trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length).trimEnd() : trimmed;
  return { bare, suffix };
}

export function sessionName(name: string, tag: string | undefined): string {
  const { bare, suffix } = splitTag(name, tag);
  return `${bare}${suffix}`;
}

export function windowName(name: string, tag: string | undefined): string {
  return splitTag(name, tag).bare;
}

export const register: Register = (on) => {
  on("command.run", { command: "rename" }, async ($, e, next) => {
    // bare /rename lets Claude pick the name, which this hook can't see
    if (e.args.trim() === "") return next(e);

    const pane = await $.env.get("TMUX_PANE");
    const inTmux = pane !== undefined && pane !== "";

    // The tmux server's global value first: Claude copies its env once at
    // launch, so a session started on a server the daemon hadn't yet tagged
    // (a fresh server, before the daemon's next republish) would otherwise
    // stay untagged for good. Absent there — another tmux server, a failed
    // query — the process's own, which a spawn's `new-window -e` sets.
    let tag = await $.env.get("SEANCE_MACHINE_TAG");
    if (inTmux) {
      try {
        const shown = await $.process.run(["tmux", "show-environment", "-g", "SEANCE_MACHINE_TAG"]);
        const value = /^SEANCE_MACHINE_TAG=(.*)$/u.exec(shown.stdout.trim())?.[1];
        if (shown.exitCode === 0 && value !== undefined) tag = value;
      } catch {
        // tmux couldn't start or timed out; the rename-window below toasts it
      }
    }

    const name = windowName(e.args, tag);
    const result = await next({ ...e, args: sessionName(e.args, tag) });
    if (!inTmux) return result;

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
