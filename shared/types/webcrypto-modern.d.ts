/**
 * The slice of the "Modern Algorithms in the Web Cryptography API" draft that
 * `identity.ts` uses. bun-types already declare it, so the daemon and the
 * extension see it natively; lib.dom (pwa) and workers-types (relay) do not
 * yet, and their tsconfigs include this file (kept out of `src/` so the shared
 * workspace, whose `SubtleCrypto` only extends the Node one, never sees it) to merge these overloads into
 * their `SubtleCrypto`. A script file on purpose: an import would turn it
 * into a module and the merge would need `declare global`, which overrides
 * rather than merges where `SubtleCrypto` only *extends* the Node one. The
 * runtimes implement all three — probed in `identity.test.ts` and the relay
 * suite, never assumed.
 */
interface SubtleCrypto {
  importKey(
    format: "raw-seed" | "raw-public",
    keyData: ArrayBuffer | ArrayBufferView,
    algorithm: { readonly name: string },
    extractable: boolean,
    keyUsages: readonly ("sign" | "verify")[],
  ): Promise<CryptoKey>;
  exportKey(format: "raw-public", key: CryptoKey): Promise<ArrayBuffer>;
  getPublicKey(key: CryptoKey, keyUsages: readonly ("sign" | "verify")[]): Promise<CryptoKey>;
}
