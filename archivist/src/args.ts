export type Command =
  | { readonly kind: "run" }
  | { readonly kind: "status" }
  | { readonly kind: "help" }
  | { readonly kind: "install"; readonly user?: string; readonly pathEnv?: string }
  | { readonly kind: "uninstall" }
  | { readonly kind: "update"; readonly requested: boolean };

/** A usage error, as opposed to one the command itself raised: main prints the usage for it. */
export class UsageError extends Error {}

/**
 * The command line, parsed whole before anything runs. `install` and `uninstall`
 * exist only as `--system` (the key comes only from a system unit's credential),
 * so the flag is required rather than implied: the daemon's bare `install` means
 * a user unit, and the two must not read alike.
 */
export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  switch (command) {
    case "run":
    case "status":
      noArgs(command, rest);
      return { kind: command };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "install":
      return parseInstall(rest);
    case "uninstall":
      if (rest.length !== 1 || rest[0] !== "--system") throw new UsageError("usage: uninstall --system");
      return { kind: "uninstall" };
    case "update":
      if (rest.length === 0) return { kind: "update", requested: false };
      if (rest.length === 1 && rest[0] === "--requested") return { kind: "update", requested: true };
      throw new UsageError("usage: update");
    default:
      throw new UsageError(command === undefined ? "no command" : `unknown command ${JSON.stringify(command)}`);
  }
}

function noArgs(command: string, rest: readonly string[]): void {
  if (rest.length > 0) throw new UsageError(`${command} takes no arguments`);
}

function parseInstall(rest: readonly string[]): Command {
  let system = false;
  let user: string | undefined;
  let pathEnv: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--system") {
      system = true;
      continue;
    }
    if (arg === "--user" || arg === "--path") {
      const value = rest[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      if (arg === "--user") user = value;
      else pathEnv = value;
      continue;
    }
    throw new UsageError(`install: unknown argument ${JSON.stringify(arg)}`);
  }
  if (!system) {
    throw new UsageError("install takes --system: the archivist runs only as a systemd system unit (docs/psk.md)");
  }
  return {
    kind: "install",
    ...(user === undefined ? {} : { user }),
    ...(pathEnv === undefined ? {} : { pathEnv }),
  };
}
