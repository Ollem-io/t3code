export type PrimeContextCapabilities = {
  readonly compaction?: boolean | undefined;
  readonly compactionCancel?: boolean | undefined;
  readonly usageAndRetry?: boolean | undefined;
};
export type PrimeContextState = {
  readonly compaction: {
    readonly status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
    readonly trigger: "manual" | "automatic";
    readonly reason?: string | undefined;
  };
  readonly retry?:
    | { readonly attempt: number; readonly maxAttempts?: number | undefined }
    | undefined;
  readonly usage?:
    | { readonly usedTokens: number; readonly maxTokens?: number | undefined }
    | undefined;
};

/**
 * Compaction is the runtime's own context management. It is never a checkpoint
 * and never reverts work, and this sentence is the single source of that copy
 * on both clients so the two surfaces cannot drift apart.
 */
export const PRIME_COMPACTION_NOT_CHECKPOINT =
  "Compacting shortens the agent's context. It is not a checkpoint and does not revert your work.";

/** True only when the runtime advertises an actionable PA-A03 context extension. */
export function hasPrimeContextControls(
  providerName: string | null | undefined,
  capabilities: PrimeContextCapabilities | undefined,
): boolean {
  return (
    providerName === "prime-agent" &&
    (capabilities?.compaction === true || capabilities?.usageAndRetry === true)
  );
}

/**
 * Cancellation copy is derived from the negotiated capability, never assumed: a
 * runtime that gains `compactionCancel` must not keep telling users compaction
 * cannot be stopped.
 */
export function primeCompactionCancelCopy(
  capabilities: PrimeContextCapabilities | undefined,
): string {
  return capabilities?.compactionCancel === true
    ? "Compaction can be cancelled while it runs."
    : "Compaction cannot be cancelled by this runtime once it starts.";
}

export function resolvePrimeCompactionRequest(
  providerName: string | null | undefined,
  capabilities: PrimeContextCapabilities | undefined,
  state: PrimeContextState | undefined,
): { ok: boolean; reason?: string } {
  if (providerName !== "prime-agent" || capabilities?.compaction !== true)
    return { ok: false, reason: "This runtime does not support manual compaction." };
  if (state?.compaction.status === "running")
    return { ok: false, reason: "Compaction is already running." };
  return { ok: true };
}

export function resolvePrimeCompactionCancel(
  capabilities: PrimeContextCapabilities | undefined,
  state: PrimeContextState | undefined,
): { ok: boolean; reason?: string } {
  if (capabilities?.compactionCancel !== true)
    return { ok: false, reason: primeCompactionCancelCopy(capabilities) };
  if (state?.compaction.status !== "running")
    return { ok: false, reason: "No compaction is running." };
  return { ok: true };
}

export function resolvePrimeUsageRefresh(capabilities: PrimeContextCapabilities | undefined): {
  ok: boolean;
  reason?: string;
} {
  return capabilities?.usageAndRetry === true
    ? { ok: true }
    : { ok: false, reason: "This runtime does not report context usage on demand." };
}

/**
 * Authoritative snapshot rendering, static by construction: every line is
 * derived from the latest snapshot, so there is nothing to animate between
 * updates.
 */
export function renderPrimeContext(state: PrimeContextState | undefined): string[] {
  if (!state) return [];
  const lines: string[] = [];
  const usage = state.usage;
  if (usage) {
    lines.push(
      usage.maxTokens === undefined
        ? `Context: ${usage.usedTokens} tokens used`
        : `Context: ${usage.usedTokens}/${usage.maxTokens} tokens used`,
    );
  }
  const { status, trigger, reason } = state.compaction;
  if (status !== "idle") {
    const label =
      status === "running"
        ? "Compacting"
        : status === "succeeded"
          ? "Compacted"
          : status === "failed"
            ? "Compaction failed"
            : "Compaction cancelled";
    lines.push(`${label} (${trigger})${reason === undefined ? "" : `: ${reason}`}`);
  }
  const retry = state.retry;
  if (retry && retry.attempt > 0) {
    lines.push(
      retry.maxAttempts === undefined
        ? `Retrying: attempt ${retry.attempt}`
        : `Retrying: attempt ${retry.attempt} of ${retry.maxAttempts}`,
    );
  }
  return lines;
}
