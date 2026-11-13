/**
 * Spike-2 stand-in for the daemon's `inbox` binding: accepts on `<sock>`, reads the peer pid at
 * accept (`peerPid(socketFd(sock))`, as `local-socket.ts` does), walks it to a pane of the private
 * tmux server `-L <server>`, keeps the connection open, and pushes `tick <n>` to every open
 * connection every `<tickSec>` seconds (default 60). SIGUSR1 pushes `PUSH-<n>` at once. Logs one
 * JSON line per event to stdout.
 *
 *   bun spike/hold-listener.ts <sock> <tmux-server> [tickSec]
 */
import type { Socket } from "bun";
import { unlinkSync } from "node:fs";
import { ancestorIn, peerPid, peerPidSupported, socketFd } from "../daemon/src/peer.ts";

const [sockPath, server, tickArg] = process.argv.slice(2);
if (sockPath === undefined || server === undefined)
  throw new Error("usage: hold-listener <sock> <tmux-server> [tickSec]");
try {
  unlinkSync(sockPath);
} catch {}

type Conn = { id: number; peer: number | null; pane: string | null; opened: number };
const open = new Set<Socket<Conn>>();
const out = (o: Record<string, unknown>): void => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
let nextId = 1;
let tick = 0;
let push = 0;

async function panes(): Promise<Map<number, string>> {
  const res = Bun.spawnSync(["tmux", "-L", server!, "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]);
  const map = new Map<number, string>();
  for (const line of res.stdout.toString().trim().split("\n")) {
    const [id, pid] = line.split(" ");
    if (id !== undefined && pid !== undefined) map.set(Number(pid), id);
  }
  return map;
}

function send(line: string): void {
  for (const s of open) out({ push: line, conn: s.data.id, wrote: s.write(`${line}\n`) });
}

out({ peerPidSupported: peerPidSupported() });
process.on("SIGUSR1", () => send(`PUSH-${++push} ${new Date().toISOString()}`));
setInterval(() => send(`tick ${++tick} ${new Date().toISOString()}`), Number(tickArg ?? 60) * 1000);

Bun.listen<Conn>({
  unix: sockPath,
  socket: {
    open(sock) {
      sock.data = { id: nextId++, peer: peerPid(socketFd(sock)), pane: null, opened: Date.now() };
      open.add(sock);
      const { id, peer } = sock.data;
      void (async () => {
        sock.data.pane = peer === null ? null : await ancestorIn(peer, await panes());
        out({ accept: id, peer, pane: sock.data.pane });
      })();
    },
    data(sock, buf) {
      out({ conn: sock.data.id, got: buf.toString().trim() });
    },
    close(sock) {
      open.delete(sock);
      out({ close: sock.data.id, peer: sock.data.peer, heldMin: ((Date.now() - sock.data.opened) / 60000).toFixed(1) });
    },
  },
});
