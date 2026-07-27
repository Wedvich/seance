import { APP_ID, open, seal, type Envelope, type MachineInfo, type OpName, type Plain } from "@seance/shared";
import { connectDaemon, type Client, type TestRelay } from "../../relay/test/harness.ts";

/**
 * A daemon just far enough to answer the app: registers an encrypted MachineInfo
 * and replies to ops from a handler map. Real crypto and the real relay, so the
 * only fake here is what the daemon does with a decrypted payload.
 */
export interface FakeDaemon {
  readonly deviceId: string;
  readonly client: Client;
  /** Stops answering; the socket stays open unless closed. */
  readonly stop: () => void;
  readonly close: () => void;
}

export type Handlers = Partial<Record<OpName, (payload: unknown) => unknown>>;

export async function startFakeDaemon(
  relay: TestRelay,
  key: CryptoKey,
  deviceId: string,
  info: MachineInfo,
  handlers: Handlers = {},
  opts: { readonly infoTs?: number } = {},
): Promise<FakeDaemon> {
  const client = await connectDaemon(relay);

  const infoPlain: Plain = {
    id: crypto.randomUUID(),
    ts: opts.infoTs ?? Date.now(),
    op: "machine-info",
    payload: info,
  };
  client.send({
    t: "register",
    deviceId,
    info: await seal(key, { to: APP_ID, from: deviceId }, infoPlain),
  });

  // A holder rather than a bare `let`: the loop condition is flipped by the
  // stop/close closures below, which static analysis cannot see through.
  const state = { answering: true };
  void (async () => {
    while (state.answering) {
      let env: Envelope;
      try {
        ({ env } = await client.waitFor<{ t: "msg"; env: Envelope }>("msg", 30_000));
      } catch {
        return;
      }
      const request = await open(key, env);
      const handler = handlers[request.op];
      if (handler === undefined) continue;
      const reply: Plain = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        op: request.op,
        re: request.id,
        payload: handler(request.payload),
      };
      client.send({ t: "msg", env: await seal(key, { to: APP_ID, from: deviceId }, reply) });
    }
  })();

  return {
    deviceId,
    client,
    stop: () => {
      state.answering = false;
    },
    close: () => {
      state.answering = false;
      client.close();
    },
  };
}
