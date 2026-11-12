import { STATUS_MAX_TRAIT_PAIRS } from "@seance/shared";
import {
  daemonSink,
  probeAudit,
  type AuditSink,
  type ProbeOutcomeAudit,
  type ProbeUnitAudit,
  type ProbeVia,
} from "./audit.ts";
import type { TraitProbeConfig, TraitsConfig } from "./config.ts";
import { DEFAULT_EXCLAVE, type Exclave, type ExclaveScan } from "./exclaves.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";
import { exclaveTraitNames } from "./traits.ts";

/**
 * Trait probes (DESIGN.md, Daemon, "Trait probes"; docs/scheduler.md M4, "Traits"): whether a trait this
 * machine declares is working right now. A trait in `config.json` may name an argv array; the daemon runs it
 * on a cadence and reports a failing one in its `status` (`tf`), which the leader's filter reads as
 * `trait_unhealthy`.
 *
 * **The command comes only from this machine's own config file** — never a frame, the PWA or another machine —
 * and is exec'd as an argv array, never through a shell. It runs as the daemon's user with the environment a
 * session gets (the daemon's, less the service-delivered credential directory; a probe has to judge the
 * context a session runs in, and a keyring-backed CLI fails in a bare one) plus `CLAUDE_CONFIG_DIR` for an
 * exclave-scoped trait. Its stdio is ignored: nothing it prints is read, and nothing but a word count, a hash
 * and the program's basename of its argv is ever logged. It is not a boundary against a same-uid session,
 * which can already write `config.json`.
 *
 * One at a time in the whole process. Exit 0 is healthy, any other exit failing; a timeout, a spawn failure
 * or an unresolvable program is unknown, which still routes, as auth health's is.
 */

/** A failing or unknown unit reruns this soon, at the earliest: a transient failure must not hold work for `everyMinutes`. */
export const PROBE_FLOOR_MS = 5 * 60_000;
export const CHECK_INTERVAL_MS = 60_000;
const KILL_AFTER_MS = 1_000;
const HARD_DEADLINE_SLACK_MS = 1_000;

export type ProbeState =
  | { readonly kind: "pending" }
  | { readonly kind: "healthy" }
  | { readonly kind: "failing"; readonly exit: number }
  | { readonly kind: "unknown"; readonly why: "timeout" | "spawn" | "not_found" };

/** A probe that has run. */
type Settled = Exclude<ProbeState, { kind: "pending" }>;

type TraitPair = readonly [number, number];

/** A status's `tf` and `tu`: `[exclave index, trait index into that exclave's advertised traits]`. */
export interface TraitLists {
  readonly tf: readonly TraitPair[];
  readonly tu: readonly TraitPair[];
}

export interface TraitProbesDeps {
  /** The whole `traits` config: indices into an exclave's advertised traits come from it, probed or not. */
  readonly allTraits: TraitsConfig;
  /** The last scan: which exclaves exist, and where each one's config dir is. */
  readonly scan: () => Pick<ExclaveScan, "exclaves">;
  /** The daemon's home: the probe's cwd. */
  readonly home: string;
  /** Some unit's state changed (a first result counts) and the lane has gone quiet: send a status now. */
  readonly onChange: () => void;
  /** Default: the daemon's log. */
  readonly audit?: AuditSink;
  readonly now?: () => number;
  readonly checkIntervalMs?: number;
  /** Why this daemon is arming, for its audit lines. Default `start`. */
  readonly via?: ProbeVia;
}

export interface TraitProbes {
  /** Arms every unit and runs each once, then checks every `checkIntervalMs` for a due one. */
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  /** Resolves once nothing is queued or running; for tests. */
  readonly idle: () => Promise<void>;
  /** `tf` and `tu` for this scan's exclaves, by `exclaveTraitNames` indices: at most `STATUS_MAX_TRAIT_PAIRS` together, `tf` first. */
  readonly statusLists: (scan: Pick<ExclaveScan, "exclaves">) => TraitLists;
  /** By unit key (`trait`, or `trait/exclave` for a scoped one); for tests. */
  readonly view: () => ReadonlyMap<string, ProbeState>;
}

interface Unit {
  readonly key: string;
  readonly trait: string;
  readonly probe: TraitProbeConfig;
  /** Absent for a machine-wide trait. */
  readonly exclave?: Exclave;
}

interface Entry {
  state: ProbeState;
  /** When the last run started; null until one has. */
  startedAt: number | null;
  /** The last audited result line's tail, so only a change is written. */
  logged: string | null;
}

/**
 * One child at a time in the whole process, not per instance: a config reload starts a second daemon in
 * process while the first one's probe may still be going.
 */
let lane: Promise<unknown> = Promise.resolve();

function inLane<T>(run: () => Promise<T>): Promise<T> {
  const next = lane.then(run);
  lane = next.catch(() => undefined);
  return next;
}

export function hasProbe(traits: TraitsConfig | undefined): boolean {
  return Object.values(traits ?? {}).some((scope) => scope.probe !== undefined);
}

function describe(state: ProbeState): string {
  if (state.kind === "failing") return `failing exit=${state.exit}`;
  if (state.kind === "unknown") return `unknown why=${state.why}`;
  return state.kind;
}

function outcomeOf(state: Settled): ProbeOutcomeAudit {
  if (state.kind === "failing") return { state: "failing", exit: state.exit };
  if (state.kind === "unknown") return { state: "unknown", why: state.why };
  return { state: "healthy" };
}

/** The probe in flight; its pid is set only while its group leader is unreaped. */
interface Run {
  readonly key: string;
  pid: number | null;
}

export function createTraitProbes(deps: TraitProbesDeps): TraitProbes {
  const now = deps.now ?? Date.now;
  const sink = deps.audit ?? daemonSink;
  const audit = probeAudit(sink);
  const via = deps.via ?? "start";
  const entries = new Map<string, Entry>();
  const queued: string[] = [];
  let draining: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running: Run | null = null;
  let changed = false;
  let overflowLogged = 0;

  /** Every probed trait's units against the scan: one for a machine-wide trait, one per listed exclave the scan has for a scoped one. */
  const unitsOf = (scan: Pick<ExclaveScan, "exclaves">): readonly Unit[] =>
    Object.entries(deps.allTraits).flatMap(([trait, scope]): readonly Unit[] => {
      const { probe } = scope;
      if (probe === undefined) return [];
      if (scope.exclaves === undefined) return [{ key: trait, trait, probe }];
      return scope.exclaves.flatMap((id): readonly Unit[] => {
        const exclave = scan.exclaves.find((x) => x.id === id);
        return exclave === undefined ? [] : [{ key: `${trait}/${id}`, trait, probe, exclave }];
      });
    });

  const auditOf = (unit: Unit): ProbeUnitAudit => ({
    trait: unit.trait,
    ...(unit.exclave === undefined ? {} : { exclave: unit.exclave.id }),
    everyMinutes: unit.probe.everyMinutes,
    timeoutSeconds: unit.probe.timeoutSeconds,
    argv: unit.probe.argv,
  });

  /** An audit sink that fails must not fail the probe or leave a rejection unhandled. */
  const record = (line: Promise<void>): void => {
    void line.catch(() => undefined);
  };

  const settle = (): void => {
    if (!changed || stopped || draining !== null) return;
    changed = false;
    deps.onChange();
  };

  /** The session's environment, less what the exec layer always strips; an exclave-scoped trait adds its config dir. */
  const envOf = (unit: Unit): Readonly<Record<string, string | undefined>> =>
    unit.exclave === undefined
      ? {}
      : { CLAUDE_CONFIG_DIR: unit.exclave.id === DEFAULT_EXCLAVE ? undefined : unit.exclave.configDir };

  const runProbe = async (unit: Unit, run: Run): Promise<Settled> => {
    const [program = "", ...rest] = unit.probe.argv;
    const env = envOf(unit);
    // Resolved at each run and never kept: a path recorded now dangles when a package manager retires it.
    const resolved = program.includes("/")
      ? program
      : Bun.which(program, { PATH: process.env["PATH"] ?? "", cwd: deps.home });
    if (resolved === null) return { kind: "unknown", why: "not_found" };
    const timeoutMs = unit.probe.timeoutSeconds * 1000;
    // Past the kill grace plus a second the run is lost as a timeout and the lane moves on: a child that
    // survives SIGKILL (uninterruptible sleep) would otherwise hold a lane that is process-wide.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<"abandoned">((resolve) => {
      deadline = setTimeout(() => resolve("abandoned"), timeoutMs + KILL_AFTER_MS + HARD_DEADLINE_SLACK_MS);
    });
    const ran = exec([resolved, ...rest], {
      cwd: deps.home,
      env,
      killGroup: true,
      killAfterMs: KILL_AFTER_MS,
      // A probe repeats on a cadence: a descendant it leaves behind would pile up every five minutes while it fails.
      sweepGroup: true,
      timeoutMs,
      discardStdout: true,
      discardStderr: true,
      // This run's own record, never `running`: an abandoned child's exit can land during a later run.
      onSpawn: (pid) => {
        run.pid = pid;
      },
      onExit: () => {
        run.pid = null;
      },
    }).catch(() => "spawn" as const);
    const result = await Promise.race([ran, abandoned]).finally(() => {
      clearTimeout(deadline);
      run.pid = null;
    });
    if (result === "spawn") return { kind: "unknown", why: "spawn" };
    if (result === "abandoned" || result.timedOut) return { kind: "unknown", why: "timeout" };
    return result.exitCode === 0 ? { kind: "healthy" } : { kind: "failing", exit: result.exitCode };
  };

  const attempt = async (key: string): Promise<void> => {
    if (stopped) return;
    const unit = unitsOf(deps.scan()).find((u) => u.key === key);
    const entry = entries.get(key);
    if (unit === undefined || entry === undefined) return;
    entry.startedAt = now();
    const run: Run = { key, pid: null };
    running = run;
    let state: Settled;
    try {
      state = await runProbe(unit, run);
    } finally {
      running = null;
    }
    if (stopped) return;
    entry.state = state;
    const line = describe(state);
    if (entry.logged === line) return;
    entry.logged = line;
    changed = true;
    record(audit.result(auditOf(unit), outcomeOf(state)));
  };

  const drain = (): void => {
    if (draining !== null) return;
    draining = (async (): Promise<void> => {
      try {
        for (;;) {
          const key = queued.shift();
          if (key === undefined || stopped) return;
          // oxlint-disable-next-line no-await-in-loop -- one child at a time is the point
          await inLane(() => attempt(key)).catch(() => undefined);
        }
      } finally {
        draining = null;
        settle();
      }
    })();
  };

  const enqueue = (key: string): void => {
    if (stopped || queued.includes(key) || running?.key === key) return;
    queued.push(key);
    drain();
  };

  const isDue = (unit: Unit, entry: Entry): boolean => {
    if (entry.startedAt === null) return true;
    const every = entry.state.kind === "healthy" ? unit.probe.everyMinutes * 60_000 : PROBE_FLOOR_MS;
    return now() - entry.startedAt >= every;
  };

  const check = (): void => {
    if (stopped) return;
    const units = unitsOf(deps.scan());
    const keys = new Set(units.map((u) => u.key));
    for (const key of entries.keys()) if (!keys.has(key)) entries.delete(key);
    for (const unit of units) {
      let entry = entries.get(unit.key);
      if (entry === undefined) {
        // An exclave that appears in a later scan is armed when it does.
        entry = { state: { kind: "pending" }, startedAt: null, logged: null };
        entries.set(unit.key, entry);
        record(audit.armed(auditOf(unit), via));
      }
      if (isDue(unit, entry)) enqueue(unit.key);
    }
  };

  const wait = async (): Promise<void> => {
    // oxlint-disable-next-line no-await-in-loop -- a drain begun while waiting is waited for too
    for (let pending = draining; pending !== null; pending = draining) await pending;
  };

  return {
    start: (): void => {
      if (stopped || timer !== null) return;
      timer = setInterval(check, deps.checkIntervalMs ?? CHECK_INTERVAL_MS);
      check();
    },
    stop: async (): Promise<void> => {
      stopped = true;
      queued.length = 0;
      if (timer !== null) clearInterval(timer);
      timer = null;
      const pid = running?.pid ?? null;
      if (pid !== null) {
        try {
          // The group, only while its leader is unreaped (`onExit` clears the pid): a reaped group id may
          // name an unrelated group. No TERM grace: a probe has nothing to flush.
          process.kill(-pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
      await wait();
    },
    idle: wait,
    statusLists: (scan) => {
      const tf: TraitPair[] = [];
      const tu: TraitPair[] = [];
      scan.exclaves.forEach((exclave, x) => {
        exclaveTraitNames(exclave.id, deps.allTraits).forEach((trait, i) => {
          const scope = deps.allTraits[trait];
          if (scope?.probe === undefined) return;
          const key = scope.exclaves === undefined ? trait : `${trait}/${exclave.id}`;
          const kind = entries.get(key)?.state.kind ?? "pending";
          if (kind === "failing") tf.push([x, i]);
          else if (kind !== "healthy") tu.push([x, i]);
        });
      });
      if (tf.length > STATUS_MAX_TRAIT_PAIRS && tf.length !== overflowLogged) {
        log.warn(`traits: probe status overflow: failing=${tf.length} kept=${STATUS_MAX_TRAIT_PAIRS}`);
      }
      overflowLogged = tf.length > STATUS_MAX_TRAIT_PAIRS ? tf.length : 0;
      const keptTf = tf.slice(0, STATUS_MAX_TRAIT_PAIRS);
      return { tf: keptTf, tu: tu.slice(0, STATUS_MAX_TRAIT_PAIRS - keptTf.length) };
    },
    view: (): ReadonlyMap<string, ProbeState> => new Map([...entries].map(([key, entry]) => [key, entry.state])),
  };
}
