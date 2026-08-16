import { describe, expect, it } from "vite-plus/test";
import {
  PRIME_COMPACT_COMMAND,
  PRIME_SESSION_STATS_COMMAND,
  PrimeContextTracker,
  normalizePrimeSessionStats,
} from "./PrimeCompaction.ts";
import { decodePrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";

describe("prime session stats", () => {
  it("uses the exact declared native command shapes", () => {
    expect(PRIME_SESSION_STATS_COMMAND).toEqual({ type: "get_session_stats" });
    expect(PRIME_COMPACT_COMMAND).toEqual({ type: "compact" });
  });

  it("normalizes usage and drops unknown fields", () => {
    expect(
      normalizePrimeSessionStats({
        usedTokens: 120.7,
        maxTokens: 8000,
        inputTokens: 10,
        outputTokens: 20,
        compactsAutomatically: true,
        somethingNew: "ignored",
      }),
    ).toEqual({
      usedTokens: 120,
      maxTokens: 8000,
      inputTokens: 10,
      outputTokens: 20,
      compactsAutomatically: true,
    });
  });

  it("treats absent usage as absent rather than zero", () => {
    expect(normalizePrimeSessionStats(undefined)).toBeUndefined();
    expect(normalizePrimeSessionStats({})).toBeUndefined();
    expect(normalizePrimeSessionStats({ usedTokens: "many" })).toBeUndefined();
    expect(normalizePrimeSessionStats({ usedTokens: 0 })).toEqual({ usedTokens: 0 });
  });
});

const compaction = (extra: Record<string, unknown>) => ({
  type: "compaction_update" as const,
  ...extra,
});

describe("prime context tracker", () => {
  const trackerWithClock = () => ({ tracker: new PrimeContextTracker() });

  it("maps the manual compaction lifecycle", () => {
    const { tracker } = trackerWithClock();
    expect(tracker.apply(compaction({ phase: "started", trigger: "manual" }) as never)).toEqual({
      compaction: { status: "running", trigger: "manual" },
    });
    expect(
      tracker.apply(
        compaction({
          phase: "completed",
          trigger: "manual",
          usedTokens: 50,
          maxTokens: 900,
        }) as never,
      ),
    ).toEqual({
      compaction: { status: "succeeded", trigger: "manual" },
      usage: { usedTokens: 50, maxTokens: 900 },
    });
  });

  it("keeps prior usage when post-compaction usage is absent", () => {
    const { tracker } = trackerWithClock();
    tracker.observeUsage({ usedTokens: 700 });
    const snapshot = tracker.apply(
      compaction({ phase: "completed", trigger: "automatic" }) as never,
    );
    expect(snapshot?.usage).toEqual({ usedTokens: 700 });
  });

  it("records failure and cancellation truthfully", () => {
    const { tracker } = trackerWithClock();
    expect(
      tracker.apply(
        compaction({ phase: "failed", trigger: "manual", reason: "provider busy" }) as never,
      ),
    ).toEqual({ compaction: { status: "failed", trigger: "manual", reason: "provider busy" } });
    expect(tracker.apply(compaction({ phase: "cancelled", trigger: "manual" }) as never)).toEqual({
      compaction: { status: "cancelled", trigger: "manual" },
    });
  });

  it("coalesces byte-identical snapshots", () => {
    const { tracker } = trackerWithClock();
    const event = compaction({ phase: "started", trigger: "automatic" }) as never;
    expect(tracker.apply(event)).toBeDefined();
    expect(tracker.apply(event)).toBeUndefined();
  });

  it("never publishes streamed usage churn, and never delays a status change", () => {
    const { tracker } = trackerWithClock();
    tracker.observeUsage({ usedTokens: 1 });
    tracker.observeUsage({ usedTokens: 2 });
    expect(
      tracker.apply(compaction({ phase: "started", trigger: "automatic" }) as never)?.usage,
    ).toEqual({ usedTokens: 2 });
    expect(tracker.applyUsage({ usedTokens: 3 })).toBeDefined();
    expect(tracker.applyUsage({ usedTokens: 3 })).toBeUndefined();
  });

  // Review regression: a terminal compaction phase must not keep showing a retry
  // attempt that is no longer in flight.
  it("clears retry status once compaction reaches a terminal phase", () => {
    const { tracker } = trackerWithClock();
    tracker.apply({ type: "retry_update", attempt: 1, maxAttempts: 3 } as never);
    const published = tracker.apply({
      type: "compaction_update",
      phase: "completed",
      trigger: "manual",
    } as never);
    expect(published?.retry).toBeUndefined();
  });

  it("keeps retry status visible while compaction is still running", () => {
    const { tracker } = trackerWithClock();
    tracker.apply({ type: "retry_update", attempt: 2, maxAttempts: 3 } as never);
    const published = tracker.apply({
      type: "compaction_update",
      phase: "started",
      trigger: "automatic",
    } as never);
    expect(published?.retry).toEqual({ attempt: 2, maxAttempts: 3 });
  });

  // Review regression: omitting maxTokens is not the runtime retracting the
  // context window it already reported.
  it("merges partial compaction usage over the last known snapshot", () => {
    const { tracker } = trackerWithClock();
    tracker.applyUsage({ usedTokens: 100, maxTokens: 200_000, compactsAutomatically: true });
    const published = tracker.apply({
      type: "compaction_update",
      phase: "completed",
      trigger: "manual",
      usedTokens: 4_200,
    } as never);
    expect(published?.usage).toEqual({
      usedTokens: 4_200,
      maxTokens: 200_000,
      compactsAutomatically: true,
    });
  });

  it("tracks retry attempts", () => {
    const { tracker } = trackerWithClock();
    expect(tracker.apply({ type: "retry_update", attempt: 1, maxAttempts: 3 } as never)).toEqual({
      compaction: { status: "idle", trigger: "automatic" },
      retry: { attempt: 1, maxAttempts: 3 },
    });
  });
});

describe("prime compaction protocol boundary", () => {
  it("decodes the declared compaction and retry events", () => {
    expect(
      decodePrimeRpcEnvelope({ type: "compaction_update", phase: "started", trigger: "manual" })
        ._tag,
    ).toBe("known-event");
    expect(decodePrimeRpcEnvelope({ type: "retry_update", attempt: 1 })._tag).toBe("known-event");
  });

  it("refuses an unrecognized shape instead of reinterpreting it", () => {
    expect(
      decodePrimeRpcEnvelope({
        type: "compaction_update",
        phase: "started",
        trigger: "manual",
        extra: 1,
      })._tag,
    ).toBe("malformed");
    expect(decodePrimeRpcEnvelope({ type: "compaction_update", phase: "unknown" })._tag).toBe(
      "malformed",
    );
  });

  it("accepts the compaction and stats commands", () => {
    expect(decodePrimeRpcEnvelope({ ...PRIME_COMPACT_COMMAND })._tag).toBe("command");
    expect(decodePrimeRpcEnvelope({ ...PRIME_SESSION_STATS_COMMAND })._tag).toBe("command");
  });
});
