// `seance-adapter.json`, the file an adapter's repository carries at its root (DESIGN.md, "Adapters";
// DESIGN.md, "Adapters", "Installing"), and how `seance adapter add` turns it into a `config.json` entry. The manifest
// is the adapter author's file, read on the owner's word: it may name a program on PATH or a file inside its own
// checkout, and nothing else. Log-free: `adapter-cli.ts` and `doctor` say what they say.
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ADAPTER_PROTOCOLS, isAdapterName, isRecord } from "@seance/shared";
import { ADAPTER_ARGV_LIMITS } from "./config.ts";
import { hardenedGit } from "./git-hardened.ts";

export const ADAPTER_MANIFEST = "seance-adapter.json";

const MANIFEST_MAX_BYTES = 64 * 1024;
const MANIFEST_KEYS = ["name", "protocol", "argv"] as const;

export interface AdapterManifest {
  readonly name: string;
  readonly protocol: number;
  readonly argv: readonly string[];
}

export type ManifestRead =
  | {
      readonly ok: true;
      readonly manifest: AdapterManifest;
      /** The checkout, realpath'd: what the entry's `dir` records. */
      readonly dir: string;
      /** The manifest's argv with every word naming a file in the checkout made absolute: what the entry's `argv` records. */
      readonly argv: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/** Exactly `{name, protocol, argv}`, or why not. The protocol is checked against this daemon's by `readAdapterManifest`. */
export function parseAdapterManifest(raw: unknown): AdapterManifest | string {
  if (!isRecord(raw)) return "must be a JSON object";
  const extra = Object.keys(raw).filter((key) => !(MANIFEST_KEYS as readonly string[]).includes(key));
  if (extra.length > 0)
    return `has keys this séance does not know (${extra.join(", ")}); its keys are name, protocol, argv`;
  const { name, protocol, argv } = raw;
  if (!isAdapterName(name)) return '"name" must match ^[a-z][a-z0-9-]{0,31}$';
  if (typeof protocol !== "number" || !Number.isSafeInteger(protocol) || protocol < 1) {
    return '"protocol" must be a protocol major, a whole number from 1';
  }
  const word = (w: unknown): w is string =>
    typeof w === "string" && w.length > 0 && w.length <= ADAPTER_ARGV_LIMITS.wordLength && !w.includes("\0");
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > ADAPTER_ARGV_LIMITS.words || !argv.every(word)) {
    return `"argv" must be a non-empty array of at most ${ADAPTER_ARGV_LIMITS.words} strings, each free of NUL`;
  }
  return { name, protocol, argv: [...argv] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `word` as a path inside `dir` (realpath'd), or why not: never a path that leaves the checkout, a link's target included. */
async function inside(dir: string, word: string): Promise<string | { readonly message: string }> {
  let real: string;
  try {
    real = await realpath(resolve(dir, word));
  } catch {
    return { message: `names ${JSON.stringify(word)}, which is not in the checkout` };
  }
  if (real !== dir && !real.startsWith(`${dir}${sep}`)) {
    return { message: `names ${JSON.stringify(word)}, which leads outside the checkout` };
  }
  return resolve(dir, word);
}

/**
 * Reads `<dir>/seance-adapter.json` and resolves its argv for `config.json`, since an adapter runs with its own state
 * directory as its cwd, never the checkout:
 *
 * - `argv[0]` a bare name (`bun`, `node`, `python3`) stays bare, resolved through PATH at each start; a relative path is
 *   made absolute and must be an executable file in the checkout; an absolute path is refused.
 * - Any later word that is a flag (`-…`) stays as written. One that names a file or directory in the checkout, or holds
 *   a `/`, is made absolute and must stay inside the checkout; an absolute one is refused. Any other word stays.
 */
export async function readAdapterManifest(dir: string): Promise<ManifestRead> {
  let root: string;
  try {
    root = await realpath(dir);
    if (!(await stat(root)).isDirectory()) return { ok: false, message: `${dir} is not a directory` };
  } catch {
    return { ok: false, message: `${dir} does not exist` };
  }
  const path = join(root, ADAPTER_MANIFEST);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, message: `${path} is not a file` };
    if (info.size > MANIFEST_MAX_BYTES) return { ok: false, message: `${path} is over ${MANIFEST_MAX_BYTES} bytes` };
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, message: `no ${ADAPTER_MANIFEST} in ${root} — is this an adapter's checkout?` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: `${path} is not valid JSON` };
  }
  const parsed = parseAdapterManifest(raw);
  if (typeof parsed === "string") return { ok: false, message: `${path} ${parsed}` };
  if (!(ADAPTER_PROTOCOLS as readonly number[]).includes(parsed.protocol)) {
    return {
      ok: false,
      message: `${path} names protocol ${parsed.protocol}; this séance speaks ${ADAPTER_PROTOCOLS.join(", ")} — update séance or use an adapter release at a protocol it speaks`,
    };
  }
  const argv: string[] = [];
  for (const [index, word] of parsed.argv.entries()) {
    const refuse = (why: string): ManifestRead => ({ ok: false, message: `${path}: argv[${index}] ${why}` });
    if (isAbsolute(word)) return refuse(`is an absolute path; a manifest names files inside its own checkout`);
    if (index === 0) {
      if (!word.includes("/")) {
        argv.push(word);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one word at a time, in order
      const at = await inside(root, word);
      if (typeof at !== "string") return refuse(at.message);
      try {
        // oxlint-disable-next-line no-await-in-loop -- as above
        if (!(await stat(at)).isFile()) return refuse(`names ${JSON.stringify(word)}, which is not a file`);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await access(at, constants.X_OK);
      } catch {
        return refuse(`names ${JSON.stringify(word)}, which is not executable`);
      }
      argv.push(at);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (word.startsWith("-") || (!word.includes("/") && !(await exists(join(root, word))))) {
      argv.push(word);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    const at = await inside(root, word);
    if (typeof at !== "string") return refuse(at.message);
    argv.push(at);
  }
  return { ok: true, manifest: parsed, dir: root, argv };
}

/** The checkout's `HEAD` when `dir` is in a git work tree, through the hardened git (its repo config is the author's). */
export async function checkoutCommit(dir: string): Promise<string | null> {
  try {
    const result = await hardenedGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD"], 10_000);
    const sha = result.stdout.trim();
    return result.exitCode === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
