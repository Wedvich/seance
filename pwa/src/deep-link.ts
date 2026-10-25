import { isTaskId } from "@seance/shared";
import type { Store } from "./store.ts";

/** Where a notification sends the app: the paths push-sw.js builds, nothing else. */
export type DeepLink = { readonly to: "task"; readonly taskId: string } | { readonly to: "machines" };

/**
 * Reads a `?task=<id>` or `?screen=machines` query. The id passes `isTaskId` or the link
 * is nothing: it ends up in an element id lookup and a store field, and a query string is
 * whatever the opener typed.
 */
export function parseDeepLink(search: string): DeepLink | null {
  const params = new URLSearchParams(search);
  const taskId = params.get("task");
  if (taskId !== null) return isTaskId(taskId) ? { to: "task", taskId } : null;
  return params.get("screen") === "machines" ? { to: "machines" } : null;
}

/** Same rule for a path the worker posts to a running app: only the app's own root, with a link query. */
export function parseOpenMessage(data: unknown): DeepLink | null {
  if (typeof data !== "object" || data === null || !("t" in data) || data.t !== "open") return null;
  if (!("url" in data) || typeof data.url !== "string" || !data.url.startsWith("/?")) return null;
  return parseDeepLink(data.url.slice(1));
}

export function openDeepLink(store: Store, link: DeepLink): void {
  if (link.to === "machines") {
    store.openMachines();
    return;
  }
  store.focusTask(link.taskId);
  store.openQueue();
  // The default listing is the newest tasks: one outside it (an older alert's) is read by name and merged in.
  void store.refreshQueue([link.taskId]);
}

/** Opens what a launch URL's query names; an unreadable one opens nothing. */
export function openLaunchLink(store: Store, search: string): void {
  const link = parseDeepLink(search);
  if (link !== null) openDeepLink(store, link);
}

/** Opens what the service worker posts to a running app; anything else is ignored. */
export function openMessage(store: Store, data: unknown): void {
  const link = parseOpenMessage(data);
  if (link !== null) openDeepLink(store, link);
}
