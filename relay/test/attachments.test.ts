import {
  ATTACHMENT_MAX_OBJECT_BYTES,
  ATTACHMENT_OVERHEAD_BYTES,
  ATTACHMENT_PATH,
  mintAttachmentId,
  type AttachmentHttpCode,
} from "@seance/shared";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type TestRelay } from "./harness.ts";

const TOKEN = "test-bearer-token";

/** Booting workerd within ~100 ms of a dispose breaks its stdio (CLAUDE.md, Testing). */
const SETTLE_MS = 500;

/** Low enough to exhaust in a handful of small uploads; the month window is tested on its own relay. */
const HOUR_UPLOADS = 40;

function object(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function put(relay: TestRelay, id: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return relay.probe(ATTACHMENT_PATH + id, {
    method: "PUT",
    headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/octet-stream", ...headers },
    body,
  });
}

function get(relay: TestRelay, id: string, token = relay.token): Promise<Response> {
  return relay.probe(ATTACHMENT_PATH + id, { headers: { authorization: `Bearer ${token}` } });
}

/**
 * A PUT written over raw TCP, head and then only `body`: `fetch` recomputes
 * Content-Length from the body it is given, so a declared length the body does
 * not match can only be sent by hand. Reads the one response and hangs up.
 */
async function rawPut(
  relay: TestRelay,
  id: string,
  headers: Record<string, string>,
  body = "",
): Promise<{ readonly status: number; readonly code: unknown }> {
  const done = Promise.withResolvers<string>();
  let text = "";
  const socket = await Bun.connect<undefined>({
    hostname: relay.url.hostname,
    port: Number(relay.url.port),
    socket: {
      data: (_s, chunk) => {
        text += chunk.toString("latin1");
        const split = text.indexOf("\r\n\r\n");
        const length = /^content-length: *(\d+)/imu.exec(text)?.[1];
        if (split !== -1 && length !== undefined && text.length >= split + 4 + Number(length)) done.resolve(text);
      },
      close: () => done.reject(new Error(`connection closed before a response: ${JSON.stringify(text)}`)),
    },
  });
  const lines = Object.entries({ host: relay.url.host, authorization: `Bearer ${relay.token}`, ...headers });
  socket.write(
    `PUT ${ATTACHMENT_PATH}${id} HTTP/1.1\r\n${lines.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`,
  );
  try {
    const response = await done.promise;
    const status = Number(response.split(" ")[1]);
    const json = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4)) as { code?: unknown };
    return { status, code: json.code };
  } finally {
    socket.terminate();
  }
}

async function expectCode(res: Response, status: number, code: AttachmentHttpCode): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  expect({ status: res.status, code: body["code"] }).toEqual({ status, code });
  return body;
}

describe("attachment routes", () => {
  let relay: TestRelay;
  /** Ids the relay accepted a transfer of: the last test finds none in a log line. */
  const accepted: string[] = [];

  beforeAll(async () => {
    await Bun.sleep(SETTLE_MS);
    relay = await startRelay(TOKEN, { captureLogs: true, uploadAllowance: { hourUploads: HOUR_UPLOADS } });
  });

  afterAll(async () => {
    await relay.dispose();
    await Bun.sleep(SETTLE_MS);
  });

  test("an object round-trips byte for byte, as opaque octets nobody may cache", async () => {
    const id = mintAttachmentId();
    const bytes = object(4096);
    const stored = await put(relay, id, bytes, { "content-type": "image/png" });
    await expectCode(stored, 201, "stored");
    accepted.push(id);
    expect(stored.headers.get("access-control-allow-origin")).toBe("*");

    const res = await get(relay, id);
    expect(res.status).toBe(200);
    // No metadata reaches R2: the PUT's content type does not come back.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("4096");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("uploads are create-only: a second PUT under a stored id is refused and changes nothing", async () => {
    const id = mintAttachmentId();
    const first = object(64);
    await expectCode(await put(relay, id, first), 201, "stored");
    await expectCode(await put(relay, id, object(64)), 409, "exists");
    expect(new Uint8Array(await (await get(relay, id)).arrayBuffer())).toEqual(first);
  });

  test("the token rides the Authorization header only", async () => {
    const id = mintAttachmentId();
    const wrong = await relay.probe(ATTACHMENT_PATH + id, {
      method: "PUT",
      headers: { authorization: "Bearer wrong" },
      body: object(64),
    });
    await expectCode(wrong, 401, "unauthorized");
    // A refused PUT is still readable cross-origin, so the PWA can show why.
    expect(wrong.headers.get("access-control-allow-origin")).toBe("*");
    const inQuery = await relay.probe(`${ATTACHMENT_PATH}${id}?t=${TOKEN}`, { method: "PUT", body: object(64) });
    await expectCode(inQuery, 401, "unauthorized");
    await expectCode(await get(relay, id, "wrong"), 401, "unauthorized");
    await expectCode(await relay.probe(ATTACHMENT_PATH + id), 401, "unauthorized");
    // The refused PUTs stored nothing.
    await expectCode(await get(relay, id), 404, "not_found");
  });

  test("an id outside the pattern is refused before any storage", async () => {
    for (const id of ["", "not-a-uuid", mintAttachmentId().toUpperCase(), `${mintAttachmentId()}/x`, "..%2Fhub"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential keeps each refusal's line in order
      await expectCode(await put(relay, id, object(64)), 404, "invalid_id");
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expectCode(await get(relay, id), 404, "invalid_id");
    }
  });

  test("GET of an id never stored is not_found", async () => {
    await expectCode(await get(relay, mintAttachmentId()), 404, "not_found");
  });

  test("other methods are refused, after the token", async () => {
    const id = mintAttachmentId();
    const res = await relay.probe(ATTACHMENT_PATH + id, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await expectCode(res, 405, "method_not_allowed");
    expect(res.headers.get("allow")).toBe("GET, PUT, OPTIONS");
    await expectCode(await relay.probe(ATTACHMENT_PATH + id, { method: "DELETE" }), 401, "unauthorized");
  });

  test("the declared length is checked before a byte is read", async () => {
    await expectCode(
      await put(relay, mintAttachmentId(), object(ATTACHMENT_OVERHEAD_BYTES - 1)),
      400,
      "invalid_length",
    );
    // Head only, no body: the refusal arrives without the relay waiting for a byte.
    const big = await rawPut(relay, mintAttachmentId(), { "content-length": String(ATTACHMENT_MAX_OBJECT_BYTES + 1) });
    expect(big).toMatchObject({ status: 413, code: "too_large" });
    const chunked = await rawPut(relay, mintAttachmentId(), { "transfer-encoding": "chunked" }, "40\r\n");
    expect(chunked).toMatchObject({ status: 411, code: "length_required" });
  });

  test("an object at the cap is stored", async () => {
    const id = mintAttachmentId();
    await expectCode(await put(relay, id, object(ATTACHMENT_MAX_OBJECT_BYTES)), 201, "stored");
    accepted.push(id);
    expect((await get(relay, id)).headers.get("content-length")).toBe(String(ATTACHMENT_MAX_OBJECT_BYTES));
  });

  test("the preflight answers without a token, for PUT with the two headers the PWA sets", async () => {
    const res = await relay.probe(ATTACHMENT_PATH + mintAttachmentId(), {
      method: "OPTIONS",
      headers: {
        origin: "https://pwa.example",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(Object.fromEntries([...res.headers].filter(([name]) => name.startsWith("access-control-")))).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "PUT",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "7200",
    });
  });

  test("the hour's upload count runs out with a 429 naming the window and the wait", async () => {
    // Uploads until refused, rather than counting the ones above: an hour rolling over
    // mid-suite opens a fresh bucket, which this bound still covers.
    let res: Response | null = null;
    let id = "";
    for (let attempt = 0; attempt <= 2 * HOUR_UPLOADS; attempt += 1) {
      id = mintAttachmentId();
      // oxlint-disable-next-line no-await-in-loop -- the allowance counts one upload at a time
      res = await put(relay, id, object(ATTACHMENT_OVERHEAD_BYTES));
      if (res.status !== 201) break;
      accepted.push(id);
    }
    if (res === null) throw new Error("no upload attempted");
    const body = await expectCode(res, 429, "allowance_exhausted");
    expect(body["window"]).toBe("hour");
    expect(body["retryAfter"]).toBeGreaterThan(0);
    expect(body["retryAfter"]).toBeLessThanOrEqual(3600);
    expect(res.headers.get("retry-after")).toBe(String(body["retryAfter"]));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    await expectCode(await get(relay, id), 404, "not_found");
  });

  /**
   * Last: it reads every line the routes above produced. Accepted transfers log
   * nothing, and a refusal names its id and code, never a length or a token.
   */
  test("logs hold refusals only, by id", async () => {
    const lines = relay.logs();
    expect(accepted.length).toBeGreaterThan(2);
    expect(lines.every((line) => line.startsWith("attachment refused "))).toBe(true);
    expect(lines.filter((line) => line.includes(TOKEN))).toEqual([]);
    expect(lines.filter((line) => accepted.some((id) => line.includes(id)))).toEqual([]);
    expect(lines.some((line) => line.endsWith(" code=exists"))).toBe(true);
    expect(lines.some((line) => line.endsWith(" code=allowance_exhausted window=hour"))).toBe(true);
  });
});

describe("attachment allowance windows", () => {
  let relay: TestRelay;

  beforeAll(async () => {
    await Bun.sleep(SETTLE_MS);
    // Month below hour-and-a-bit: both windows reachable within one hour.
    relay = await startRelay(TOKEN, { uploadAllowance: { windowBytes: 100, hourBytes: 60 } });
  });

  afterAll(async () => {
    await relay.dispose();
    await Bun.sleep(SETTLE_MS);
  });

  test("the hour's bytes, then the month's, each answer 429 with their window", async () => {
    await expectCode(await put(relay, mintAttachmentId(), object(60)), 201, "stored");
    const hour = await expectCode(await put(relay, mintAttachmentId(), object(28)), 429, "allowance_exhausted");
    expect(hour["window"]).toBe("hour");
    // 60 + 41 is past the month's 100 as well as the hour's 60: the month answers, its wait the longer.
    const month = await expectCode(await put(relay, mintAttachmentId(), object(41)), 429, "allowance_exhausted");
    expect(month["window"]).toBe("month");
    expect(month["retryAfter"]).toBeGreaterThan(720 * 3600);
  });
});
