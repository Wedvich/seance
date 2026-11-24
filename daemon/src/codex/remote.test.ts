import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRemoteSlot,
  parseRemoteRecord,
  parseRemoteStatus,
  readRemote,
  removeRemote,
  writeRemote,
  type RemoteStatus,
  type SlotMember,
} from "./remote.ts";

const record = { v: 1, environmentId: "env_b_1", clients: ["cli_a"], at: 5 } as const;

describe("remote.json", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "seance-remote-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("parses strictly: a client, ids in a closed alphabet, nothing else kept", () => {
    expect(parseRemoteRecord({ ...record, extra: 1 })).toEqual(record);
    expect(parseRemoteRecord({ ...record, clients: [] })).toBeNull();
    expect(parseRemoteRecord({ ...record, clients: ["cli a"] })).toBeNull();
    expect(parseRemoteRecord({ ...record, environmentId: "env/../x" })).toBeNull();
    expect(parseRemoteRecord({ ...record, v: 2 })).toBeNull();
    expect(parseRemoteRecord({ ...record, at: -1 })).toBeNull();
    expect(parseRemoteRecord({ ...record, clients: Array.from({ length: 17 }, (_, i) => `cli_${i}`) })).toBeNull();
  });

  test("round-trips, reads unpaired when gone, unparseable or a symlink", async () => {
    const path = join(dir, "remote.json");
    await writeRemote(record, path);
    expect(await readRemote(path)).toEqual(record);
    await removeRemote(path);
    expect(await readRemote(path)).toBeNull();
    await removeRemote(path);
    await writeFile(path, "{not json");
    expect(await readRemote(path)).toBeNull();
    const target = join(dir, "elsewhere.json");
    await writeFile(target, JSON.stringify(record));
    const link = join(dir, "link.json");
    await symlink(target, link);
    expect(await readRemote(link)).toBeNull();
  });

  test("a status keeps its state and environment, refusing an unknown state or a bad id", () => {
    expect(parseRemoteStatus({ status: "connected", serverName: "x", environmentId: "env_1" })).toEqual({
      status: "connected",
      environmentId: "env_1",
    });
    expect(parseRemoteStatus({ status: "disabled", environmentId: null })).toEqual({
      status: "disabled",
      environmentId: null,
    });
    expect(parseRemoteStatus({ status: "on", environmentId: null })).toBeNull();
    expect(parseRemoteStatus({ status: "connected", environmentId: "a b" })).toBeNull();
  });
});

/** A fake fleet of servers: which are enabled, every call in order. */
function servers(opts: { readonly refuse?: readonly string[] } = {}) {
  const enabled = new Set<string>();
  const calls: string[] = [];
  const control = async (runDir: string, method: "remoteControl/enable" | "remoteControl/disable") => {
    calls.push(`${method === "remoteControl/enable" ? "enable" : "disable"} ${runDir}`);
    if (method === "remoteControl/disable") {
      enabled.delete(runDir);
      return { status: "disabled", environmentId: null } satisfies RemoteStatus;
    }
    if (opts.refuse?.includes(runDir) === true) return null;
    enabled.add(runDir);
    return { status: "connected", environmentId: "env_1" } satisfies RemoteStatus;
  };
  return { enabled, calls, control };
}

const member = (paneId: string, level: SlotMember["level"]): SlotMember => ({ paneId, runDir: `run-${paneId}`, level });

describe("the remote-control slot", () => {
  test("goes to the first session, passes on when it ends, and a checkpoint session takes it from an auto one", async () => {
    const fleet = servers();
    const slot = createRemoteSlot({ paired: () => true, control: fleet.control });
    slot.join(member("a", "auto"));
    slot.join(member("b", "auto"));
    await slot.settled();
    expect(slot.holder()).toBe("a");
    expect([...fleet.enabled]).toEqual(["run-a"]);

    slot.join(member("c", "checkpoint"));
    await slot.settled();
    expect(slot.holder()).toBe("c");
    expect([...fleet.enabled]).toEqual(["run-c"]);

    // Another checkpoint session never takes it from one.
    slot.join(member("d", "checkpoint"));
    await slot.settled();
    expect(slot.holder()).toBe("c");

    slot.leave("c");
    await slot.settled();
    expect(slot.holder()).toBe("d");
    expect([...fleet.enabled]).toEqual(["run-d"]);

    slot.leave("d");
    await slot.settled();
    expect(slot.holder()).toBe("a");
    slot.leave("a");
    slot.leave("b");
    await slot.settled();
    expect(slot.holder()).toBeNull();
    expect(fleet.enabled.size).toBe(0);
  });

  test("unpaired, it is never offered; paired later, it is; unpaired again, it is taken back", async () => {
    const fleet = servers();
    let paired = false;
    const slot = createRemoteSlot({ paired: () => paired, control: fleet.control });
    slot.join(member("a", "checkpoint"));
    await slot.settled();
    expect(slot.holder()).toBeNull();
    expect(fleet.calls).toEqual([]);

    paired = true;
    slot.reconcile();
    await slot.settled();
    expect(slot.holder()).toBe("a");

    paired = false;
    slot.reconcile();
    await slot.settled();
    expect(slot.holder()).toBeNull();
    expect(fleet.enabled.size).toBe(0);
  });

  test("a server that refuses is skipped while it lives", async () => {
    const fleet = servers({ refuse: ["run-a"] });
    const slot = createRemoteSlot({ paired: () => true, control: fleet.control });
    slot.join(member("a", "checkpoint"));
    slot.join(member("b", "auto"));
    await slot.settled();
    expect(slot.holder()).toBe("b");
    slot.reconcile();
    await slot.settled();
    expect(fleet.calls.filter((c) => c === "enable run-a")).toHaveLength(1);
  });

  test("a re-join already enabled keeps the slot without a call; a second one enabled is turned off", async () => {
    const fleet = servers();
    const slot = createRemoteSlot({ paired: () => true, control: fleet.control });
    slot.join(member("a", "auto"), true);
    slot.join(member("b", "auto"), true);
    await slot.settled();
    expect(slot.holder()).toBe("a");
    expect(fleet.calls).toEqual(["disable run-b"]);
  });

  test("stop forgets every member without touching a server", async () => {
    const fleet = servers();
    const slot = createRemoteSlot({ paired: () => true, control: fleet.control });
    slot.join(member("a", "auto"));
    await slot.settled();
    slot.stop();
    slot.leave("a");
    await slot.settled();
    expect(slot.holder()).toBeNull();
    expect(fleet.calls).toEqual(["enable run-a"]);
  });
});
