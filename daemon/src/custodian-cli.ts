import { stat, writeFile } from "node:fs/promises";
import { isRecord } from "@seance/shared";
import { CUSTODIAN_FRAME_KIND, CUSTODIAN_FRAME_VERSION, parseCustodianFrame } from "./custodian-frame.ts";
import { exchange, LocalRequestFailed, LocalUnavailable, RESTART_GRACE_MS } from "./local-client.ts";
import { custodianNotesPath, socketPath } from "./paths.ts";

/**
 * `seanced custodian <verb>`: the round's verbs (docs/custodian.md; DESIGN.md, "The custodian frame kind"). Each sends
 * one `custodian` frame to the local daemon and prints its JSON reply, which is the round's data channel — so nothing
 * here may reach `log.ts` (`daemon/test/message-layering.test.ts` walks the import closure), and the daemon decides who
 * may ask: the frame is bound by this process's pid, never by anything it says. Imported statically by `main.ts` like
 * `session-event` (the round runs its verbs many times a turn): no import here may be heavy.
 *
 * Exit 0 for an `ok` reply, 1 for a refusal (its code on stderr), 2 for a command line the CLI refuses or a daemon it
 * cannot reach.
 */

const USAGE = "usage: seanced custodian sessions | close <pane> | notes [--clear] | done";

/** `close` covers a graceful despawn, a fetch and a `gh` read; the rest answer from memory or one small write. */
const CLOSE_TIMEOUT_MS = 180_000;
const VERB_TIMEOUT_MS = 30_000;

const usage = (): void => {
  console.error(USAGE);
  process.exitCode = 2;
};

/**
 * C39's owner act: truncated here, from the owner's own shell, never through the daemon — no frame offers a round a
 * way to wipe the notes, and its sandbox cannot write the state dir. A file that is not there is left absent.
 */
async function clearNotes(): Promise<void> {
  const path = custodianNotesPath();
  if (
    !(await stat(path).then(
      () => true,
      () => false,
    ))
  ) {
    console.log("notes cleared");
    return;
  }
  await writeFile(path, "", { mode: 0o600 });
  console.log("notes cleared");
}

function frameFor(rest: readonly string[], text: () => Promise<string>): Promise<object> | null {
  const base = { v: CUSTODIAN_FRAME_VERSION, kind: CUSTODIAN_FRAME_KIND } as const;
  const [verb, ...args] = rest;
  if (verb === "sessions" && args.length === 0) return Promise.resolve({ ...base, verb });
  if (verb === "close" && args.length === 1) return Promise.resolve({ ...base, verb, pane: args[0] });
  if (verb === "notes" && args.length === 0) return text().then((body) => ({ ...base, verb, text: body }));
  if (verb === "done" && args.length === 0) return text().then((body) => ({ ...base, verb, summary: body }));
  return null;
}

export async function cmdCustodian(rest: readonly string[]): Promise<void> {
  if (rest[0] === "notes" && rest[1] === "--clear" && rest.length === 2) {
    await clearNotes().catch(() => {
      console.error("seanced custodian: could not clear the notes");
      process.exitCode = 2;
    });
    return;
  }
  const pending = frameFor(rest, () => Bun.stdin.text());
  if (pending === null) return usage();
  const frame = await pending;
  // The daemon parses it again; this one catches a pane that is not tmux's own form before a round trip.
  if (parseCustodianFrame(frame) === null) return usage();
  const verb = rest[0];
  try {
    const reply = await exchange(frame, {
      path: socketPath(),
      timeoutMs: verb === "close" ? CLOSE_TIMEOUT_MS : VERB_TIMEOUT_MS,
      timeoutText: `the daemon did not answer ${verb ?? "the verb"} in time`,
      // Only a read rides out a restart: a lost close or done may have run.
      ...(verb === "sessions" ? { restartGraceMs: RESTART_GRACE_MS } : {}),
    });
    console.log(JSON.stringify(reply));
    if (isRecord(reply) && reply["ok"] === true) return;
    const code = isRecord(reply) && typeof reply["code"] === "string" ? reply["code"] : "unknown";
    console.error(`seanced custodian: refused ${code}`);
    process.exitCode = 1;
  } catch (err) {
    console.error(
      err instanceof LocalUnavailable
        ? "seanced custodian: the daemon is not running"
        : `seanced custodian: ${err instanceof LocalRequestFailed ? err.message : "the request failed"}`,
    );
    process.exitCode = 2;
  }
}
