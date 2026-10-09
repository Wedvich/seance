/**
 * A stand-in for claude's TUI, for the tests that drive one with keys. Run by
 * the `makeClaudeStub` wrappers under bun's versioned name, so tmux sees a
 * claude; on the alternate screen and titled, as the real one is. Modes:
 *
 * - `exit-prompt` — already on the worktree exit dialog.
 * - `repl` — an idle claude with an input box, keyed as 2.1.295 measured: one
 *   Esc does *not* clear a draft (it only arms "Esc again to clear"), Ctrl+C
 *   does, `/exit` + Enter exits — via the dialog when `--worktree` is in argv —
 *   and Enter on anything else submits it as a prompt.
 * - `deaf` — ignores every key and SIGHUP, as a wedged claude would.
 *
 * On the dialog, Enter takes the preselected Keep and exits 0; Esc cancels back
 * to the box. With `--stub-record <file>` each launch appends `pid <n>` and one
 * line per event (`esc`, `submitted <text>`), so a test can assert what reached
 * it and that its process is gone.
 */
import { appendFileSync } from "node:fs";
import { EXIT_PROMPT_SCREEN } from "./exit-prompt-screen.ts";

const args = Bun.argv.slice(2);
const mode = args[0];
const recordAt = args.indexOf("--stub-record");
const recordFile = recordAt === -1 ? undefined : args[recordAt + 1];
const worktree = args.includes("--worktree");

function note(event: string): void {
  if (recordFile !== undefined) appendFileSync(recordFile, `${event}\n`);
}

function draw(lines: readonly string[]): void {
  process.stdout.write(`\u001B[H\u001B[2J${lines.join("\r\n")}`);
}

let atPrompt = mode === "exit-prompt";
let draft = "";

function drawBox(): void {
  draw(["⏺ Ready.", "─".repeat(40), `> ${draft}`, "─".repeat(40), "  ? for shortcuts"]);
}

function redraw(): void {
  if (atPrompt) draw(EXIT_PROMPT_SCREEN.split("\n"));
  else drawBox();
}

function press(key: string): void {
  if (key === "\u001B") {
    note("esc");
    if (atPrompt) atPrompt = false;
    return;
  }
  if (atPrompt) {
    if (key === "\r") process.exit(0);
    return;
  }
  if (key === "\u0003") {
    draft = "";
    return;
  }
  if (key !== "\r") {
    draft += key;
    return;
  }
  if (draft === "/exit") {
    draft = "";
    if (!worktree) process.exit(0);
    atPrompt = true;
    return;
  }
  if (draft !== "") note(`submitted ${draft}`);
  draft = "";
}

note(`pid ${process.pid}`);
process.stdout.write("\u001B[?1049h\u001B]2;✳ stub\u001B\\");
if (mode === "deaf") {
  process.on("SIGHUP", () => {});
  // The pty closing ends stdin, and with it the event loop: without a handle of
  // its own this stub would exit unprompted, and the escalation tests that rely
  // on it outliving its pane would pass with no escalation at all.
  setInterval(() => {}, 1 << 30);
  process.stdin.on("error", () => {});
}
redraw();
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk: Buffer) => {
  if (mode === "deaf") return;
  for (const key of chunk.toString()) press(key);
  redraw();
});
