import { describe, expect, it } from "vite-plus/test";
import {
  PRIME_COMPACTION_NOT_CHECKPOINT,
  hasPrimeContextControls,
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
    expect(resolvePrimeCompactionRequest("prime-agent", {}, undefined).ok).toBe(false);
    expect(resolvePrimeCompactionRequest("prime-agent", { compaction: true }, undefined).ok).toBe(
      true,
    );
    const running = resolvePrimeCompactionRequest(
      "prime-agent",
      { compaction: true },
      {
        compaction: { status: "running", trigger: "manual" },
      },
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
    expect(resolvePrimeUsageRefresh({}).ok).toBe(false);
    expect(resolvePrimeUsageRefresh({ usageAndRetry: true }).ok).toBe(true);
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
