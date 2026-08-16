export type PrimeExtensionUiCapabilities = {
  readonly interactions?: boolean | undefined;
};
export type PrimeNotice = {
  readonly key: string;
  readonly kind: "notification" | "status" | "widget" | "title" | "editor-text";
  readonly severity: "info" | "warning" | "error";
  readonly text: string;
  readonly lines?: ReadonlyArray<string> | undefined;
};
export type PrimeNoticeBoard = { readonly notices: ReadonlyArray<PrimeNotice> };
export type PrimeSessionLiveness = {
  readonly status?: string | undefined;
} | null;

/**
 * Extension UI status is *now*, never history. This module is kept
 * byte-identical with its mobile twin
 * (`apps/mobile/src/features/threads/primeExtensionUi.ts`), and each surface's
 * test asserts that equality so the two cannot drift apart.
 */
export const PRIME_NOTICES_ARE_TRANSIENT =
  "Live status from the agent's extensions. It is not part of the transcript and clears when the session ends.";

/** Copy for the one operation T3 deliberately does not perform on the user's behalf. */
export const PRIME_EDITOR_TEXT_IS_A_SUGGESTION =
  "The agent suggested composer text. T3 shows it instead of overwriting what you are typing.";

/** True only when the runtime advertises the PA-A05 extension UI extension. */
export function hasPrimeExtensionUi(
  providerName: string | null | undefined,
  capabilities: PrimeExtensionUiCapabilities | undefined,
): boolean {
  return providerName === "prime-agent" && capabilities?.interactions === true;
}

/**
 * A board only describes a live runtime. After a crash or restart the session
 * row can survive with its last snapshot attached, and showing a dead
 * extension's "Indexing…" would be a lie no event can ever clear.
 */
export function hasLivePrimeSession(session: PrimeSessionLiveness | undefined): boolean {
  return session?.status === "running" || session?.status === "ready";
}

/**
 * Identity of what is currently displayed. A replaced entry gets a new
 * fingerprint, so dismissing "Indexing 40%" does not also hide "Indexing 90%":
 * dismissal hides one exact message, it does not mute a key forever.
 */
export function primeNoticeFingerprint(notice: PrimeNotice): string {
  return [notice.key, notice.text, ...(notice.lines ?? [])].join("\u001f");
}

/**
 * The notices a client should currently show: nothing at all for a dead
 * session, and nothing the viewer dismissed while it still reads the same.
 */
export function visiblePrimeNotices(
  board: PrimeNoticeBoard | undefined,
  session: PrimeSessionLiveness | undefined,
  dismissed: ReadonlySet<string> = new Set(),
): ReadonlyArray<PrimeNotice> {
  if (!board || !hasLivePrimeSession(session)) return [];
  return board.notices.filter((notice) => !dismissed.has(primeNoticeFingerprint(notice)));
}

/** Static one-line rendering; every line is derived from the latest snapshot. */
export function renderPrimeNotice(notice: PrimeNotice): string {
  const label =
    notice.kind === "title"
      ? "Agent title"
      : notice.kind === "editor-text"
        ? "Suggested composer text"
        : notice.severity === "error"
          ? "Error"
          : notice.severity === "warning"
            ? "Warning"
            : notice.kind === "widget"
              ? "Widget"
              : "Status";
  const body =
    notice.kind === "widget" && notice.lines && notice.lines.length > 0
      ? notice.lines.join(" · ")
      : notice.text;
  return `${label}: ${body}`;
}

export function renderPrimeNotices(
  board: PrimeNoticeBoard | undefined,
  session: PrimeSessionLiveness | undefined,
  dismissed?: ReadonlySet<string>,
): ReadonlyArray<string> {
  return visiblePrimeNotices(board, session, dismissed).map(renderPrimeNotice);
}

/**
 * Pending/resolved/cancelled for the typed dialogs. Resolution and
 * cancellation both remove the dialog, so the difference has to be *said*:
 * a cancelled dialog is never described as answered.
 */
export function renderPrimeDialogStatus(pendingCount: number): string | undefined {
  if (pendingCount <= 0) return undefined;
  return pendingCount === 1
    ? "Waiting for your answer to 1 agent request."
    : `Waiting for your answer to ${pendingCount} agent requests.`;
}

export const PRIME_DIALOG_CANCELLED_NOTE =
  "A cancelled request is closed without an answer. The agent is told it was cancelled.";
