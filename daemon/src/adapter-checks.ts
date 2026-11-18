// `doctor`'s "adapters" section (DESIGN.md, "Adapters", "Installing"). A moved
// checkout is a warning, never a failure: the owner chose to run that code, and new code running is what to be told of.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AdaptersView } from "./adapter-control.ts";
import { checkoutCommit, readAdapterManifest, type ManifestRead } from "./adapter-manifest.ts";
import type { Check } from "./check.ts";
import type { AdaptersConfig } from "./config.ts";

export interface AdapterCheckDeps {
  readonly which?: (program: string) => string | null;
  readonly commitOf?: (dir: string) => Promise<string | null>;
  readonly manifestOf?: (dir: string) => Promise<ManifestRead>;
  /** The running daemon's status view, when its pid is the live daemon's; null when none is. */
  readonly view?: AdaptersView | null;
}

const short = (sha: string): string => sha.slice(0, 12);

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function adapterChecks(adapters: AdaptersConfig, deps: AdapterCheckDeps = {}): Promise<readonly Check[]> {
  const which = deps.which ?? ((program: string): string | null => Bun.which(program));
  const commitOf = deps.commitOf ?? checkoutCommit;
  const manifestOf = deps.manifestOf ?? readAdapterManifest;
  const checks: Check[] = [];
  const ok = (message: string): void => void checks.push({ level: "ok", message });
  const warn = (message: string): void => void checks.push({ level: "warn", message });
  const fail = (message: string): void => void checks.push({ level: "fail", message });

  for (const [name, config] of Object.entries(adapters)) {
    const [program = ""] = config.argv;
    if (isAbsolute(program)) {
      // oxlint-disable-next-line no-await-in-loop -- one adapter at a time, printed in order
      if (await executable(program)) ok(`${name}: runs ${program}`);
      else fail(`${name}: ${program} is missing or not executable — the daemon cannot start it`);
    } else {
      const found = which(program);
      if (found === null) {
        warn(`${name}: ${program} is not on this shell's PATH — the daemon resolves it on its own PATH at each start`);
      } else {
        ok(`${name}: runs ${program} (${found} on this shell's PATH)`);
      }
    }
    for (const word of config.argv.slice(1).filter((each) => isAbsolute(each))) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      if (!(await present(word))) warn(`${name}: ${word} in its argv is gone`);
    }

    if (config.dir === undefined) {
      ok(`${name}: written by hand (no dir recorded): no manifest or commit to check`);
    } else {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const read = await manifestOf(config.dir);
      if (!read.ok) {
        warn(`${name}: ${read.message}`);
      } else if (read.manifest.name !== name) {
        warn(`${name}: its manifest now names "${read.manifest.name}" — its hello will be refused (reason=name)`);
      } else if (JSON.stringify(read.argv) !== JSON.stringify(config.argv)) {
        warn(`${name}: its manifest's argv changed since \`seance adapter add\` — run it again to take the new one`);
      }
      if (config.commit === undefined) {
        ok(`${name}: ${config.dir} was not a git checkout at add, so no commit is recorded to compare`);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const head = await commitOf(config.dir);
        if (head === null) {
          warn(`${name}: ${config.dir} is no longer a git checkout (recorded ${short(config.commit)} at add)`);
        } else if (head !== config.commit) {
          warn(
            `${name}: its checkout moved since \`seance adapter add\` (${short(config.commit)} → ${short(head)}): ` +
              `the daemon runs that code from its next start — review it, then \`seance adapter add ${config.dir}\` records it`,
          );
        } else {
          ok(`${name}: checkout at ${short(head)}, as added`);
        }
      }
    }

    const live = deps.view?.adapters[name];
    if (live?.state === "failed")
      warn(`${name}: held as failed after repeated exits — \`seance adapter restart ${name}\``);
    if (live?.state === "refused") {
      warn(
        `${name}: refused (${live.lastExit?.reason ?? "protocol"}) — fix it, then \`seance adapter restart ${name}\``,
      );
    }
  }
  return checks;
}
