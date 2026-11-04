import { ATTACHMENT_LIMITS } from "@seance/shared";
import { beforeEach, describe, expect, test } from "bun:test";
import { pastTotalText, tooLargeText, tooManyText } from "../src/attachments.ts";
import { matchShare, receiveShare } from "../src/share-handler.ts";
import {
  deliverShare,
  drainShareInbox,
  type ReceivedShare,
  receiveOnBoot,
  reloadCostText,
  SHARE_MISSING_TEXT,
  SHARE_UNREADABLE_TEXT,
  sharedText,
  shareMarker,
} from "../src/share-inbox.ts";
import {
  SHARE_ACTION,
  SHARE_FILES_FIELD,
  SHARE_INBOX,
  SHARE_INBOX_PATH,
  SHARE_MARKER,
  SHARE_UNREADABLE,
} from "../src/share.ts";

/** The worker's scope: Cache Storage resolves a relative key against it. */
const ORIGIN = "https://pwa.test";

/**
 * Cache Storage is a browser boundary Bun does not provide. Bodies are kept as blobs, and
 * keys come back absolute, as the real `keys()` returns them.
 */
class FakeCache {
  readonly bodies = new Map<string, Blob>();
  refusePut: (url: string) => boolean = () => false;

  async put(request: string, response: Response): Promise<void> {
    const url = new URL(request, ORIGIN).href;
    if (this.refusePut(url)) throw new Error("QuotaExceededError");
    this.bodies.set(url, await response.blob());
  }

  async match(request: string): Promise<Response | undefined> {
    const body = this.bodies.get(new URL(request, ORIGIN).href);
    return body === undefined ? undefined : new Response(body);
  }

  async keys(): Promise<readonly { readonly url: string }[]> {
    return [...this.bodies.keys()].map((url) => ({ url }));
  }

  async delete(request: string): Promise<boolean> {
    return this.bodies.delete(new URL(request, ORIGIN).href);
  }

  paths(): readonly string[] {
    return [...this.bodies.keys()].map((url) => new URL(url).pathname).toSorted();
  }
}

class FakeStorage {
  readonly opened: string[] = [];
  readonly cache = new FakeCache();
  failOpen = false;

  async open(name: string): Promise<FakeCache> {
    if (this.failOpen) throw new Error("SecurityError");
    this.opened.push(name);
    return this.cache;
  }
}

let storage = new FakeStorage();
beforeEach(() => {
  storage = new FakeStorage();
  Object.defineProperty(globalThis, "caches", { value: storage, configurable: true, writable: true });
});

/**
 * Rebuilt from source text, as workbox-build writes it into sw.js: a name the module
 * defines outside the function would be undefined here. (Bun's `toString` inlines module
 * constants, which rolldown does not, so the top-level scan below is the other half.)
 */
const rebuiltReceive: typeof receiveShare = new Function(`return (${String(receiveShare)})`)();
const rebuiltMatch: typeof matchShare = new Function(`return (${String(matchShare)})`)();

function shareRequest(form: FormData): Request {
  return new Request(`${ORIGIN}${SHARE_ACTION}`, { method: "POST", body: form });
}

function shareForm(files: readonly File[], fields: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const file of files) form.append(SHARE_FILES_FIELD, file);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

/** A `File` that reports `size` without holding it: only the limits read it. */
function sized(name: string, size: number): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** A request whose parsed form hands the handler `sized` files, which FormData would re-wrap. */
function sizedRequest(files: readonly File[]): Request {
  const request = shareRequest(new FormData());
  const form = { getAll: (key: string) => (key === SHARE_FILES_FIELD ? files : []), get: () => null };
  Object.defineProperty(request, "formData", { value: async () => form });
  return request;
}

function location(response: Response): string {
  const url = new URL(response.headers.get("location") ?? "");
  return `${url.pathname}${url.search}`;
}

describe("share-handler.ts", () => {
  test("holds the two route functions and no other top-level statement", async () => {
    const source = await Bun.file(new URL("../src/share-handler.ts", import.meta.url)).text();
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
    const topLevel = code.split("\n").filter((line) => line !== "" && !/^\s/u.test(line));
    expect(topLevel).toEqual([
      expect.stringMatching(/^export function matchShare\(/u),
      "}",
      expect.stringMatching(/^export async function receiveShare\(/u),
      "}",
    ]);
  });

  test("matches only a same-origin request to the manifest's action", () => {
    expect(rebuiltMatch({ url: new URL(`${ORIGIN}${SHARE_ACTION}`), sameOrigin: true })).toBe(true);
    expect(rebuiltMatch({ url: new URL(`https://relay.test${SHARE_ACTION}`), sameOrigin: false })).toBe(false);
    expect(rebuiltMatch({ url: new URL(`${ORIGIN}/`), sameOrigin: true })).toBe(false);
  });

  test("stores each file and a meta entry under the inbox, then 303s to the marked form", async () => {
    const response = await rebuiltReceive({
      request: shareRequest(
        shareForm([new File(["first"], "a.txt", { type: "text/plain" }), new File(["second"], "b.png")], {
          text: "see https://x.test",
          url: "https://x.test",
        }),
      ),
    });
    expect(response.status).toBe(303);
    expect(location(response)).toBe(`/?${SHARE_MARKER}`);
    expect(storage.opened).toEqual([SHARE_INBOX]);
    const paths = storage.cache.paths();
    expect(paths).toHaveLength(3);
    for (const path of paths) expect(path.startsWith(SHARE_INBOX_PATH)).toBe(true);
  });

  test("applies the attachment limits before storing anything", async () => {
    const { fileBytes, files, totalBytes } = ATTACHMENT_LIMITS;
    await rebuiltReceive({ request: sizedRequest([sized("big.mov", fileBytes + 1), sized("ok.mov", fileBytes)]) });
    const eleven = Array.from({ length: files + 1 }, (_, i) => sized(`f${i}`, 1));
    await rebuiltReceive({ request: sizedRequest(eleven) });
    const atTotal = [fileBytes, fileBytes, fileBytes, totalBytes - 3 * fileBytes].map((size, i) =>
      sized(`t${i}`, size),
    );
    await rebuiltReceive({ request: sizedRequest([...atTotal, sized("over", 1)]) });

    const share = await drainShareInbox(storage, "received");
    expect(share?.files.map((f) => f.name)).toEqual([
      "ok.mov",
      ...eleven.slice(0, files).map((f) => f.name),
      ...atTotal.map((f) => f.name),
    ]);
    expect(share?.refused).toEqual([tooLargeText("big.mov", fileBytes + 1), tooManyText(), pastTotalText("over")]);
  });

  test("names a file the cache refused, and still stores the rest", async () => {
    let puts = 0;
    storage.cache.refusePut = () => (puts += 1) === 1;
    const response = await rebuiltReceive({
      request: shareRequest(shareForm([new File(["a"], "lost.mp4"), new File(["b"], "kept.png")])),
    });
    expect(location(response)).toBe(`/?${SHARE_MARKER}`);
    const share = await drainShareInbox(storage, "received");
    expect(share?.files.map((f) => f.name)).toEqual(["kept.png"]);
    expect(share?.problems).toEqual([expect.stringContaining("Not received from the share: lost.mp4")]);
  });

  test("any throw still answers 303, marked unreadable", async () => {
    const unreadable = `/?${SHARE_MARKER}=${SHARE_UNREADABLE}`;
    const notMultipart = new Request(`${ORIGIN}${SHARE_ACTION}`, { method: "POST", body: "plain" });
    expect(location(await rebuiltReceive({ request: notMultipart }))).toBe(unreadable);
    storage.failOpen = true;
    const response = await rebuiltReceive({ request: shareRequest(shareForm([new File(["a"], "a")])) });
    expect(response.status).toBe(303);
    expect(location(response)).toBe(unreadable);
  });
});

describe("drainShareInbox", () => {
  test("hands back the files, text and nothing to complain of, and a reload finds no share", async () => {
    await rebuiltReceive({
      request: shareRequest(
        shareForm(
          [
            new File(["first"], "a.pdf", { type: "application/pdf" }),
            new File(["second"], "b.png", { type: "image/png" }),
          ],
          {
            title: "Bug",
            text: "see https://x.test",
            url: "https://x.test",
          },
        ),
      ),
    });
    const share = await drainShareInbox(storage, "received");
    expect(share?.files.map((f) => [f.name, f.type])).toEqual([
      ["a.pdf", "application/pdf"],
      ["b.png", "image/png"],
    ]);
    expect(share?.problems).toEqual([]);
    expect(share?.text).toBe("Bug\nsee https://x.test");

    // The meta is gone, the files backing the form are not, and still read.
    expect(storage.cache.paths()).toHaveLength(2);
    expect(await share?.files[0]?.text()).toBe("first");
    // A reload is no share. It leaves the files alone while they may still back a form in
    // another tab, or be a share the worker is mid-way through writing...
    expect(await drainShareInbox(storage, null)).toBeNull();
    expect(storage.cache.paths()).toHaveLength(2);
    // ...and sweeps them once they are old enough to be nobody's.
    expect(await drainShareInbox(storage, null, Date.now() + 25 * 60 * 60 * 1000)).toBeNull();
    expect(storage.cache.paths()).toEqual([]);
  });

  test("a delete that rejects keeps what was read and says it may repeat", async () => {
    const meta = (name: string): Blob =>
      new Blob([JSON.stringify({ at: 1, files: [], skipped: [], lost: [], title: "", text: name, url: "" })]);
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}a`, meta("one"));
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}b`, meta("two"));
    const realDelete = storage.cache.delete.bind(storage.cache);
    storage.cache.delete = async (request) => {
      if (request.endsWith("/b")) throw new Error("QuotaExceededError");
      return realDelete(request);
    };
    const share = await drainShareInbox(storage, null);
    expect(share?.text).toBe("one\n\ntwo");
    expect(share?.problems).toEqual([expect.stringContaining("may arrive again")]);
  });

  test("a skipped file with a reason this build doesn't know is still named", async () => {
    storage.cache.bodies.set(
      `${ORIGIN}${SHARE_INBOX_PATH}q`,
      new Blob([
        JSON.stringify({
          at: 1,
          files: [],
          skipped: [{ name: "odd.bin", size: 5, reason: "type" }],
          lost: [],
          title: "",
          text: "",
          url: "",
        }),
      ]),
    );
    expect((await drainShareInbox(storage, null))?.refused).toEqual(["odd.bin was left out by the share"]);
  });

  test("deliverShare reports the reload's cost only on a share boot, and never throws", async () => {
    const before = { files: 2, submitting: false };
    const got: ReceivedShare[] = [];
    await deliverShare(storage, null, before, (share) => void got.push(share));
    expect(got).toEqual([]);

    storage.cache.bodies.set(
      `${ORIGIN}${SHARE_INBOX_PATH}1`,
      new Blob([JSON.stringify({ at: 1, files: [], skipped: [], lost: [], title: "", text: "hi", url: "" })]),
    );
    await deliverShare(storage, null, before, (share) => void got.push(share));
    expect(got[0]?.problems).toEqual([]);

    await deliverShare(storage, "received", before, (share) => void got.push(share));
    expect(got[1]?.problems).toEqual([SHARE_MISSING_TEXT, ...reloadCostText(before)]);

    storage.failOpen = true;
    await deliverShare(storage, "unreadable", null, (share) => void got.push(share));
    expect(got[2]?.problems).toEqual([SHARE_UNREADABLE_TEXT]);
  });

  test("drains every waiting share, oldest first", async () => {
    const meta = (at: number, name: string): Blob =>
      new Blob([
        JSON.stringify({
          at,
          files: [{ n: 0, name, type: "" }],
          skipped: [],
          lost: [],
          title: "",
          text: name,
          url: "",
        }),
      ]);
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}b`, meta(2, "later"));
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}b/0`, new Blob(["2"]));
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}a`, meta(1, "earlier"));
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}a/0`, new Blob(["1"]));
    const share = await drainShareInbox(storage, null);
    expect(share?.files.map((f) => f.name)).toEqual(["earlier", "later"]);
    expect(share?.text).toBe("earlier\n\nlater");
  });

  test("says why when the marker promised a share the inbox doesn't hold", async () => {
    expect(await drainShareInbox(storage, null)).toBeNull();
    expect((await drainShareInbox(storage, "received"))?.problems).toEqual([SHARE_MISSING_TEXT]);
    expect((await drainShareInbox(storage, "unreadable"))?.problems).toEqual([SHARE_UNREADABLE_TEXT]);
  });

  test("at boot, no Cache Storage or a failing one still says a marked share was lost", async () => {
    expect(await receiveOnBoot(undefined, null)).toBeNull();
    expect((await receiveOnBoot(undefined, "received"))?.problems).toEqual([SHARE_MISSING_TEXT]);
    storage.failOpen = true;
    expect(await receiveOnBoot(storage, null)).toBeNull();
    expect((await receiveOnBoot(storage, "unreadable"))?.problems).toEqual([SHARE_UNREADABLE_TEXT]);
  });

  test("a malformed meta reads as unreadable and is deleted", async () => {
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}x`, new Blob(['{"at":"soon"}']));
    storage.cache.bodies.set(`${ORIGIN}${SHARE_INBOX_PATH}y`, new Blob(["not json"]));
    const share = await drainShareInbox(storage, "received");
    expect(share?.files).toEqual([]);
    expect(share?.problems).toEqual([SHARE_UNREADABLE_TEXT]);
    expect(storage.cache.paths()).toEqual([]);
  });

  test("a file entry the meta names but the cache lost is reported, not dropped silently", async () => {
    storage.cache.bodies.set(
      `${ORIGIN}${SHARE_INBOX_PATH}z`,
      new Blob([
        JSON.stringify({
          at: 1,
          files: [{ n: 0, name: "gone.mov", type: "" }],
          skipped: [],
          lost: [],
          title: "",
          text: "",
          url: "",
        }),
      ]),
    );
    const share = await drainShareInbox(storage, "received");
    expect(share?.files).toEqual([]);
    expect(share?.problems).toEqual([expect.stringContaining("gone.mov")]);
  });
});

describe("share text and markers", () => {
  test("sharedText keeps distinct parts and drops one inside another", () => {
    expect(sharedText("", "look https://x.test", "https://x.test")).toBe("look https://x.test");
    expect(sharedText("Title", "", "https://x.test")).toBe("Title\nhttps://x.test");
    expect(sharedText("same", "same", " ")).toBe("same");
    expect(sharedText("", "", "")).toBe("");
  });

  test("shareMarker reads the redirect's query", () => {
    expect(shareMarker("")).toBeNull();
    expect(shareMarker("?other=1")).toBeNull();
    expect(shareMarker(`?${SHARE_MARKER}`)).toBe("received");
    expect(shareMarker(`?${SHARE_MARKER}=${SHARE_UNREADABLE}`)).toBe("unreadable");
  });

  test("reloadCostText names what the replaced document held", () => {
    expect(reloadCostText(null)).toEqual([]);
    expect(reloadCostText({ files: 0, submitting: false })).toEqual([]);
    expect(reloadCostText({ files: 1, submitting: false })).toEqual([
      "1 file that was on the form before the share was removed; add it again.",
    ]);
    expect(reloadCostText({ files: 3, submitting: true })).toEqual([
      "3 files that were on the form before the share were removed; add them again.",
      "A Queue was in progress when the share arrived; check the Queue before queueing again.",
    ]);
  });
});
