import { describe, expect, test } from "bun:test";
import { RequestFailure } from "@seance/shared";
import { failureText } from "./errors.ts";

describe("failureText", () => {
  test("says nothing started when the relay refused delivery", () => {
    expect(failureText(new RequestFailure("offline", "that machine is not connected"))).toBe(
      "That machine is not connected to the relay",
    );
  });

  test("distinguishes an unknown machine from an offline one", () => {
    expect(failureText(new RequestFailure("unknown", "unknown machine"))).toBe("The relay has never seen that machine");
  });

  test("names the socket, not the machine, when the client lost its connection", () => {
    expect(failureText(new RequestFailure("disconnected", "the relay socket closed"))).toBe(
      "Lost the relay connection before the request went out",
    );
  });

  // A timeout is the one outcome that is genuinely unknown: the request went
  // out and nothing came back, so a session may be running. Saying "failed"
  // flatly would be a lie.
  test("keeps a timeout ambiguous", () => {
    expect(failureText(new RequestFailure("timeout", "spawn timed out after 90000ms"))).toBe(
      "spawn timed out after 90000ms — it may be asleep, or the session may have started anyway",
    );
  });

  test("passes an ordinary Error's message through", () => {
    expect(failureText(new Error("no socket to the relay"))).toBe("no socket to the relay");
  });

  test("stringifies a throw that was not an Error at all", () => {
    expect(failureText("something odd")).toBe("something odd");
  });
});
