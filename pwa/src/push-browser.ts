import type { RelayClient } from "@seance/shared";
import {
  resyncPush,
  SERVICE_WORKER_READY_MS,
  watchResync,
  withTimeout,
  type PushClient,
  type PushEnv,
} from "./push.ts";

const PUSH_OFF_KEY = "seance:push-off";

/** The browser's Notification and PushManager as `PushEnv`; kept apart from push.ts so tests need no DOM. */
export const browserPushEnv: PushEnv = {
  permission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  // `ready` never rejects, it just never resolves when no worker registers (a dev build, a blocked
  // registration), which would leave the card on "Setting up…" for good.
  manager: async () => (await withTimeout(navigator.serviceWorker.ready, SERVICE_WORKER_READY_MS)).pushManager,
  // Blocked storage (a private window) forgets a turn-off, and the next load's re-sync then subscribes again. Accepted:
  // the person sees "On" and can turn it off again, and nothing else on this page can outlive a load.
  optedOut: () => {
    try {
      return localStorage.getItem(PUSH_OFF_KEY) !== null;
    } catch {
      return false;
    }
  },
  setOptedOut: (off) => {
    try {
      if (off) localStorage.setItem(PUSH_OFF_KEY, "1");
      else localStorage.removeItem(PUSH_OFF_KEY);
    } catch {
      // See `optedOut`.
    }
  },
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
