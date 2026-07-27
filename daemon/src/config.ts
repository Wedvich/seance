import { fromBase64 } from "@seance/shared";
import { configPath, expandTilde } from "./paths.ts";

export interface Config {
  readonly name: string;
  readonly relayUrl: string;
  readonly bearerToken: string;
  readonly psk: string;
  /** Tilde-expanded parent roots scanned for repos at depth 2. */
  readonly repoRoots: readonly string[];
  /** tmux session group daemon-spawned windows land in. */
  readonly tmuxSession: string;
}

export function configSkeleton(machineName: string): string {
  const skeleton = {
    name: machineName,
    relayUrl: "wss://",
    bearerToken: "",
    psk: "",
    repoRoots: ["~/repos"],
    tmuxSession: "main",
  };
  return `${JSON.stringify(skeleton, null, 2)}\n`;
}

function requireString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== "string") {
    throw new Error(`config at ${path}: "${key}" must be a string`);
  }
  return value;
}

/** Validates shape only — empty psk/bearerToken load fine so `doctor` can report them. */
export async function loadConfig(path: string = configPath()): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no config at ${path} — run \`seanced init\` first`);
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    throw new Error(`config at ${path} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config at ${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const roots = obj["repoRoots"];
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((r) => typeof r !== "string")) {
    throw new Error(`config at ${path}: "repoRoots" must be a non-empty array of strings`);
  }
  return {
    name: requireString(obj, "name", path),
    relayUrl: requireString(obj, "relayUrl", path),
    bearerToken: requireString(obj, "bearerToken", path),
    psk: requireString(obj, "psk", path),
    repoRoots: (roots as string[]).map(expandTilde),
    tmuxSession: typeof obj["tmuxSession"] === "string" ? (obj["tmuxSession"] as string) : "main",
  };
}

/** Everything `seanced` (run) needs beyond shape. Returns problems instead of throwing so doctor can list them all. */
export function runnableProblems(config: Config): readonly string[] {
  const problems: string[] = [];
  if (!/^wss?:\/\/.+/.test(config.relayUrl)) {
    problems.push(`relayUrl "${config.relayUrl}" is not a ws:// or wss:// URL`);
  }
  if (config.bearerToken === "") {
    problems.push("bearerToken is empty");
  }
  if (config.name === "") {
    problems.push("name is empty");
  }
  if (config.psk === "") {
    problems.push("psk is empty — generate 32 random bytes (base64) and paste them in");
  } else {
    try {
      const bytes = fromBase64(config.psk);
      if (bytes.byteLength !== 32) {
        problems.push(`psk decodes to ${bytes.byteLength} bytes, need 32`);
      }
    } catch {
      problems.push("psk is not valid base64");
    }
  }
  return problems;
}
