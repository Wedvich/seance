/**
 * The service worker's share route. workbox-build copies `matchShare` and `receiveShare`
 * into the generated sw.js as source text (`handler.toString()`), so they can name
 * nothing from module scope: this file holds those two functions and nothing else, and
 * every value is a literal inside them — share.ts's names and `ATTACHMENT_LIMITS`.
 * share.test.ts fails on any other top-level statement and holds the literals to both.
 * No imports for the same reason, and because vite.config.ts loads this under Node.
 */

export function matchShare({ url, sameOrigin }: { readonly url: URL; readonly sameOrigin: boolean }): boolean {
  return sameOrigin && url.pathname === "/share";
}

/**
 * Files go into Cache Storage, one entry each, then one meta entry the app drains at
 * boot (share-inbox.ts): the page this redirects to is not loaded yet, and the worker
 * may be stopped before it is. Limits are applied here as `admitFiles` applies them, so
 * a screen recording past them costs no disk write. Always a 303: a throw still lands
 * on the form, marked, so the app can say the share was lost.
 */
export async function receiveShare({ request }: { readonly request: Request }): Promise<Response> {
  let target = "/?shared";
  try {
    const form = await request.formData();
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const cache = await caches.open("seance-share-inbox");
    const chosen: { n: number; file: File }[] = [];
    const skipped: { name: string; size: number; reason: "file" | "count" | "total" }[] = [];
    let total = 0;
    for (const entry of form.getAll("files")) {
      if (typeof entry === "string") continue;
      const { name, size } = entry;
      if (size > 30 * 1024 * 1024) {
        skipped.push({ name, size, reason: "file" });
        continue;
      }
      if (chosen.length >= 10) {
        skipped.push({ name, size, reason: "count" });
        break;
      }
      if (total + size > 100 * 1024 * 1024) {
        skipped.push({ name, size, reason: "total" });
        continue;
      }
      chosen.push({ n: chosen.length, file: entry });
      total += size;
    }
    // The File itself as the body: streamed to disk, never read into memory here.
    const stored = await Promise.all(
      chosen.map(({ n, file }) =>
        cache.put(`/share-inbox/${id}/${n}`, new Response(file)).then(
          () => true,
          () => false,
        ),
      ),
    );
    const files = chosen.filter((_, i) => stored[i]).map(({ n, file }) => ({ n, name: file.name, type: file.type }));
    const lost = chosen.filter((_, i) => !stored[i]).map(({ file }) => file.name);
    const field = (key: string): string => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    const meta = {
      at: Date.now(),
      files,
      skipped,
      lost,
      title: field("title"),
      text: field("text"),
      url: field("url"),
    };
    await cache.put(
      `/share-inbox/${id}`,
      new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }),
    );
  } catch {
    target = "/?shared=unreadable";
  }
  return Response.redirect(new URL(target, request.url).href, 303);
}
