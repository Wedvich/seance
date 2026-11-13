import { describe, expect, test } from "bun:test";
import type { ArchivedTask, ArchivistEntry, Machine, RelayState, Task } from "@seance/shared";
import { deriveOlder, olderRequest } from "../src/older-view.ts";
import {
  CLOSED_OLDER,
  DEFAULT_FORM,
  NO_OLDER_FILTERS,
  OLDER_DATE_SPANS,
  RESCAN_IDLE,
  type OlderList,
  type OlderState,
  type QueueState,
} from "../src/state.ts";
import type { AppState } from "../src/view.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = "github.com/acme/app";
const ARCHIVIST: ArchivistEntry = {
  deviceId: "arch-1",
  name: "archive",
  platform: "linux",
  connected: true,
  lastSeen: NOW,
};

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    deviceId: "dev-a",
    name: "box-a",
    platform: "linux",
    repos: [{ name: "app", path: "/r/app", defaultBranch: "main", origin: ORIGIN }],
    scannedAt: NOW,
    lastSeen: NOW,
    connected: true,
    exclaves: [
      {
        id: "default",
        accountId: "org-1:acct-1",
        email: "one@example.com",
        extraUsageEnabled: null,
        authOk: true,
        skills: [],
      },
    ],
    ...overrides,
  };
}

function state(
  older: Partial<OlderState>,
  overrides: Partial<AppState> = {},
  relay: Partial<RelayState> = {},
): AppState {
  const machines = relay.machines ?? [machine()];
  return {
    relay: {
      status: "open",
      rejection: null,
      archivist: ARCHIVIST,
      machines,
      registrySize: machines.length,
      ignored: 0,
      unbound: 0,
      skewed: 0,
      settling: false,
      registrySettled: true,
      fleetQuota: [],
      scheduler: { kind: "ready", deviceId: "dev-a", term: 1 },
      ...relay,
    },
    form: DEFAULT_FORM,
    autonomy: "checkpoint",
    promptUndo: null,
    sheet: null,
    settings: false,
    machines: false,
    history: null,
    spawning: false,
    rescan: RESCAN_IDLE,
    verdict: null,
    held: [],
    preview: null,
    sessions: {},
    queue: true,
    wide: false,
    queueView: null,
    focusedTask: null,
    taskAction: null,
    queueNotice: null,
    startNowRefusal: null,
    pausing: false,
    discarding: false,
    accounts: { aliases: {}, nameable: true, saving: null, renaming: null, notice: null },
    attachments: [],
    attachNotice: null,
    heldDropped: [],
    awaitingUploads: false,
    archiveStatus: null,
    older: { ...CLOSED_OLDER, open: true, deviceId: "arch-1", ...older },
    ...overrides,
  };
}

function archived(id: string, fields: Partial<Task> = {}, row: Partial<ArchivedTask> = {}): ArchivedTask {
  return {
    task: {
      id,
      spec: { repo: ORIGIN, mode: "worktree", title: `Task ${id}` },
      state: "done",
      createdAt: NOW - 3 * DAY,
      assignment: { deviceId: "dev-a", exclave: "default", clone: "app" },
      ...fields,
    },
    endedAt: NOW - 2 * DAY,
    machine: "box-a",
    account: null,
    alias: null,
    ...row,
  };
}

function page(tasks: readonly ArchivedTask[], fields: Partial<Extract<OlderList, { kind: "ok" }>> = {}): OlderList {
  return { kind: "ok", tasks, total: tasks.length, next: null, loadingMore: false, moreError: null, ...fields };
}

function live(ids: readonly string[]): QueueState {
  return {
    kind: "ok",
    tasks: ids.map((id) => ({ id, spec: { repo: ORIGIN, mode: "worktree" }, state: "done", createdAt: NOW })),
    holds: [],
    unreadable: [],
    idle: [],
    at: NOW,
    skew: 0,
  };
}

const CURSOR = { endedAt: NOW - 9 * DAY, createdAt: NOW - 10 * DAY, id: "t-z" };

describe("Older (docs/archivist.md A34–A36j)", () => {
  test("is not there at all while no archivist is online (A35)", () => {
    expect(deriveOlder(state({}, {}, { archivist: null }), NOW)).toBeNull();
    expect(deriveOlder(state({}, {}, { archivist: { ...ARCHIVIST, connected: false } }), NOW)).toBeNull();
    expect(deriveOlder(state({ open: false }), NOW)).toMatchObject({ open: false });
  });

  test("lists only tasks the live queue does not, and counts the same rows", () => {
    const view = deriveOlder(
      state(
        { list: page([archived("t-1"), archived("t-2"), archived("t-3")], { total: 40, next: CURSOR }) },
        {
          queueView: live(["t-1"]),
        },
      ),
      NOW,
    );
    expect(view?.rows.map((row) => row.id)).toEqual(["t-2", "t-3"]);
    expect(view?.showing).toBe("Showing 2 of 39");
    expect(view?.more).toEqual({ loading: false });
    expect(view?.status).toBeNull();
  });

  test("an archived card shows what the archive holds and offers nothing to act on (A36i)", () => {
    const row = archived(
      "t-1",
      {
        state: "done",
        doneBy: "merged",
        prUrl: "https://github.com/acme/app/pull/12",
        pr: { state: "merged", at: NOW - DAY, checks: "passing" },
        remoteSession: "session_abc",
      },
      { account: "account:feedface00", alias: "Work" },
    );
    const [card] = deriveOlder(state({ list: page([row]) }), NOW)?.rows ?? [];
    expect(card).toMatchObject({
      title: "Task t-1",
      headline: "Its PR merged on box-a",
      age: "2d ago",
      body: "Created 3d ago.",
      placement: "acme/app · Work",
      canCancel: false,
      canMarkDone: false,
      canContinue: false,
      canFollowUp: false,
      startNow: null,
      inline: null,
      session: null,
      answer: null,
    });
    expect(card?.pr).toMatchObject({ label: "#12", state: "merged", checks: null, stale: false, blocked: null });
  });

  test("a failed card says why, and names a retired machine by its last known name", () => {
    const row = archived(
      "t-1",
      {
        state: "failed",
        failure: { code: "dispatch_unconfirmed", message: "" },
        assignment: { deviceId: "dev-gone", exclave: "default", clone: "app" },
      },
      { machine: "old-box" },
    );
    const [card] = deriveOlder(state({ list: page([row]) }), NOW)?.rows ?? [];
    expect(card?.headline).toBe("It failed on old-box");
    expect(card?.dot).toBe("err");
    expect(card?.body).toMatch(/Created 3d ago\.$/u);
    expect(card?.body).not.toBe("Created 3d ago.");
  });

  test("an account shows by its name here when its store key is one this install knows", () => {
    const row = archived("t-1", {}, { account: "account:feedface00", alias: "Archived name" });
    const aliased = state(
      { list: page([row]), accountKeys: { "account:feedface00": "org-1:acct-1" } },
      {
        accounts: {
          aliases: { "org-1:acct-1": "Live name" },
          nameable: true,
          saving: null,
          renaming: null,
          notice: null,
        },
      },
    );
    expect(deriveOlder(aliased, NOW)?.rows[0]?.placement).toBe("acme/app · Live name");
    const plain = state({ list: page([row]), accountKeys: { "account:feedface00": "org-1:acct-1" } });
    expect(deriveOlder(plain, NOW)?.rows[0]?.placement).toBe("acme/app · one@example.com");
    const unknown = state({ list: page([archived("t-2", {}, { account: "account:0123456789ab" })]) });
    expect(deriveOlder(unknown, NOW)?.rows[0]?.placement).toBe("acme/app · acct 01234567");
  });

  test("says Loading… under the filters until the first page lands, and an archive failure as it is", () => {
    expect(deriveOlder(state({ list: null }), NOW)?.status).toBe("Loading…");
    expect(deriveOlder(state({ list: { kind: "loading" } }), NOW)?.status).toBe("Loading…");
    const failed = deriveOlder(
      state({ list: { kind: "failed", message: "No answer — the archivist may be offline." } }),
      NOW,
    );
    expect(failed).toMatchObject({ status: "No answer — the archivist may be offline.", rows: [], showing: null });
    // A page of live duplicates read on by the store: still loading, not "no match".
    const reading = deriveOlder(
      state({ list: page([archived("t-1")], { next: CURSOR, loadingMore: true }) }, { queueView: live(["t-1"]) }),
      NOW,
    );
    expect(reading).toMatchObject({ status: "Loading…", more: null });
    // Rows that turned live after the read leave nothing shown but a cursor: Load older stays on offer.
    const stranded = deriveOlder(
      state({ list: page([archived("t-1")], { next: CURSOR }) }, { queueView: live(["t-1"]) }),
      NOW,
    );
    expect(stranded).toMatchObject({ rows: [], more: { loading: false } });
  });

  test("a narrowed read that finds nothing offers to clear; an unnarrowed one just says so", () => {
    const narrowed = deriveOlder(state({ list: page([]), filters: { ...NO_OLDER_FILTERS, title: "deploy" } }), NOW);
    expect(narrowed).toMatchObject({ status: "No older tasks match.", clearable: true });
    const whole = deriveOlder(state({ list: page([]) }), NOW);
    expect(whole).toMatchObject({ status: "No older tasks.", clearable: false });
  });

  test("Load older shows its own progress and failure, keeping the rows", () => {
    const loading = deriveOlder(
      state({ list: page([archived("t-1")], { next: CURSOR, total: 30, loadingMore: true }) }),
      NOW,
    );
    expect(loading?.more).toEqual({ loading: true });
    const failed = deriveOlder(
      state({ list: page([archived("t-1")], { next: CURSOR, total: 30, moreError: "oops" }) }),
      NOW,
    );
    expect(failed).toMatchObject({ moreError: "oops", more: { loading: false }, showing: "Showing 1 of 30" });
  });

  test("the tiles say Any until picked, Dates its preset", () => {
    const view = deriveOlder(
      state({
        filters: {
          ...NO_OLDER_FILTERS,
          repo: ORIGIN,
          outcome: "failed",
          machine: { id: "dev-a", label: "box-a" },
          dates: "30d",
        },
      }),
      NOW,
    );
    expect(view?.tiles.map(({ sheet, tile }) => [sheet, tile.value])).toEqual([
      ["repo", "acme/app"],
      ["outcome", "Failed"],
      ["machine", "box-a"],
      ["account", "Any"],
      ["dates", "Last 30 days"],
    ]);
  });

  test("the Machine sheet lists retired machines under their last known name (A24, A36h)", () => {
    const rows = [
      archived(
        "t-1",
        { assignment: { deviceId: "dev-gone", exclave: "default", clone: "app" } },
        { machine: "old-box", endedAt: NOW - 41 * DAY },
      ),
      archived("t-2"),
    ];
    const view = deriveOlder(
      state(
        { list: page(rows), sheet: "machine" },
        {},
        {
          machines: [
            machine(),
            machine({ deviceId: "dev-b", name: "box-b", connected: false, lastSeen: NOW - 3 * DAY }),
          ],
        },
      ),
      NOW,
    );
    expect(view?.sheet?.options.map((o) => [o.label, o.sub])).toEqual([
      ["Any", "every machine"],
      ["box-a", null],
      ["box-b", "offline · last seen 3d ago"],
      ["old-box", "no longer listed · last seen 41d ago"],
    ]);
    expect(view?.sheet?.options.at(-1)?.pick).toEqual({ machine: { id: "dev-gone", label: "old-box" } });
  });

  test("the Account sheet lists accounts by store key, never a raw id", () => {
    const view = deriveOlder(
      state({
        list: page([archived("t-1", {}, { account: "account:aaaa", alias: "Side" })]),
        sheet: "account",
        accountKeys: { "account:bbbb": "org-1:acct-1" },
      }),
      NOW,
    );
    expect(view?.sheet?.options.map((o) => [o.label, o.pick])).toEqual([
      ["Any", { account: null }],
      ["one@example.com", { account: { id: "account:bbbb", label: "one@example.com" } }],
      ["Side", { account: { id: "account:aaaa", label: "Side" } }],
    ]);
  });

  test("the Dates sheet offers presets only", () => {
    const view = deriveOlder(state({ sheet: "dates" }), NOW);
    expect(view?.sheet?.options.map((o) => o.label)).toEqual([
      "Last 7 days",
      "Last 30 days",
      "Last 90 days",
      "Last year",
      "Any time",
    ]);
  });
});

describe("olderRequest", () => {
  test("sends a page of 20 with no filter by default", () => {
    expect(olderRequest(NO_OLDER_FILTERS, NOW)).toEqual({ limit: 20 });
  });

  test("maps every filter, bounds the dates from now and trims the search", () => {
    expect(
      olderRequest(
        {
          repo: ORIGIN,
          outcome: "cancelled",
          machine: { id: "dev-a", label: "box-a" },
          account: { id: "account:aaaa", label: "Side" },
          dates: "7d",
          title: "  deploy ",
        },
        NOW,
        CURSOR,
      ),
    ).toEqual({
      limit: 20,
      before: CURSOR,
      repo: ORIGIN,
      outcome: "cancelled",
      machine: "dev-a",
      account: "account:aaaa",
      since: NOW - OLDER_DATE_SPANS["7d"],
      title: "deploy",
    });
    expect(olderRequest({ ...NO_OLDER_FILTERS, title: "   " }, NOW)).toEqual({ limit: 20 });
  });
});
