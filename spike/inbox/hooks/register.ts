import type { EngineInterface, Register } from "claude-code";

/**
 * Throwaway spike-2 mod (docs/messaging.md §1, "Spike before PR 1"). Not shipped, not installed.
 * Named `inbox` so the model reads its pushes as "The inbox plugin sent a message", as the spec
 * wants. Driven by env, logs to `$SPIKE_DIR/log-<start ms>.jsonl` (one file per process, so a
 * `--resume` in the same pane does not overwrite the first process's log):
 *
 *   SPIKE_HOLD=1     at session.start, `$.process.spawn` `bun $SPIKE_DIR/hold-client.ts
 *                    $SPIKE_DIR/hold.sock` and log every stdout/stderr chunk and the end (check 1)
 *   SPIKE_COMPOSE=1  a `prompt.compose` hook appends one `session` section carrying a codeword
 *                    (check 2); each run is logged
 *   always           registers `read_messages`; ctl ops `inbox` (queue a message) and `submit`
 *                    (`$.prompt.submit`) via `$SPIKE_DIR/ctl`, polled every 500 ms (check 3)
 */

const started = Date.now();
let dir = "";
const lines: string[] = [];
const inbox: string[] = [];
let composeRuns = 0;

const COMPOSE_SECTION =
  "Inbox plugin check: if anyone asks for the inbox codeword, it is HERON-7316. Never say it otherwise.";

async function log($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  if (dir === "") return;
  lines.push(JSON.stringify({ t: new Date().toISOString(), ...entry }));
  await $.fs.write(`${dir}/log-${started}.jsonl`, `${lines.join("\n")}\n`);
}

async function poll($: EngineInterface): Promise<void> {
  const raw = await $.fs.read(`${dir}/ctl`).catch(() => "");
  if (typeof raw !== "string" || raw.trim() === "") return;
  await $.fs.write(`${dir}/ctl`, "");
  const cmd = JSON.parse(raw) as { op: string; text?: string };
  await log($, { ctl: cmd.op });
  try {
    if (cmd.op === "submit") await log($, { submitResolved: await $.prompt.submit({ text: cmd.text ?? "" }) });
    else if (cmd.op === "inbox") inbox.push(cmd.text ?? "");
  } catch (err) {
    await log($, { error: String(err) });
  }
}

async function hold($: EngineInterface): Promise<void> {
  const child = $.process.spawn({ argv: ["bun", `${dir}/hold-client.ts`, `${dir}/hold.sock`] });
  await log($, { holdSpawned: true });
  try {
    for await (const { stream, text } of child) await log($, { chunk: stream, text });
    await log($, { holdEnded: await child.result });
  } catch (err) {
    await log($, { holdError: String(err) });
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    dir = (await $.env.get("SPIKE_DIR")) ?? "";
    if (dir === "") return result;
    const reg = await $.tool.register({
      name: "read_messages",
      description: "Returns messages other sessions sent this session, oldest first, and clears them.",
    });
    await log($, { started: true, sessionId: await $.session.id(), tool: reg });
    $.clock.every(500, () => poll($));
    if ((await $.env.get("SPIKE_HOLD")) === "1") void hold($);
    return result;
  });

  on("session.end", async ($, e, next) => {
    await log($, { sessionEnd: e.reason, sessionId: e.sessionId });
    return next(e);
  });

  on("prompt.compose", async ($, e, next) => {
    const res = await next(e);
    if (dir === "" || (await $.env.get("SPIKE_COMPOSE")) !== "1") return res;
    composeRuns += 1;
    await log($, { composeRun: composeRuns, model: e.model, ids: res.sections.map((s) => s.id) });
    return { sections: [...res.sections, { id: "inbox-spike", text: COMPOSE_SECTION, scope: "session" }] };
  });

  on("tool.call", async ($, e, next) => {
    if (e.tool !== "mcp__inbox__read_messages") return next(e);
    const msgs = inbox.splice(0);
    await log($, { readMessages: msgs.length });
    return { result: msgs.length === 0 ? "No messages." : msgs.join("\n\n") };
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) await log($, { turnStart: e.turnId });
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) await log($, { turnComplete: true });
    return next(e);
  });
};
