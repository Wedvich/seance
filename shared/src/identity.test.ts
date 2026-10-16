import { describe, expect, test } from "bun:test";
import {
  IDENTITY_PUBLIC_KEY_BYTES,
  IDENTITY_SIGNATURE_BYTES,
  REGISTER_FRESHNESS_MS,
  base64Length,
  deviceIdOf,
  fromBase64,
  generateIdentitySeed,
  identityFromSeed,
  signRegister,
  verifyRegister,
} from "./index.ts";

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

describe("identity", () => {
  test("a seed derives one identity, and the deviceId is the key's hash in the relay's id charset", async () => {
    const seed = generateIdentitySeed();
    const a = await identityFromSeed(seed);
    const b = await identityFromSeed(seed);
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.publicKey).toBe(a.publicKey);
    expect(a.deviceId).toBe(await deviceIdOf(fromBase64(a.publicKey)));
    expect(a.deviceId).toMatch(SAFE_ID);
    expect(a.deviceId.length).toBeLessThanOrEqual(64);
    expect(fromBase64(a.publicKey).byteLength).toBe(IDENTITY_PUBLIC_KEY_BYTES);
  });

  test("a signed register verifies, and the signature is the documented size", async () => {
    const identity = await identityFromSeed(generateIdentitySeed());
    const ts = Date.now();
    const sig = await signRegister(identity, ts);
    expect(sig.length).toBe(base64Length(IDENTITY_SIGNATURE_BYTES));
    expect(await verifyRegister({ deviceId: identity.deviceId, publicKey: identity.publicKey, ts, sig }, ts)).toBe(
      "ok",
    );
  });

  // The attack this exists for: a bearer-token holder with their own key
  // registering under a machine's id. The key hashes to a different id, so the
  // claim fails before any signature is looked at.
  test("a key that does not hash to the claimed deviceId is refused", async () => {
    const victim = await identityFromSeed(generateIdentitySeed());
    const thief = await identityFromSeed(generateIdentitySeed());
    const ts = Date.now();
    const sig = await signRegister({ ...thief, deviceId: victim.deviceId }, ts);
    expect(await verifyRegister({ deviceId: victim.deviceId, publicKey: thief.publicKey, ts, sig }, ts)).toBe(
      "key-id-mismatch",
    );
  });

  test("a signature over another timestamp, or by another key, is refused", async () => {
    const identity = await identityFromSeed(generateIdentitySeed());
    const other = await identityFromSeed(generateIdentitySeed());
    const ts = Date.now();
    const claim = { deviceId: identity.deviceId, publicKey: identity.publicKey };
    const sig = await signRegister(identity, ts);
    expect(await verifyRegister({ ...claim, ts: ts + 1, sig }, ts)).toBe("bad-signature");
    const foreign = await signRegister({ ...other, deviceId: identity.deviceId }, ts);
    expect(await verifyRegister({ ...claim, ts, sig: foreign }, ts)).toBe("bad-signature");
  });

  test("a register outside the freshness window is stale, whichever way the clocks lean", async () => {
    const identity = await identityFromSeed(generateIdentitySeed());
    const ts = Date.now();
    const sig = await signRegister(identity, ts);
    const claim = { deviceId: identity.deviceId, publicKey: identity.publicKey, ts, sig };
    expect(await verifyRegister(claim, ts + REGISTER_FRESHNESS_MS)).toBe("ok");
    expect(await verifyRegister(claim, ts + REGISTER_FRESHNESS_MS + 1)).toBe("stale");
    expect(await verifyRegister(claim, ts - REGISTER_FRESHNESS_MS - 1)).toBe("stale");
  });

  // v2 is what makes `roles` something the relay can act on: a token holder
  // relaying a captured register must not be able to add, drop or reorder them,
  // and a v1 signature must never stand in for a frame that carries roles.
  test("a v2 signature covers exactly its roles, and the two versions never verify as each other", async () => {
    const identity = await identityFromSeed(generateIdentitySeed());
    const ts = Date.now();
    const claim = { deviceId: identity.deviceId, publicKey: identity.publicKey, ts };
    const v2 = await signRegister(identity, ts, ["scheduler"]);
    expect(await verifyRegister({ ...claim, sig: v2, roles: ["scheduler"] }, ts)).toBe("ok");
    expect(await verifyRegister({ ...claim, sig: v2, roles: [] }, ts)).toBe("bad-signature");
    expect(await verifyRegister({ ...claim, sig: v2, roles: ["scheduler", "x"] }, ts)).toBe("bad-signature");
    expect(await verifyRegister({ ...claim, sig: v2 }, ts)).toBe("bad-signature");

    const v1 = await signRegister(identity, ts);
    expect(await verifyRegister({ ...claim, sig: v1 }, ts)).toBe("ok");
    expect(await verifyRegister({ ...claim, sig: v1, roles: ["scheduler"] }, ts)).toBe("bad-signature");
    expect(await verifyRegister({ ...claim, sig: v1, roles: [] }, ts)).toBe("bad-signature");

    const ordered = await signRegister(identity, ts, ["a", "b"]);
    expect(await verifyRegister({ ...claim, sig: ordered, roles: ["b", "a"] }, ts)).toBe("bad-signature");
  });

  test("a key or signature of the wrong size, or not base64, is malformed rather than thrown", async () => {
    const identity = await identityFromSeed(generateIdentitySeed());
    const ts = Date.now();
    const sig = await signRegister(identity, ts);
    const claim = { deviceId: identity.deviceId, publicKey: identity.publicKey, ts, sig };
    expect(await verifyRegister({ ...claim, publicKey: claim.publicKey.slice(4) }, ts)).toBe("malformed");
    expect(await verifyRegister({ ...claim, sig: "not base64!" }, ts)).toBe("malformed");
  });
});
