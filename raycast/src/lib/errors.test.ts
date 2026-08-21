import { describe, expect, test } from "bun:test";
import { failureReasonText, RequestFailure } from "@seance/shared";
import { failureText } from "./errors.ts";

describe("failureText", () => {
  test("says nothing started when the relay refused delivery", () => {
    expect(failureText(new RequestFailure("offline", "that machine is not connected"))).toBe(
      "that machine is not connected to the relay",
    );
  });

  test("distinguishes an unknown machine from an offline one", () => {
    expect(failureText(new RequestFailure("unknown", "unknown machine"))).toBe("the relay has never seen that machine");
  });

  test("names the socket, not the machine, when the client lost its connection", () => {
    expect(failureText(new RequestFailure("disconnected", "the relay socket closed"))).toBe(
      "lost the relay connection before the request went out",
    );
  });

  // A timeout is the one outcome that is genuinely unknown: the request went
  // out and nothing came back, so it may have landed anyway. Saying "failed"
  // flatly would be a lie.
  test("keeps a timeout ambiguous", () => {
    expect(failureText(new RequestFailure("timeout", "spawn timed out after 90000ms"))).toBe(
      "spawn timed out after 90000ms — the machine may be asleep, or the request may have landed anyway",
    );
  });

  // "refused" is an undeliverable code minted after this build: no fixed line
  // could name it, so the message — which does — passes through whole.
  test("keeps the relay's own code for a refusal this build does not know", () => {
    expect(
      failureText(new RequestFailure("refused", 'the relay refused to deliver the request (code "rejected")')),
    ).toBe('the relay refused to deliver the request (code "rejected")');
  });

  // The mapping lives in shared/ so this surface and `seanced mcp` explain a
  // reason identically; this pins the wrapper to it.
  test("is the shared mapping verbatim for a RequestFailure", () => {
    const failure = new RequestFailure("offline", "x");
    expect(failureText(failure)).toBe(failureReasonText(failure));
  });

  test("passes an ordinary Error's message through", () => {
    expect(failureText(new Error("no socket to the relay"))).toBe("no socket to the relay");
  });

  test("stringifies a throw that was not an Error at all", () => {
    expect(failureText("something odd")).toBe("something odd");
  });
});
