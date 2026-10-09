import { homedir } from "node:os";
import { exec, type ExecResult } from "./exec.ts";

/**
 * SEANCE_TMUX_SOCKET points tests at a private tmux server. A path (`-S`), not a
 * name (`-L`): tmux never unlinks its socket, so a name leaves a file in the
 * shared `tmux-$UID` dir per run; a path lets the test own where it lands.
 */
export async function tmux(args: readonly string[]): Promise<ExecResult> {
  const socket = process.env["SEANCE_TMUX_SOCKET"];
  return exec(["tmux", ...(socket ? ["-S", socket] : []), ...args], { timeoutMs: 10_000 });
}

export class TmuxError extends Error {}

/**
 * Field separator for `-F` formats: tmux 3.4 (Linux distros) mangles
 * non-printables in format output (tab becomes `_`), while printable
 * separators survive on every version.
 */
export const FIELD_SEP = "|";

/**
 * `1` once claude has set the pane's title, `0` before. Claude titles its
 * terminal (`✳ <session>`) only when the TUI is up, i.e. past every startup
 * gate — a trust or approval dialog leaves the title untouched — and a pane
 * that runs `exec claude` straight from tmux has no shell in between to set
 * one, so until then it carries tmux's default: the hostname. The comparison
 * runs inside tmux so no title text (a hand-run claude's is arbitrary) reaches
 * the format output. A tmux too old for `#{==:}` renders the format literally,
 * which parses as untitled: the session list goes visibly empty rather than
 * counting every pane as a session.
 */
export const PANE_TITLED = "#{?pane_title,#{?#{==:#{pane_title},#{host}},0,1},0}";

/** Window names reach us as unvalidated wire text; a separator inside one would misparse its pane line. */
export function sanitizeWindowName(name: string): string {
  return name.replaceAll(FIELD_SEP, "-");
}

export async function tmuxOk(args: readonly string[]): Promise<string> {
  const result = await tmux(args);
  if (result.exitCode !== 0) {
    throw new TmuxError(`tmux ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

/**
 * Terminals auto-attach to a session *group* (zshrc creates `main`,
 * `main-1`, … sharing one window set), so any member is a valid target — a
 * window spawned into one appears in all. Cold boot with no server or no
 * matching session: create it detached; the next terminal attaches to it.
 */
export async function resolveTargetSession(group: string): Promise<string> {
  const result = await tmux(["list-sessions", "-F", `#{session_name}${FIELD_SEP}#{session_group}`]);
  if (result.exitCode === 0) {
    for (const line of result.stdout.split("\n")) {
      const [name, sessionGroup] = line.split(FIELD_SEP);
      if (name !== undefined && name !== "" && (name === group || sessionGroup === group)) {
        return name;
      }
    }
  }
  await tmuxOk(["new-session", "-d", "-s", group, "-c", homedir()]);
  return group;
}

/**
 * What a pane is showing, or null when tmux can't say (the pane is gone).
 * `history` pulls the scrollback in too; a live claude is on the alternate
 * screen, which has none, so the screen alone is what it is showing now.
 */
export async function capturePane(target: string, opts: { readonly history: boolean }): Promise<string | null> {
  const range = opts.history ? ["-S", "-", "-E", "-"] : [];
  const result = await tmux(["capture-pane", "-p", ...range, "-t", target]);
  return result.exitCode === 0 ? result.stdout : null;
}
