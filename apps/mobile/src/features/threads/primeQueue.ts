export type PrimeActionMode = "steer" | "followUp" | null;
export type PrimeRuntimeCapabilities = {
  readonly steer?: boolean | undefined;
  readonly followUps?: boolean | undefined;
  readonly followUpCancel?: boolean | undefined;
};
export type PrimeActionState = {
  readonly steering: ReadonlyArray<string>;
  readonly followUps: ReadonlyArray<string>;
  readonly active?: { readonly label?: string | undefined } | undefined;
};
/** True only when the runtime advertises an actionable PA-A02 extension. */
export function hasPrimeRuntimeActions(
  providerName: string | null | undefined,
  capabilities: PrimeRuntimeCapabilities | undefined,
): boolean {
  return (
    providerName === "prime-agent" &&
    (capabilities?.steer === true || capabilities?.followUps === true)
  );
}

/**
 * Cancellation copy is derived from the negotiated capability, never assumed: a
 * runtime that gains `followUpCancel` must not keep telling users the queue is
 * uncancellable.
 */
export function primeCancellationCopy(capabilities: PrimeRuntimeCapabilities | undefined): string {
  return capabilities?.followUpCancel === true
    ? "Interrupt stops the current turn; Stop ends the session. Queued actions can be cancelled individually."
    : "Interrupt stops the current turn; Stop ends the session. Queued actions cannot be cancelled by this runtime.";
}

export function resolvePrimeSend(
  providerName: string | null | undefined,
  mode: PrimeActionMode,
  capabilities: PrimeRuntimeCapabilities | undefined,
  attachmentCount: number,
): { ok: boolean; reason?: string } {
  if (attachmentCount > 0)
    return { ok: false, reason: "Runtime actions support plain text only; remove attachments." };
  if (!hasPrimeRuntimeActions(providerName, capabilities))
    return {
      ok: false,
      reason:
        "This runtime does not support steering or queued follow-ups. Use Interrupt or Stop to control it.",
    };
  if (mode === null) return { ok: false, reason: "Choose Steer now or Queue next before sending." };
  if (!capabilities?.[mode === "steer" ? "steer" : "followUps"])
    return {
      ok: false,
      reason:
        mode === "steer"
          ? "Steering is not supported by this runtime."
          : "Queued follow-ups are not supported by this runtime.",
    };
  return { ok: true };
}
/**
 * Authoritative snapshot rendering: the action the runtime reports as running
 * first, then steering, then queued follow-ups.
 */
export function renderPrimeQueue(state: PrimeActionState | undefined): string[] {
  if (!state) return [];
  const activeLabel = state.active?.label;
  return [
    ...(activeLabel !== undefined && activeLabel.length > 0 ? [`Active: ${activeLabel}`] : []),
    ...state.steering.map((text) => `Steering: ${text}`),
    ...state.followUps.map((text) => `Queued: ${text}`),
  ];
}
