import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error -- the review artifact is plain ESM with no type declarations.
import * as transcript from "../../../../../packages/contracts/fixtures/pa-a06-prime-agents-transcript.mjs";
import { primeAgentRoster, primeObservationDecision } from "./PrimeObservation.ts";

/**
 * The PA-A06 review artifact is only evidence while it *executes* the shipped
 * mapper, contract, and client projection. These tests keep it wired to the
 * real implementations instead of a copy that could pass against a broken one.
 */
describe("pa-a06 review artifact", () => {
  it("passes end to end", () => {
    expect(() => transcript.verifyTranscript()).not.toThrow();
  });

  it("maps through the shipped mapper rather than a copy of it", () => {
    const adversarial = [
      { taskId: "root-1", title: "  Refactor  ", status: "running" },
      { taskId: "sub-1", parentTaskId: "root-1", title: "x".repeat(400), status: "paused" },
      { taskId: "sub-1", parentTaskId: "root-1", title: "duplicate", status: "running" },
      { taskId: "   ", status: "running" },
    ];
    expect(transcript.mapRoster(adversarial)).toEqual(primeAgentRoster(adversarial as never));
    expect(transcript.mapRoster(adversarial)).toHaveLength(2);
  });

  it("refuses an unowned target through the shipped ownership gate", () => {
    const roster = primeAgentRoster([{ taskId: "sub-1", status: "running" }] as never);
    expect(primeObservationDecision(roster, "sub-9", "observe")).toEqual({
      allowed: false,
      reason: "unknown-agent",
    });
  });
});
