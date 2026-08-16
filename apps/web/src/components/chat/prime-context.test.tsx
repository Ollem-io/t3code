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
import { renderToStaticMarkup } from "react-dom/server";

import { PrimeContextStatus } from "./PrimeContextStatus";

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
 * Blocker regression: the helpers above must be reachable from a real rendered
 * surface, not only from this test. A dead module cannot satisfy "current
 * context/compaction/retry state is visible".
 */
describe("PrimeContextStatus", () => {
  const noop = async () => true;

  it("renders current context status and both controls for a capable runtime", () => {
    const markup = renderToStaticMarkup(
      <PrimeContextStatus
        providerName="prime-agent"
        capabilities={{ compaction: true, compactionCancel: false, usageAndRetry: true }}
        state={{
          compaction: { status: "running", trigger: "manual" },
          retry: { attempt: 1, maxAttempts: 3 },
          usage: { usedTokens: 100, maxTokens: 200_000 },
        }}
        hasRunningTurn
        onRequestCompaction={noop}
        onRefreshUsage={noop}
      />,
    );

    expect(markup).toContain('data-testid="prime-context-status"');
    expect(markup).toContain("Context: 100/200000 tokens used");
    expect(markup).toContain("Compacting (manual)");
    expect(markup).toContain("Retrying: attempt 1 of 3");
    expect(markup).toContain("Compact context");
    expect(markup).toContain("Refresh usage");
    // Compaction is explicitly distinguished from a checkpoint/revert, and no
    // revert affordance is offered alongside it.
    expect(markup).toContain("It is not a checkpoint and does not revert your work.");
    expect(markup).not.toMatch(/>\s*(Revert|Restore|Roll back)/i);
  });

  it("disables the controls and states why when no turn is running", () => {
    const markup = renderToStaticMarkup(
      <PrimeContextStatus
        providerName="prime-agent"
        capabilities={{ compaction: true, usageAndRetry: true }}
        state={{ compaction: { status: "idle", trigger: "automatic" } }}
        hasRunningTurn={false}
        onRequestCompaction={noop}
        onRefreshUsage={noop}
      />,
    );

    expect(markup).toContain(PRIME_CONTEXT_NEEDS_RUNNING_TURN);
    expect(markup.match(/<button[^>]*disabled/g)?.length).toBe(2);
  });

  it("renders nothing for a runtime that advertises no context capability", () => {
    expect(
      renderToStaticMarkup(
        <PrimeContextStatus
          providerName="codex"
          capabilities={undefined}
          state={undefined}
          hasRunningTurn={false}
          onRequestCompaction={noop}
          onRefreshUsage={noop}
        />,
      ),
    ).toBe("");
  });
});
