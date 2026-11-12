import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitDrift } from "./self-update.ts";
import { ARCHIVIST_UNIT, archivistUnits, UPDATE_PATH_UNIT, UPDATE_UNIT } from "./units.ts";

const OPTS = {
  user: "archivist",
  bunPath: "/home/archivist/.bun/bin/bun",
  mainPath: "/home/archivist/seance/archivist/src/main.ts",
  pathEnv: "/home/archivist/.bun/bin:/usr/bin",
  stateDir: "/home/archivist/.local/state/seance-archivist",
} as const;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function installed(texts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "archivist-units-"));
  dirs.push(dir);
  await Promise.all(Object.entries(texts).map(([name, text]) => writeFile(join(dir, name), text)));
  return dir;
}

describe("unitDrift", () => {
  test("nothing differs when the installed units are what this checkout would write", async () => {
    const dir = await installed(archivistUnits(OPTS));
    expect(await unitDrift(OPTS.mainPath, dir)).toEqual([]);
  });

  test("names each installed unit the generators would now write differently", async () => {
    const units = archivistUnits(OPTS);
    const dir = await installed({
      ...units,
      [UPDATE_UNIT]: units[UPDATE_UNIT].replace("StartLimitIntervalSec=0\n", ""),
      [UPDATE_PATH_UNIT]: "[Path]\n",
    });
    expect(await unitDrift(OPTS.mainPath, dir)).toEqual([UPDATE_UNIT, UPDATE_PATH_UNIT]);
  });

  test("a missing service, or one that isn't ours, is no drift to report", async () => {
    expect(await unitDrift(OPTS.mainPath, await installed({}))).toEqual([]);
    expect(await unitDrift(OPTS.mainPath, await installed({ [ARCHIVIST_UNIT]: "[Service]\n" }))).toEqual([]);
  });
});
