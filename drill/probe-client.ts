// Drill helper, run by bun inside the round's sandbox (copied beside probe.sh) and, for `listen`, outside it.
// Never prints file contents or secrets. Exit codes: 0 reached/ok, 3 connect refused (prints `fail:<CODE>`), 1 usage/crash.
//   connect <path>...             connect-only to each unix socket; prints `OK <path>` per reached one; exit 0 always
//   despawn <sock> <pane> [force] connect, send a Plain despawn frame, print `REACHED <ok|code>`; exit 3 when the connect fails
//   tcp <host> <port>             connect-only TCP; exit 0 reached, 3 refused
//   walk-sockets                  E1: every unix socket under / (budgeted), connect-only to each; counts + first 5 offenders
//   walk-files                    E2: regular files owned by this uid that pass access(R_OK), outside DRILL_ALLOW; counts + first 5
//   listen <logfile>              outside only: HTTP + raw TCP listeners on 127.0.0.1, prints "<httpPort> <rawPort>", logs each hit
import { appendFileSync, closeSync, lstatSync, openSync, readdirSync, realpathSync } from "node:fs";

const [mode = "", ...args] = process.argv.slice(2);

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "ERR";
}

/** Resolves the error code, or "" when it connected. Sends bytes only when `hello` is given. */
async function tryUnix(path: string, timeoutMs: number, hello?: string): Promise<{ code: string; reply: string }> {
  let reply = "";
  let settled = false;
  return new Promise((resolve) => {
    const done = (code: string): void => {
      if (settled) return;
      settled = true;
      resolve({ code, reply });
    };
    const timer = setTimeout(() => done("TIMEOUT"), timeoutMs);
    Bun.connect({
      unix: path,
      socket: {
        open(sock) {
          if (hello === undefined) {
            clearTimeout(timer);
            sock.end();
            done("");
            return;
          }
          sock.write(hello);
        },
        data(sock, chunk) {
          reply += Buffer.from(chunk).toString("utf8");
          if (reply.includes("\n")) {
            clearTimeout(timer);
            sock.end();
            done("");
          }
        },
        close() {
          clearTimeout(timer);
          done(hello === undefined || reply !== "" ? "" : "CLOSED");
        },
        error(_sock, err) {
          clearTimeout(timer);
          done(codeOf(err));
        },
        connectError(_sock, err) {
          clearTimeout(timer);
          done(codeOf(err));
        },
      },
    }).catch((err: unknown) => {
      clearTimeout(timer);
      done(codeOf(err));
    });
  });
}

async function tryTcp(host: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: string): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const timer = setTimeout(() => done("TIMEOUT"), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(sock) {
          clearTimeout(timer);
          sock.end();
          done("");
        },
        data() {},
        close() {},
        error(_s, err) {
          clearTimeout(timer);
          done(codeOf(err));
        },
        connectError(_s, err) {
          clearTimeout(timer);
          done(codeOf(err));
        },
      },
    }).catch((err: unknown) => {
      clearTimeout(timer);
      done(codeOf(err));
    });
  });
}

const BUDGET_MS = Number(process.env["DRILL_WALK_MS"] ?? "100000");
const darwin = process.platform === "darwin";

/** Never entered: pseudo filesystems, and on macOS the Data volume's own mount (its content shows through `/`). */
const SKIP = new Set<string>(darwin ? ["/dev", "/System/Volumes", "/Volumes"] : ["/proc", "/sys", "/dev"]);

function* walk(start: number): Generator<{ path: string; kind: "socket" | "file" }, { truncated: boolean }> {
  const stack = ["/"];
  while (stack.length > 0) {
    if (Date.now() - start > BUDGET_MS) return { truncated: true };
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP.has(path)) stack.push(path);
      } else if (entry.isSocket()) {
        yield { path, kind: "socket" };
      } else if (entry.isFile()) {
        yield { path, kind: "file" };
      }
    }
  }
  return { truncated: false };
}

const first5 = (items: readonly string[]): string => items.slice(0, 5).join(",");

async function main(): Promise<number> {
  if (mode === "connect") {
    for (const path of args) {
      const result = await tryUnix(path, 2000);
      if (result.code === "") console.log(`OK ${path}`);
    }
    return 0;
  }
  if (mode === "despawn") {
    const [sock, pane, force] = args;
    if (sock === undefined || pane === undefined) return 1;
    const frame = {
      id: "drill",
      ts: Date.now(),
      op: "despawn",
      payload: { id: pane, ...(force === "force" ? { force: true } : {}), client: "drill" },
    };
    const result = await tryUnix(sock, 4000, `${JSON.stringify(frame)}\n`);
    if (result.code === "") {
      let verdict = "reply";
      try {
        const parsed = JSON.parse(result.reply.trim()) as { payload?: { ok?: boolean; code?: string } };
        verdict = parsed.payload?.ok === true ? "ok" : (parsed.payload?.code ?? "refused");
      } catch {
        // an unparseable reply still means the connect went through
      }
      console.log(`REACHED ${verdict}`);
      return 0;
    }
    if (result.code === "CLOSED" || result.code === "TIMEOUT") {
      console.log(`REACHED-ish ${result.code}`);
      return 0;
    }
    console.log(`fail:${result.code}`);
    return 3;
  }
  if (mode === "tcp") {
    const [host = "127.0.0.1", port = "0"] = args;
    const code = await tryTcp(host, Number(port), 3000);
    if (code === "") {
      console.log("REACHED");
      return 0;
    }
    console.log(`fail:${code}`);
    return 3;
  }
  if (mode === "walk-sockets") {
    const start = Date.now();
    const allowed = [process.env["SEANCE_CUSTODIAN_SOCKET"] ?? "", process.env["TMPDIR"] ?? ""].filter(
      (value) => value !== "",
    );
    const found: string[] = [];
    const gen = walk(start);
    let step = gen.next();
    while (!step.done) {
      if (step.value.kind === "socket") found.push(step.value.path);
      step = gen.next();
    }
    const truncated = step.value.truncated;
    const reached: string[] = [];
    const permitted: string[] = [];
    const queue = [...found];
    const worker = async (): Promise<void> => {
      for (;;) {
        const path = queue.pop();
        if (path === undefined) return;
        const forms = darwin ? [path, `/System/Volumes/Data${path}`] : [path];
        for (const form of forms) {
          const result = await tryUnix(form, 1500);
          if (result.code !== "") continue;
          const ok = allowed.some((a) => form === a || form.startsWith(a.endsWith("/") ? a : `${a}/`));
          (ok ? permitted : reached).push(form);
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, () => worker()));
    console.log(
      `socks=${found.length} reached_offending=${reached.length} reached_allowed=${permitted.length} truncated=${truncated} first=${first5(reached.sort())}`,
    );
    return 0;
  }
  if (mode === "walk-files") {
    const start = Date.now();
    const uid = process.getuid?.() ?? -1;
    const allow = (process.env["DRILL_ALLOW"] ?? "")
      .split(":")
      .filter((value) => value !== "")
      .flatMap((value) => {
        try {
          return [value, realpathSync(value)];
        } catch {
          return [value];
        }
      });
    const inAllow = (path: string): boolean => allow.some((a) => path === a || path.startsWith(`${a}/`));
    const readable: string[] = [];
    const sensitive: string[] = [];
    const buckets = new Map<string, number>();
    // The roots the macOS masks name (and, on Linux, everything outside the system dirs): a readable file here is the real hole.
    const MASKED = darwin
      ? ["/Users", "/opt", "/usr/local", "/private/tmp", "/private/var/folders", "/private/var/tmp", "/Library/Keychains", "/Volumes", "/tmp", "/var/tmp", "/var/folders"]
      : [];
    const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/proc", "/dev", "/sys"];
    const isSensitive = (path: string): boolean =>
      darwin
        ? MASKED.some((m) => path === m || path.startsWith(`${m}/`))
        : !SYSTEM.some((m) => path === m || path.startsWith(`${m}/`));
    let scanned = 0;
    let owned = 0;
    const gen = walk(start);
    let step = gen.next();
    while (!step.done) {
      const { path, kind } = step.value;
      step = gen.next();
      if (kind !== "file") continue;
      scanned += 1;
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue;
      }
      if (info.uid !== uid) continue;
      owned += 1;
      if (inAllow(path)) continue;
      // A real open for read (never a read of the bytes): access(2) is not what the sandbox's file-read rule answers.
      try {
        closeSync(openSync(path, "r"));
      } catch {
        continue;
      }
      readable.push(path);
      if (isSensitive(path)) sensitive.push(path);
      const key = path.split("/").slice(0, 3).join("/");
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const truncated = step.value.truncated;
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join(",");
    console.log(
      `files=${scanned} owned=${owned} readable_outside_allow=${readable.length} in_masked_roots=${sensitive.length} truncated=${truncated} top=${top} first=${first5(readable.sort())} masked_first=${first5(sensitive.sort())}`,
    );
    return 0;
  }
  if (mode === "listen") {
    const [logfile = "/dev/null"] = args;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        appendFileSync(logfile, `${Date.now()} hit ${new URL(req.url).host}\n`);
        return new Response("drill-listener\n");
      },
    });
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(sock) {
          appendFileSync(logfile, `${Date.now()} raw-connect\n`);
          sock.end();
        },
        data() {},
        close() {},
        error() {},
      },
    });
    console.log(`${server.port} ${raw.port}`);
    await new Promise(() => {});
    return 0;
  }
  console.error("usage: probe-client.ts connect|despawn|tcp|walk-sockets|walk-files|listen ...");
  return 1;
}

process.exit(await main());
