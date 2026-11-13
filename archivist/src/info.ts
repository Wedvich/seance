import { APP_ID, seal, type ArchivistInfo, type Envelope } from "@seance/shared";

export function sealArchivistInfo(key: CryptoKey, from: string, info: ArchivistInfo): Promise<Envelope> {
  return seal(
    key,
    { to: APP_ID, from },
    { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: info },
  );
}
