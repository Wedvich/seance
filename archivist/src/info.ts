import { APP_ID, seal, type Envelope } from "@seance/shared";

/**
 * The archivist's registry blob. Sealed under op `machine-info` like a
 * daemon's, but deliberately not a `MachineInfo`: no `repos`, no `scannedAt`,
 * no exclaves, so `parseMachineInfo` refuses it. A client built before the
 * relay flagged the seat (docs/archivist.md, Build order item 1) opens the
 * blob, fails the parse and counts the entry `skewed` — "update" — rather than
 * a machine to spawn on, and never `ignored`, which would send someone to
 * rotate a correct key. A client with the flag skips the entry before it gets
 * that far. `name` and `platform` are display only (the health card, item 6).
 */
export interface ArchivistInfo {
  readonly archivist: true;
  readonly name: string;
  readonly platform: string;
}

export function sealArchivistInfo(key: CryptoKey, from: string, info: ArchivistInfo): Promise<Envelope> {
  return seal(
    key,
    { to: APP_ID, from },
    { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: info },
  );
}
