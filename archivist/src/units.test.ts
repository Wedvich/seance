import { describe, expect, test } from "bun:test";
import { unitBunPath, unitCredentialBlob, unitPathEnv, unitUser } from "../../daemon/src/systemd.ts";
import { ARCHIVIST_UNIT, archivistUnits, expectedArchivistUnits, UPDATE_PATH_UNIT, UPDATE_UNIT } from "./units.ts";

const OPTS = {
  user: "archivist",
  bunPath: "/home/archivist/.bun/bin/bun",
  mainPath: "/home/archivist/seance/archivist/src/main.ts",
  pathEnv: "/home/archivist/.bun/bin:/usr/bin:/bin",
  stateDir: "/home/archivist/.local/state/seance-archivist",
} as const;

describe("archivist units", () => {
  test("the service runs `run` as its user with the key delivered, and restarts on a clean exit", () => {
    const unit = archivistUnits(OPTS)[ARCHIVIST_UNIT];
    // Read back with the daemon's own parsers: one syntax for both services' units.
    expect(unitUser(unit)).toBe("archivist");
    expect(unitBunPath(unit)).toBe(OPTS.bunPath);
    expect(unit).toContain(`ExecStart="${OPTS.bunPath}" "${OPTS.mainPath}" run\n`);
    expect(unitCredentialBlob(unit)).toBe(`${OPTS.stateDir}/psk.cred`);
    expect(unitPathEnv(unit)).toBe(OPTS.pathEnv);
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("WantedBy=multi-user.target\n");
    expect(unit).not.toContain("append:");
  });

  test("the update unit runs `update --requested` as the same user and is never handed the key", () => {
    const unit = archivistUnits(OPTS)[UPDATE_UNIT];
    expect(unitUser(unit)).toBe("archivist");
    expect(unit).toContain(`"${OPTS.mainPath}" update --requested\n`);
    expect(unit).toContain("Type=oneshot\n");
    // Else a crash loop of fast skips fails the unit, and then the path unit that starts it.
    expect(unit).toContain("StartLimitIntervalSec=0\n");
    expect(unitCredentialBlob(unit)).toBeNull();
    expect(unit).not.toContain("LoadCredential");
    expect(unitPathEnv(unit)).toBe(OPTS.pathEnv);
  });

  test("the path unit watches the request file and starts the update unit", () => {
    const unit = archivistUnits(OPTS)[UPDATE_PATH_UNIT];
    expect(unit).toContain(`PathChanged=${OPTS.stateDir}/update-requested\n`);
    expect(unit).toContain(`Unit=${UPDATE_UNIT}\n`);
  });

  test("% is escaped for systemd, and a value the unit can't carry is refused", () => {
    const units = archivistUnits({ ...OPTS, pathEnv: "/opt/100%/bin:/usr/bin" });
    expect(units[ARCHIVIST_UNIT]).toContain('Environment="PATH=/opt/100%%/bin:/usr/bin"');
    expect(unitPathEnv(units[ARCHIVIST_UNIT])).toBe("/opt/100%/bin:/usr/bin");
    expect(() => archivistUnits({ ...OPTS, pathEnv: '/usr/bin"\nUser=root' })).toThrow(/no quote or newline/u);
    expect(() => archivistUnits({ ...OPTS, stateDir: "relative/state" })).toThrow(/absolute path/u);
  });
});

describe("expectedArchivistUnits", () => {
  test("rebuilds exactly the units installed from the service's own values, and sees another main.ts or a stale unit", () => {
    const units = archivistUnits(OPTS);
    expect(expectedArchivistUnits(units[ARCHIVIST_UNIT], OPTS.mainPath)).toEqual(units);
    const moved = expectedArchivistUnits(units[ARCHIVIST_UNIT], "/home/archivist/other/archivist/src/main.ts");
    expect(moved?.[ARCHIVIST_UNIT]).not.toBe(units[ARCHIVIST_UNIT]);
    expect(expectedArchivistUnits("[Service]\nUser=x\n", OPTS.mainPath)).toBeNull();
  });
});
