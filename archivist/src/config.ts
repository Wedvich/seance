import { readFile } from "node:fs/promises";
import { isRecord } from "@seance/shared";
import type { RelayConfigFields } from "../../daemon/src/config-checks.ts";

/** What the archivist reads from its config: where the relay is and how to reach it. Nothing else. */
export type ArchivistConfig = RelayConfigFields;

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`config at ${path} is not valid JSON`);
  }
}

/**
 * Shape only, like the daemon's `loadConfig`: empty strings load, and
 * `runnableProblems` reports them. A `psk` key is refused outright rather than
 * ignored: the archivist reads its key only from its unit's credential
 * (docs/archivist.md, A12), and a key left in this file would be one more
 * plaintext copy that nothing reads.
 */
export async function loadArchivistConfig(path: string): Promise<ArchivistConfig> {
  const text = await readFile(path, "utf8").catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`no config at ${path} — write {"name", "relayUrl", "bearerToken"} there (0600)`);
    }
    throw err;
  });
  const raw = parseJson(text, path);
  if (!isRecord(raw)) throw new TypeError(`config at ${path} must be a JSON object`);
  if ("psk" in raw) {
    throw new Error(
      `config at ${path} holds a "psk" — remove it: the archivist reads its key only from its systemd credential (docs/psk.md)`,
    );
  }
  const field = (key: keyof ArchivistConfig): string => {
    const value = raw[key];
    if (typeof value !== "string") throw new TypeError(`config at ${path}: "${key}" must be a string`);
    return value;
  };
  return { name: field("name"), relayUrl: field("relayUrl"), bearerToken: field("bearerToken") };
}
