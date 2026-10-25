import { describe, expect, test } from "bun:test";
import {
  APP_ID,
  ENVELOPE_MAX_CT_LENGTH,
  importPsk,
  open,
  REPO_MAX_SKILLS,
  SKILL_NAME_MAX_LENGTH,
  toBase64,
  type MachineInfo,
  type RepoEntry,
} from "@seance/shared";
import { sealMachineInfo } from "./machine-info.ts";

const key = await importPsk(toBase64(new Uint8Array(32).fill(1)));

function info(repos: readonly RepoEntry[]): MachineInfo {
  return { name: "box", platform: "linux", repos, scannedAt: 1 };
}

function repo(i: number, skills?: readonly string[]): RepoEntry {
  return {
    name: `r${i}`,
    path: `/home/u/r${i}`,
    defaultBranch: "main",
    origin: `github.com/acme/r${i}`,
    ...(skills === undefined ? {} : { skills }),
  };
}

describe("sealMachineInfo", () => {
  test("a blob that fits keeps its project skills", async () => {
    const given = info([repo(0, ["ship"]), repo(1)]);
    const { sealed, droppedSkills, oversized } = await sealMachineInfo(key, "dev1", given);
    expect(droppedSkills).toBe(false);
    expect(sealed.to).toBe(APP_ID);
    expect(oversized).toBe(false);
    const plain = await open(key, sealed);
    expect(plain.op).toBe("machine-info");
    expect(plain.payload).toEqual(given);
  });

  test("past the envelope bound, every clone's project skills go and the rest still registers", async () => {
    const full = Array.from({ length: REPO_MAX_SKILLS }, (_, i) => `${i}`.padEnd(SKILL_NAME_MAX_LENGTH, "s"));
    const repos = Array.from({ length: 80 }, (_, i) => repo(i, full));
    const { sealed, droppedSkills, oversized } = await sealMachineInfo(key, "dev1", info(repos));
    expect(droppedSkills).toBe(true);
    expect(oversized).toBe(false);
    expect(sealed.ct.length).toBeLessThanOrEqual(ENVELOPE_MAX_CT_LENGTH);
    const plain = await open(key, sealed);
    expect(plain.payload).toEqual(info(Array.from({ length: 80 }, (_, i) => repo(i))));
  });

  test("over the bound with no project skills to drop is sent as is and reported oversized", async () => {
    const { sealed, droppedSkills, oversized } = await sealMachineInfo(
      key,
      "dev1",
      info(Array.from({ length: 1000 }, (_, i) => repo(i))),
    );
    expect(sealed.ct.length).toBeGreaterThan(ENVELOPE_MAX_CT_LENGTH);
    expect(droppedSkills).toBe(false);
    expect(oversized).toBe(true);
  });

  test("still over the bound after the drop is reported oversized beside droppedSkills", async () => {
    const { droppedSkills, oversized } = await sealMachineInfo(
      key,
      "dev1",
      info(Array.from({ length: 1000 }, (_, i) => repo(i, ["ship"]))),
    );
    expect(droppedSkills).toBe(true);
    expect(oversized).toBe(true);
  });
});
