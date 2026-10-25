import type { RelayClient } from "@seance/shared";
import {
  resyncPush,
  SERVICE_WORKER_READY_MS,
  watchResync,
  withTimeout,
  type PushClient,
  type PushEnv,
} from "./push.ts";

/** The browser's Notification and PushManager as `PushEnv`; kept apart from push.ts so tests need no DOM. */
export const browserPushEnv: PushEnv = {
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  // `ready` never rejects, it just never resolves when no worker registers (a dev build, a blocked
  // registration), which would leave the card on "Setting up…" for good.
  manager: async () => (await withTimeout(navigator.serviceWorker.ready, SERVICE_WORKER_READY_MS)).pushManager,
};

/** False on a browser without the three APIs, and on iOS outside a Home Screen install. */
export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Re-sends this browser's subscription after a page load, when permission was already
 * granted and a leader is verified. It waits for that moment rather than asking at boot,
 * when the socket is still dialling and every request would fail, and tries again on a
 * later one when the leader was still starting (`watchResync`).
 */
export function watchPushResync(client: RelayClient, push: PushClient = client): void {
  if (!pushSupported() || Notification.permission !== "granted") return;
  watchResync(
    {
      ready: () => {
        const state = client.getState();
        return state.status === "open" && state.scheduler.kind === "ready";
      },
      subscribe: (listener) => client.subscribe(listener),
    },
    () => resyncPush(push, browserPushEnv),
  );
}
