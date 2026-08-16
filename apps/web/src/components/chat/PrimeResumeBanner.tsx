import { useState } from "react";

import {
  PRIME_RESUME_ARCHIVE_NOTE,
  PRIME_RESUME_STOP_NOTE,
  primeResumeSurface,
  type PrimeResumeIntent,
  type PrimeResumeModel,
} from "@t3tools/client-runtime/prime-resume";

export interface PrimeResumeBannerProps {
  readonly providerName: string | null | undefined;
  readonly model: PrimeResumeModel;
  /** Dispatches the chosen recovery. A cancelled confirmation dispatches nothing. */
  readonly onRecover: (intent: PrimeResumeIntent) => void;
}

/**
 * PA-B04 — what happened to this thread's durable Prime Agent session, and the
 * explicit way out of every refusal.
 *
 * Reconnecting and every refusal keep the composer shut (`composerBlocked` on
 * the shared surface); this banner is the only place that says why. Retry and
 * fork are reversible and dispatch immediately. A fresh start is not — it is
 * the choice that leaves an earlier session behind — so it is confirmed first,
 * with copy that states plainly that nothing is deleted.
 */
export function PrimeResumeBanner(props: PrimeResumeBannerProps) {
  const [confirming, setConfirming] = useState(false);
  const surface = primeResumeSurface(props.providerName, props.model);
  if (surface.kind === "hidden") return null;

  return (
    <div
      className="px-2 py-1 text-xs text-muted-foreground"
      data-testid="prime-resume"
      data-state={surface.kind}
    >
      <div data-testid="prime-resume-title">{surface.title}</div>
      <div data-testid="prime-resume-detail">{surface.detail}</div>
      {surface.composerBlocked ? (
        <div data-testid="prime-resume-composer-blocked">
          Sending is paused for this thread until you choose what to do, so no message can start a
          new session by accident.
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {surface.choices.map((choice) => (
          <button
            key={choice.kind}
            type="button"
            className="rounded-md border px-2 py-0.5"
            data-testid={`prime-resume-${choice.kind}`}
            onClick={() => {
              if (choice.kind === "fresh") {
                setConfirming(true);
                return;
              }
              props.onRecover({ kind: choice.kind });
            }}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {surface.choices.map((choice) =>
        choice.kind === "fresh" && confirming ? (
          <div key="confirm" data-testid="prime-resume-fresh-confirm">
            <span>{choice.confirm}</span>
            <span data-testid="prime-resume-stop-note">{PRIME_RESUME_STOP_NOTE}</span>
            <span data-testid="prime-resume-archive-note">{PRIME_RESUME_ARCHIVE_NOTE}</span>
            <button
              type="button"
              className="rounded-md border px-2 py-0.5"
              onClick={() => {
                setConfirming(false);
                props.onRecover({ kind: "fresh", discardCursor: choice.discardCursor });
              }}
            >
              Start a new session
            </button>
            <button
              type="button"
              className="rounded-md border px-2 py-0.5"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        ) : null,
      )}
    </div>
  );
}
