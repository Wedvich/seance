import type { EngineInterface, Register } from "claude-code";

/**
 * Throwaway spike mod: delivers text into a live session three ways, driven by a
 * control file the test harness writes (`$SPIKE_DIR/ctl`, one JSON object), and
 * logs what the engine did to `$SPIKE_DIR/log.jsonl`. Not shipped, not installed.
 *
 * ctl ops:
 *   {"op":"submit","text":…}  $.prompt.submit
 *   {"op":"append","text":…}  $.session.append (user-role row)
 *   {"op":"inbox","text":…}   queue a message for read_messages; every later tool
 *                             result carries a "1 unread message" notice while it waits
 *   {"op":"fetch"}            $.http.fetch over $SPIKE_DIR/peer.sock
 *   {"op":"spawn"}            $.process.spawn of a bun client dialing that socket
 */

let dir = "";
const lines: string[] = [];
const inbox: string[] = [];

async function log($: EngineInterface, entry: Record<string, unknown>): Promise<void> {
  if (dir === "") return;
  lines.push(JSON.stringify({ t: new Date().toISOString(), ...entry }));
  await $.fs.write(`${dir}/log.jsonl`, `${lines.join("\n")}\n`);
}

async function poll($: EngineInterface): Promise<void> {
  const raw = await $.fs.read(`${dir}/ctl`).catch(() => "");
  if (typeof raw !== "string" || raw.trim() === "") return;
  await $.fs.write(`${dir}/ctl`, "");
  const cmd = JSON.parse(raw) as { op: string; text?: string };
  await log($, { ctl: cmd.op });
  const text = cmd.text ?? "";
  try {
    if (cmd.op === "submit") {
      const res = await $.prompt.submit({ text });
      await log($, { submitResolved: res });
    } else if (cmd.op === "append") {
      const res = await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
      await log($, { appendResolved: res });
    } else if (cmd.op === "inbox") {
      inbox.push(text);
    } else if (cmd.op === "fetch") {
      const res = await $.http.fetch("http://peer/", { socketPath: `${dir}/peer.sock` });
      await log($, { fetch: res.status, body: res.text });
    } else if (cmd.op === "spawn") {
      const stream = $.process.spawn({ argv: ["bun", `${dir}/client.ts`, `${dir}/peer.sock`] });
      let out = "";
      for await (const chunk of stream) out += chunk.text;
      await log($, { spawnOut: out, spawnEnd: await stream.result });
    }
  } catch (err) {
    await log($, { error: String(err) });
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    dir = (await $.env.get("SPIKE_DIR")) ?? "";
    if (dir === "") return result;
    const reg = await $.tool.register({
      name: "read_messages",
      description: "Returns messages waiting for this session, oldest first, and clears them.",
    });
    await log($, { started: true, tool: reg, pid: await $.env.get("SPIKE_MARK") });
    $.clock.every(500, () => poll($));
    return result;
  });

  on("tool.call", async ($, e, next) => {
    if (e.tool === "mcp__text-in__read_messages") {
      const msgs = inbox.splice(0);
      await log($, { readMessages: msgs.length });
      return { result: msgs.length === 0 ? "No messages." : msgs.map((m, i) => `${i + 1}. ${m}`).join("\n") };
    }
    const res = await next(e);
    if (inbox.length === 0 || "deny" in res) return res;
    await log($, { notice: inbox.length, after: e.tool });
    return { ...res, context: [...(res.context ?? []), `${inbox.length} unread message, call read_messages`] };
  });

  on("session.append", async ($, e, next) => {
    if (e.door === "note") await log($, { appendHook: e.door, origin: e.origin });
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    await log($, { submitHook: e.origin, turnId: e.turnId ?? null, isMeta: e.isMeta ?? false });
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) await log($, { turnStart: e.turnId });
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) await log($, { turnComplete: true });
    return next(e);
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    await log($, { classic: "UserPromptSubmit" });
    return next(e);
  });

  on("classic.PreToolUse", async ($, e, next) => {
    await log($, { classic: "PreToolUse" });
    return next(e);
  });
};
