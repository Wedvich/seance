import { isRecord } from "./parse.ts";
import type { SessionTag } from "./tags.ts";
import { NEEDS_INPUT_REASONS, type NeedsInputReason } from "./types.ts";

/**
 * The adapter protocol (docs/messaging.md §6.1; DESIGN.md, "Adapters"): what the daemon and an adapter, a program the
 * machine's owner names in its own `config.json`, say to each other over the adapter's stdin and stdout. The schema of
 * record: `adapter-protocol.schema.json` beside this file is generated from it (`adapterProtocolSchema`, written by
 * `bun run adapter-schema`, held equal by `adapter-protocol.test.ts`), so an adapter in any language can vendor a copy
 * at a protocol version. Séance never names a tool here, or anywhere.
 *
 * Newline-delimited JSON, one frame per line, UTF-8, at most `ADAPTER_LINE_MAX` bytes a line. The daemon writes its
 * `hello` first, the adapter answers with its own, and nothing else flows before both. `protocol` is a major number,
 * bumped only for a breaking change; additions inside a major are `features` strings, as `CAPABILITIES` are on the
 * wire. Adapters ignore unknown fields on frames they know; the daemon's parsers accept exactly their fields.
 *
 * Built so far (3a): the handshake, `snapshot`, `session`, `session-gone`, `task`, `error`, and the adapter's `resync`.
 * `deliver`, `tag`, `message`, `result` and `delivery` are 3b's: the daemon answers a `deliver` or `tag` `unsupported`.
 */

/** The protocol majors this daemon speaks. */
export const ADAPTER_PROTOCOLS = [1] as const;
export type AdapterProtocol = (typeof ADAPTER_PROTOCOLS)[number];

/** Additions inside a major this daemon offers; none yet. */
export const ADAPTER_FEATURES: readonly string[] = [];

/** One line, either way. A delivery carries at most `MESSAGE_MAX` of text (64 KiB), which JSON escaping can grow. */
export const ADAPTER_LINE_MAX = 256 * 1024;

/** An adapter's name: its `config.json` key, its `adapter.<name>.*` tag namespace and its audit `name`. */
export const ADAPTER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

/** Adapters one machine may name. */
export const ADAPTERS_MAX = 4;

export function isAdapterName(value: unknown): value is string {
  return typeof value === "string" && ADAPTER_NAME_PATTERN.test(value);
}

/** What an adapter may ask to be sent. */
export const ADAPTER_WANTS = ["sessions", "tasks", "messages"] as const;
export type AdapterWant = (typeof ADAPTER_WANTS)[number];

const FEATURE = /^[a-z][a-z0-9-]{0,63}$/u;
const FEATURES_MAX = 32;
const VERSION_MAX = 64;

/** A session's turn state as an adapter sees it; `unknown` until its first report after a daemon start. */
export const ADAPTER_SESSION_STATES = ["busy", "idle", "needs-input", "unknown"] as const;
export type AdapterSessionState = (typeof ADAPTER_SESSION_STATES)[number];

/**
 * Why a `session` record ended (review point 4): `exited` the process ended on its own (an `ended` report, a crash,
 * `/exit`), `closed` Séance closed it (a despawn, a hand-off's or a pass's close, a custodian `close`, the drain),
 * `replaced` the pane was re-tagged for another task under the same process. Display only: the `task` event says the
 * work ended.
 */
export const SESSION_GONE_REASONS = ["exited", "closed", "replaced"] as const;
export type SessionGoneReason = (typeof SESSION_GONE_REASONS)[number];

/** A task this machine launched moved: from the launch ledger and the session's own reports. */
export const ADAPTER_TASK_EVENTS = ["launched", "done", "handoff", "pass", "ended"] as const;
export type AdapterTaskEvent = (typeof ADAPTER_TASK_EVENTS)[number];

/** Where a `Session`'s `name` came from (docs/tags.md §6.1, T2). */
export const NAME_SOURCES = ["owner", "task", "self", "window"] as const;
export type NameSource = (typeof NAME_SOURCES)[number];

/**
 * One live `claude` process of this machine, as an adapter sees it. Three ids, three lifetimes: `key` the process
 * (`<pid>:<start time>`), `session.id` the conversation (`agent.session`, stable across `--resume` and a `continue_task`
 * chain), `task.id` the work. The whole record is sent on every change, never a patch.
 */
export interface AdapterSession {
  readonly key: string;
  /**
   * The conversation: `verified` only from the daemon's own sources; `conflict` while another live process claims the
   * same id. Absent until a conversation is reported or read; a refuted claim is never sent.
   */
  readonly session?: { readonly id: string; readonly verified: boolean; readonly conflict?: true };
  /**
   * `ref` is sent for a task launched with `SpawnRequest.ref` (the scheduler's spawn, noted in the launch ledger); `title`
   * is protocol 1's but not sent: the daemon holds none for its launches.
   */
  readonly task?: {
    readonly id: string;
    readonly title?: string;
    readonly ref?: { readonly ref: string; readonly url?: string };
  };
  /** The exclave's name, never an account id. */
  readonly exclave: string;
  /** The scan-set name (`SessionEntry.repo`); absent outside every known repo. */
  readonly repo?: string;
  readonly branch?: string;
  readonly state: AdapterSessionState;
  readonly turnEnded?: true;
  readonly reason?: NeedsInputReason;
  readonly prUrl?: string;
  /** When `state` began, as this daemon saw it (for `unknown`, when the daemon first saw the process). */
  readonly since: number;
  readonly name: { readonly text: string; readonly source: NameSource };
  /** Session tags, full keys, every namespace but other adapters' `adapter.*`. */
  readonly tags: Readonly<Record<string, SessionTag>>;
}

export interface DaemonHello {
  readonly kind: "hello";
  readonly protocol: readonly AdapterProtocol[];
  readonly features: readonly string[];
  readonly machine: { readonly deviceId: string; readonly name: string };
  readonly daemon: { readonly version: string };
}

export interface SnapshotFrame {
  readonly kind: "snapshot";
  readonly sessions: readonly AdapterSession[];
}

export interface SessionFrame {
  readonly kind: "session";
  readonly session: AdapterSession;
}

export interface SessionGoneFrame {
  readonly kind: "session-gone";
  readonly key: string;
  readonly reason: SessionGoneReason;
}

export interface TaskFrame {
  readonly kind: "task";
  readonly task: string;
  readonly event: AdapterTaskEvent;
  /** On `launched` of a continuation: the task it continues. Not sent yet: the ledger does not note it. */
  readonly continues?: string;
  readonly prUrl?: string;
}

/** `invalid`: a line that did not parse. `unsupported`: a frame kind this daemon does not take yet, or not before `hello`. */
export const ADAPTER_ERROR_CODES = ["invalid", "unsupported"] as const;
export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[number];

export interface ErrorFrame {
  readonly kind: "error";
  readonly code: AdapterErrorCode;
}

export type AdapterDaemonFrame = DaemonHello | SnapshotFrame | SessionFrame | SessionGoneFrame | TaskFrame | ErrorFrame;

export interface AdapterHello {
  readonly kind: "hello";
  /** The major the adapter speaks; the daemon stops one that names none of `ADAPTER_PROTOCOLS`. */
  readonly protocol: number;
  /** Must equal its `config.json` key. */
  readonly name: string;
  readonly version: string;
  readonly wants: readonly AdapterWant[];
  readonly features: readonly string[];
}

export interface ResyncFrame {
  readonly kind: "resync";
}

export type AdapterFrame = AdapterHello | ResyncFrame;

/** Frame kinds protocol 1 defines from the adapter that this daemon does not take yet (3b). */
const LATER_KINDS: ReadonlySet<string> = new Set(["deliver", "tag"]);

export type AdapterLine =
  | { readonly ok: true; readonly frame: AdapterFrame }
  | { readonly ok: false; readonly code: AdapterErrorCode };

const hasOnly = (raw: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(raw).every((key) => keys.includes(key));

const isStringList = (raw: unknown, ok: (value: string) => boolean, max: number): raw is readonly string[] =>
  Array.isArray(raw) && raw.length <= max && raw.every((v) => typeof v === "string" && ok(v));

function parseHello(raw: Record<string, unknown>): AdapterHello | null {
  if (!hasOnly(raw, ["kind", "protocol", "name", "version", "wants", "features"])) return null;
  const { protocol, name, version, wants, features } = raw;
  // Any integer: a major this daemon does not speak is a refusal (`protocol`), not a malformed line.
  if (typeof protocol !== "number" || !Number.isSafeInteger(protocol) || protocol < 1) return null;
  if (typeof name !== "string" || name.length > 64) return null;
  if (typeof version !== "string" || version === "" || version.length > VERSION_MAX) return null;
  const want = (v: string): boolean => (ADAPTER_WANTS as readonly string[]).includes(v);
  if (!isStringList(wants, want, ADAPTER_WANTS.length) || new Set(wants).size !== wants.length) return null;
  if (!isStringList(features, (v) => FEATURE.test(v), FEATURES_MAX)) return null;
  return {
    kind: "hello",
    protocol,
    name,
    version,
    wants: wants.filter((v): v is AdapterWant => want(v)),
    features: [...features],
  };
}

/**
 * One line from an adapter: parsed into a fresh value by the frame's own rule, exact fields only. `unsupported` for a
 * kind protocol 1 defines that this daemon does not take yet; `invalid` for anything else, an unknown kind included.
 */
export function parseAdapterLine(line: string): AdapterLine {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, code: "invalid" };
  }
  if (!isRecord(raw) || typeof raw["kind"] !== "string") return { ok: false, code: "invalid" };
  const kind = raw["kind"];
  if (kind === "hello") {
    const hello = parseHello(raw);
    return hello === null ? { ok: false, code: "invalid" } : { ok: true, frame: hello };
  }
  if (kind === "resync") return hasOnly(raw, ["kind"]) ? { ok: true, frame: { kind } } : { ok: false, code: "invalid" };
  return { ok: false, code: LATER_KINDS.has(kind) ? "unsupported" : "invalid" };
}

/** One frame as the line the daemon writes, newline included. */
export function encodeDaemonFrame(frame: AdapterDaemonFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Whether `wants` asks for what `frame` is: a frame kind goes only to an adapter that named it. */
export function adapterWants(wants: readonly AdapterWant[], frame: AdapterDaemonFrame): boolean {
  switch (frame.kind) {
    case "snapshot":
    case "session":
    case "session-gone":
      return wants.includes("sessions");
    case "task":
      return wants.includes("tasks");
    case "hello":
    case "error":
      return true;
  }
}

type Schema = Readonly<Record<string, unknown>>;

const str = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const oneOf = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
const obj = (properties: Record<string, Schema>, required: readonly string[]): Schema => ({
  type: "object",
  properties,
  required: [...required],
});

/**
 * The protocol as JSON Schema (draft 2020-12), from the constants above: the committed `adapter-protocol.schema.json`
 * is this, pretty-printed. Daemon frames leave `additionalProperties` open (an adapter ignores a field it does not
 * know); adapter frames close it, as the daemon's parsers do.
 */
export function adapterProtocolSchema(): Schema {
  const tag = obj(
    {
      value: str(),
      at: { type: "integer" },
      scope: oneOf(["conversation", "process"]),
      verified: { const: true },
    },
    ["value", "at", "scope"],
  );
  const session = obj(
    {
      key: str({ pattern: "^[0-9]+:.+$" }),
      session: obj({ id: str(), verified: { type: "boolean" }, conflict: { const: true } }, ["id", "verified"]),
      task: obj(
        {
          id: str(),
          title: str(),
          ref: obj({ ref: str(), url: str() }, ["ref"]),
        },
        ["id"],
      ),
      exclave: str(),
      repo: str(),
      branch: str(),
      state: oneOf(ADAPTER_SESSION_STATES),
      turnEnded: { const: true },
      reason: oneOf(NEEDS_INPUT_REASONS),
      prUrl: str({ pattern: "^https://" }),
      since: { type: "integer" },
      name: obj({ text: str(), source: oneOf(NAME_SOURCES) }, ["text", "source"]),
      tags: { type: "object", additionalProperties: { $ref: "#/$defs/tag" } },
    },
    ["key", "exclave", "state", "since", "name", "tags"],
  );
  const closed = (schema: Schema): Schema => ({ ...schema, additionalProperties: false });
  const daemon = {
    hello: obj(
      {
        kind: { const: "hello" },
        protocol: { type: "array", items: { enum: [...ADAPTER_PROTOCOLS] } },
        features: { type: "array", items: str() },
        machine: obj({ deviceId: str(), name: str() }, ["deviceId", "name"]),
        daemon: obj({ version: str() }, ["version"]),
      },
      ["kind", "protocol", "features", "machine", "daemon"],
    ),
    snapshot: obj({ kind: { const: "snapshot" }, sessions: { type: "array", items: { $ref: "#/$defs/session" } } }, [
      "kind",
      "sessions",
    ]),
    session: obj({ kind: { const: "session" }, session: { $ref: "#/$defs/session" } }, ["kind", "session"]),
    "session-gone": obj({ kind: { const: "session-gone" }, key: str(), reason: oneOf(SESSION_GONE_REASONS) }, [
      "kind",
      "key",
      "reason",
    ]),
    task: obj(
      {
        kind: { const: "task" },
        task: str(),
        event: oneOf(ADAPTER_TASK_EVENTS),
        continues: str(),
        prUrl: str({ pattern: "^https://" }),
      },
      ["kind", "task", "event"],
    ),
    error: obj({ kind: { const: "error" }, code: oneOf(ADAPTER_ERROR_CODES) }, ["kind", "code"]),
  };
  const adapter = {
    hello: closed(
      obj(
        {
          kind: { const: "hello" },
          protocol: { type: "integer", minimum: 1 },
          name: str({ pattern: ADAPTER_NAME_PATTERN.source }),
          version: str({ minLength: 1, maxLength: VERSION_MAX }),
          wants: { type: "array", items: oneOf(ADAPTER_WANTS), uniqueItems: true },
          features: { type: "array", items: str({ pattern: FEATURE.source }), maxItems: FEATURES_MAX },
        },
        ["kind", "protocol", "name", "version", "wants", "features"],
      ),
    ),
    resync: closed(obj({ kind: { const: "resync" } }, ["kind"])),
  };
  const ref = (side: string, kinds: Record<string, Schema>): Schema => ({
    oneOf: Object.keys(kinds).map((kind) => ({ $ref: `#/$defs/${side}-${kind}` })),
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "seance-adapter-protocol-1",
    title: "Séance adapter protocol, major 1",
    description:
      "One JSON object per line over the adapter's stdin (daemon frames) and stdout (adapter frames), at most " +
      `${ADAPTER_LINE_MAX} bytes a line. Generated from shared/src/adapter-protocol.ts; do not edit.`,
    $defs: {
      tag,
      session,
      daemonFrame: ref("daemon", daemon),
      adapterFrame: ref("adapter", adapter),
      ...Object.fromEntries(Object.entries(daemon).map(([kind, schema]) => [`daemon-${kind}`, schema])),
      ...Object.fromEntries(Object.entries(adapter).map(([kind, schema]) => [`adapter-${kind}`, schema])),
    },
  };
}

/** The committed file's text: what `bun run adapter-schema` writes. */
export function adapterProtocolSchemaText(): string {
  return `${JSON.stringify(adapterProtocolSchema(), null, 2)}\n`;
}
