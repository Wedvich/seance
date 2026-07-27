import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliSink, spawnAudit, type AuditSink } from "./audit.ts";
import { logPath } from "./paths.ts";

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
});
