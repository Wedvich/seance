/**
 * A `codex` stand-in for the Codex login's tests (`codexStub`, fixtures.ts): `--version`, `app-server` on stdio and
 * `login`/`logout`, each answering from a scenario file the test rewrites between probes. Like the real 0.170.0, the
 * app-server answers line by line and exits at EOF on stdin without answering what is still pending (docs/codex.md,
 * "Quota"). Every call appends what it saw to `<scenario>.calls`: argv, `CODEX_HOME`, cwd and whether
 * `CREDENTIALS_DIRECTORY` reached it.
 *
 * For a Codex session's launch (`agents/codex.ts`) it is also `app-server --listen unix://PATH`, which, as the real
 * one, listens in a 0700 directory of its own and links PATH to that socket, appending each request it takes to
 * `<scenario>.rpc`; and `resume --remote unix://PATH -- <thread>`, the TUI, which titles its pane and idles.
 *
 * With `turn` set, the first turn runs as the real 0.170.0's did in the item 7 spike: `thread/status/changed` to
 * active, `turn/started`, `account/rateLimits/updated` (to every connection, as the real server's per-thread
 * subscription would), then by `turn`: `complete` goes idle and `turn/completed`; `approval` waits on an approval,
 * sending the server request no daemon may answer; `hold` stays busy. `turn/interrupt` ends a running turn
 * `interrupted`. Each turn also announces a decoy: another thread's approval wait, which no reader may take as its own.
 * `thread/resume` subscribes its connection and answers the thread's status; on a server that has started no thread it
 * loads the one named, as the real server loads a thread from the home's store for a continuation (`resumeError`
 * answers an error instead, a store that lost it). `thread/turns/list` answers the turn. A reply to a server request
 * is logged as `(response)`.
 */
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

interface Scenario {
  readonly version?: string;
  /** `--version` exits with this instead of printing. */
  readonly versionExit?: number;
  /** The answer to `account/read`: a result or an error, as the wire carries it. */
  readonly account?: unknown;
  readonly rateLimits?: unknown;
  /** Never answer `account/rateLimits/read`: the probe's timeout ends it. */
  readonly hang?: boolean;
  /** Write this many bytes of notification lines before answering. */
  readonly flood?: number;
  readonly loginExit?: number;
  /** `--listen`'s own directory's mode (0o700 as the real one's by default): a test of the daemon's ownership check. */
  readonly listenDirMode?: number;
  /** The `codexHome` `initialize` answers, instead of the `CODEX_HOME` the server runs under. */
  readonly codexHome?: string;
  /** `thread/start` answers this error code. */
  readonly threadStartError?: number;
  /** `thread/start` answers this thread id instead of a fresh UUIDv7. */
  readonly threadId?: string;
  /** `thread/resume` answers this error code. */
  readonly resumeError?: number;
  /** `--listen` exits at once, binding nothing. */
  readonly listenExit?: number;
  /** How the first turn runs on the listening server; absent, it announces nothing. */
  readonly turn?: "complete" | "hold" | "approval";
}

const [scenarioPath = "", ...args] = process.argv.slice(2);
const scenario: Scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
appendFileSync(
  `${scenarioPath}.calls`,
  `${JSON.stringify({
    argv: args,
    codexHome: process.env["CODEX_HOME"] ?? null,
    cwd: process.cwd(),
    credentials: process.env["CREDENTIALS_DIRECTORY"] !== undefined,
  })}\n`,
);

const write = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

if (args[0] === "--version") {
  if (scenario.versionExit !== undefined) process.exit(scenario.versionExit);
  process.stdout.write(`codex-cli ${scenario.version ?? "0.170.0"}\n`);
  process.exit(0);
}

if (args[0] === "login" || args[0] === "logout") {
  process.stdout.write(`stub ${args[0]}\n`);
  process.exit(scenario.loginExit ?? 0);
}

if (args[0] === "resume") {
  // The TUI's join: titled as the real one titles its pane (its thread's name), so the pane registers. Like the real
  // one (0.170.0) it outlives a hangup: only the launch script's own `TERM` ends it.
  process.on("SIGHUP", () => undefined);
  process.stdout.write("\u001B]2;codex\u0007stub tui\n");
  setInterval(() => undefined, 60_000);
} else if (args[0] === "app-server" && args[1] === "--listen") {
  await listen(args[2] ?? "");
} else if (args[0] === "app-server") {
  await stdio();
} else {
  process.exit(2);
}

async function listen(url: string): Promise<void> {
  if (scenario.listenExit !== undefined) process.exit(scenario.listenExit);
  const link = url.replace(/^unix:\/\//u, "");
  // Short and fixed under `/tmp`, as the real `/tmp/codex-daemon-<uid>/`: a socket path has ~104 bytes on macOS.
  const own = mkdtempSync("/tmp/seance-cxstub-");
  chmodSync(own, scenario.listenDirMode ?? 0o700);
  const socket = join(own, "s.sock");
  const cleanup = (): void => {
    rmSync(own, { recursive: true, force: true });
  };
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
  process.on("exit", cleanup);
  const peers = new Set<{ send: (text: string) => unknown }>();
  const announce = (method: string, params: unknown): void => {
    for (const peer of peers) peer.send(JSON.stringify({ method, params }));
  };
  let thread = "";
  let status: { type: string; activeFlags?: string[] } = { type: "idle" };
  let turnStatus = "completed";
  const setStatus = (next: typeof status): void => {
    status = next;
    announce("thread/status/changed", { threadId: thread, status });
  };
  const endTurn = (how: string): void => {
    turnStatus = how;
    setStatus({ type: "idle" });
    announce("turn/completed", { threadId: thread, turn: { id: "turn-1", status: how } });
  };
  const runTurn = (): void => {
    if (scenario.turn === undefined) return;
    turnStatus = "inProgress";
    setStatus({ type: "active", activeFlags: [] });
    announce("turn/started", { threadId: thread, turn: { id: "turn-1", status: "inProgress" } });
    announce("thread/status/changed", {
      threadId: "019a0000-0000-7000-8000-000000000000",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    announce("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 9 } } });
    if (scenario.turn === "complete") setTimeout(() => endTurn("completed"), 50);
    if (scenario.turn === "approval") {
      setStatus({ type: "active", activeFlags: ["waitingOnApproval"] });
      for (const peer of peers) {
        peer.send(
          JSON.stringify({
            id: 900,
            method: "item/commandExecution/requestApproval",
            params: { threadId: thread, turnId: "turn-1", itemId: "i-1", command: "git commit" },
          }),
        );
      }
    }
  };
  Bun.serve({
    unix: socket,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("websocket only", { status: 400 })),
    websocket: {
      open: (ws) => {
        // Before any `thread/resume`: the real server sends a thread's status to any client, its turns only to one
        // subscribed. The stub's simplification is to subscribe the launch's connection from the start.
        if (peers.size === 0) peers.add(ws);
      },
      close: (ws) => {
        peers.delete(ws);
      },
      message: (ws, data) => {
        const message = JSON.parse(String(data));
        if (typeof message.id !== "number") return;
        appendFileSync(
          `${scenarioPath}.rpc`,
          `${JSON.stringify({ method: message.method ?? "(response)", params: message.params })}\n`,
        );
        if (message.method === undefined) return;
        const reply = (body: object): void => {
          ws.send(JSON.stringify({ id: message.id, ...body }));
        };
        if (message.method === "initialize") {
          reply({ result: { userAgent: "stub", codexHome: scenario.codexHome ?? process.env["CODEX_HOME"] ?? null } });
        } else if (message.method === "thread/start") {
          thread = scenario.threadId ?? Bun.randomUUIDv7();
          reply(
            scenario.threadStartError === undefined
              ? { result: { thread: { id: thread } } }
              : { error: { code: scenario.threadStartError, message: "stub refused" } },
          );
        } else if (message.method === "turn/start") {
          reply({ result: { turn: { id: "turn-1", status: "inProgress" } } });
          runTurn();
        } else if (message.method === "thread/resume") {
          if (scenario.resumeError !== undefined) {
            reply({ error: { code: scenario.resumeError, message: "stub refused" } });
            return;
          }
          if (thread === "") thread = String(message.params?.threadId);
          peers.add(ws);
          reply({ result: { thread: { id: message.params?.threadId, status } } });
        } else if (message.method === "thread/turns/list") {
          reply({ result: { data: [{ id: "turn-1", status: turnStatus }], nextCursor: null } });
        } else if (message.method === "turn/interrupt") {
          reply({ result: {} });
          if (turnStatus === "inProgress") endTurn("interrupted");
        } else if (message.method === "account/rateLimits/read") {
          reply(scenario.rateLimits ?? { result: null });
        } else {
          reply({ error: { code: -32601, message: "unknown" } });
        }
      },
    },
  });
  symlinkSync(socket, link);
  // Held until the pane's hangup: the real server outlives no TUI either.
  setInterval(() => undefined, 60_000);
}

async function stdio(): Promise<void> {
  // The real server announces state unprompted; a reader must skip what carries no id.
  write({ method: "remoteControl/status/changed", params: { status: "disabled" } });
  if (scenario.flood !== undefined) {
    const line = `${JSON.stringify({ method: "noise", params: { pad: "x".repeat(1000) } })}\n`;
    for (let sent = 0; sent < scenario.flood; sent += line.length) process.stdout.write(line);
  }

  const answer = (id: number, body: unknown): void => {
    write({ id, ...(typeof body === "object" && body !== null ? body : { result: body }) });
  };

  let pending = "";
  for await (const chunk of process.stdin) {
    pending += String(chunk);
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const message = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (message.method === "initialize") answer(message.id, { result: { userAgent: "stub" } });
      if (message.method === "account/read") answer(message.id, scenario.account ?? { result: null });
      if (message.method === "account/rateLimits/read" && scenario.hang !== true) {
        answer(message.id, scenario.rateLimits ?? { result: null });
      }
    }
  }
  process.exit(0);
}
