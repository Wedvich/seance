import { APP_ID, ENVELOPE_MAX_CT_LENGTH, seal, type Envelope, type MachineInfo, type RepoEntry } from "@seance/shared";

export interface SealedInfo {
  readonly sealed: Envelope;
  /** Project skills were stripped to fit the envelope; the caller logs it (this module stays log-free). */
  readonly droppedSkills: boolean;
  /** Still past the bound as sealed (skills dropped or none to drop): the relay will refuse it, and the caller says so. */
  readonly oversized: boolean;
}

/**
 * The register blob, sealed `to: "app"`. The relay drops an envelope past
 * `ENVELOPE_MAX_CT_LENGTH` unseen, which would cost the machine its whole
 * registration, so a blob over it is resealed without every clone's project
 * skills — optional, and read as none by the skills filter — before anything
 * else gives (types.ts, `REPO_MAX_SKILLS`).
 */
export async function sealMachineInfo(key: CryptoKey, from: string, info: MachineInfo): Promise<SealedInfo> {
  const sealed = await sealInfo(key, from, info);
  const tooBig = sealed.ct.length > ENVELOPE_MAX_CT_LENGTH;
  if (!tooBig || !info.repos.some((r) => r.skills !== undefined)) {
    return { sealed, droppedSkills: false, oversized: tooBig };
  }
  // Spread, not rebuilt field by field, so a RepoEntry field added later survives; JSON drops the undefined.
  const repos = info.repos.map((repo): RepoEntry => ({ ...repo, skills: undefined }));
  const trimmed = await sealInfo(key, from, { ...info, repos });
  return { sealed: trimmed, droppedSkills: true, oversized: trimmed.ct.length > ENVELOPE_MAX_CT_LENGTH };
}

function sealInfo(key: CryptoKey, from: string, info: MachineInfo): Promise<Envelope> {
  return seal(
    key,
    { to: APP_ID, from },
    { id: crypto.randomUUID(), ts: Date.now(), op: "machine-info", payload: info },
  );
}
