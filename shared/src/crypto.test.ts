import { describe, expect, test } from "bun:test";
import { fromBase64, importPsk, open, ReplayError, ReplayGuard, seal, toBase64 } from "./crypto.ts";
import { PROTOCOL_VERSION, type Envelope, type Plain } from "./types.ts";

const PSK_A = toBase64(new Uint8Array(32).fill(7));
const PSK_B = toBase64(new Uint8Array(32).fill(8));

const plain: Plain = {
  id: "11111111-2222-3333-4444-555555555555",
  ts: 1_785_000_000_000,
  op: "sessions",
  payload: {},
};

const route = { to: "device-a", from: "app" };

describe("base64", () => {
  test("roundtrips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("importPsk", () => {
  test("rejects keys that are not 32 bytes", async () => {
    expect(importPsk(toBase64(new Uint8Array(16)))).rejects.toThrow("32 bytes");
  });
});

describe("seal/open", () => {
  test("roundtrips", async () => {
    const key = await importPsk(PSK_A);
    const env = await seal(key, route, plain);
    expect(env.v).toBe(PROTOCOL_VERSION);
    expect(env.to).toBe("device-a");
    expect(fromBase64(env.iv).byteLength).toBe(12);
    expect(await open(key, env)).toEqual(plain);
  });

  test("unique IV per message", async () => {
    const key = await importPsk(PSK_A);
    const a = await seal(key, route, plain);
    const b = await seal(key, route, plain);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test("wrong key fails to open", async () => {
    const env = await seal(await importPsk(PSK_A), route, plain);
    expect(open(await importPsk(PSK_B), env)).rejects.toThrow();
  });

  test("tampered ciphertext fails to open", async () => {
    const key = await importPsk(PSK_A);
    const env = await seal(key, route, plain);
    const ct = fromBase64(env.ct);
    ct[0] = (ct[0]! ^ 0xff) & 0xff;
    expect(open(key, { ...env, ct: toBase64(ct) })).rejects.toThrow();
  });

  test("re-addressed envelope fails AAD check", async () => {
    const key = await importPsk(PSK_A);
    const env = await seal(key, route, plain);
    // A compromised relay redirects the blob to a different machine.
    expect(open(key, { ...env, to: "device-b" })).rejects.toThrow();
  });

  test("swapped sender fails AAD check", async () => {
    const key = await importPsk(PSK_A);
    const env = await seal(key, route, plain);
    expect(open(key, { ...env, from: "device-b" })).rejects.toThrow();
  });

  test("unsupported version is rejected before decrypting", async () => {
    const key = await importPsk(PSK_A);
    const env = await seal(key, route, plain);
    const bumped = { ...env, v: 99 } as Envelope;
    expect(open(key, bumped)).rejects.toThrow("unsupported envelope version");
  });

  test("malformed IV is rejected", async () => {
    const key = await importPsk(PSK_A);
    const env = await seal(key, route, plain);
    expect(open(key, { ...env, iv: toBase64(new Uint8Array(4)) })).rejects.toThrow("IV must be");
  });
});

describe("ReplayGuard", () => {
  const NOW = 1_785_000_000_000;

  test("accepts a fresh message", () => {
    const guard = new ReplayGuard();
    expect(() => guard.check("iv-1", NOW, NOW)).not.toThrow();
  });

  test("rejects a duplicate IV", () => {
    const guard = new ReplayGuard();
    guard.check("iv-1", NOW, NOW);
    expect(() => guard.check("iv-1", NOW + 1, NOW + 1)).toThrow(ReplayError);
    try {
      guard.check("iv-1", NOW + 1, NOW + 1);
    } catch (err) {
      expect((err as ReplayError).reason).toBe("replayed");
    }
  });

  test("rejects a stale timestamp", () => {
    const guard = new ReplayGuard();
    expect(() => guard.check("iv-1", NOW - 60_001, NOW)).toThrow(ReplayError);
  });

  test("rejects a future timestamp", () => {
    const guard = new ReplayGuard();
    expect(() => guard.check("iv-1", NOW + 60_001, NOW)).toThrow(ReplayError);
  });

  test("accepts timestamps at the window edge", () => {
    const guard = new ReplayGuard();
    expect(() => guard.check("iv-1", NOW - 60_000, NOW)).not.toThrow();
    expect(() => guard.check("iv-2", NOW + 60_000, NOW)).not.toThrow();
  });

  test("prunes expired IVs — cache does not grow unbounded", () => {
    const guard = new ReplayGuard();
    guard.check("iv-1", NOW, NOW);
    // 120s later the entry has expired; the same IV would be accepted again,
    // but only because the ts window already rejects anything that old.
    const later = NOW + 120_001;
    expect(() => guard.check("iv-1", later, later)).not.toThrow();
  });

  test("retention outlives the ts window: replay near the edge still caught", () => {
    const guard = new ReplayGuard();
    guard.check("iv-1", NOW, NOW);
    // 90s later: ts NOW is stale anyway, but a forged-ts frame reusing the IV
    // must still hit the seen-cache.
    const later = NOW + 90_000;
    expect(() => guard.check("iv-1", later - 1_000, later)).toThrow(ReplayError);
  });
});
