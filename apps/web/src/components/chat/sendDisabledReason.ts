import { PRIME_RESUME_COMPOSER_BLOCKED_REASON } from "@t3tools/client-runtime/prime-resume";

/**
 * PA-B04 — the composer's single send gate, as a value rather than a shape
 * buried in JSX.
 *
 * `ChatComposer` refuses to submit for any non-null reason, on the button and
 * on the keyboard path alike, so the precedence here is the shipped behaviour
 * and is worth testing on its own. An unresolved Prime Agent resume outranks
 * everything else: a thread whose exact session refused to reopen must not
 * accept a prompt, because that prompt is what would silently open a new
 * session in its place. The other reasons keep their previous order.
 */
export function resolveSendDisabledReason(input: {
  readonly primeResumeBlocked: boolean;
  readonly threadDetailLoading: boolean;
  readonly modelSelectionReason: string | null;
}): string | null {
  if (input.primeResumeBlocked) return PRIME_RESUME_COMPOSER_BLOCKED_REASON;
  if (input.threadDetailLoading) return "Messages loading";
  return input.modelSelectionReason;
}
