import { INBOX_FRAME_KIND, MESSAGE_FRAME_VERSION } from "./message-frame.ts";
import { socketPath } from "./paths.ts";

/**
 * `seanced inbox`: the inbox mod's listener child (docs/messaging.md, DESIGN.md "Session messages"). It dials the
 * local daemon, sends one `inbox` frame and copies everything the daemon writes to stdout, which the mod reads
 * piece by piece (a piece may hold a partial line; the mod reassembles). It holds the connection for the
 * session's life: the mod ending kills this process, and the connection closing drops the daemon's binding.
 *
 * Silent: nothing here logs, because stdout is the mod's data channel. The exit code is the mod's backoff
 * signal. 0: the daemon acked and the connection later ended (a rebind or a restart; retry soon). 3: the daemon
 * answered `unsupported` and runs no message delivery (retry rarely). 2: anything else — no daemon, a refusal, or
 * a close with no reply at all, which an older daemon (it drops the frame as malformed) and a daemon mid-update
 * look the same as, so neither is told apart from a restart.
 */

const EXIT_ACKED = 0;
const EXIT_OTHER = 2;
const EXIT_UNSUPPORTED = 3;

type FirstLine = "pending" | "acked" | "unsupported" | "other";

function classify(line: string): FirstLine {
  try {
    const reply: unknown = JSON.parse(line);
    if (typeof reply !== "object" || reply === null) return "other";
    if (Reflect.get(reply, "ok") === true) return "acked";
    return Reflect.get(reply, "code") === "unsupported" ? "unsupported" : "other";
  } catch {
    return "other";
  }
}

export async function cmdInbox(): Promise<void> {
  const decoder = new TextDecoder();
  let head = "";
  let first: FirstLine = "pending";
  /**
   * Writes are chained so none is lost or reordered, and the exit waits for the last. A mod that stops reading
   * grows this queue, but the daemon already bounds what it sends one connection (its inbox caps and rate limit).
   */
  let written: Promise<void> = Promise.resolve();
  const emit = (chunk: Buffer): void => {
    written = written.then(
      () =>
        new Promise<void>((resolve) => {
          process.stdout.write(chunk, () => resolve());
        }),
    );
  };

  const connected = await new Promise<boolean>((resolve) => {
    Bun.connect<undefined>({
      unix: socketPath(),
      socket: {
        open: (sock): void => {
          sock.write(`${JSON.stringify({ v: MESSAGE_FRAME_VERSION, kind: INBOX_FRAME_KIND })}\n`);
        },
        data: (_sock, chunk: Buffer): void => {
          if (first === "pending") {
            head += decoder.decode(chunk, { stream: true });
            const nl = head.indexOf("\n");
            if (nl !== -1) first = classify(head.slice(0, nl));
          }
          // The refusal is for the exit code; only an acked connection's lines are the mod's to read.
          if (first === "acked" || first === "pending") emit(chunk);
        },
        close: (): void => resolve(true),
        error: (): void => resolve(true),
      },
    }).catch(() => resolve(false));
  });

  await written;
  if (!connected || first === "pending" || first === "other") process.exit(EXIT_OTHER);
  process.exit(first === "unsupported" ? EXIT_UNSUPPORTED : EXIT_ACKED);
}
