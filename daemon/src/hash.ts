/**
 * First 4 bytes of SHA-256, hex. Short enough to read out over the phone when
 * checking that four machines share a key, and the comparison it serves is
 * accidental mismatch rather than an adversary hunting collisions.
 */
export async function fingerprint(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fingerprintText(value: string): Promise<string> {
  return fingerprint(new Uint8Array(new TextEncoder().encode(value)));
}
