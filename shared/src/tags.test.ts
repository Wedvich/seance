import { describe, expect, test } from "bun:test";
import {
  agentVisibleTags,
  displayLine,
  displayName,
  joinTags,
  parseTags,
  parseTagValue,
  sessionTagsFit,
  splitTagKey,
  TAG_VALUE_MAX,
  TAGS_PER_PANE_MAX,
  TAGS_PER_WRITER_MAX,
  TASK_TAG_BUDGET,
  writeTags,
} from "./tags.ts";

const UUID = "0b3f5e0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("key grammar", () => {
  test("splits at the last dot, so an adapter's name is part of its namespace", () => {
    expect(splitTagKey("agent.session")).toEqual({ namespace: "agent", suffix: "session" });
    expect(splitTagKey("adapter.linear.ticket")).toEqual({ namespace: "adapter.linear", suffix: "ticket" });
    expect(splitTagKey("owner.label")).toEqual({ namespace: "owner", suffix: "label" });
  });

  test("refuses an unknown namespace, a bad suffix, a bad adapter name and a dotless key", () => {
    for (const key of ["label", "mine.label", "agent.Session", "agent.", ".x", "adapter.Linear.x", "adapter.x.y.z"]) {
      expect(splitTagKey(key)).toBeNull();
    }
    expect(splitTagKey(`self.${"a".repeat(33)}`)).toBeNull();
    expect(splitTagKey(`self.${"a".repeat(32)}`)).not.toBeNull();
  });

  test("a write carries bare suffixes: a full key is refused, never re-homed", () => {
    expect(writeTags("self", { "self.doing": "x" }, "process")).toEqual({ ok: false, code: "invalid" });
    expect(writeTags("adapter.linear", { "adapter.linear.ticket": "x" }, "conversation")).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(writeTags("self", { doing: "fixing it" }, "process")).toEqual({ ok: true, tags: { doing: "fixing it" } });
  });

  test("a known-only namespace refuses a suffix it does not know; an opaque one takes any", () => {
    expect(writeTags("agent", { colour: "red" }, "conversation")).toEqual({ ok: false, code: "unknown_key" });
    expect(writeTags("seance", { anything: "x" }, "process")).toEqual({ ok: false, code: "unknown_key" });
    expect(writeTags("self", { mood: "x" }, "process")).toEqual({ ok: false, code: "unknown_key" });
    expect(writeTags("adapter.linear", { ticket: "LIN-1" }, "conversation")).toEqual({
      ok: true,
      tags: { ticket: "LIN-1" },
    });
    expect(writeTags("owner", { colour: "red" }, "task")).toEqual({ ok: true, tags: { colour: "red" } });
  });

  test('`""` clears a key; a value that fails its parser is refused whole', () => {
    expect(writeTags("self", { doing: "" }, "process", { doing: "old", name: "n" })).toEqual({
      ok: true,
      tags: { name: "n" },
    });
    expect(writeTags("self", { doing: "ok", name: "x".repeat(201) }, "process")).toEqual({
      ok: false,
      code: "invalid",
    });
  });
});

describe("known keys", () => {
  test.each([
    ["agent.kind", "claude", "claude", "conversation"],
    ["agent.kind", "codex", null, "conversation"],
    ["agent.session", UUID, UUID, "conversation"],
    ["agent.session", UUID.toUpperCase(), null, "conversation"],
    ["agent.session", "not-a-uuid", null, "conversation"],
    ["agent.remote", "session_abc123", "session_abc123", "process"],
    ["agent.remote", "session_../x", null, "process"],
    ["agent.remote", "session_abc123", null, "conversation"],
    ["self.doing", "  reading\nthe\tlogs ", "reading the logs", "process"],
    ["self.name", "a".repeat(200), "a".repeat(200), "process"],
    ["self.name", "a".repeat(201), null, "process"],
    ["owner.label", "my session", "my session", "conversation"],
    ["owner.label", "my task", "my task", "task"],
    ["creator.ref", "linear:LIN-123", "linear:LIN-123", "task"],
    ["creator.ref", "linear:has space", null, "task"],
    ["creator.ref", "Linear:LIN-1", null, "task"],
    ["creator.ref", `linear:${"x".repeat(65)}`, null, "task"],
    ["creator.ref-url", "https://linear.app/x/issue/LIN-1", "https://linear.app/x/issue/LIN-1", "task"],
    ["creator.ref-url", "http://linear.app/x", null, "task"],
    ["creator.ref", "linear:LIN-1", null, "conversation"],
  ] as const)("%s = %j", (key, raw, want, scope) => {
    expect(parseTagValue(key, raw, scope)).toBe(want);
  });

  test("the printable rule: controls, bidi and separators gone, cut to bytes on a code point", () => {
    expect(displayLine("a\u0000b‮c d")).toBe("a b c d");
    const long = "é".repeat(TAG_VALUE_MAX);
    const cut = displayLine(long);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(TAG_VALUE_MAX);
    expect(cut).toBe("é".repeat(TAG_VALUE_MAX / 2));
    expect(displayLine("\u0001\u0002 ")).toBe("");
  });
});

describe("caps and budgets", () => {
  test("a session writer holds at most four keys in its namespace", () => {
    const four = { a: "1", b: "2", c: "3", d: "4" };
    expect(writeTags("adapter.linear", four, "conversation").ok).toBe(true);
    expect(writeTags("adapter.linear", { e: "5" }, "conversation", four)).toEqual({ ok: false, code: "full" });
    expect(TAGS_PER_WRITER_MAX).toBe(4);
  });

  test("task writers have their own budgets, so one cannot starve another", () => {
    expect(TASK_TAG_BUDGET).toEqual({ creator: 3, owner: 2, scheduler: 1 });
    expect(writeTags("creator", { a: "1", b: "2", c: "3" }, "task").ok).toBe(true);
    expect(writeTags("creator", { a: "1", b: "2", c: "3", d: "4" }, "task")).toEqual({ ok: false, code: "full" });
    expect(writeTags("owner", { label: "x", b: "2", c: "3" }, "task")).toEqual({ ok: false, code: "full" });
    // `scheduler.*` knows no key in v1, so nothing is ever written there yet.
    expect(writeTags("scheduler", { x: "1" }, "task")).toEqual({ ok: false, code: "unknown_key" });
  });

  test("the pane cap counts every namespace but `adapter.*`, which each have their own four", () => {
    const outside = Array.from({ length: TAGS_PER_PANE_MAX }, (_, i) => `owner.k${i}`);
    expect(sessionTagsFit(outside)).toBe(false); // `owner.*` alone past four
    const spread = ["agent.kind", "agent.session", "agent.remote", "self.doing", "self.name"];
    const adapters = ["a", "b", "c", "d"].flatMap((name) => [1, 2, 3, 4].map((i) => `adapter.${name}.k${i}`));
    expect(sessionTagsFit([...spread, ...adapters])).toBe(true);
    expect(sessionTagsFit([...spread, ...adapters, "adapter.a.k5"])).toBe(false);
  });
});

describe("parseTags", () => {
  test("drops what it does not know, never the map", () => {
    const parsed = parseTags(
      {
        "agent.session": { value: UUID, at: 1, scope: "conversation", verified: true },
        "agent.remote": { value: "session_abc", at: 2, scope: "process" },
        "agent.future": { value: "x", at: 3, scope: "conversation" },
        "mine.thing": { value: "x", at: 3, scope: "process" },
        "self.doing": { value: "x", at: "soon", scope: "process" },
        "agent.kind": { value: "claude", at: 4, scope: "task" },
      },
      { scope: "session" },
    );
    expect(parsed).toEqual({
      "agent.session": { value: UUID, at: 1, scope: "conversation", verified: true },
      "agent.remote": { value: "session_abc", at: 2, scope: "process" },
    });
  });

  test("only an `agent.session` may say it is verified; a non-record is null", () => {
    expect(
      parseTags(
        { "agent.kind": { value: "claude", at: 1, scope: "conversation", verified: true } },
        { scope: "session" },
      ),
    ).toEqual({ "agent.kind": { value: "claude", at: 1, scope: "conversation" } });
    expect(parseTags([], { scope: "session" })).toBeNull();
    expect(parseTags("x", { scope: "task" })).toBeNull();
  });

  test("`known` keeps the known keys alone", () => {
    expect(
      parseTags(
        { "owner.label": { value: "a", at: 1 }, "owner.colour": { value: "red", at: 1 } },
        { scope: "task", known: true },
      ),
    ).toEqual({ "owner.label": { value: "a", at: 1 } });
  });
});

describe("agentVisibleTags", () => {
  test("another agent sees `agent.kind`, never `agent.session` or `agent.remote`", () => {
    expect(
      agentVisibleTags({
        "agent.kind": { value: "claude", at: 1, scope: "conversation" },
        "agent.session": { value: UUID, at: 1, scope: "conversation", verified: true },
        "agent.remote": { value: "session_x", at: 1, scope: "process" },
        "self.doing": { value: "x", at: 1, scope: "process" },
      }),
    ).toEqual({ "agent.kind": { value: "claude", at: 1, scope: "conversation" } });
    expect(agentVisibleTags({ "agent.session": { value: UUID, at: 1, scope: "conversation" } })).toBeUndefined();
    expect(agentVisibleTags(undefined)).toBeUndefined();
  });
});

describe("joinTags and displayName", () => {
  test("each key keeps its scope; the task's `owner.label` wins over the conversation's", () => {
    const joined = joinTags(
      { "owner.label": { value: "task label", at: 3 } },
      { "owner.label": { value: "conv label", at: 2 }, "agent.session": { value: UUID, at: 2, verified: true } },
      { "agent.remote": { value: "session_x", at: 1 } },
    );
    expect(joined).toEqual({
      "owner.label": { value: "task label", at: 3, scope: "task" },
      "agent.session": { value: UUID, at: 2, verified: true, scope: "conversation" },
      "agent.remote": { value: "session_x", at: 1, scope: "process" },
    });
    expect(joinTags()).toEqual({});
  });

  test("owner label > task title > self.name > window, with the source", () => {
    const self = joinTags(null, null, { "self.name": { value: "self named", at: 1 } });
    const owned = joinTags(null, { "owner.label": { value: "owned", at: 1 } }, { "self.name": { value: "s", at: 1 } });
    expect(displayName(owned, { title: "title" }, "zsh")).toEqual({ text: "owned", source: "owner" });
    expect(displayName(self, { title: "the title" }, "zsh")).toEqual({ text: "the title", source: "task" });
    expect(displayName(self, { title: " \n" }, "zsh")).toEqual({ text: "self named", source: "self" });
    expect(displayName(self, null, "zsh")).toEqual({ text: "self named", source: "self" });
    expect(displayName({}, undefined, "zsh\u0007")).toEqual({ text: "zsh", source: "window" });
  });
});
