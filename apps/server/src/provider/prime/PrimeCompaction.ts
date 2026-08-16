import type { SessionContextUpdatedPayload, ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type { PrimeRpcKnownEvent } from "./PrimeRpcProtocol.ts";

/**
 * Prime 0.7.2 context management: `get_session_stats` usage, `compact`, and the
 * native compaction/retry status snapshots.
 *
 * Two invariants are load-bearing here:
 *  - Compaction is the runtime's own context management. It is not a T3
 *    checkpoint and never reverts user work, so nothing in this module produces
 *    a revert/rollback concept.
 *  - Absent usage after compaction is valid, not an error. A missing number is
 *    omitted rather than guessed at zero.
 */

/** Native no-argument commands. Exact 0.7.2 shapes, never inferred. */
export const PRIME_SESSION_STATS_COMMAND = Object.freeze({ type: "get_session_stats" as const });
export const PRIME_COMPACT_COMMAND = Object.freeze({ type: "compact" as const });

const MAX_TOKENS = 1_000_000_000;
const MAX_REASON_CHARS = 256;

const boundedInt = (value: unknown, minimum: number): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored < minimum ? undefined : Math.min(floored, MAX_TOKENS);
};

const cleanReason = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, MAX_REASON_CHARS);
  return text.length > 0 ? text : undefined;
};

/**
 * Normalizes a `get_session_stats` response body into the neutral usage
 * snapshot. Unknown fields are dropped; a body with no usable usage yields
 * `undefined` so callers do not publish an invented zero.
 */
export function normalizePrimeSessionStats(data: unknown): ThreadTokenUsageSnapshot | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  const usedTokens = boundedInt(raw.usedTokens ?? raw.totalTokens, 0);
  if (usedTokens === undefined) return undefined;
  const maxTokens = boundedInt(raw.maxTokens ?? raw.contextWindow, 1);
  const inputTokens = boundedInt(raw.inputTokens, 0);
  const outputTokens = boundedInt(raw.outputTokens, 0);
  return {
    usedTokens,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(typeof raw.compactsAutomatically === "boolean"
      ? { compactsAutomatically: raw.compactsAutomatically }
      : {}),
  };
}

const COMPACTION_STATUS = {
  started: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * Folds native context events into the neutral snapshot and bounds how often it
 * is published: streamed usage churn never publishes at all, and a snapshot
 * byte-identical to the last published one is dropped. The status surface is
 * therefore a short list of discrete states, not a repaint loop.
 */
export class PrimeContextTracker {
  #state: SessionContextUpdatedPayload = { compaction: { status: "idle", trigger: "automatic" } };
  #publishedJson: string | undefined;

  get state(): SessionContextUpdatedPayload {
    return this.#state;
  }

  /**
   * Records streamed usage without publishing a context snapshot. Streaming
   * usage already has its own canonical event; this only keeps the context
   * snapshot's usage current for the next status change.
   */
  observeUsage(usage: ThreadTokenUsageSnapshot | undefined): void {
    if (usage) this.#state = { ...this.#state, usage };
  }

  /** Publishes an explicitly requested usage snapshot. */
  applyUsage(
    usage: ThreadTokenUsageSnapshot | undefined,
  ): SessionContextUpdatedPayload | undefined {
    if (!usage) return undefined;
    this.#state = { ...this.#state, usage };
    return this.#publish();
  }

  /** Applies a native event; returns the snapshot to publish, if any. */
  apply(event: PrimeRpcKnownEvent): SessionContextUpdatedPayload | undefined {
    if (event.type === "compaction_update") {
      const reason = cleanReason(event.reason);
      const usedTokens = boundedInt(event.usedTokens, 0);
      const maxTokens = boundedInt(event.maxTokens, 1);
      // Post-compaction usage may legitimately be absent; keep the prior value
      // rather than fabricating one. A partial update merges over the last known
      // snapshot, because the runtime omitting `maxTokens` is not the runtime
      // retracting the context window it already reported.
      const usage =
        usedTokens === undefined
          ? this.#state.usage
          : {
              ...this.#state.usage,
              usedTokens,
              ...(maxTokens === undefined ? {} : { maxTokens }),
            };
      const status = COMPACTION_STATUS[event.phase];
      this.#state = {
        compaction: {
          status,
          trigger: event.trigger,
          ...(reason === undefined ? {} : { reason }),
        },
        // Retry status belongs to the attempt that is still in flight. Once
        // compaction reaches a terminal phase nothing is retrying, so carrying
        // the last attempt forward would display a lie until session exit.
        ...(status === "running" && this.#state.retry !== undefined
          ? { retry: this.#state.retry }
          : {}),
        ...(usage === undefined ? {} : { usage }),
      };
      return this.#publish();
    }
    if (event.type === "retry_update") {
      const reason = cleanReason(event.reason);
      this.#state = {
        ...this.#state,
        retry: {
          attempt: event.attempt,
          ...(event.maxAttempts === undefined ? {} : { maxAttempts: event.maxAttempts }),
          ...(reason === undefined ? {} : { reason }),
        },
      };
      return this.#publish();
    }
    return undefined;
  }

  #publish(): SessionContextUpdatedPayload | undefined {
    const json = JSON.stringify(this.#state);
    if (json === this.#publishedJson) return undefined;
    this.#publishedJson = json;
    return this.#state;
  }
}
