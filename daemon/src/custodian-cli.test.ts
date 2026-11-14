import { describe, expect, test } from "bun:test";
import { frameFor } from "./custodian-cli.ts";
import { parseCustodianFrame } from "./custodian-frame.ts";

const stdin = (): Promise<string> => Promise.resolve("from stdin");

describe("frameFor's flag arm", () => {
  test("a pane and a reason is a flag with no note; a third word is the note, spaces and all", async () => {
    expect(await frameFor(["flag", "%3", "stuck"], stdin)).toEqual({
      v: 1,
      kind: "custodian",
      verb: "flag",
      pane: "%3",
      reason: "stuck",
    });
    const frame = await frameFor(["flag", "%3", "look", "same error four times"], stdin);
    expect(frame).toMatchObject({ verb: "flag", pane: "%3", reason: "look", note: "same error four times" });
    expect(parseCustodianFrame(frame)).not.toBeNull();
  });

  test("a missing reason, a fourth word and a bare `flag` are no frame: the usage line follows", () => {
    expect(frameFor(["flag", "%3"], stdin)).toBeNull();
    expect(frameFor(["flag", "%3", "stuck", "a", "b"], stdin)).toBeNull();
    expect(frameFor(["flag"], stdin)).toBeNull();
  });
});
