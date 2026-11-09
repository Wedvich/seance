import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  LocalStorage,
  Toast,
  closeMainWindow,
  environment,
  getPreferenceValues,
  showHUD,
  showToast,
} from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayState, SpawnRequest, SpawnResponse, TaskRequest } from "@seance/shared";
import {
  accountLine,
  NO_ALIASES,
  readAliases,
  shouldListAccounts,
  type AccountAliases,
  type ListingProgress,
} from "./lib/accounts.ts";
import { readLastUsed, readRegistry, writeLastUsed, writeRegistry, type Store } from "./lib/cache.ts";
import { loadKey } from "./lib/credentials.ts";
import { failureText } from "./lib/errors.ts";
import {
  AUTO,
  checkSubmit,
  formatAge,
  initialValues,
  nextLastUsed,
  reconcile,
  repoChoices,
  sortedMachines,
  type Defaults,
  type FormValues,
  type LastUsed,
  type PickerMachine,
} from "./lib/form.ts";
import {
  EFFORTS,
  EFFORT_LABELS,
  FALLBACK_EFFORT,
  FALLBACK_MODEL,
  MODELS,
  MODEL_LABELS,
  isEffort,
  isModel,
} from "./lib/options.ts";
import { enqueue, leaderWait, schedulerLine, taskFor, type Unsettled } from "./lib/queue.ts";
import { connect, type RelayHandle } from "./lib/relay.ts";
import { installNodeGlobals } from "./lib/runtime.ts";

/**
 * Declared by hand rather than imported from the generated `raycast-env.d.ts`:
 * that file is gitignored, so a clean clone has none and `bun run typecheck`
 * would fail on the import. A `type` and not an `interface` so it picks up the
 * implicit index signature `PreferenceValues` requires.
 *
 * Defaults only. The PSK and bearer token are never Raycast preferences — they
 * come from the local daemon's config and keychain, which is what keeps this
 * surface free of a second copy of the key at rest.
 */
type Preferences = {
  readonly defaultMachine: string;
  readonly defaultModel: string;
  readonly defaultEffort: string;
};

// Before anything from `shared/` runs: Raycast's sandbox withholds `crypto` and
// `WebSocket`, which every envelope and every socket needs. See lib/runtime.ts.
installNodeGlobals();

/** Raycast's LocalStorage, narrowed to the seam cache.ts declares. */
const store: Store = {
  getItem: (key) => LocalStorage.getItem<string>(key),
  setItem: (key, value) => LocalStorage.setItem(key, value),
};

function readDefaults(): Defaults {
  const preferences = getPreferenceValues<Preferences>();
  return {
    machineName: preferences.defaultMachine.trim(),
    // A preference can hold a value this build no longer offers — the manifest's
    // list and the code's are separate copies by necessity.
    model: isModel(preferences.defaultModel) ? preferences.defaultModel : FALLBACK_MODEL,
    effort: isEffort(preferences.defaultEffort) ? preferences.defaultEffort : FALLBACK_EFFORT,
  };
}

function statusLine(relay: RelayState | null, machines: readonly PickerMachine[]): string {
  if (relay === null) return "Reading the local daemon config…";
  if (relay.status === "rejected") {
    return relay.rejection === "unauthorized"
      ? "The relay rejected the bearer token — check bearerToken in ~/.config/seance/config.json"
      : "The relay rejected the connection as malformed";
  }
  if (relay.status !== "open") {
    if (relay.settling) return "Reaching the relay…";
    return machines.length === 0
      ? "Relay unreachable"
      : `Relay unreachable — showing the last list, from ${formatAge(machines, Date.now())}`;
  }
  if (!relay.registrySettled) return "Connected — waiting for the machine list";
  const online = machines.filter((machine) => machine.connected).length;
  return `Connected · ${online} of ${machines.length} ${machines.length === 1 ? "machine" : "machines"} online`;
}

/**
 * Zero-friction spawn: hotkey, prompt, Start. Monitoring is the PWA's job, so
 * there is no session list here and no `sessions` op on the wire. A named
 * machine is a direct spawn, there at once; `Auto` queues a task for the
 * scheduler to place, as the PWA does.
 *
 * Cache-first by design. The picker renders from the last registry projection
 * immediately — dialing the relay costs a TLS handshake plus a registry push,
 * which is long enough to be felt on a surface whose whole point is speed — and
 * the live registry reconciles into it when it lands.
 *
 * A default export because Raycast's command loader requires one.
 */
export default function Command(): React.JSX.Element {
  const defaultsRef = useRef<Defaults>(readDefaults());
  const defaults = defaultsRef.current;

  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [machines, setMachines] = useState<readonly PickerMachine[]>([]);
  const [relay, setRelay] = useState<RelayState | null>(null);
  const [values, setValues] = useState<FormValues>(() => initialValues([], null, defaultsRef.current));
  const [busy, setBusy] = useState<"spawn" | "rescan" | null>(null);
  const [aliases, setAliases] = useState<AccountAliases>(NO_ALIASES);

  const handleRef = useRef<RelayHandle | null>(null);
  /** Reconciliation apologises at most once per invocation; later pushes adjust silently. */
  const notedRef = useRef(false);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  /** The cached projection and the last-used memory feed reconciliation, but nothing renders them — refs, not state. */
  const cachedRef = useRef<readonly PickerMachine[]>([]);
  const lastUsedRef = useRef<LastUsed | null>(null);
  /** The last `auto` create that may have landed: Queue again with the same form re-sends it, not a second task. */
  const unsettledRef = useRef<Unsettled | null>(null);

  const absorb = useCallback(
    (pushed: readonly PickerMachine[], authoritative: boolean): void => {
      const list = sortedMachines(pushed);
      setMachines(list);
      const result = reconcile(valuesRef.current, list, {
        cached: cachedRef.current,
        lastUsed: lastUsedRef.current,
        defaults,
      });
      setValues(result.values);
      if (result.note !== null && authoritative && !notedRef.current) {
        notedRef.current = true;
        void showToast(Toast.Style.Failure, "The registry moved on", result.note);
      }
    },
    [defaults],
  );

  // One effect for the whole lifecycle: read the cache, paint, then dial. The
  // two halves are deliberately not awaited in sequence — the form is usable
  // from the moment the cache lands, and the socket reconciles into it.
  useEffect(() => {
    let disposed = false;

    const run = async (): Promise<void> => {
      const [registry, remembered] = await Promise.all([readRegistry(store), readLastUsed(store)]);
      if (disposed) return;
      const list = sortedMachines(registry?.machines ?? []);
      cachedRef.current = list;
      setMachines(list);
      lastUsedRef.current = remembered;
      // The autoFocus TextArea takes keystrokes from the first frame, before
      // these reads resolve — anything already typed survives the opening values.
      setValues((current) => {
        const opening = { ...initialValues(list, remembered, defaults), prompt: current.prompt };
        valuesRef.current = opening;
        return opening;
      });
      setReady(true);

      let credentials;
      try {
        credentials = await loadKey(
          environment.isDevelopment
            ? { onAccountKeyError: (error) => console.error("account key derivation failed", error) }
            : {},
        );
      } catch (err) {
        if (!disposed) setFatal(err instanceof Error ? err.message : String(err));
        return;
      }
      if (disposed) return;

      // The wire log has somewhere to go under `ray develop` and nowhere at all
      // in a released extension, so it is wired only in dev. Same shape the
      // daemon, relay and PWA emit, so one grep spans every tier.
      const handle = connect(credentials, environment.isDevelopment ? (line) => console.log(line) : undefined);
      handleRef.current = handle;
      // One answered `account:` listing per open, never per push: the relay's list bucket
      // is shared with every app, the PWA included. One lost to a disconnect asks again.
      let progress: ListingProgress = "none";
      const onChange = (): void => {
        const state = handle.getState();
        setRelay(state);
        // Authoritative only once the client marks this socket's registry
        // settled — the moment between `open` and the first push must not read
        // as "every machine vanished". An authoritative *empty* list is cached
        // like any other: a machine removed from the registry must not
        // resurrect from LocalStorage on the next launch.
        if (state.status !== "open" || !state.registrySettled) return;
        absorb(state.machines, true);
        void writeRegistry(store, state.machines, Date.now());
        if (!shouldListAccounts(state, state.machines, progress)) return;
        progress = "inflight";
        // Names show by email until this lands, and stay that way if it fails.
        void readAliases(handle.listAccounts).then((read) => {
          progress = read.lost ? "lost" : "settled";
          if (!disposed) setAliases(read.aliases);
        });
      };
      const unsubscribe = handle.subscribe(onChange);
      onChange();
      disposers.push(unsubscribe);
    };

    const disposers: (() => void)[] = [];
    void run();

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, [absorb, defaults]);

  const connected = relay?.status === "open";
  const auto = values.machineId === AUTO;
  const selected = machines.find((machine) => machine.deviceId === values.machineId) ?? null;
  // From the live registry only: the cached projection keeps no exclaves.
  const accounts = accountLine(relay?.machines ?? [], values.machineId, aliases);

  const start = async (): Promise<void> => {
    const refusal = auto ? "Can't queue a task" : "Can't start a session";
    const check = checkSubmit(values, machines, connected);
    if (!check.ok) {
      await showToast(Toast.Style.Failure, refusal, check.reason);
      return;
    }
    const handle = handleRef.current;
    if (handle === null) {
      await showToast(Toast.Style.Failure, refusal, "No relay connection");
      return;
    }
    if (check.kind === "queue") {
      await queue(handle, check.request, check.label);
      return;
    }

    const request: Omit<SpawnRequest, "client"> = {
      repo: check.repo,
      mode: values.worktree ? "worktree" : "here",
      model: values.model,
      effort: values.effort,
      // An empty prompt is a deliberate mode (start an empty session), and the
      // daemon distinguishes absent from empty — so it is omitted, not blanked.
      ...(values.prompt.trim() === "" ? {} : { prompt: values.prompt }),
    };

    setBusy("spawn");
    let reply: SpawnResponse;
    try {
      reply = await handle.spawn(check.machine.deviceId, request);
    } catch (err) {
      await showToast(Toast.Style.Failure, "Spawn failed", failureText(err));
      return;
    } finally {
      setBusy(null);
    }
    if (!reply.ok) {
      // Stays open with the form intact: the typed prompt is the expensive
      // part of this interaction and must survive a failure.
      await showToast(Toast.Style.Failure, `Spawn failed (${reply.code})`, reply.message);
      return;
    }
    // Only the spawn itself sits in the try above. The session is running now,
    // so a failure in the bookkeeping below must not report "Spawn failed" —
    // that reads as "nothing started" and invites a duplicate.
    const persisted = nextLastUsed(lastUsedRef.current, values);
    lastUsedRef.current = persisted;
    try {
      await writeLastUsed(store, persisted);
      if (reply.pending === true) {
        // Not a spawn failure — the session exists — but it needs someone at that
        // machine, so it gets the style that actually stops you.
        await showToast(Toast.Style.Failure, `${reply.window} started but is stuck`, reply.note);
        return;
      }
      if (reply.note !== undefined) {
        // A note is the one success worth reading, so the window stays put.
        await showToast(Toast.Style.Success, `Started ${reply.window}`, reply.note);
        return;
      }
      await closeMainWindow();
      await showHUD(`Started ${reply.window} on ${check.machine.name}`);
    } catch {
      void showToast(Toast.Style.Success, `Started ${reply.window} on ${check.machine.name}`);
    }
  };

  const queue = async (handle: RelayHandle, request: TaskRequest, label: string): Promise<void> => {
    const pending = taskFor(request, unsettledRef.current, Date.now());
    setBusy("spawn");
    const outcome = await enqueue(handle.createTask, pending.task);
    setBusy(null);
    if (outcome.kind === "refused") {
      // This send stored nothing, but an earlier unsure one of the same form may have:
      // the kept task stays kept, so the next try still re-sends its id.
      // The form stays intact, as on a failed spawn.
      await showToast(Toast.Style.Failure, "Not queued", outcome.message);
      return;
    }
    // Kept after a store too: the window can stay open with the form intact (a leader-wait toast),
    // and Queue again must read "already queued", not queue the work twice.
    unsettledRef.current = pending;
    if (outcome.kind === "unsure") {
      await showToast(Toast.Style.Failure, "Not sure it queued", outcome.message);
      return;
    }
    const title = outcome.landedEarlier ? `${label} was already queued` : `Queued ${label}`;
    // As after a spawn: the task is stored, so bookkeeping failing must not read as "not queued".
    const persisted = nextLastUsed(lastUsedRef.current, values);
    lastUsedRef.current = persisted;
    try {
      await writeLastUsed(store, persisted);
      const wait = leaderWait(handle.getState().scheduler);
      if (wait !== null) {
        // Worth reading, so a toast that stays rather than a HUD that vanishes.
        await showToast(Toast.Style.Success, title, wait);
        return;
      }
      await closeMainWindow();
      await showHUD(title);
    } catch {
      void showToast(Toast.Style.Success, title);
    }
  };

  // Earns its keybinding precisely because cache-first makes a stale repo list
  // the likeliest way this form is wrong.
  const rescan = async (): Promise<void> => {
    const handle = handleRef.current;
    if (selected === null || handle === null || !connected) {
      await showToast(Toast.Style.Failure, "Can't rescan", "Pick a connected machine to rescan");
      return;
    }
    setBusy("rescan");
    const toast = await showToast(Toast.Style.Animated, `Rescanning ${selected.name}…`);
    try {
      const reply = await handle.rescan(selected.deviceId);
      // applyScan already folded this into the client, so the subscription has
      // refreshed the picker by now; the toast just says what changed.
      toast.style = Toast.Style.Success;
      toast.title = `${reply.repos.length} ${reply.repos.length === 1 ? "repo" : "repos"} on ${selected.name}`;
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Rescan failed";
      toast.message = failureText(err);
    } finally {
      setBusy(null);
    }
  };

  if (fatal !== null) {
    return (
      <Detail
        markdown={[
          "# Séance can't reach your credentials",
          "",
          fatal,
          "",
          "This extension reads the relay URL, bearer token and PSK from the local daemon's own",
          "config and keychain — it deliberately keeps no copy of its own.",
        ].join("\n")}
      />
    );
  }

  return (
    <Form
      isLoading={!ready || busy !== null}
      navigationTitle="Spawn a Claude Code session"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={auto ? "Queue" : "Start"}
            icon={auto ? Icon.Tray : Icon.Play}
            onSubmit={() => void start()}
          />
          <Action
            title="Rescan Repos"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={() => void rescan()}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="prompt"
        title="Prompt"
        placeholder="Describe the work — or leave it blank and start empty."
        autoFocus
        value={values.prompt}
        onChange={(prompt) => setValues((current) => ({ ...current, prompt }))}
      />
      <Form.Description title="Relay" text={statusLine(relay, machines)} />
      <Form.Dropdown
        id="machine"
        title="Machine"
        value={values.machineId ?? ""}
        onChange={(machineId) =>
          setValues(
            (current) =>
              // repo: null — switching machines consults the target machine's
              // own remembered repo, never the previous machine's selection.
              reconcile({ ...current, machineId, repo: null }, machines, {
                cached: cachedRef.current,
                lastUsed: lastUsedRef.current,
                defaults,
              }).values,
          )
        }
      >
        <Form.Dropdown.Item
          value={AUTO}
          title="Auto — the scheduler picks"
          icon={{ source: Icon.CircleFilled, tintColor: Color.Blue }}
        />
        {machines.map((machine) => (
          <Form.Dropdown.Item
            key={machine.deviceId}
            value={machine.deviceId}
            title={machine.connected ? machine.name : `${machine.name} — asleep`}
            icon={{ source: Icon.CircleFilled, tintColor: machine.connected ? Color.Green : Color.SecondaryText }}
          />
        ))}
      </Form.Dropdown>
      {accounts === null ? null : <Form.Description title="Accounts" text={accounts} />}
      {auto && relay !== null ? (
        <Form.Description title="Scheduler" text={schedulerLine(relay.scheduler, relay.machines)} />
      ) : null}
      <Form.Dropdown
        id="repo"
        title="Repository"
        value={values.repo ?? ""}
        onChange={(repo) => setValues((current) => ({ ...current, repo }))}
      >
        {repoChoices(values.machineId, machines).map((repo) => (
          <Form.Dropdown.Item key={repo.value} value={repo.value} title={repo.title} keywords={[...repo.keywords]} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="model"
        title="Model"
        value={values.model}
        onChange={(model) => setValues((current) => (isModel(model) ? { ...current, model } : current))}
      >
        {MODELS.map((model) => (
          <Form.Dropdown.Item key={model} value={model} title={MODEL_LABELS[model]} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown
        id="effort"
        title="Effort"
        value={values.effort}
        onChange={(effort) => setValues((current) => (isEffort(effort) ? { ...current, effort } : current))}
      >
        {EFFORTS.map((effort) => (
          <Form.Dropdown.Item key={effort} value={effort} title={EFFORT_LABELS[effort]} />
        ))}
      </Form.Dropdown>
      <Form.Checkbox
        id="worktree"
        label="Fresh worktree"
        info="Branches off the default branch on origin, not off your checkout. Off runs in the repo as it stands."
        value={values.worktree}
        onChange={(worktree) => setValues((current) => ({ ...current, worktree }))}
      />
    </Form>
  );
}
