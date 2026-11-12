import { APP_ID, open, seal, type Envelope, type MachineInfo, type OpName, type Plain } from "@seance/shared";
import { connectDaemon, register, type Client, type TestRelay } from "../../relay/test/harness.ts";

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
  /** From the relay harness's `newDeviceId()`, so the register can be signed. */
  deviceId: string,
  info: MachineInfo,
  handlers: Handlers = {},
  /** `roles`: signed into the register (v2), as a daemon claiming a role sends them. */
  opts: { readonly infoTs?: number; readonly roles?: readonly string[] } = {},
): Promise<FakeDaemon> {
  const client = await connectDaemon(relay);

  const infoPlain: Plain = {
    id: crypto.randomUUID(),
    ts: opts.infoTs ?? Date.now(),
    op: "machine-info",
    payload: info,
  };
  const sealed = await seal(key, { to: APP_ID, from: deviceId }, infoPlain);
  client.send(await register(deviceId, { info: sealed, ...(opts.roles === undefined ? {} : { roles: opts.roles }) }));

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
