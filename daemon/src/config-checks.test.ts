import { describe, expect, test } from "bun:test";
import { toBase64 } from "@seance/shared";
import { bearerTokenWarnings, pskFingerprint, runnableProblems } from "./config-checks.ts";

const PSK = toBase64(new Uint8Array(32).fill(1));
const base = { name: "Test Mac", relayUrl: "wss://relay.example/daemon", bearerToken: "token" };

describe("runnableProblems", () => {
  // A daemon config whose `psk` field is empty: the key came from a platform store or the unit.
  const emptyField = { ...base, psk: "" };

  test("valid config has no problems", () => {
    expect(runnableProblems(base, PSK)).toEqual([]);
  });

  test("absent psk, short psk, bad base64, bad url all reported", () => {
    expect(runnableProblems(base, null)).toHaveLength(1);
    expect(runnableProblems(base, null)[0]).toContain("psk-import");
    expect(runnableProblems(base, toBase64(new Uint8Array(16)))[0]).toContain("16 bytes");
    expect(runnableProblems(base, "!!!")[0]).toContain("base64");
    expect(runnableProblems({ ...base, relayUrl: "https://x" }, PSK)[0]).toContain("ws://");
    expect(runnableProblems({ ...base, bearerToken: "" }, null)).toHaveLength(2);
  });

  test("judges the resolved key, not the config field — an empty field with a keychain key is runnable", () => {
    expect(runnableProblems(emptyField, PSK)).toEqual([]);
  });

  test("a key the service manager delivers is not a missing key — every other problem still reported", () => {
    expect(runnableProblems(emptyField, null, { pskDelivered: true })).toEqual([]);
    expect(runnableProblems({ ...base, bearerToken: "" }, null, { pskDelivered: true })).toHaveLength(1);
  });
});

const fingerprintOfKey = (fill: number): Promise<string> => pskFingerprint(toBase64(new Uint8Array(32).fill(fill)));

describe("pskFingerprint", () => {
  test("eight stable hex characters that differ between keys", async () => {
    const a = await fingerprintOfKey(1);
    expect(a).toMatch(/^[0-9a-f]{8}$/u);
    expect(await fingerprintOfKey(1)).toBe(a);
    expect(await fingerprintOfKey(2)).not.toBe(a);
  });

  test("reveals nothing of the key it summarises", async () => {
    const psk = toBase64(new Uint8Array(32).fill(7));
    expect(psk).not.toContain(await pskFingerprint(psk));
  });
});

describe("bearerTokenWarnings", () => {
  const strong = "CMQWe8MLQUjWD4UpUlqaiMrVEUTDxe3PlPpSECJn0Pg";

  test("a base64url token of decent length draws no warnings", () => {
    expect(bearerTokenWarnings(strong)).toEqual([]);
  });

  test("padded base64url is fine — `=` survives both a header and a query value", () => {
    expect(bearerTokenWarnings(`${strong}=`)).toEqual([]);
  });

  test("empty is left to runnableProblems rather than double-reported", () => {
    expect(bearerTokenWarnings("")).toEqual([]);
  });

  test("flags standard-base64 characters that ?t= mangles", () => {
    const [warning] = bearerTokenWarnings("DQ0N7k/gkySJE7MxZEyEBZuyShlCC1PP1TFOPx+fkzU=");
    expect(warning).toContain("?t=");
    expect(warning).toContain("base64url");
  });

  test("names each offending character once, quoted so whitespace is visible", () => {
    const [warning] = bearerTokenWarnings(`${strong}++&& #`);
    expect(warning).toContain(`"+" "&" " " "#"`);
  });

  test("flags a token short enough to be worth regenerating", () => {
    expect(bearerTokenWarnings("short")[0]).toContain("5 characters");
    expect(bearerTokenWarnings("a".repeat(31))[0]).toContain("31 characters");
    expect(bearerTokenWarnings("a".repeat(32))).toEqual([]);
  });

  test("reports encoding and length independently", () => {
    expect(bearerTokenWarnings("a+b")).toHaveLength(2);
  });
});
