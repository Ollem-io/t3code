import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error -- the review artifact is plain ESM with no type declarations.
import * as transcript from "../../../../../packages/contracts/fixtures/pa-a07-prime-goals-heartbeats-transcript.mjs";
import { primeGoalBoard, primeHeartbeatDecision } from "./PrimeGoalsHeartbeats.ts";

/**
 * The PA-A07 review artifact is only evidence while it *executes* the shipped
 * mapper, contract, and client projection. These tests keep it wired to the
 * real implementations instead of a copy that could pass against a broken one.
 */
describe("pa-a07 review artifact", () => {
  it("passes end to end", () => {
    expect(() => transcript.verifyTranscript()).not.toThrow();
  });

  it("maps through the shipped mapper rather than a copy of it", () => {
    const adversarial = [
      { heartbeatId: "hb-t3-1", title: "  Check CI  ", intervalSeconds: 1_200 },
      { heartbeatId: "hb-t3-1", title: "duplicate", intervalSeconds: 1_200 },
      { heartbeatId: "hb-sentinel", title: "Someone else", intervalSeconds: 3_600 },
      { heartbeatId: "hb-t3-2", title: "Too often", intervalSeconds: 5 },
    ];
    const owned = new Set(["hb-t3-1", "hb-t3-2"]);
    expect(transcript.mapBoard(adversarial, owned)).toEqual(
      primeGoalBoard({
        goal: {
          goalId: "goal-1",
          title: "Finish provider adapter review",
          status: "active",
          detail: "3 of 8",
        },
        heartbeats: adversarial as never,
        owned,
        resident: true,
        owner: "T3 thread thread-1",
      }),
    );
    expect(transcript.mapBoard(adversarial, owned).heartbeats).toHaveLength(1);
  });

  it("refuses an unowned target through the shipped ownership gate", () => {
    const board = primeGoalBoard({
      heartbeats: [
        { heartbeatId: "hb-t3-1", title: "Check CI", intervalSeconds: 1_200 },
        { heartbeatId: "hb-sentinel", title: "Someone else", intervalSeconds: 3_600 },
      ] as never,
      owned: new Set(["hb-t3-1"]),
      owner: "T3 thread thread-1",
    });
    expect(primeHeartbeatDecision(board, "hb-sentinel", "delete")).toEqual({
      allowed: false,
      reason: "unknown-heartbeat",
    });
  });
});
