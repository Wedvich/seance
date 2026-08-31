import { appRelayUrl, TOKEN_PARAM, type AppFrame } from "@seance/shared";
import type { Config } from "./config.ts";

/**
 * Deletes this machine's registry entry as it is uninstalled, so a box that is
 * gone stops sitting in the picker with a stale last-seen. Sent as an app-role
 * client on `/app` — the same verb the PWA's bin sends, authorized by the same
 * bearer token — rather than as a frame on the daemon leg: the leg that could
 * prove socket identity is the one the service was just told to stop, and the
 * CLI running the uninstall never holds it. No PSK either, deliberately: the
 * entry is routing metadata, and a service-delivered key is unreadable here.
 */

const CONNECT_MS = 5_000;

/**
 * How long to wait for the relay to confirm by pushing a registry that no longer
 * lists this entry. That push is the only acknowledgement the protocol has — a
 * `forget` that lands is otherwise silent.
 */
const CONFIRM_MS = 5_000;

/**
 * The relay refuses to forget a machine it still holds a socket for, and the
 * close from the service just stopped can still be in flight. Retried rather
 * than reported: "uninstalled but still listed" is the outcome this exists to
 * prevent.
 */
const REFUSAL_RETRY_MS = 1_000;
const MAX_ATTEMPTS = 3;

export type DeregisterOutcome =
  /** The entry was there and is gone. */
  | { readonly kind: "forgotten" }
  /** Nothing to delete — the registry never held this deviceId, or it is already gone. */
  | { readonly kind: "absent" }
  /** Refused past every retry: something is still registered under this id. */
  | { readonly kind: "connected" }
  | { readonly kind: "failed"; readonly detail: string };

/** Only the two frames this caller acts on; `shared/src/app-client.ts` is the full reader. */
function readFrame(text: string): { readonly ids: readonly string[] } | "refused" | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (frame["t"] === "forget-refused") return "refused";
  if (frame["t"] !== "registry" || !Array.isArray(frame["entries"])) return null;
  const ids: string[] = [];
  for (const entry of frame["entries"] as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>)["deviceId"];
    if (typeof id === "string") ids.push(id);
  }
  return { ids };
}

export function deregisterMachine(config: Config, deviceId: string): Promise<DeregisterOutcome> {
  const url = new URL(appRelayUrl(config.relayUrl));
  url.searchParams.set(TOKEN_PARAM, config.bearerToken);
  let socket: WebSocket;
  try {
    socket = new WebSocket(url.href);
  } catch (err) {
    return Promise.resolve({ kind: "failed", detail: String(err) });
  }

  return new Promise<DeregisterOutcome>((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let attempts = 0;
    let settled = false;

    const settle = (outcome: DeregisterOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };

    const forget = (): void => {
      attempts += 1;
      const frame: AppFrame = { t: "forget", deviceId };
      socket.send(JSON.stringify(frame));
    };

    timers.push(
      setTimeout(
        () => settle({ kind: "failed", detail: `no answer from ${url.host} within ${CONNECT_MS}ms` }),
        CONNECT_MS,
      ),
    );

    socket.addEventListener("open", () => {
      timers.push(
        setTimeout(() => settle({ kind: "failed", detail: "the relay never confirmed the delete" }), CONFIRM_MS),
      );
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = readFrame(event.data);
      if (frame === null) return;
      if (frame === "refused") {
        if (attempts >= MAX_ATTEMPTS) return settle({ kind: "connected" });
        timers.push(setTimeout(forget, REFUSAL_RETRY_MS));
        return;
      }
      // The relay pushes the registry on connect, so the first one says whether
      // there is anything here to delete; later pushes are the confirmation.
      if (frame.ids.includes(deviceId)) {
        if (attempts === 0) forget();
        return;
      }
      settle(attempts === 0 ? { kind: "absent" } : { kind: "forgotten" });
    });
    socket.addEventListener("error", () => settle({ kind: "failed", detail: `could not reach ${url.host}` }));
    socket.addEventListener("close", () =>
      settle({ kind: "failed", detail: "the relay closed the socket before confirming" }),
    );
  });
}
