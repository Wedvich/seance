import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBase64 } from "@seance/shared";
import { loadPsk, type Config } from "../src/config.ts";
import { credentialPskPath } from "../src/credential.ts";
import { exec } from "../src/exec.ts";

/**
 * The two halves of the credential scrub, together: children must not inherit
 * `CREDENTIALS_DIRECTORY`, and the daemon must not lose it by handing it out.
 * The second is the one with teeth — `loadPsk` runs again on every config
 * reload (supervise.ts), so a scrub that mutated `process.env` instead of a
 * copy would take a credential-delivered box offline at the first reload after
 * any spawn, which is to say after roughly anything.
 */

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

const PSK = toBase64(new Uint8Array(32).fill(3));

const CONFIG: Config = {
  name: "Test box",
  relayUrl: "wss://relay.example/daemon",
  bearerToken: "token",
  psk: "",
  repoRoots: ["/tmp"],
  tmuxSession: "seance",
};

async function deliveredCredential(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seance-creds-"));
  cleanups.push(dir);
  await writeFile(join(dir, "seance-psk"), `${PSK}\n`);
  return dir;
}

describe("a delivered credential survives the daemon's own spawning", () => {
  test("the key still resolves after the spawns a reload would follow", async () => {
    const original = process.env["CREDENTIALS_DIRECTORY"];
    process.env["CREDENTIALS_DIRECTORY"] = await deliveredCredential();
    try {
      expect((await loadPsk(CONFIG))?.source).toBe("credential");

      // What the daemon actually does between reloads: git during a scan, tmux
      // when a spawn lands. Each one used to be a chance to hand the path out.
      await exec(["true"]);
      await exec(["sh", "-c", "echo scanning"]);

      const afterSpawns = await loadPsk(CONFIG);
      expect(afterSpawns?.source).toBe("credential");
      expect(afterSpawns?.psk).toBe(PSK);
      expect(credentialPskPath()).not.toBeNull();
    } finally {
      if (original === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
      else process.env["CREDENTIALS_DIRECTORY"] = original;
    }
  });

  test("no child sees the path, however deep — a shell's children included", async () => {
    const original = process.env["CREDENTIALS_DIRECTORY"];
    process.env["CREDENTIALS_DIRECTORY"] = await deliveredCredential();
    try {
      // The grandchild is the case that matters: the daemon boots the tmux
      // server, the server forks the panes, and it is the pane that would read
      // the tmpfs.
      const result = await exec(["sh", "-c", 'sh -c "echo ${CREDENTIALS_DIRECTORY-absent}"']);
      expect(result.stdout.trim()).toBe("absent");
      expect(result.exitCode).toBe(0);
    } finally {
      if (original === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
      else process.env["CREDENTIALS_DIRECTORY"] = original;
    }
  });
});
