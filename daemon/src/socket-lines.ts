/**
 * Line framing for the daemon's unix sockets (`local-socket.ts`, `custodian-socket.ts`): a reply is queued, not written
 * straight through, so backpressure never truncates a JSON line. One copy, typed structurally on the connection.
 */
import type { Socket } from "bun";

export const EMPTY = Buffer.alloc(0);

/** The part of a connection the framing touches. */
export interface Outbound {
  outbound: Buffer;
}

/**
 * Queued rather than written straight through: a spawn reply embeds a refreshed
 * session list, which is comfortably large enough to meet backpressure, and a
 * short write would truncate the JSON into an unparseable line.
 */
export function flush(sock: Socket<undefined>, conn: Outbound): void {
  if (conn.outbound.length === 0) return;
  try {
    const written = sock.write(conn.outbound);
    conn.outbound = written >= conn.outbound.length ? EMPTY : conn.outbound.subarray(written);
  } catch {
    // The peer vanished — a Claude session killed mid-spawn is the ordinary
    // case. The spawn itself already happened; there is no one left to tell.
    conn.outbound = EMPTY;
  }
}

export function sendLine(sock: Socket<undefined>, conn: Outbound, line: string): void {
  conn.outbound = Buffer.concat([conn.outbound, Buffer.from(`${line}\n`, "utf8")]);
  flush(sock, conn);
}
