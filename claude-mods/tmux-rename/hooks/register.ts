import type { EngineInterface, Register } from "claude-code";

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

/**
 * The panes whose window shows this session through `claude attach`. A
 * background session (`claude --bg`, a daemon's) runs in a pty host the
 * daemon starts without TMUX_PANE, and the attaching terminal is just a
 * client whose env never reaches it, so the pane is found from the outside:
 * each `claude attach <id prefix>` process, walked up its parents to a tmux
 * pane's shell. Several attached windows each get the name.
 *
 * `ps` is `ps -Ao pid=,ppid=,args=`; `panes` is `tmux list-panes -a -F
 * '#{pane_id} #{pane_pid}'`, which lists a pane once per session in a group.
 */
export function attachedPanes(sessionId: string, ps: string, panes: string): readonly string[] {
  const paneOfPid = new Map<number, string>();
  for (const line of panes.split("\n")) {
    const [pane, pid] = line.trim().split(/\s+/u);
    if (pane !== undefined && pane !== "" && pid !== undefined) paneOfPid.set(Number(pid), pane);
  }

  const parentOf = new Map<number, number>();
  const attachers: number[] = [];
  for (const line of ps.split("\n")) {
    const [pid, ppid, ...argv] = line.trim().split(/\s+/u);
    if (pid === undefined || ppid === undefined) continue;
    parentOf.set(Number(pid), Number(ppid));
    if (isAttachTo(argv, sessionId)) attachers.push(Number(pid));
  }

  const found = new Set<string>();
  for (const attacher of attachers) {
    // bounded: a pid reused mid-listing could close a loop
    let pid: number | undefined = attacher;
    for (let depth = 0; pid !== undefined && pid > 1 && depth < 32; depth++) {
      const pane = paneOfPid.get(pid);
      if (pane !== undefined) {
        found.add(pane);
        break;
      }
      pid = parentOf.get(pid);
    }
  }
  return [...found];
}

// `claude attach 4a64b25d`: the id may be any prefix Claude resolves, flags aside
function isAttachTo(argv: readonly string[], sessionId: string): boolean {
  const [bin, sub, ...rest] = argv;
  if (bin === undefined || !/(?:^|\/)claude$/u.test(bin) || sub !== "attach") return false;
  return rest.some((arg) => !arg.startsWith("-") && sessionId.startsWith(arg));
}

async function findAttachedPanes($: EngineInterface): Promise<readonly string[]> {
  try {
    const [ps, panes] = await Promise.all([
      $.process.run(["ps", "-Ao", "pid=,ppid=,args="]),
      $.process.run(["tmux", "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]),
    ]);
    if (ps.exitCode !== 0 || panes.exitCode !== 0) return [];
    return attachedPanes(await $.session.id(), ps.stdout, panes.stdout);
  } catch {
    // no tmux server, or ps/tmux couldn't start: nothing attached in tmux
    return [];
  }
}

export const register: Register = (on) => {
  on("command.run", { command: "rename" }, async ($, e, next) => {
    // bare /rename lets Claude pick the name, which this hook can't see
    if (e.args.trim() === "") return next(e);

    const ownPane = await $.env.get("TMUX_PANE");
    const panes = ownPane !== undefined && ownPane !== "" ? [ownPane] : await findAttachedPanes($);
    const inTmux = panes.length > 0;

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
    await Promise.all(
      panes.map(async (pane) => {
        try {
          const ran = await $.process.run(["tmux", "rename-window", "-t", pane, "--", name]);
          if (ran.exitCode !== 0) $.ui.toast(`tmux rename-window failed: ${ran.stderr.trim()}`);
        } catch (err) {
          // rejects when tmux can't start or outlives the timeout
          $.ui.toast(`tmux rename-window failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    return result;
  })
    // fail open: whatever else throws must never cost the rename itself
    // oxlint-disable-next-line promise/no-callback-in-promise -- a hook registration's `.catch`, not a Promise's
    .catch(($, e, next) => next(e));
};
