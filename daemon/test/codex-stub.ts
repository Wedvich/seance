/**
 * A `codex` stand-in for the Codex login's tests (`codexStub`, fixtures.ts): `--version`, `app-server` on stdio and
 * `login`/`logout`, each answering from a scenario file the test rewrites between probes. Like the real 0.170.0, the
 * app-server answers line by line and exits at EOF on stdin without answering what is still pending (docs/codex.md,
 * "Quota"). Every call appends what it saw to `<scenario>.calls`: argv, `CODEX_HOME`, cwd and whether
 * `CREDENTIALS_DIRECTORY` reached it.
 */
import { appendFileSync, readFileSync } from "node:fs";

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

if (args[0] !== "app-server") process.exit(2);

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
