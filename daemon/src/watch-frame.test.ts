import { describe, expect, test } from "bun:test";
import { isWatchFrameKind, parseWatchFrame } from "./watch-frame.ts";

const ID = "5f0c1c1e-8a5f-4d3a-9d6e-0a3f4a2b7c11";
const PR = "https://github.com/octo/widgets/pull/42";
const RUN = "https://github.com/octo/widgets/actions/runs/123";
const HEAD = "a".repeat(40);
const add = { v: 1, kind: "watch", op: "add", url: PR } as const;

describe("parseWatchFrame", () => {
  test("takes a PR with and without a head", () => {
    expect(parseWatchFrame(add)).toEqual({
      op: "add",
      target: { kind: "pr", pr: { owner: "octo", repo: "widgets", number: 42 } },
    });
    expect(parseWatchFrame({ ...add, head: HEAD })).toEqual({
      op: "add",
      target: { kind: "pr", pr: { owner: "octo", repo: "widgets", number: 42 } },
      head: HEAD,
    });
  });

  test("takes a run with and without an attempt", () => {
    const target = { kind: "run", run: { owner: "octo", repo: "widgets", id: "123" } } as const;
    expect(parseWatchFrame({ ...add, url: RUN })).toEqual({ op: "add", target });
    expect(parseWatchFrame({ ...add, url: `${RUN}/attempts/2` })).toEqual({ op: "add", target });
  });

  test("takes a remove", () => {
    expect(parseWatchFrame({ v: 1, kind: "watch", op: "remove", id: ID })).toEqual({ op: "remove", id: ID });
  });

  test("refuses what is not exactly a frame", () => {
    const bad: unknown[] = [
      { ...add, pane: "%1" },
      { ...add, task: "t-0123456789abcdef" },
      { ...add, v: 2 },
      { ...add, kind: "message" },
      { ...add, op: "nope" },
      { ...add, url: RUN, head: HEAD },
      { ...add, head: "abc" },
      { ...add, head: 7 },
      { ...add, url: "https://gitlab.com/octo/widgets/pull/42" },
      { ...add, url: `${PR}/files` },
      { ...add, url: 7 },
      { v: 1, kind: "watch", op: "add" },
      { v: 1, kind: "watch", op: "remove" },
      { v: 1, kind: "watch", op: "remove", id: ID, url: PR },
      { v: 1, kind: "watch", op: "remove", id: "not-a-uuid" },
      null,
      "watch",
      [],
    ];
    for (const raw of bad) expect(parseWatchFrame(raw)).toBeNull();
  });
});

describe("isWatchFrameKind", () => {
  test("is true only for an object of that kind", () => {
    expect(isWatchFrameKind({ kind: "watch" })).toBe(true);
    expect(isWatchFrameKind({ kind: "message" })).toBe(false);
    for (const raw of [null, undefined, "watch", 3, []]) expect(isWatchFrameKind(raw)).toBe(false);
  });
});
