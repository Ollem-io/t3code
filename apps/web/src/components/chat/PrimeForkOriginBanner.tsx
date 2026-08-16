import {
  PRIME_FORK_OPEN_SOURCE_LABEL,
  renderPrimeForkOrigin,
  type PrimeThreadForkOrigin,
} from "./primeFork";

export interface PrimeForkOriginBannerProps {
  /** Thread ancestry as the thread record holds it; null for a thread that was simply created. */
  readonly origin: PrimeThreadForkOrigin | null | undefined;
  readonly onOpenSourceThread: (threadId: string) => void;
}

/**
 * Where this thread came from, and the way back to it.
 *
 * Deliberately outside the Prime Agent panel: ancestry is a T3 thread record,
 * so it must stay readable and navigable when the session is gone, the runtime
 * is older, or Prime Agent is uninstalled entirely. Rendering it beside the
 * provider controls would tie the only way back to a provider that may no
 * longer be there.
 */
export function PrimeForkOriginBanner(props: PrimeForkOriginBannerProps) {
  const label = renderPrimeForkOrigin(props.origin);
  if (!props.origin || label === "") return null;
  const sourceThreadId = props.origin.threadId;
  return (
    <div
      className="flex items-center gap-2 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground"
      data-testid="prime-fork-origin"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        className="rounded-md border px-2 py-0.5"
        data-testid="prime-fork-origin-open"
        onClick={() => {
          props.onOpenSourceThread(sourceThreadId);
        }}
      >
        {PRIME_FORK_OPEN_SOURCE_LABEL}
      </button>
    </div>
  );
}
