export type PrimeActionMode = "steer" | "followUp" | null;
export type PrimeActionState = {
  readonly steering: ReadonlyArray<string>;
  readonly followUps: ReadonlyArray<string>;
  readonly active?: { readonly label?: string | undefined } | undefined;
};
/** True only when the runtime advertises an actionable PA-A02 extension. */
export function hasPrimeRuntimeActions(
  capabilities:
    | { readonly steer?: boolean | undefined; readonly followUps?: boolean | undefined; readonly followUpCancel?: boolean | undefined }
    | undefined,
): boolean {
  return capabilities?.steer === true || capabilities?.followUps === true;
}

export function resolvePrimeSend(
  mode: PrimeActionMode,
  capabilities:
    | { readonly steer?: boolean | undefined; readonly followUps?: boolean | undefined }
    | undefined,
  attachmentCount: number,
): { ok: boolean; reason?: string } {
  if (attachmentCount > 0)
    return { ok: false, reason: "Runtime actions support plain text only; remove attachments." };
  if (!hasPrimeRuntimeActions(capabilities))
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
export function renderPrimeQueue(state: PrimeActionState | undefined): string[] {
  if (!state) return [];
  return [
    ...state.steering.map((text) => `Steering: ${text}`),
    ...state.followUps.map((text) => `Queued: ${text}`),
  ];
}
