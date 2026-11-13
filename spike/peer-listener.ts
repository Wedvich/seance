/**
 * Throwaway stand-in for the daemon's local socket: accepts on `<sock>`, asks the
 * kernel for the peer pid exactly as `local-socket.ts` does (`peerPid(socketFd(sock))`),
 * walks it up with `ancestorIn` against the pane pids of the private tmux server
 * `-L <server>`, and answers (HTTP if the peer spoke HTTP) with what it found.
 *
 *   bun spike/peer-listener.ts <sock> <tmux-server-name>
 */
import { unlinkSync } from "node:fs";
import { ancestorIn, peerPid, peerPidSupported, socketFd } from "../daemon/src/peer.ts";

const [sockPath, server] = process.argv.slice(2);
if (sockPath === undefined || server === undefined) throw new Error("usage: peer-listener <sock> <tmux-server>");
try {
  unlinkSync(sockPath);
} catch {}

async function panes(): Promise<Map<number, string>> {
  const out = Bun.spawnSync(["tmux", "-L", server!, "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]);
  const map = new Map<number, string>();
  for (const line of out.stdout.toString().trim().split("\n")) {
    const [id, pid] = line.split(" ");
    if (id !== undefined && pid !== undefined) map.set(Number(pid), id);
  }
  return map;
}

function chain(pid: number): string {
  const ps = Bun.spawnSync(["ps", "-o", "pid=,ppid=,comm=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  return ps;
}

console.log(`peerPidSupported=${peerPidSupported()}`);
Bun.listen<{ peer: number | null }>({
  unix: sockPath,
  socket: {
    open(sock) {
      sock.data = { peer: peerPid(socketFd(sock)) };
    },
    async data(sock, buf) {
      const peer = sock.data.peer;
      const pane = peer === null ? null : await ancestorIn(peer, await panes());
      const info = { peer, peerProc: peer === null ? null : chain(peer), pane };
      console.log(JSON.stringify({ got: buf.toString().split("\n")[0], ...info }));
      const body = JSON.stringify(info);
      sock.write(
        buf.toString().startsWith("GET ")
          ? `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
          : `${body}\n`,
      );
      sock.end();
    },
  },
});
