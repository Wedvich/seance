import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startPushEndpoint, type PushEndpoint } from "./push-endpoint.ts";

let push: PushEndpoint;

beforeAll(() => {
  push = startPushEndpoint();
});

afterAll(async () => {
  await push.stop();
});

function send(url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { TTL: "60", "Content-Encoding": "aes128gcm", Authorization: "vapid t=jwt, k=key" },
    body,
  });
}

describe("push endpoint stub", () => {
  test("records a push with its headers and body, answers 201, and listens on 127.0.0.1", async () => {
    const url = push.endpoint("sub-1");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const reply = await send(url, "sealed");
    expect(reply.status).toBe(201);

    const [received] = await push.waitForRequests(1);
    expect(received).toMatchObject({
      method: "POST",
      path: "/push/sub-1",
      headers: { ttl: "60", "content-encoding": "aes128gcm", authorization: "vapid t=jwt, k=key" },
    });
    expect(new TextDecoder().decode(received?.body)).toBe("sealed");
  });

  test("answers the chosen status, still recording the request", async () => {
    const before = push.requests().length;
    push.respondWith(410);
    try {
      expect((await send(push.endpoint("gone"), "x")).status).toBe(410);
    } finally {
      push.respondWith(201);
    }
    expect(
      push
        .requests()
        .slice(before)
        .map((r) => r.path),
    ).toEqual(["/push/gone"]);
  });

  test("a held push is recorded on arrival and answered only once released", async () => {
    const before = push.requests().length;
    const release = push.hold();
    let answered = false;
    const reply = send(push.endpoint("slow"), "x").then((r) => {
      answered = true;
      return r;
    });
    try {
      await push.waitForRequests(before + 1);
      // A sleep is right before a negative assertion: a non-event cannot be polled.
      await Bun.sleep(100);
      expect(answered).toBe(false);
    } finally {
      release();
    }
    expect((await reply).status).toBe(201);
  });

  test("overlapping holds keep withholding until the last is released", async () => {
    const before = push.requests().length;
    const first = push.hold();
    const second = push.hold();
    let answered = false;
    const reply = send(push.endpoint("two-holds"), "x").then((r) => {
      answered = true;
      return r;
    });
    try {
      await push.waitForRequests(before + 1);
      first();
      await Bun.sleep(100);
      expect(answered).toBe(false);
    } finally {
      second();
    }
    expect((await reply).status).toBe(201);
  });

  test("stop answers a held request rather than cutting its connection", async () => {
    const own = startPushEndpoint();
    own.hold();
    const reply = fetch(own.endpoint(), { method: "POST", body: "x" });
    await own.waitForRequests(1);
    await own.stop();
    expect((await reply).status).toBe(201);
  });
});
