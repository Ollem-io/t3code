// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MAX_PRIME_HEARTBEATS,
  PRIME_GOAL_READ_ONLY,
  PRIME_HEARTBEATS_UNAVAILABLE,
  PRIME_HEARTBEAT_DAEMON_DISCLOSURE,
  PRIME_HEARTBEAT_OWNERSHIP_NOTE,
  hasLivePrimeSession,
  hasPrimeGoals,
  primeGoalBoardView,
  primeHeartbeatControls,
  MAX_PRIME_HEARTBEAT_TITLE_CHARS,
  primeHeartbeatDraftDecision,
  renderPrimeGoalBoard,
  renderPrimeHeartbeat,
  renderPrimeInterval,
  type PrimeGoalBoard,
  type PrimeHeartbeat,
} from "./primeHeartbeat";
import { PrimeHeartbeatPanel } from "./PrimeHeartbeatPanel";

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

describe("prime goals and heartbeats surface", () => {
  it("is unavailable without prime-agent or the negotiated capability", () => {
    expect(hasPrimeGoals("codex", { goals: true })).toBe(false);
    expect(hasPrimeGoals("prime-agent", {})).toBe(false);
    expect(hasPrimeGoals("prime-agent", capabilities)).toBe(true);
    expect(primeGoalBoardView("prime-agent", {}, board, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_HEARTBEATS_UNAVAILABLE,
    });
  });

  // Crash-restart regression shape: a stopped session can keep its last
  // snapshot, and pausing a schedule inside a dead process can never succeed.
  it("shows nothing for a session that is not live", () => {
    expect(hasLivePrimeSession({ status: "ready" })).toBe(true);
    expect(hasLivePrimeSession({ status: "stopped" })).toBe(false);
    expect(primeGoalBoardView("prime-agent", capabilities, board, { status: "stopped" })).toEqual({
      kind: "hidden",
    });
    expect(renderPrimeGoalBoard(board, { status: "stopped" })).toEqual([]);
    for (const control of primeHeartbeatControls(running, { status: "stopped" }, capabilities)) {
      expect(control.enabled).toBe(false);
      expect(control.reason).toBe("This heartbeat's session is no longer running.");
    }
  });

  it("renders current state that every client derives identically", () => {
    expect(renderPrimeInterval(60)).toBe("every minute");
    expect(renderPrimeInterval(1_200)).toBe("every 20 minutes");
    expect(renderPrimeInterval(3_600)).toBe("every hour");
    expect(renderPrimeHeartbeat(running)).toBe(
      "Check CI · every 20 minutes · Running · next 2026-08-16T09:20:00.000Z",
    );
    // A paused heartbeat never advertises a next run.
    expect(renderPrimeHeartbeat({ ...paused, nextRunAt: "2026-08-16T09:20:00.000Z" })).toBe(
      "Sweep flaky tests · every hour · Paused",
    );
    expect(renderPrimeGoalBoard(board, live)).toEqual([
      "Goal: Finish provider adapter review · In progress",
      "Check CI · every 20 minutes · Running · next 2026-08-16T09:20:00.000Z",
      "Sweep flaky tests · every hour · Paused",
      "Resident Prime Agent session owned by T3 thread thread-1 · Stop session to end it",
    ]);
  });

  it("always offers the exact reverse of every state", () => {
    expect(primeHeartbeatControls(running, live, capabilities)).toEqual([
      { action: "heartbeat.pause", label: "Pause", enabled: true },
      { action: "heartbeat.delete", label: "Delete", enabled: true },
    ]);
    expect(primeHeartbeatControls(paused, live, capabilities)).toEqual([
      { action: "heartbeat.resume", label: "Resume", enabled: true },
      { action: "heartbeat.delete", label: "Delete", enabled: true },
    ]);
  });

  it("discloses the resident-daemon consequence before creating anything", () => {
    const decision = primeHeartbeatDraftDecision(board, live, capabilities, {
      title: "Watch the deploy",
      intervalSeconds: 900,
    });
    expect(decision).toEqual({ canCreate: true, disclosure: PRIME_HEARTBEAT_DAEMON_DISCLOSURE });
    expect(PRIME_HEARTBEAT_DAEMON_DISCLOSURE).toContain("resident");
  });

  it("refuses drafts the host would refuse, with the reason stated", () => {
    const refuse = (
      draft: { readonly title: string; readonly intervalSeconds: number },
      current: PrimeGoalBoard | undefined = board,
    ) => primeHeartbeatDraftDecision(current, live, capabilities, draft);
    expect(refuse({ title: "  ", intervalSeconds: 900 })).toEqual({
      canCreate: false,
      reason: "Name what this heartbeat should do.",
    });
    // The wire schema caps the title at 120 characters. Saying so inline is
    // the difference between guidance and a raw dispatch rejection.
    expect(
      refuse({ title: "x".repeat(MAX_PRIME_HEARTBEAT_TITLE_CHARS + 1), intervalSeconds: 900 }),
    ).toEqual({
      canCreate: false,
      reason: `Keep the heartbeat name to ${MAX_PRIME_HEARTBEAT_TITLE_CHARS} characters or fewer.`,
    });
    expect(
      refuse({ title: "x".repeat(MAX_PRIME_HEARTBEAT_TITLE_CHARS), intervalSeconds: 900 })
        .canCreate,
    ).toBe(true);
    for (const intervalSeconds of [30, 90_000, 60.5]) {
      expect(refuse({ title: "Watch", intervalSeconds })).toEqual({
        canCreate: false,
        reason: "A heartbeat runs every minute to once a day.",
      });
    }
    const full = {
      heartbeats: Array.from({ length: MAX_PRIME_HEARTBEATS }, (_unused, index) => ({
        ...running,
        heartbeatId: `hb-${index}`,
      })),
    };
    expect(refuse({ title: "Watch", intervalSeconds: 900 }, full).canCreate).toBe(false);
    expect(
      primeHeartbeatDraftDecision(board, { status: "stopped" }, capabilities, {
        title: "Watch",
        intervalSeconds: 900,
      }),
    ).toEqual({
      canCreate: false,
      reason: "Start a Prime Agent session before scheduling work.",
    });
  });

  it("renders the board, its ownership limit, and the read-only goal", () => {
    const markup = renderToStaticMarkup(
      <PrimeHeartbeatPanel
        providerName="prime-agent"
        capabilities={capabilities}
        board={board}
        session={live}
        onCreateHeartbeat={() => {}}
        onHeartbeatAction={() => {}}
      />,
    );
    expect(markup).toContain("Check CI");
    expect(markup).toContain("Pause");
    expect(markup).toContain("Resume");
    expect(markup).toContain("Delete");
    expect(markup).toContain(PRIME_HEARTBEAT_OWNERSHIP_NOTE);
    expect(markup).toContain(PRIME_GOAL_READ_ONLY);
    expect(markup).toContain("Resident Prime Agent session owned by T3 thread thread-1");
    // The disclosure is a deliberate second step, so it is not on screen until
    // creation is actually requested.
    expect(markup).not.toContain(PRIME_HEARTBEAT_DAEMON_DISCLOSURE);
  });

  it("explains an older runtime instead of rendering nothing", () => {
    const markup = renderToStaticMarkup(
      <PrimeHeartbeatPanel
        providerName="prime-agent"
        capabilities={{}}
        board={board}
        session={live}
        onCreateHeartbeat={() => {}}
        onHeartbeatAction={() => {}}
      />,
    );
    expect(markup).toContain(PRIME_HEARTBEATS_UNAVAILABLE);
    expect(markup).not.toContain("Check CI");
  });

  it("renders nothing for another provider or a dead session", () => {
    for (const props of [
      { providerName: "codex", capabilities, session: live },
      { providerName: "prime-agent", capabilities, session: { status: "stopped" } },
    ]) {
      expect(
        renderToStaticMarkup(
          <PrimeHeartbeatPanel
            board={board}
            onCreateHeartbeat={() => {}}
            onHeartbeatAction={() => {}}
            {...props}
          />,
        ),
      ).toBe("");
    }
  });

  it("keeps the mobile twin byte-identical", () => {
    expect(readFileSync("apps/mobile/src/features/threads/primeHeartbeat.ts", "utf8")).toBe(
      readFileSync("apps/web/src/components/chat/primeHeartbeat.ts", "utf8"),
    );
  });
});
