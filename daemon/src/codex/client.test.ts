import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMessage, socketState, SOCKET_NAME } from "./client.ts";

// Under `/tmp`, never `tmpdir()`: a socket path has ~104 bytes on macOS.
let base: string;
const listeners: { stop: () => void }[] = [];

beforeAll(async () => {
  base = await mkdtemp("/tmp/seance-cxc-");
});

afterAll(async () => {
  for (const listener of listeners) listener.stop();
  await rm(base, { recursive: true, force: true });
});

let made = 0;
async function dir(mode = 0o700): Promise<string> {
  made += 1;
  const path = join(base, String(made));
  await mkdir(path);
  await chmod(path, mode);
  return path;
}

function listen(path: string): void {
  listeners.push(Bun.listen({ unix: path, socket: { data: () => undefined } }));
}

/** A run dir whose `s.sock` links to a socket in `server`, as Codex's own `--listen` lays it out. */
async function linked(server: string, target = join(server, "srv.sock")): Promise<string> {
  const run = await dir();
  await symlink(target, join(run, SOCKET_NAME));
  return run;
}

describe("socketState: only a socket this uid owns, in a directory only it can enter", () => {
  test("nothing there yet is absent, as is a link whose server has not bound", async () => {
    expect(await socketState(await dir())).toBe("absent");
    expect(await socketState(await linked(await dir()))).toBe("absent");
  });

  test("a socket bound in the run dir, or linked into a 0700 directory, is ready", async () => {
    const direct = await dir();
    listen(join(direct, SOCKET_NAME));
    expect(await socketState(direct)).toBe("ready");
    const server = await dir();
    listen(join(server, "srv.sock"));
    expect(await socketState(await linked(server))).toBe("ready");
  });

  test("refused: another uid, a looser directory, a relative link, a file, a link to a link", async () => {
    const server = await dir();
    listen(join(server, "srv.sock"));
    const uid = process.getuid?.() ?? 0;
    expect(await socketState(await linked(server), uid + 1)).toBe("refused");

    const loose = await dir(0o755);
    listen(join(loose, "srv.sock"));
    expect(await socketState(await linked(loose))).toBe("refused");

    expect(await socketState(await linked(server, "srv.sock"))).toBe("refused");

    const file = await dir();
    await writeFile(join(file, SOCKET_NAME), "");
    expect(await socketState(file)).toBe("refused");

    const hop = await linked(server);
    expect(await socketState(await linked(hop, join(hop, SOCKET_NAME)))).toBe("refused");
  });

  test("a link into a directory that is not there is refused, not waited on", async () => {
    expect(await socketState(await linked(join(base, "gone")))).toBe("refused");
  });
});

describe("parseMessage: responses only", () => {
  test("a result, and an error by its code alone", () => {
    expect(parseMessage('{"id":1,"result":{"ok":true}}')).toEqual({
      id: 1,
      answer: { kind: "result", value: { ok: true } },
    });
    const error = parseMessage('{"id":2,"error":{"code":-32600,"message":"quoted backend body"}}');
    expect(error).toEqual({ id: 2, answer: { kind: "error", code: -32600 } });
    expect(JSON.stringify(error)).not.toContain("quoted");
  });

  test("a notification, a server request (an approval the daemon never answers) and noise are none", () => {
    expect(parseMessage('{"method":"turn/started","params":{}}')).toBeNull();
    expect(parseMessage('{"id":7,"method":"item/commandExecution/requestApproval","params":{}}')).toBeNull();
    expect(parseMessage('{"id":"x","result":1}')).toBeNull();
    expect(parseMessage('{"id":3}')).toBeNull();
    expect(parseMessage("not json")).toBeNull();
  });
});
