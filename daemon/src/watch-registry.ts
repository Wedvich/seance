import {
  isTerminalKey,
  quote,
  watchJsonBytes,
  watchKeyOf,
  watchTargetKey,
  WATCH_EVENT_JSON_MAX,
  WATCH_FLEET_PRS,
  WATCH_FLEET_RUNS,
  WATCH_PASSING_CONCLUSIONS,
  WATCH_SET_MAX,
  type GithubPr,
  type GithubRun,
  type ParsedWatch,
  type ParsedWatchSet,
  type WatchConclusion,
  type WatchEvent,
  type WatchEventBody,
  type WatchEventRequest,
  type WatchEventResponse,
  type WatchFailing,
  type WatchGeneration,
  type WatchRefusal,
  type WatchSuspendReason,
} from "@seance/shared";

/**
 * The leader's watch registry (docs/gh-watch.md W9; DESIGN.md, Scheduler, "PR status"): soft state per term, one set per
 * device and generation, the fleet caps, what each poll's readings make due for each watch, and the `watch-event`s
 * sent to each device (at most one in flight; one goes at a poll's end, a clock tick and an accepted set). Pure apart
 * from the injected `send` and `log`, and it takes `send` as `| null` rather than the scheduler's `NoAnswer`, so it
 * imports nothing under `scheduler/` and nothing that logs (the `seance mcp` closure).
 *
 * Nothing here names a URL, owner, repo, head, check name or watch id in a log line: a watch's target is a session's
 * word, and a log is read by people who never saw the session.
 */

/** A set not refreshed (by any accepted `watch-set`, a re-answered duplicate included) for this long is dropped. */
export const WATCH_SET_TTL_MS = 15 * 60_000;

/**
 * Polls a watch given a head by its set ignores a different head before following it: the head a set names is the
 * session's word (what it pushed), which GitHub may not show yet, so a different one read at first is probably the
 * previous push still being the PR's head. Only until the set's head has been read once.
 */
export const HEAD_GRACE_POLLS = 5;

/** Keys remembered as acknowledged per watch, oldest dropped. */
const ACKED_MAX = 16;
/** Boots remembered as retired per device. */
const RETIRED_MAX = 4;

export type PrReading =
  /** The alias answered null (`NOT_FOUND`/`FORBIDDEN`). */
  | { readonly kind: "unreadable" }
  | { readonly kind: "merged"; readonly stacked: boolean }
  | { readonly kind: "closed" }
  /** Open or draft; `head` only from a blocked read. */
  | {
      readonly kind: "open";
      readonly head?: string;
      readonly conflict: boolean;
      readonly checks?: "pass" | "fail";
      readonly failing: readonly WatchFailing[];
    };

export type RunReading =
  | { readonly kind: "unreadable" }
  | { readonly kind: "running" }
  | {
      readonly kind: "completed";
      readonly attempt: number;
      readonly conclusion: WatchConclusion;
      readonly failing: readonly WatchFailing[];
    };

export interface WatchedPr {
  readonly key: string;
  readonly pr: GithubPr;
}

export interface WatchedRun {
  readonly key: string;
  readonly run: GithubRun;
}

/** What the poller sees of the registry. */
export interface PollerWatches {
  readonly wanted: (now: number) => { readonly prs: readonly WatchedPr[]; readonly runs: readonly WatchedRun[] };
  readonly read: (
    readings: { readonly prs: ReadonlyMap<string, PrReading>; readonly runs: ReadonlyMap<string, RunReading> },
    now: number,
  ) => void;
  /**
   * Every clock tick; `reason` is why a watch unread for two intervals is suspended. While a poll is `polling` nothing
   * is suspended: a healthy poll longer than an interval leaves every watch unread for longer than two, and its end
   * reads them.
   */
  readonly tick: (now: number, reason: WatchSuspendReason, resetAt: number | null, polling?: boolean) => void;
}

export interface WatchRegistryDeps {
  /** `null`: no answer (an ended term, an unreachable machine). */
  readonly send: (deviceId: string, request: WatchEventRequest) => Promise<WatchEventResponse | null>;
  readonly canReceive: (deviceId: string) => boolean;
  /** The poller's interval; a watch is suspended once unread for twice it. */
  readonly intervalMs: number;
  readonly log: { readonly info: (m: string) => void; readonly warn: (m: string) => void };
}

export interface WatchRegistry extends PollerWatches {
  /** A parsed set from `deviceId`; false when ignored unanswered (a lower generation or a retired boot). */
  readonly accept: (deviceId: string, set: ParsedWatchSet, now: number) => boolean;
}

interface Suspension {
  readonly reason: WatchSuspendReason;
  readonly since: number;
  readonly resetAt?: number;
}

interface WatchState {
  readonly id: string;
  readonly targetKey: string;
  readonly target: ParsedWatch["target"];
  /** The `head` the set carried, which decides whether a replacing set keeps this state. */
  readonly setHead: string | undefined;
  head: string | undefined;
  confirmed: boolean;
  followed: boolean;
  grace: number;
  readonly seen: Set<string>;
  acked: string[];
  nullStreak: number;
  lastReadAt: number;
  suspension: Suspension | null;
}

interface Refusal {
  readonly id: string;
  readonly code: WatchRefusal;
}

interface Device {
  boot: string;
  n: number;
  retired: string[];
  lastSetAt: number;
  watches: Map<string, WatchState>;
  refused: readonly Refusal[];
  inFlight: boolean;
  failing: boolean;
  setAnswerDue: boolean;
  /** Where the next frame starts in the watches' order, so a watch whose events were not taken cannot starve the rest. */
  cursor: number;
  /** The last refusal counts warned, so a heartbeat repeating the same refusals logs once. */
  refusalNote: string;
}

interface Held<T> {
  readonly reading: T;
  /** When the poll that made it ran: only a watch read in that same poll acts on it. */
  readonly at: number;
}

function sameGen(device: Device, gen: WatchGeneration): boolean {
  return device.boot === gen.boot && device.n === gen.n;
}

export function createWatchRegistry(deps: WatchRegistryDeps): WatchRegistry {
  const devices = new Map<string, Device>();
  const prReadings = new Map<string, Held<PrReading>>();
  const runReadings = new Map<string, Held<RunReading>>();

  function expire(now: number): void {
    for (const [id, device] of devices) {
      if (now - device.lastSetAt > WATCH_SET_TTL_MS) devices.delete(id);
    }
  }

  function isDone(watch: WatchState): boolean {
    return [...watch.seen, ...watch.acked].some(isTerminalKey);
  }

  function fresh(watch: ParsedWatch, now: number): WatchState {
    const head = watch.target.kind === "pr" ? watch.head : undefined;
    return {
      id: watch.id,
      targetKey: watchTargetKey(watch.target),
      target: watch.target,
      setHead: head,
      head,
      confirmed: false,
      followed: false,
      grace: HEAD_GRACE_POLLS,
      seen: new Set(watch.seen),
      acked: [],
      nullStreak: 0,
      lastReadAt: now,
      suspension: null,
    };
  }

  function prune(): void {
    const live = new Set<string>();
    for (const device of devices.values()) for (const w of device.watches.values()) live.add(w.targetKey);
    for (const key of prReadings.keys()) if (!live.has(key)) prReadings.delete(key);
    for (const key of runReadings.keys()) if (!live.has(key)) runReadings.delete(key);
  }

  /** Item 2: the refusals and the entries kept, in set order. */
  function admit(
    deviceId: string,
    set: ParsedWatchSet,
    previous: Device | undefined,
  ): { readonly kept: readonly ParsedWatch[]; readonly refused: readonly Refusal[] } {
    const refused: Refusal[] = set.invalid.map((id) => ({ id, code: "invalid" as const }));
    const within = set.watches.slice(0, WATCH_SET_MAX);
    for (const over of set.watches.slice(WATCH_SET_MAX)) refused.push({ id: over.id, code: "invalid" });

    const counted = new Set<string>();
    for (const [otherId, other] of devices) {
      if (otherId === deviceId) continue;
      for (const w of other.watches.values()) counted.add(w.targetKey);
    }
    const count = (kind: "pr" | "run"): number => [...counted].filter((k) => k.startsWith(`${kind}:`)).length;
    const held = new Set(previous === undefined ? [] : [...previous.watches.values()].map((w) => w.targetKey));
    const taken = new Set<string>();
    const fleetFull = new Set<string>();

    const consider = (watch: ParsedWatch): void => {
      const key = watchTargetKey(watch.target);
      if (!counted.has(key)) {
        const kind = watch.target.kind;
        if (count(kind) >= (kind === "pr" ? WATCH_FLEET_PRS : WATCH_FLEET_RUNS)) {
          fleetFull.add(watch.id);
          return;
        }
        counted.add(key);
      }
      taken.add(watch.id);
    };
    // A cap never evicts: what this device already held is admitted before what is new.
    for (const watch of within) if (held.has(watchTargetKey(watch.target))) consider(watch);
    for (const watch of within) if (!held.has(watchTargetKey(watch.target))) consider(watch);

    for (const watch of within) if (fleetFull.has(watch.id)) refused.push({ id: watch.id, code: "fleet_full" });
    return { kept: within.filter((w) => taken.has(w.id)), refused };
  }

  function replace(deviceId: string, device: Device, set: ParsedWatchSet, now: number): void {
    const { kept, refused } = admit(deviceId, set, device);
    const next = new Map<string, WatchState>();
    for (const watch of kept) {
      const old = device.watches.get(watch.id);
      const headOf = watch.target.kind === "pr" ? watch.head : undefined;
      if (old !== undefined && old.targetKey === watchTargetKey(watch.target) && old.setHead === headOf) {
        for (const key of watch.seen) old.seen.add(key);
        next.set(watch.id, old);
      } else {
        next.set(watch.id, fresh(watch, now));
      }
    }
    device.watches = next;
    device.refused = refused;
    const full = refused.filter((r) => r.code === "fleet_full").length;
    const note =
      refused.length === 0 ? "" : `refused ${refused.length} (fleet_full ${full}, invalid ${refused.length - full})`;
    if (note !== "" && note !== device.refusalNote)
      deps.log.warn(`scheduler: watch-set from=${quote(deviceId)} ${note}`);
    device.refusalNote = note;
  }

  /** Item 6: what a reading makes due for one watch, keys in neither `seen` nor the acknowledged. */
  function dueFor(watch: WatchState): WatchEventBody[] {
    if (isDone(watch)) return [];
    const bodies: WatchEventBody[] = [];
    if (watch.target.kind === "pr") {
      const held = prReadings.get(watch.targetKey);
      if (held !== undefined && held.at === watch.lastReadAt) prDue(watch, held.reading, bodies);
    } else {
      const held = runReadings.get(watch.targetKey);
      if (held !== undefined && held.at === watch.lastReadAt) runDue(watch, held.reading, bodies);
    }
    const s = watch.suspension;
    if (s !== null) {
      bodies.push({
        kind: "suspended",
        reason: s.reason,
        since: s.since,
        ...(s.resetAt === undefined ? {} : { resetAt: s.resetAt }),
      });
    }
    return bodies.filter((b) => !watch.seen.has(watchKeyOf(b)) && !watch.acked.includes(watchKeyOf(b)));
  }

  function prDue(watch: WatchState, r: PrReading, out: WatchEventBody[]): void {
    switch (r.kind) {
      case "unreadable":
        if (watch.nullStreak >= 2) out.push({ kind: "unreadable" });
        return;
      case "merged":
        out.push({ kind: "merged", ...(r.stacked ? { stacked: true as const } : {}) });
        return;
      case "closed":
        out.push({ kind: "closed" });
        return;
      case "open": {
        const head = watch.head;
        if (head === undefined || r.head !== head) return;
        const moved = watch.followed ? { headMoved: true as const } : {};
        if (r.checks !== undefined) {
          out.push({
            kind: "checks",
            outcome: r.checks,
            head,
            ...moved,
            ...(r.checks === "fail" && r.failing.length > 0 ? { failing: r.failing } : {}),
          });
        }
        if (r.conflict) out.push({ kind: "conflict", head, ...moved });
        break;
      }
    }
  }

  function runDue(watch: WatchState, r: RunReading, out: WatchEventBody[]): void {
    switch (r.kind) {
      case "unreadable":
        if (watch.nullStreak >= 2) out.push({ kind: "unreadable" });
        break;
      case "running":
        break;
      case "completed": {
        const passing = WATCH_PASSING_CONCLUSIONS.some((c) => c === r.conclusion);
        const failing = r.failing.length > 0 && !passing;
        out.push({
          kind: "completed",
          attempt: r.attempt,
          conclusion: r.conclusion,
          ...(failing ? { failing: r.failing } : {}),
        });
        break;
      }
    }
  }

  /** Item 7. */
  function trackHead(watch: WatchState, r: PrReading): void {
    if (r.kind !== "open" || r.head === undefined) return;
    if (watch.head === undefined) {
      watch.head = r.head;
      watch.confirmed = true;
      return;
    }
    if (r.head === watch.head) {
      watch.confirmed = true;
      return;
    }
    if (watch.confirmed) {
      watch.head = r.head;
      watch.followed = true;
      return;
    }
    watch.grace -= 1;
    if (watch.grace > 0) return;
    watch.head = r.head;
    watch.confirmed = true;
    watch.followed = true;
  }

  function ack(watch: WatchState, key: string): void {
    if (watch.acked.includes(key)) return;
    watch.acked.push(key);
    if (watch.acked.length > ACKED_MAX) watch.acked.shift();
  }

  /** Item 8. */
  function sendPass(): void {
    for (const [deviceId, device] of devices) {
      if (device.inFlight || !deps.canReceive(deviceId)) continue;
      const carriedSet = device.setAnswerDue
        ? { gen: { boot: device.boot, n: device.n }, refused: device.refused }
        : undefined;
      const events: WatchEvent[] = [];
      const list = [...device.watches.values()];
      const start = list.length === 0 ? 0 : device.cursor % list.length;
      let stoppedAt: number | null = null;
      for (let step = 0; step < list.length && stoppedAt === null; step += 1) {
        const index = (start + step) % list.length;
        const watch = list[index];
        if (watch === undefined) continue;
        for (const body of dueFor(watch)) {
          const event: WatchEvent = { id: watch.id, key: watchKeyOf(body), event: body };
          const trial: WatchEventRequest = {
            ...(carriedSet === undefined ? {} : { set: carriedSet }),
            events: [...events, event],
          };
          // The rest is due next send: everything is level-triggered.
          if (watchJsonBytes(trial) > WATCH_EVENT_JSON_MAX) {
            stoppedAt = index;
            break;
          }
          events.push(event);
        }
      }
      // A frame that filled resumes at the watch it stopped in, so what an earlier watch left unacknowledged cannot
      // fill every frame ahead of the later ones.
      device.cursor = stoppedAt ?? 0;
      if (events.length === 0 && carriedSet === undefined) continue;
      void transmit(deviceId, device, { ...(carriedSet === undefined ? {} : { set: carriedSet }), events });
    }
  }

  async function transmit(deviceId: string, device: Device, request: WatchEventRequest): Promise<void> {
    device.inFlight = true;
    let answer: WatchEventResponse | null = null;
    try {
      answer = await deps.send(deviceId, request);
    } catch {
      answer = null;
    } finally {
      device.inFlight = false;
    }
    if (answer === null || !answer.ok) {
      if (!device.failing) {
        device.failing = true;
        deps.log.warn(
          `scheduler: watch-event to=${quote(deviceId)} failed (${answer === null ? "unreachable" : answer.code})`,
        );
      }
      return;
    }
    if (device.failing) {
      device.failing = false;
      deps.log.info(`scheduler: watch-event to=${quote(deviceId)} answered again`);
    }
    if (request.set !== undefined && sameGen(device, request.set.gen)) device.setAnswerDue = false;
    const delivered = new Set(answer.delivered);
    for (const event of request.events) {
      if (!delivered.has(event.id)) continue;
      const watch = device.watches.get(event.id);
      if (watch === undefined) continue;
      ack(watch, event.key);
    }
    // A set accepted while this send was in flight waits for its own frame, not for the next read or tick.
    if (device.setAnswerDue) sendPass();
  }

  return {
    accept(deviceId, set, now) {
      expire(now);
      const existing = devices.get(deviceId);
      if (existing !== undefined) {
        if (existing.retired.includes(set.gen.boot)) return false;
        if (existing.boot === set.gen.boot && set.gen.n < existing.n) return false;
        if (existing.boot === set.gen.boot && set.gen.n === existing.n) {
          existing.lastSetAt = now;
          existing.setAnswerDue = true;
          sendPass();
          return true;
        }
      }
      const device: Device = existing ?? {
        boot: set.gen.boot,
        n: -1,
        retired: [],
        lastSetAt: now,
        watches: new Map(),
        refused: [],
        inFlight: false,
        failing: false,
        setAnswerDue: false,
        cursor: 0,
        refusalNote: "",
      };
      if (existing !== undefined && existing.boot !== set.gen.boot) {
        device.retired = [...device.retired, existing.boot].slice(-RETIRED_MAX);
      }
      devices.set(deviceId, device);
      replace(deviceId, device, set, now);
      device.boot = set.gen.boot;
      device.n = set.gen.n;
      device.lastSetAt = now;
      device.setAnswerDue = true;
      prune();
      sendPass();
      return true;
    },

    wanted(now) {
      expire(now);
      const prs = new Map<string, WatchedPr>();
      const runs = new Map<string, WatchedRun>();
      for (const device of devices.values()) {
        for (const w of device.watches.values()) {
          if (isDone(w)) continue;
          if (w.target.kind === "pr") {
            if (!prs.has(w.targetKey)) prs.set(w.targetKey, { key: w.targetKey, pr: w.target.pr });
          } else if (!runs.has(w.targetKey)) {
            runs.set(w.targetKey, { key: w.targetKey, run: w.target.run });
          }
        }
      }
      return { prs: [...prs.values()], runs: [...runs.values()] };
    },

    read(readings, now) {
      expire(now);
      for (const [key, reading] of readings.prs) prReadings.set(key, { reading, at: now });
      for (const [key, reading] of readings.runs) runReadings.set(key, { reading, at: now });
      for (const device of devices.values()) {
        for (const w of device.watches.values()) {
          const held = w.target.kind === "pr" ? prReadings.get(w.targetKey) : runReadings.get(w.targetKey);
          if (held === undefined || held.at !== now) continue;
          w.lastReadAt = now;
          w.suspension = null;
          w.nullStreak = held.reading.kind === "unreadable" ? w.nullStreak + 1 : 0;
          const pr = w.target.kind === "pr" ? prReadings.get(w.targetKey) : undefined;
          if (pr !== undefined) trackHead(w, pr.reading);
        }
      }
      prune();
      sendPass();
    },

    tick(now, reason, resetAt, polling = false) {
      expire(now);
      for (const device of devices.values()) {
        for (const w of device.watches.values()) {
          if (polling || w.suspension !== null || isDone(w) || now - w.lastReadAt <= 2 * deps.intervalMs) continue;
          const reset = (reason === "limited" || reason === "reserve") && resetAt !== null ? { resetAt } : {};
          w.suspension = { reason, since: w.lastReadAt, ...reset };
        }
      }
      sendPass();
    },
  };
}
