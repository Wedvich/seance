import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerFrameId, type BrokerReply } from "../src/broker-protocol.ts";
import { startLocalSocket } from "../src/local-socket.ts";

/**
 * A daemon's broker end as a peer test sees it: the real local op socket with
 * the real framing, answering broker frames with whatever the test says. For a
 * daemon the real broker cannot be — one that predates a frame, say. Records
 * every frame it received, so a test can show what never reached it.
 */
export interface BrokerDouble {
  readonly path: string;
  readonly frames: unknown[];
  readonly stop: () => Promise<void>;
}

export async function startBrokerDouble(
  answer: (raw: unknown, id: string) => BrokerReply | Promise<BrokerReply>,
): Promise<BrokerDouble> {
  const dir = await mkdtemp(join(tmpdir(), "seance-brkdbl-"));
  const path = join(dir, "seanced.sock");
  const frames: unknown[] = [];
  const socket = await startLocalSocket({
    path,
    handle: () => Promise.resolve(null),
    broker: async (raw) => {
      frames.push(raw);
      return answer(raw, brokerFrameId(raw) ?? "");
    },
  });
  return {
    path,
    frames,
    stop: async (): Promise<void> => {
      socket.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
