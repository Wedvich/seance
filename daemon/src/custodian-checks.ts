import type { Check } from "./check.ts";
import { modMissing } from "./claude-mod.ts";
import type { Config } from "./config.ts";
import {
  exclaveRootExists,
  roundDirFor,
  roundDirPlanted,
  sandboxProblem,
  toolchainRefusal,
  weakerNestedNeeded,
} from "./custodian-launch.ts";
import { custodianPlatform, hostProblem, sandboxDrilled, SANDBOX_UNDRILLED } from "./custodian-seat.ts";
import { scanExclaves, type ExclaveScan } from "./exclaves.ts";
import { tildify } from "./paths.ts";
import { isDirTrusted } from "./trust.ts";

export interface CustodianCheckDeps {
  readonly scan: (home: string) => Promise<ExclaveScan>;
  readonly trusted: (dir: string, configFile: string) => Promise<boolean>;
  readonly rootExists: (root: string) => Promise<boolean>;
  readonly planted: (dir: string) => Promise<boolean>;
  readonly sandboxProblem: (platform: "darwin" | "linux") => Promise<string | null>;
  readonly weakerNested: () => Promise<boolean>;
  /** The seat's own `sandboxDrilled`; a seam so a test on any host can say the mode was drilled. */
  readonly drilled: (platform: "darwin" | "linux", weakerNested: boolean) => boolean;
  /**
   * Why the round's `seanced` would not run under the sandbox's masks, or would undo them (`toolchainProblem`: a shim
   * bun, an allow entry over a masked path), null when it is safe; given the machine's repo and exclave roots.
   */
  readonly toolchainProblem: (platform: "darwin" | "linux", rootMasks: readonly string[]) => Promise<string | null>;
  /** The exclaves whose Claude Code lacks the `session-events` mod: its frames are how the custodian's `close` sees a session. */
  readonly sessionEventsMissing: () => Promise<readonly string[]>;
  /** The exclaves whose Claude Code lacks the `inbox` mod: messaging is how the custodian's `nudge` reaches a session. */
  readonly inboxMissing: () => Promise<readonly string[]>;
}

const REAL: CustodianCheckDeps = {
  scan: scanExclaves,
  trusted: isDirTrusted,
  rootExists: exclaveRootExists,
  planted: roundDirPlanted,
  sandboxProblem,
  weakerNested: weakerNestedNeeded,
  drilled: sandboxDrilled,
  toolchainProblem: toolchainRefusal,
  sessionEventsMissing: () => modMissing("session-events"),
  inboxMissing: () => modMissing("inbox"),
};

/**
 * `seanced doctor`'s custodian section, for a machine whose config carries `custodian` (docs/custodian.md): why a
 * round would not start here, or could not close what it finds. Read-only — it never creates a round dir, which only a
 * round about to run does. The probes are the seat's own: the sandbox, the sandbox mode the containment was drilled in,
 * the toolchain the round's `seanced` needs under the masks, then each exclave's round dir and the session-events and
 * inbox mods its `close` and `nudge` need.
 */
export async function custodianChecks(o: {
  readonly config: Pick<Config, "custodian" | "repoRoots">;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly deps?: Partial<CustodianCheckDeps>;
}): Promise<readonly Check[]> {
  const deps = { ...REAL, ...o.deps };
  const platform = custodianPlatform(o.platform);
  if (platform === null) return [{ level: "fail", message: "the custodian runs only on macOS and Linux" }];
  const checks: Check[] = [];
  const problem = await deps.sandboxProblem(platform);
  if (problem !== null) checks.push({ level: "fail", message: problem });
  if (platform === "linux") {
    const nested = await deps.weakerNested();
    if (!deps.drilled(platform, nested)) checks.push({ level: "fail", message: SANDBOX_UNDRILLED });
    else if (nested) {
      checks.push({
        level: "warn",
        message:
          "/proc/sys is read-only (a container): rounds run with enableWeakerNestedSandbox — a sandboxed command can create a user namespace and undo the write denies, and the host's /proc cmdline and status stay readable",
      });
    }
  }
  const scan = await deps.scan(o.home);
  const toolchain = await deps.toolchainProblem(platform, [
    ...o.config.repoRoots,
    ...scan.exclaves.map((each) => each.root),
  ]);
  if (toolchain !== null) checks.push({ level: "fail", message: `${toolchain} — rounds refuse to start` });
  let hosts = 0;
  for (const [at, exclave] of scan.exclaves.entries()) {
    const info = scan.info[at];
    if (info === undefined || !info.authOk || info.accountId === null) {
      checks.push({ level: "warn", message: `exclave ${exclave.id}: signed out — rounds skip it` });
      continue;
    }
    const dir = roundDirFor(exclave);
    // oxlint-disable-next-line no-await-in-loop -- one small read per exclave, reported in order
    const issue = await hostProblem({ roundDirFor, ...deps }, exclave, scan.exclaves);
    if (issue === null) {
      hosts += 1;
      checks.push({ level: "ok", message: `exclave ${exclave.id}: round dir ${tildify(dir, o.home)} trusted` });
    } else if (issue === "round dir untrusted") {
      checks.push({
        level: "warn",
        message: `exclave ${exclave.id}: ${tildify(dir, o.home)} is not trusted in ${tildify(exclave.configFile, o.home)} — rounds skip it; trust it once: mkdir -p ${dir} && cd ${dir} && claude`,
      });
    } else {
      checks.push({ level: "warn", message: `exclave ${exclave.id}: ${issue} — rounds skip it` });
    }
  }
  if (hosts === 0) checks.push({ level: "fail", message: "no exclave can host a round" });
  // `close` refuses a session with no observed turn end (`unobserved`), and that frame is the mod's.
  for (const label of await deps.sessionEventsMissing()) {
    checks.push({
      level: "warn",
      message: `${label}: the session-events mod is not installed or enabled — the custodian can never close its sessions (unobserved); run \`seanced mod install\``,
    });
  }
  // `nudge` delivers through the mod's listener; without one it answers `no_listener` (C26).
  for (const label of await deps.inboxMissing()) {
    checks.push({
      level: "warn",
      message: `${label}: the inbox mod is not installed or enabled — the custodian can never nudge its sessions (no_listener); run \`seanced mod install\``,
    });
  }
  return checks;
}
