import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLogChecks, cliSink, ensureAuditLog, spawnAudit, type AuditSink } from "./audit.ts";
import { logPath } from "./paths.ts";

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
/** Only root can write a file it has no write bit on, so the unwritable cases can't be exercised as root. */
const unprivileged = process.getuid?.() !== 0;

const collected: string[] = [];
const collect: AuditSink = (line) => void collected.push(line);
const emitted = (): string => collected.join("\n");

let stateDir: string | undefined;
let realStateDir: string | undefined;
let realError: typeof console.error;
const errors: string[] = [];

beforeEach(async () => {
  collected.length = 0;
  errors.length = 0;
  realStateDir = process.env["SEANCE_STATE_DIR"];
  stateDir = await mkdtemp(join(tmpdir(), "seance-audit-"));
  process.env["SEANCE_STATE_DIR"] = stateDir;
  realError = console.error;
  console.error = (line: string): void => void errors.push(line);
});

afterEach(async () => {
  console.error = realError;
  if (realStateDir === undefined) delete process.env["SEANCE_STATE_DIR"];
  else process.env["SEANCE_STATE_DIR"] = realStateDir;
  if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
});

describe("spawn audit lines", () => {
  const audit = spawnAudit("relay", collect);

  test("the prompt is a length and a hash, never the text", async () => {
    await audit.request({ repo: "myrepo", mode: "worktree", prompt: "deploy the thing" });
    expect(emitted()).toContain("promptLen=16");
    expect(emitted()).toMatch(/promptSha=[0-9a-f]{8}/u);
    expect(emitted()).not.toContain("deploy the thing");
  });

  test("the same prompt hashes the same way, so repeats are recognisable", async () => {
    await audit.request({ repo: "myrepo", mode: "here", prompt: "same" });
    await audit.request({ repo: "myrepo", mode: "here", prompt: "same" });
    const [first, second] = collected;
    expect(first).toBe(second);
  });

  test("an absent prompt reads as none rather than as a hash of nothing", async () => {
    await audit.request({ repo: "myrepo", mode: "here" });
    expect(emitted()).toContain("prompt=none");
  });

  test("defaults are recorded as they will be applied, not as absent", async () => {
    await audit.request({ repo: "myrepo", mode: "here" });
    expect(emitted()).toContain('model="opus" effort="medium"');
  });

  test("origin separates a spawn typed at the machine from one that arrived over the relay", async () => {
    await spawnAudit("cli", collect).request({ repo: "myrepo", mode: "here" });
    await spawnAudit("relay", collect).request({ repo: "myrepo", mode: "here" });
    expect(collected[0]).toContain("origin=cli");
    expect(collected[1]).toContain("origin=relay");
  });

  test("client separates which app-role client formed the request, and stays quotable free text", async () => {
    await audit.request({ repo: "myrepo", mode: "here", client: "mcp" });
    expect(emitted()).toContain('origin=relay client="mcp" repo="myrepo"');
  });

  test("a request without a client — an older sender — carries no client field at all", async () => {
    await audit.request({ repo: "myrepo", mode: "here" });
    expect(emitted()).not.toContain("client=");
    expect(emitted()).toContain('origin=relay repo="myrepo"');
  });

  test("plan mode is recorded, so the log says which spawns started constrained", async () => {
    await audit.request({ repo: "myrepo", mode: "here", plan: true });
    expect(emitted()).toContain("plan=true");
  });

  test("a spawn that did not ask for plan mode carries no plan field at all", async () => {
    await audit.request({ repo: "myrepo", mode: "here", plan: false });
    expect(emitted()).not.toContain("plan=");
  });
});

describe("cliSink", () => {
  test("appends to the same log the daemon writes, in the daemon's format", async () => {
    await spawnAudit("cli", cliSink).request({ repo: "myrepo", mode: "here", title: "Local" });
    await spawnAudit("cli", cliSink).ok({ window: "Local", path: "/repos/myrepo" });
    const written = await Bun.file(logPath()).text();
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z info audit spawn origin=cli repo="myrepo"/mu);
    expect(written).toContain('audit spawn origin=cli ok window="Local"');
    expect(written.trimEnd().split("\n")).toHaveLength(2);
  });

  test("an unwritable log complains but does not fail the spawn the human asked for", async () => {
    process.env["SEANCE_STATE_DIR"] = "/dev/null/not-a-directory";
    await spawnAudit("cli", cliSink).request({ repo: "myrepo", mode: "here" });
    expect(errors.join("\n")).toContain("could not write the audit log");
  });

  test("a log it creates is owner-only — it records repo paths and window titles", async () => {
    await spawnAudit("cli", cliSink).request({ repo: "myrepo", mode: "here" });
    expect(await modeOf(logPath())).toBe(0o600);
  });
});

describe("ensureAuditLog", () => {
  test("creates the log 0600 before anything appends to it", async () => {
    expect(await ensureAuditLog()).toBeNull();
    expect(await modeOf(logPath())).toBe(0o600);
  });

  test("tightens the mode a service redirect left, keeping the file the daemon already holds open", async () => {
    await writeFile(logPath(), "an earlier line\n");
    await chmod(logPath(), 0o644);

    expect(await ensureAuditLog()).toBeNull();

    expect(await modeOf(logPath())).toBe(0o600);
    // Repaired in place: rotating it would strand the daemon's redirect on the old inode.
    expect(await Bun.file(logPath()).text()).toBe("an earlier line\n");
  });

  test("recovers a log left unwritable, rather than waiting for a reinstall to chown it", async () => {
    await writeFile(logPath(), "");
    await chmod(logPath(), 0o444);

    expect(await ensureAuditLog()).toBeNull();

    expect(await modeOf(logPath())).toBe(0o600);
  });

  test("degrades with a message instead of throwing when the state dir cannot exist", async () => {
    process.env["SEANCE_STATE_DIR"] = "/dev/null/not-a-directory";
    expect(await ensureAuditLog()).toContain("could not prepare the audit log");
  });
});

describe("auditLogChecks — what doctor renders", () => {
  test("says nothing at all before a log exists", async () => {
    expect(await auditLogChecks()).toEqual([]);
  });

  test.if(unprivileged)("fails on a log the owner cannot append to — the state doctor used to miss", async () => {
    await writeFile(logPath(), "");
    await chmod(logPath(), 0o444);

    const checks = await auditLogChecks();

    expect(checks[0]?.level).toBe("fail");
    expect(checks[0]?.message).toContain("spawns typed at this machine go unrecorded");
    expect(checks[0]?.message).toContain("sudo chown");
    // No size `ok` under the fail — a passing verdict on the same broken file
    // reads as re-checked-and-passed.
    expect(checks).toHaveLength(1);
  });

  test("warns while the mode is looser than 0600, naming the command that tightens it", async () => {
    await writeFile(logPath(), "");
    await chmod(logPath(), 0o644);

    const [first] = await auditLogChecks();

    expect(first?.level).toBe("warn");
    expect(first?.message).toContain("0644");
    expect(first?.message).toContain("seanced restart");
  });

  test("a writable 0600 log reports only its size", async () => {
    await ensureAuditLog();
    expect(await auditLogChecks()).toEqual([{ level: "ok", message: `log 0KB (${logPath()})` }]);
  });
});
