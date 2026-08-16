import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error -- the review artifact is plain ESM with no type declarations.
import * as transcript from "../../../../../packages/contracts/fixtures/pa-a08-prime-fork-transcript.mjs";
import { primeForkDecision, primeSessionIdentity } from "./PrimeFork.ts";

/**
 * The PA-A08 review artifact is only evidence while it *executes* the shipped
 * mapper, contract, and client projection. These tests keep it wired to the
 * real implementations instead of a copy that could pass against a broken one.
 */
describe("pa-a08 review artifact", () => {
  it("passes end to end", () => {
    expect(() => transcript.verifyTranscript()).not.toThrow();
  });

  it("maps through the shipped mapper rather than a copy of it", () => {
    const adversarial = [
      { messageId: "msg-1", role: "user" as const, preview: "  Start the adapter  " },
      { messageId: "msg-1", role: "assistant" as const, preview: "duplicate" },
      { messageId: "9-not-brandable", role: "user" as const, preview: "Never offered" },
      { messageId: "msg-4", role: "user" as const },
    ];
    expect(transcript.mapIdentity("Migration work", adversarial)).toEqual(
      primeSessionIdentity({ name: "Migration work", messages: adversarial }),
    );
    expect(transcript.mapIdentity("Migration work", adversarial).forkPoints).toHaveLength(2);
  });

  it("refuses a point this session never offered through the shipped gate", () => {
    const card = primeSessionIdentity({
      messages: [{ messageId: "msg-1", role: "user", preview: "Start the adapter" }],
    });
    expect(primeForkDecision(card, "msg-gone")).toEqual({
      allowed: false,
      reason: "unknown-fork-point",
    });
  });
});
