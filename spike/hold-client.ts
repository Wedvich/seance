/**
 * Spike-2 stand-in for `seanced inbox`: dials `<sock>`, sends one `inbox` line, then copies every
 * line the listener pushes to stdout for the session's life. Its own lifecycle (start, signals,
 * close) also goes to `<sock>.client-<pid>.log`, since stdout may be gone when it matters.
 */
import { appendFileSync } from "node:fs";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: hold-client <sock>");
const side = `${path}.client-${process.pid}.log`;
const note = (s: string): void => appendFileSync(side, `${new Date().toISOString()} ${s}\n`);

note(`start pid=${process.pid} ppid=${process.ppid}`);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    note(`${sig} ppid=${process.ppid}`);
    process.exit(128);
  });
}
process.stdout.on("error", (err) => note(`stdout error ${String(err)}`));
setInterval(() => note(`alive ppid=${process.ppid}`), 300_000);

await Bun.connect({
  unix: path,
  socket: {
    open(s) {
      s.write(`${JSON.stringify({ kind: "inbox", pid: process.pid })}\n`);
      process.stdout.write(`connected pid=${process.pid} ppid=${process.ppid}\n`);
    },
    data(_s, b) {
      process.stdout.write(b.toString());
    },
    close() {
      note("socket closed");
      process.stdout.write("socket closed\n");
      process.exit(0);
    },
  },
});
