import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";
import {
  PRIME_COMPACTION_NOT_CHECKPOINT,
  PRIME_CONTEXT_NEEDS_RUNNING_TURN,
  hasPrimeContextControls,
  hasPrimeRunningTurn,
  primeCompactionCancelCopy,
  renderPrimeContext,
  resolvePrimeCompactionCancel,
  resolvePrimeCompactionRequest,
  resolvePrimeUsageRefresh,
} from "./primeContext";

describe("prime context controls", () => {
  it("is unavailable without prime-agent or a negotiated capability", () => {
    expect(hasPrimeContextControls("codex", { compaction: true })).toBe(false);
    expect(hasPrimeContextControls("prime-agent", {})).toBe(false);
    expect(hasPrimeContextControls("prime-agent", { compaction: true })).toBe(true);
    expect(hasPrimeContextControls("prime-agent", { usageAndRetry: true })).toBe(true);
  });

  it("derives cancellation copy from the negotiated capability", () => {
    expect(primeCompactionCancelCopy({ compaction: true })).toContain("cannot be cancelled");
    expect(primeCompactionCancelCopy({ compaction: true, compactionCancel: true })).toContain(
      "can be cancelled",
    );
  });

  it("gates manual compaction on capability and current status", () => {
    expect(resolvePrimeCompactionRequest("prime-agent", {}, undefined, true).ok).toBe(false);
    expect(
      resolvePrimeCompactionRequest("prime-agent", { compaction: true }, undefined, true).ok,
    ).toBe(true);
    const running = resolvePrimeCompactionRequest(
      "prime-agent",
      { compaction: true },
      {
        compaction: { status: "running", trigger: "manual" },
      },
      true,
    );
    expect(running).toEqual({ ok: false, reason: "Compaction is already running." });
  });

  it("refuses cancellation the runtime does not support, and explains why", () => {
    expect(
      resolvePrimeCompactionCancel(
        { compaction: true },
        {
          compaction: { status: "running", trigger: "manual" },
        },
      ),
    ).toEqual({ ok: false, reason: primeCompactionCancelCopy({ compaction: true }) });
    expect(
      resolvePrimeCompactionCancel(
        { compaction: true, compactionCancel: true },
        {
          compaction: { status: "succeeded", trigger: "manual" },
        },
      ).ok,
    ).toBe(false);
    expect(
      resolvePrimeCompactionCancel(
        { compaction: true, compactionCancel: true },
        {
          compaction: { status: "running", trigger: "manual" },
        },
      ).ok,
    ).toBe(true);
  });

  it("gates on-demand usage refresh", () => {
    expect(resolvePrimeUsageRefresh({}, true).ok).toBe(false);
    expect(resolvePrimeUsageRefresh({ usageAndRetry: true }, true).ok).toBe(true);
  });

  // Review regression: the server rejects context actions without a live running
  // turn, so an idle thread must disable the controls with that reason instead of
  // letting the press turn into a thread error.
  it("disables both controls with a stated reason when no turn is running", () => {
    expect(hasPrimeRunningTurn({ status: "running", activeTurnId: "turn-1" })).toBe(true);
    expect(hasPrimeRunningTurn({ status: "running", activeTurnId: null })).toBe(false);
    expect(hasPrimeRunningTurn({ status: "ready", activeTurnId: "turn-1" })).toBe(false);
    expect(hasPrimeRunningTurn(undefined)).toBe(false);
    expect(
      resolvePrimeCompactionRequest("prime-agent", { compaction: true }, undefined, false),
    ).toEqual({ ok: false, reason: PRIME_CONTEXT_NEEDS_RUNNING_TURN });
    expect(resolvePrimeUsageRefresh({ usageAndRetry: true }, false)).toEqual({
      ok: false,
      reason: PRIME_CONTEXT_NEEDS_RUNNING_TURN,
    });
    // A thread that is idle while a session-level compaction is still shown gets
    // the truthful reason, not "already running" — that wording was the
    // permanent-lockout copy in the stranded-state blocker.
    expect(
      resolvePrimeCompactionRequest(
        "prime-agent",
        { compaction: true },
        { compaction: { status: "running", trigger: "automatic" } },
        false,
      ),
    ).toEqual({ ok: false, reason: PRIME_CONTEXT_NEEDS_RUNNING_TURN });
  });

  // The two client copies of this module must stay byte-identical; the comment
  // in the source claims exactly that.
  it("keeps the web and mobile copies byte-identical", () => {
    // Both paths resolve from apps/<surface>/src/... up to apps/, so the two
    // suites read the same pair of files.
    const readSource = (relative: string) =>
      readFileSync(new URL(relative, import.meta.url), "utf8");
    expect(readSource("../../../../web/src/components/chat/primeContext.ts")).toBe(
      readSource("../../../../mobile/src/features/threads/primeContext.ts"),
    );
  });

  it("renders a static snapshot of usage, compaction, and retry", () => {
    expect(renderPrimeContext(undefined)).toEqual([]);
    expect(renderPrimeContext({ compaction: { status: "idle", trigger: "automatic" } })).toEqual(
      [],
    );
    expect(
      renderPrimeContext({
        compaction: { status: "failed", trigger: "manual", reason: "provider busy" },
        retry: { attempt: 2, maxAttempts: 3 },
        usage: { usedTokens: 100, maxTokens: 1000 },
      }),
    ).toEqual([
      "Context: 100/1000 tokens used",
      "Compaction failed (manual): provider busy",
      "Retrying: attempt 2 of 3",
    ]);
    expect(
      renderPrimeContext({
        compaction: { status: "succeeded", trigger: "automatic" },
        usage: { usedTokens: 42 },
      }),
    ).toEqual(["Context: 42 tokens used", "Compacted (automatic)"]);
  });

  it("keeps compaction copy distinct from checkpoint/revert", () => {
    expect(PRIME_COMPACTION_NOT_CHECKPOINT).toContain("not a checkpoint");
    expect(PRIME_COMPACTION_NOT_CHECKPOINT).toContain("does not revert");
    expect(renderPrimeContext({ compaction: { status: "succeeded", trigger: "manual" } })).toEqual([
      "Compacted (manual)",
    ]);
  });
});

/**
 * Blocker regression: these helpers must have a production caller. React Native
 * has no render harness in this suite, so reachability is asserted against the
 * composer source and the screen that supplies its handlers — a dead module is
 * exactly the defect this guards.
 */
describe("prime context wiring", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

  it("renders context status and both controls from the composer", () => {
    const composer = read("./ThreadComposer.tsx");
    expect(composer).toContain("renderPrimeContext");
    expect(composer).toContain("resolvePrimeCompactionRequest");
    expect(composer).toContain("resolvePrimeUsageRefresh");
    // The controls know whether a turn is running, which is what the server
    // requires before it accepts either action.
    expect(composer).toContain("hasPrimeRunningTurn(props.selectedThread.session)");
    expect(composer).toContain("session?.contextState");
    expect(composer).toContain("Compact context");
    expect(composer).toContain("Refresh usage");
  });

  it("dispatches real compaction and usage-refresh commands from the thread screen", () => {
    const screen = read("./ThreadRouteScreen.tsx");
    expect(screen).toContain("threadEnvironment.requestCompaction");
    expect(screen).toContain("threadEnvironment.refreshUsage");
    expect(screen).toContain("onRequestCompaction={handleRequestCompaction}");
    expect(screen).toContain("onRefreshUsage={handleRefreshUsage}");
  });
});
