import { useCallback, useState } from "react";

import {
  PRIME_COMPACTION_NOT_CHECKPOINT,
  hasPrimeContextControls,
  primeCompactionCancelCopy,
  renderPrimeContext,
  resolvePrimeCompactionRequest,
  resolvePrimeUsageRefresh,
  type PrimeContextCapabilities,
  type PrimeContextState,
} from "./primeContext";

export interface PrimeContextStatusProps {
  readonly providerName: string | null | undefined;
  readonly capabilities: PrimeContextCapabilities | undefined;
  readonly state: PrimeContextState | undefined;
  /** Context actions are server-side rejected without a live running turn. */
  readonly hasRunningTurn: boolean;
  readonly onRequestCompaction: () => Promise<boolean>;
  readonly onRefreshUsage: () => Promise<boolean>;
}

/**
 * Current context/compaction/retry status for runtimes that advertise the
 * capability. Every line is derived from the latest authoritative snapshot, so
 * the panel is static between updates — there is nothing to animate.
 *
 * Compaction here is the runtime's own context management. It is never a T3
 * checkpoint and never reverts user work, and the copy says so.
 */
export function PrimeContextStatus(props: PrimeContextStatusProps) {
  const [busy, setBusy] = useState<"compaction" | "usage" | null>(null);
  const compactionDecision = resolvePrimeCompactionRequest(
    props.providerName,
    props.capabilities,
    props.state,
    props.hasRunningTurn,
  );
  const usageDecision = resolvePrimeUsageRefresh(props.capabilities, props.hasRunningTurn);
  const { onRequestCompaction, onRefreshUsage } = props;

  const runCompaction = useCallback(async () => {
    setBusy("compaction");
    try {
      await onRequestCompaction();
    } finally {
      setBusy(null);
    }
  }, [onRequestCompaction]);

  const runUsageRefresh = useCallback(async () => {
    setBusy("usage");
    try {
      await onRefreshUsage();
    } finally {
      setBusy(null);
    }
  }, [onRefreshUsage]);

  if (!hasPrimeContextControls(props.providerName, props.capabilities)) {
    return null;
  }

  const lines = renderPrimeContext(props.state);
  return (
    <div
      className="mx-auto w-full max-w-3xl px-1 pb-1 text-xs text-muted-foreground"
      data-testid="prime-context-status"
    >
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
      <div>{PRIME_COMPACTION_NOT_CHECKPOINT}</div>
      <div>{primeCompactionCancelCopy(props.capabilities)}</div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border px-2 py-0.5 disabled:opacity-50"
          disabled={!compactionDecision.ok || busy !== null}
          title={compactionDecision.reason}
          onClick={() => {
            void runCompaction();
          }}
        >
          Compact context
        </button>
        <button
          type="button"
          className="rounded-md border px-2 py-0.5 disabled:opacity-50"
          disabled={!usageDecision.ok || busy !== null}
          title={usageDecision.reason}
          onClick={() => {
            void runUsageRefresh();
          }}
        >
          Refresh usage
        </button>
      </div>
      {compactionDecision.ok ? null : <div className="mt-1">{compactionDecision.reason}</div>}
      {usageDecision.ok ? null : <div className="mt-1">{usageDecision.reason}</div>}
    </div>
  );
}
