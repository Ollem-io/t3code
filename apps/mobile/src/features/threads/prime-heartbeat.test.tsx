import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_HEARTBEATS_UNAVAILABLE,
  PRIME_HEARTBEAT_DAEMON_DISCLOSURE,
  hasLivePrimeSession,
  hasPrimeGoals,
  primeGoalBoardView,
  primeHeartbeatControls,
  primeHeartbeatDraftDecision,
  renderPrimeGoalBoard,
  type PrimeGoalBoard,
  type PrimeHeartbeat,
} from "./primeHeartbeat";

const running: PrimeHeartbeat = {
  heartbeatId: "hb-owned-1",
  title: "Check CI",
  intervalSeconds: 1_200,
  status: "active",
  nextRunAt: "2026-08-16T09:20:00.000Z",
};
const paused: PrimeHeartbeat = {
  heartbeatId: "hb-owned-2",
  title: "Sweep flaky tests",
  intervalSeconds: 3_600,
  status: "paused",
};
const board: PrimeGoalBoard = {
  goal: { goalId: "goal-1", title: "Finish provider adapter review", status: "active" },
  heartbeats: [running, paused],
  resident: { owner: "T3 thread thread-1" },
};
const live = { status: "running" };
const capabilities = { goals: true };

describe("prime goals and heartbeats surface (mobile)", () => {
  it("is capability-gated to prime-agent", () => {
    expect(hasPrimeGoals("prime-agent", capabilities)).toBe(true);
    expect(hasPrimeGoals("prime-agent", {})).toBe(false);
    expect(hasPrimeGoals("codex", capabilities)).toBe(false);
    expect(hasLivePrimeSession({ status: "stopped" })).toBe(false);
  });

  it("shows the same board and controls as web for the same snapshot", () => {
    expect(primeGoalBoardView("prime-agent", capabilities, board, live)).toEqual({
      kind: "board",
      goal: board.goal,
      heartbeats: board.heartbeats,
      resident: board.resident,
    });
    expect(renderPrimeGoalBoard(board, live)).toEqual([
      "Goal: Finish provider adapter review · In progress",
      "Check CI · every 20 minutes · Running · next 2026-08-16T09:20:00.000Z",
      "Sweep flaky tests · every hour · Paused",
      "Resident Prime Agent session owned by T3 thread thread-1 · Stop session to end it",
    ]);
    expect(primeHeartbeatControls(paused, live, capabilities).map((c) => c.action)).toEqual([
      "heartbeat.resume",
      "heartbeat.delete",
    ]);
  });

  it("discloses residency before creating and refuses what the host would refuse", () => {
    expect(
      primeHeartbeatDraftDecision(board, live, capabilities, {
        title: "Watch the deploy",
        intervalSeconds: 900,
      }),
    ).toEqual({ canCreate: true, disclosure: PRIME_HEARTBEAT_DAEMON_DISCLOSURE });
    expect(
      primeHeartbeatDraftDecision(board, live, capabilities, { title: "x", intervalSeconds: 5 })
        .canCreate,
    ).toBe(false);
  });

  it("renders the panel, its reverse controls, and the confirmation on the composer", () => {
    const composer = readFileSync("apps/mobile/src/features/threads/ThreadComposer.tsx", "utf8");
    expect(composer).toContain('primeGoalsSurface.kind === "unavailable"');
    expect(composer).toContain("{primeGoalsSurface.reason}");
    expect(composer).toContain("primeHeartbeatControls(");
    // The disclosure is a second, explicit step rather than fine print next to
    // an immediate action.
    expect(composer).toContain("primeHeartbeatDraft.canCreate && heartbeatConfirming");
    expect(composer).toContain("{primeHeartbeatDraft.disclosure}");
    // ...and the panel sits outside the runtime-action panel, whose own gate
    // needs `steer`/`followUps`: goals are a separate capability.
    expect(composer.indexOf('primeGoalsSurface.kind === "hidden" ? null : (')).toBeGreaterThan(
      composer.indexOf('primeAgentsSurface.kind === "hidden" ? null : ('),
    );
  });

  it("keeps an older runtime explained rather than hidden", () => {
    expect(primeGoalBoardView("prime-agent", {}, board, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_HEARTBEATS_UNAVAILABLE,
    });
    expect(primeGoalBoardView("prime-agent", capabilities, board, { status: "stopped" })).toEqual({
      kind: "hidden",
    });
  });

  it("shares one projection module with web, so the two cannot drift", () => {
    expect(readFileSync("apps/mobile/src/features/threads/primeHeartbeat.ts", "utf8")).toBe(
      readFileSync("apps/web/src/components/chat/primeHeartbeat.ts", "utf8"),
    );
  });
});
