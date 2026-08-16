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
 * and never reverts work. This module is kept byte-identical with its mobile
 * twin (`apps/mobile/src/features/threads/primeContext.ts`), and each surface's
 * test asserts that equality so the two cannot drift apart.
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

/**
 * The server accepts context actions only while a provider turn is running, so
 * the control says that up front instead of letting the press fail. Callers pass
 * the live turn fact rather than a capability guess.
 */
export const PRIME_CONTEXT_NEEDS_RUNNING_TURN =
  "Context actions are available while a turn is running.";

export function hasPrimeRunningTurn(
  session:
    | { readonly status?: string | undefined; readonly activeTurnId?: string | null }
    | null
    | undefined,
): boolean {
  return session?.status === "running" && (session.activeTurnId ?? null) !== null;
}

export function resolvePrimeCompactionRequest(
  providerName: string | null | undefined,
  capabilities: PrimeContextCapabilities | undefined,
  state: PrimeContextState | undefined,
  hasRunningTurn: boolean,
): { ok: boolean; reason?: string } {
  if (providerName !== "prime-agent" || capabilities?.compaction !== true)
    return { ok: false, reason: "This runtime does not support manual compaction." };
  // Turn liveness is checked before compaction status: an idle thread may still
  // be showing a session-level compaction that started under an earlier turn, and
  // "already running" would be the wrong reason to hand the user there.
  if (!hasRunningTurn) return { ok: false, reason: PRIME_CONTEXT_NEEDS_RUNNING_TURN };
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

export function resolvePrimeUsageRefresh(
  capabilities: PrimeContextCapabilities | undefined,
  hasRunningTurn: boolean,
): {
  ok: boolean;
  reason?: string;
} {
  if (capabilities?.usageAndRetry !== true)
    return { ok: false, reason: "This runtime does not report context usage on demand." };
  if (!hasRunningTurn) return { ok: false, reason: PRIME_CONTEXT_NEEDS_RUNNING_TURN };
  return { ok: true };
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
