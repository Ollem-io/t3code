import { useCallback, useState } from "react";

import {
  PRIME_DIALOG_CANCELLED_NOTE,
  PRIME_EDITOR_TEXT_IS_A_SUGGESTION,
  PRIME_NOTICES_ARE_TRANSIENT,
  hasPrimeExtensionUi,
  primeNoticeFingerprint,
  renderPrimeDialogStatus,
  renderPrimeNotice,
  visiblePrimeNotices,
  type PrimeExtensionUiCapabilities,
  type PrimeNoticeBoard,
  type PrimeSessionLiveness,
} from "./primeExtensionUi";

export interface PrimeExtensionStatusProps {
  readonly providerName: string | null | undefined;
  readonly capabilities: PrimeExtensionUiCapabilities | undefined;
  readonly board: PrimeNoticeBoard | undefined;
  /** Liveness fact, so a crashed session never keeps showing dead status. */
  readonly session: PrimeSessionLiveness | undefined;
  /** Typed dialogs still awaiting this viewer's answer. */
  readonly pendingDialogCount: number;
}

/**
 * Bounded transient status from runtime extensions.
 *
 * Every line comes from the latest authoritative snapshot, so the panel is
 * static between updates — there is nothing to animate and nothing lands in the
 * transcript. Dismissal is per viewer and per exact message: the host owns
 * replacement, a viewer only chooses to stop looking at what is on screen now.
 */
export function PrimeExtensionStatus(props: PrimeExtensionStatusProps) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const dismiss = useCallback((fingerprint: string) => {
    setDismissed((current) => new Set(current).add(fingerprint));
  }, []);

  if (!hasPrimeExtensionUi(props.providerName, props.capabilities)) return null;

  const notices = visiblePrimeNotices(props.board, props.session, dismissed);
  const dialogStatus = renderPrimeDialogStatus(props.pendingDialogCount);
  if (notices.length === 0 && dialogStatus === undefined) return null;
  const hasEditorSuggestion = notices.some((notice) => notice.kind === "editor-text");

  return (
    <div
      className="mx-auto w-full max-w-3xl px-1 pb-1 text-xs text-muted-foreground"
      data-testid="prime-extension-status"
    >
      {dialogStatus === undefined ? null : (
        <div data-testid="prime-dialog-status">
          {dialogStatus} {PRIME_DIALOG_CANCELLED_NOTE}
        </div>
      )}
      {notices.map((notice) => {
        const fingerprint = primeNoticeFingerprint(notice);
        return (
          <div key={fingerprint} className="flex items-center gap-2">
            <span>{renderPrimeNotice(notice)}</span>
            <button
              type="button"
              className="rounded-md border px-2 py-0.5"
              onClick={() => {
                dismiss(fingerprint);
              }}
            >
              Dismiss
            </button>
          </div>
        );
      })}
      {hasEditorSuggestion ? <div>{PRIME_EDITOR_TEXT_IS_A_SUGGESTION}</div> : null}
      {notices.length > 0 ? <div>{PRIME_NOTICES_ARE_TRANSIENT}</div> : null}
    </div>
  );
}
