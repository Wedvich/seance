import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logPath } from "./paths.ts";
import {
  assertUnitFlag,
  conflictingScopeMessage,
  expectedSystemUnit,
  installedUnits,
  noSystemdMessage,
  pinTaskCommand,
  restartCommandFor,
  scopeChecks,
  scopeFromCgroup,
  systemUnitDeliversPsk,
  unitBunPath,
  unitContent,
  unitCredentialBlob,
  unitDeliversPsk,
  unitPath,
  unitPathEnv,
  unitPathFor,
  unitStateDirEnv,
  userInstanceMissingMessage,
  type UnitOptions,
} from "./systemd.ts";

function userUnit(bunPath = "/opt/bun", mainPath = "/repo/daemon/src/main.ts", pathEnv = "/usr/bin"): string {
  return unitContent({ scope: "user", bunPath, mainPath, pathEnv, logFile: logPath() });
}

function systemUnit(overrides: Partial<UnitOptions> = {}): string {
  return unitContent({
    scope: "system",
    user: "ada",
    bunPath: "/home/ada/.local/share/mise/shims/bun",
    mainPath: "/home/ada/repos/seance/daemon/src/main.ts",
    pathEnv: "/home/ada/.local/share/mise/shims:/usr/bin",
    logFile: "/home/ada/.local/state/seance/seanced.log",
    credentialBlob: "/home/ada/.local/state/seance/psk.cred",
    ...overrides,
  });
}

describe("unitContent, user scope", () => {
  test("runs the checkout via the bun it is given, with captured PATH and the shared log file", () => {
    const unit = userUnit("/opt/bun", "/repo/daemon/src/main.ts", "/usr/bin:/mnt/c/Windows/system32");
    expect(unit).toContain('ExecStart="/opt/bun" "/repo/daemon/src/main.ts"');
    expect(unit).toContain('Environment="PATH=/usr/bin:/mnt/c/Windows/system32"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`StandardOutput=append:${logPath()}`);
    expect(unit).toContain(`StandardError=append:${logPath()}`);
    expect(unit).toContain("WantedBy=default.target");
  });

  test("carries nothing system-scoped: no User=, no delivered credential", () => {
    const unit = userUnit();
    expect(unit).not.toContain("User=");
    expect(unit).not.toContain("LoadCredentialEncrypted=");
    expect(unit).not.toContain("SEANCE_STATE_DIR");
  });

  test("escapes % so systemd specifiers stay literal", () => {
    const unit = userUnit("/opt/bun", "/repo/main.ts", "/path/with%h");
    expect(unit).toContain("/path/with%%h");
    expect(unit).not.toContain("PATH=/path/with%h");
  });
});

describe("unitContent, system scope", () => {
  test("the three fields a system unit must differ in, and the delivered credential", () => {
    const unit = systemUnit();
    expect(unit).toContain("User=ada");
    expect(unit).toContain("LoadCredentialEncrypted=seance-psk:/home/ada/.local/state/seance/psk.cred");
    // `always`, not `on-failure`: selfRestart exits 0 here and the supervisor's
    // policy is the only thing that brings the box back.
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("StandardOutput=append:/home/ada/.local/state/seance/seanced.log");
    expect(unit).not.toContain(`append:${logPath()}`);
  });

  test("no blob, no delivery line — a credential systemd can't load fails the unit at start", () => {
    expect(systemUnit({ credentialBlob: undefined })).not.toContain("LoadCredentialEncrypted=");
  });

  test("SEANCE_STATE_DIR only when the state dir isn't the default for that home", () => {
    expect(systemUnit()).not.toContain("SEANCE_STATE_DIR");
    expect(systemUnit({ stateDirEnv: "/srv/seance" })).toContain('Environment="SEANCE_STATE_DIR=/srv/seance"');
  });

  test("% is doubled in every injected value, blob and log path included", () => {
    const unit = systemUnit({
      credentialBlob: "/srv/100%/psk.cred",
      logFile: "/srv/100%/seanced.log",
      stateDirEnv: "/srv/100%",
      user: "a%d",
    });
    expect(unit).toContain("LoadCredentialEncrypted=seance-psk:/srv/100%%/psk.cred");
    expect(unit).toContain("append:/srv/100%%/seanced.log");
    expect(unit).toContain('Environment="SEANCE_STATE_DIR=/srv/100%%"');
    expect(unit).toContain("User=a%%d");
  });

  test("what the generator writes is what the reader recognises", () => {
    // Drift between these two and a credential-delivered box silently stops
    // reporting its own key.
    expect(unitDeliversPsk(systemUnit())).toBe(true);
    expect(unitCredentialBlob(systemUnit())).toBe("/home/ada/.local/state/seance/psk.cred");
    expect(unitDeliversPsk(systemUnit({ credentialBlob: undefined }))).toBe(false);
    expect(unitStateDirEnv(systemUnit({ stateDirEnv: "/srv/100%" }))).toBe("/srv/100%");
  });
});

describe("assertUnitFlag", () => {
  test("a relative --state-dir is refused, before root creates it against its own cwd", () => {
    expect(() => assertUnitFlag("--state-dir", "state", true)).toThrow(/absolute/u);
    expect(() => assertUnitFlag("--state-dir", "/srv/seance", true)).not.toThrow();
  });

  test("a quote or newline is refused — the unit would malform rather than expand", () => {
    expect(() => assertUnitFlag("--path", '/bin:/o"pt')).toThrow(/quote or newline/u);
    expect(() => assertUnitFlag("--path", "/bin\nUser=root")).toThrow(/quote or newline/u);
    // % is the one hostile character the generator handles itself.
    expect(() => assertUnitFlag("--state-dir", "/srv/100%", true)).not.toThrow();
    expect(() => assertUnitFlag("--path", "/home/ada/.local/share/mise/shims:/usr/bin")).not.toThrow();
  });
});

describe("unit readers", () => {
  test("bun path and PATH round-trip both scopes, % escaping included", () => {
    expect(unitBunPath(userUnit("/opt/bun", "/repo/main.ts", "/bin"))).toBe("/opt/bun");
    expect(unitBunPath(userUnit("/opt/100%bun", "/repo/main.ts", "/bin"))).toBe("/opt/100%bun");
    expect(unitBunPath(systemUnit())).toBe("/home/ada/.local/share/mise/shims/bun");
    expect(unitPathEnv(systemUnit())).toBe("/home/ada/.local/share/mise/shims:/usr/bin");
    expect(unitPathEnv(userUnit("/opt/bun", "/repo/main.ts", "/path/with%h"))).toBe("/path/with%h");
  });

  test("null when ExecStart isn't quoted the way we write it", () => {
    expect(unitBunPath("[Service]\nExecStart=/opt/bun /repo/main.ts\n")).toBeNull();
    expect(unitPathEnv("[Service]\nExecStart=/opt/bun\n")).toBeNull();
  });
});

describe("expectedSystemUnit", () => {
  test("reproduces a unit this checkout would write, except for the checkout path", () => {
    const mine = systemUnit({ mainPath: fileURLToPath(new URL("./main.ts", import.meta.url)) });
    expect(expectedSystemUnit(mine)).toBe(mine);
  });

  test("an older or foreign definition shows up as different, not as unparseable", () => {
    const stale = systemUnit().replace("Restart=always", "Restart=on-failure");
    expect(expectedSystemUnit(stale)).not.toBe(stale);
  });

  test("null when it isn't a unit of ours to compare", () => {
    expect(expectedSystemUnit("[Service]\nExecStart=/bin/true\n")).toBeNull();
  });
});

describe("scopeFromCgroup", () => {
  // Both strings captured from a real systemd 257 box.
  test("names the scope from the slice the process sits in", () => {
    expect(scopeFromCgroup("0::/system.slice/seanced.service\n")).toBe("system");
    expect(scopeFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/seanced.service\n")).toBe(
      "user",
    );
  });

  test("null on anything else, so the caller falls back to the unit files", () => {
    expect(scopeFromCgroup("")).toBeNull();
    expect(scopeFromCgroup("0::/\n")).toBeNull();
  });
});

describe("restartCommandFor", () => {
  test("a system unit needs root, a user unit does not", () => {
    expect(restartCommandFor("system")).toBe("sudo systemctl restart seanced.service");
    expect(restartCommandFor("user")).not.toContain("sudo");
  });
});

describe("pin task", () => {
  test("boots the distro with no console window and pins the VM", () => {
    expect(pinTaskCommand("Ubuntu")).toBe("conhost.exe --headless wsl.exe -d Ubuntu --exec sleep infinity");
  });
});

describe("preflight messages", () => {
  test("missing user instance names linger on both platforms, WSL cause only on WSL", () => {
    const wsl = userInstanceMissingMessage(true, "ada");
    const linux = userInstanceMissingMessage(false, "ada");
    for (const msg of [wsl, linux]) {
      expect(msg).toContain("sudo loginctl enable-linger ada");
      expect(msg).toContain("re-run `seanced install`");
    }
    expect(wsl).toContain("don't register with logind");
    expect(linux).toContain("headless box");
    expect(linux).not.toContain("WSL");
  });

  test("no systemd points WSL at wsl.conf and plain Linux at a manual supervisor", () => {
    expect(noSystemdMessage(true)).toContain("[boot] systemd=true");
    expect(noSystemdMessage(false)).toContain("your own supervisor");
    expect(noSystemdMessage(false)).not.toContain("wsl");
  });
});
describe("unitPathFor", () => {
  test("the XDG systemd user directory, or /etc for the system manager", () => {
    expect(unitPath()).toMatch(/\/systemd\/user\/seanced\.service$/u);
    expect(unitPathFor("user")).toBe(unitPath());
    expect(unitPathFor("system")).toBe("/etc/systemd/system/seanced.service");
  });
});

describe("systemUnitDeliversPsk", () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function unitFile(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "seance-unit-"));
    cleanups.push(dir);
    const path = join(dir, "seanced.service");
    await writeFile(path, body);
    return path;
  }

  test("no system unit — the user-unit boxes, which is most of them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-unit-"));
    cleanups.push(dir);
    expect(await systemUnitDeliversPsk(join(dir, "seanced.service"))).toBe(false);
  });

  test("recognises the delivery line docs/platform-notes.md prescribes", async () => {
    const path = await unitFile(
      "[Service]\nUser=me\nLoadCredentialEncrypted=seance-psk:/home/me/.local/state/seance/psk.cred\n",
    );
    expect(await systemUnitDeliversPsk(path)).toBe(true);
  });

  test("a system unit that delivers nothing, or delivers under another id, does not count", async () => {
    expect(await systemUnitDeliversPsk(await unitFile("[Service]\nUser=me\nExecStart=/bin/true\n"))).toBe(false);
    expect(await systemUnitDeliversPsk(await unitFile("[Service]\nLoadCredentialEncrypted=other:/tmp/x\n"))).toBe(
      false,
    );
    expect(unitCredentialBlob("[Service]\nLoadCredentialEncrypted=other:/tmp/x\n")).toBeNull();
  });

  test("installedUnits reports each file it was pointed at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-unit-"));
    cleanups.push(dir);
    const user = join(dir, "user.service");
    const system = join(dir, "system.service");
    const absent = join(dir, "absent.service");
    await writeFile(user, "[Service]\n");
    await writeFile(system, "[Service]\n");

    expect(installedUnits(absent, absent)).toEqual({ user: false, system: false });
    expect(installedUnits(user, absent)).toEqual({ user: true, system: false });
    expect(installedUnits(absent, system)).toEqual({ user: false, system: true });
    expect(installedUnits(user, system)).toEqual({ user: true, system: true });
  });
});

const messages = (checks: readonly { readonly message: string }[]): string => checks.map((c) => c.message).join("\n");

describe("scopeChecks", () => {
  const clean = { unitText: null, expectedUnit: null, blobPath: null } as const;

  test("no unit at all keeps pointing at `seanced install`", async () => {
    const checks = await scopeChecks({ user: false, system: false }, false, clean);
    expect(messages(checks)).toContain("run `seanced install`");
  });

  test("an active user unit reads as it always did", async () => {
    const checks = await scopeChecks({ user: true, system: false }, true, clean);
    expect(messages(checks)).toBe("systemd unit seanced.service active");
  });

  test("an active system unit is healthy, and an inactive one points at systemctl, not at install", async () => {
    expect(messages(await scopeChecks({ user: false, system: true }, true, clean))).toContain(
      "systemd system unit seanced.service active",
    );
    const down = messages(await scopeChecks({ user: false, system: true }, false, clean));
    expect(down).toContain("systemctl status seanced.service");
    expect(down).not.toContain("run `seanced install`");
  });

  test("both units installed names the two-daemons hazard", async () => {
    const checks = await scopeChecks({ user: true, system: true }, true, clean);
    expect(messages(checks)).toContain("two daemons against one state dir");
    expect(messages(checks)).toContain("`seanced uninstall`");
  });

  test("a system unit whose definition drifted is reported — nothing rewrites it on its own", async () => {
    const installed = systemUnit();
    const same = await scopeChecks({ user: false, system: true }, true, {
      ...clean,
      unitText: installed,
      expectedUnit: installed,
    });
    expect(messages(same)).not.toContain("differs from what this checkout would write");

    const drifted = await scopeChecks({ user: false, system: true }, true, {
      ...clean,
      unitText: installed,
      expectedUnit: installed.replace("Restart=always", "Restart=on-failure"),
    });
    expect(messages(drifted)).toContain("sudo seanced install --system");
  });

  test("a sealed blob the unit doesn't deliver is the one silent misconfiguration left", async () => {
    const checks = await scopeChecks({ user: false, system: true }, true, {
      unitText: systemUnit({ credentialBlob: undefined }),
      expectedUnit: null,
      blobPath: "/srv/seance/psk.cred",
    });
    expect(messages(checks)).toContain("a sealed blob exists at /srv/seance/psk.cred");
    expect(messages(checks)).toContain("never handed the key");

    // …and a unit that does deliver it says nothing, whatever the blob's location.
    const delivering = await scopeChecks({ user: false, system: true }, true, {
      unitText: systemUnit(),
      expectedUnit: null,
      blobPath: "/srv/seance/psk.cred",
    });
    expect(messages(delivering)).not.toContain("never handed the key");
  });
});

describe("conflictingScopeMessage", () => {
  test("each direction names the unit in the way it is removed", () => {
    expect(conflictingScopeMessage("system", "/home/ada/.config/systemd/user/seanced.service")).toContain(
      "`seanced uninstall` as that user",
    );
    expect(conflictingScopeMessage("user", "/etc/systemd/system/seanced.service")).toContain(
      "sudo seanced uninstall --system",
    );
  });
});
