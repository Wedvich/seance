import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { exec } from "../src/exec.ts";

const WARM_FLAG = "--shim-warm";

/** Between recorded calls, and between a call's arguments: neither occurs in an argument the daemon passes. */
const CALL_SEP = "\u001E";
const ARG_SEP = "\u001F";

export interface SecurityShim {
  /** Holds the `security` shim, to go first on PATH. */
  readonly binDir: string;
  /** `PATH` with `binDir` first: a child daemon's env, or `process.env.PATH` for an in-process caller. */
  readonly path: string;
  /** Stores (or with null, deletes) the generic password `-s <service>` finds. */
  readonly set: (service: string, value: string | null) => Promise<void>;
  /** Every invocation's argv, oldest first. */
  readonly calls: () => Promise<readonly (readonly string[])[]>;
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A stand-in for macOS's `/usr/bin/security`, found through PATH as the daemon
 * finds the real one (`keychain.ts`), so keychain reads run with no keychain:
 * no unlock prompt, no developer's own items. Direct calls work the same on
 * Linux, but the daemon's own read never reaches it there (`readKeychainPsk`
 * returns null off macOS).
 * Models `find-generic-password -s <service> [-w]` only, matching on the
 * service alone (`-a` is ignored, as the daemon's read omits it); a missing
 * item exits 44 as the real one does, and any other command exits 1 rather
 * than pretend. Raycast's reader runs `/usr/bin/security` by absolute path, so
 * this cannot reach it; its tests inject `readKeychain` instead.
 *
 * Call from `beforeAll`: the script is a new file, so its first exec pays the
 * macOS scan (CLAUDE.md, Testing), which the warm-up here takes in setup.
 */
export async function makeSecurityShim(base: string): Promise<SecurityShim> {
  const dir = join(base, "security-shim");
  const binDir = join(dir, "bin");
  const items = join(dir, "items");
  const callsFile = join(dir, "calls");
  await mkdir(binDir, { recursive: true });
  await mkdir(items, { recursive: true });

  const shim = join(binDir, "security");
  await Bun.write(
    shim,
    [
      "#!/bin/bash",
      `[ "$1" = ${WARM_FLAG} ] && exit 0`,
      // Record built first, appended once: concurrent calls must not interleave. A no-arg call
      // records an empty argv, not [""].
      `rec=""; for a in "$@"; do rec="$rec$a"$'\\x1f'; done`,
      `printf '%s' "$rec"$'\\x1e' >> ${shq(callsFile)}`,
      'cmd="$1"; shift',
      'if [ "$cmd" != find-generic-password ]; then',
      '  echo "security shim: unsupported command: $cmd" >&2',
      "  exit 1",
      "fi",
      'service=""; print=0',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      // `shift; shift`, not `shift 2`: a trailing flag missing its value must end the loop, not stall it.
      '    -s) service="${2-}"; shift; shift ;;',
      "    -w) print=1; shift ;;",
      "    -a|-c|-C|-D|-G|-j|-l|-r) shift; shift ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      `item=${shq(items)}/"$service"`,
      'if [ -z "$service" ] || [ ! -f "$item" ]; then',
      '  echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2',
      "  exit 44",
      "fi",
      // `-w` prints the password and a newline; without it the real tool prints attributes.
      'if [ "$print" = 1 ]; then cat "$item"; echo; else echo "class: \\"genp\\""; fi',
      "",
    ].join("\n"),
  );
  await chmod(shim, 0o755);
  const warmed = await exec([shim, WARM_FLAG]);
  if (warmed.exitCode !== 0) throw new Error(`security shim failed to start: ${warmed.stderr}`);

  const itemPath = (service: string): string => {
    if (service === "" || service === "." || service === ".." || service.includes("/") || service.includes("\0")) {
      throw new Error(`security shim: service ${JSON.stringify(service)} cannot name an item file`);
    }
    return join(items, service);
  };

  return {
    binDir,
    path: [binDir, process.env["PATH"] ?? ""].join(delimiter),
    set: async (service, value) => {
      const path = itemPath(service);
      if (value === null) await rm(path, { force: true });
      else await writeFile(path, value);
    },
    calls: async () => {
      const record = await Bun.file(callsFile)
        .text()
        .catch(() => "");
      return record
        .split(CALL_SEP)
        .slice(0, -1)
        .map((call) => (call === "" ? [] : call.split(ARG_SEP).slice(0, -1)));
    },
  };
}
