/** Throwaway client a mod's `$.process.spawn` runs: dials `<sock>`, sends a line, prints the reply. */
const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: client <sock>");
const done = Promise.withResolvers<string>();
let got = "";
await Bun.connect({
  unix: path,
  socket: {
    open(s) {
      s.write(`hello from pid ${process.pid}\n`);
    },
    data(_s, b) {
      got += b.toString();
    },
    close() {
      done.resolve(got);
    },
  },
});
console.log(`client pid=${process.pid} ppid=${process.ppid} reply=${(await done.promise).trim()}`);
