#!/usr/bin/env bun
/**
 * Séance's reference adapter (docs/messaging.md §6.4): the smallest program that speaks the adapter protocol, the
 * daemon tests' stub, and the template a new adapter starts from. Standalone on purpose (no import from Séance): an
 * adapter vendors `shared/src/adapter-protocol.schema.json`, never Séance's code.
 *
 * It answers the daemon's `hello` with its own and appends every line it reads to `$SEANCE_ADAPTER_DIR/frames.jsonl`,
 * its own state directory. It is an echo: a session's question or request to it (a `message` frame) is answered by
 * reply, a note saying `echo: <text>`. Each line a test appends to `$SEANCE_ADAPTER_DIR/outbox.jsonl` it sends as is,
 * which is how the tests drive its `deliver` and `tag` frames.
 *
 * The flags below exist for the daemon's tests, to misbehave on purpose; a real adapter has none of them.
 *   --protocol <n>      the major its hello names (default 1)
 *   --name <name>       the name its hello names (default $SEANCE_ADAPTER_NAME)
 *   --wants <a,b>       its wants (default sessions,tasks)
 *   --no-hello          never answers the daemon's hello
 *   --garbage <n>       writes n malformed lines after its hello
 *   --resync            sends `resync` after its first snapshot
 *   --no-read           stops reading stdin after its hello
 *   --exit <code>       exits with code after its hello
 *   --ignore-term       ignores SIGTERM
 *   --linger            stays up after its stdin closes
 *   --child             starts a grandchild in its process group and writes its pid to child.pid
 *   --no-echo           answers no message
 *   --warm              exits 0 at once (a test's first exec, in setup)
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--warm")) process.exit(0);

const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const dir = process.env["SEANCE_ADAPTER_DIR"] ?? ".";
const name = flag("--name") ?? process.env["SEANCE_ADAPTER_NAME"] ?? "reference";

writeFileSync(join(dir, "adapter.pid"), String(process.pid));
writeFileSync(join(dir, "env.json"), JSON.stringify(Object.keys(process.env).toSorted()));
if (args.includes("--ignore-term")) process.on("SIGTERM", () => {});
if (args.includes("--child")) {
  const child = Bun.spawn(["sleep", "600"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(dir, "child.pid"), String(child.pid));
}

const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

let snapshots = 0;
let reading = true;
let echoes = 0;

/** Lines of the outbox already sent; polled, since a test appends to it while this runs. */
let outboxSent = 0;
const outbox = join(dir, "outbox.jsonl");
let outboxTimer: ReturnType<typeof setInterval> | null = null;
const pollOutbox = (): void => {
  let lines: string[];
  try {
    lines = readFileSync(outbox, "utf8").split("\n");
  } catch {
    return;
  }
  // The last element is what follows the final newline: a line still being written.
  for (; outboxSent < lines.length - 1; outboxSent++) process.stdout.write(`${lines[outboxSent]}\n`);
};

function onFrame(frame: Readonly<Record<string, unknown>>): void {
  if (frame.kind === "hello") {
    if (args.includes("--no-hello")) return;
    send({
      kind: "hello",
      protocol: Number(flag("--protocol") ?? "1"),
      name,
      version: "0.0.0-reference",
      wants: (flag("--wants") ?? "sessions,tasks").split(",").filter((want) => want !== ""),
      features: [],
    });
    const garbage = Number(flag("--garbage") ?? "0");
    for (let i = 0; i < garbage; i++) process.stdout.write("not json\n");
    if (args.includes("--no-read")) reading = false;
    const exit = flag("--exit");
    if (exit !== undefined) process.exit(Number(exit));
    outboxTimer ??= setInterval(pollOutbox, 20);
    return;
  }
  if (frame.kind === "message" && !args.includes("--no-echo")) {
    const { id, messageKind, text } = frame;
    if (messageKind === "note" || typeof id !== "string" || typeof text !== "string") return;
    send({ kind: "deliver", ref: `echo-${++echoes}`, inReplyTo: id, messageKind: "note", text: `echo: ${text}` });
    return;
  }
  if (frame.kind === "snapshot" && ++snapshots === 1 && args.includes("--resync")) send({ kind: "resync" });
}

let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    appendFileSync(join(dir, "frames.jsonl"), `${line}\n`);
    try {
      onFrame(JSON.parse(line));
    } catch {
      // A line it cannot read is skipped: the daemon's lines are its schema's.
    }
  }
  // Stops reading but stays up: what the daemon's unread cap is for.
  // oxlint-disable-next-line no-await-in-loop -- parks the loop for good
  if (!reading) await new Promise<never>(() => {});
}
// Its stdin closed: the daemon is stopping it. A well-behaved adapter exits here.
if (outboxTimer !== null) clearInterval(outboxTimer);
if (args.includes("--linger")) setInterval(() => {}, 60_000);
