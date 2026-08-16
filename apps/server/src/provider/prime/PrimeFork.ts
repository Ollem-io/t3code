import { boundedPrimeNoticeText } from "./PrimeExtensionUi.ts";
import type { PrimeRpcForkMessage } from "./PrimeRpcProtocol.ts";

/**
 * Session naming and fork-point mapping for Prime 0.7.2.
 *
 * Prime owns the session identity and the ordering of its messages. T3 carries
 * only the bounded name and enough identity to ask Prime for a fork. Message
 * previews are labels for that choice, not a transcript copy: a single bounded,
 * control-char-stripped line per fork point. The chosen label does travel into
 * the forked thread's recorded ancestry (forkedFrom.forkPointLabel), where it
 * names the fork point for the same viewers who already see that history.
 */
export const MAX_PRIME_SESSION_NAME = 120;
export const MAX_PRIME_FORK_POINTS = 20;
export const MAX_PRIME_FORK_POINT_LABEL = 120;
export const MAX_PRIME_FORK_POINT_ID = 128;

export type PrimeForkPoint = {
  readonly forkPointId: string;
  readonly label: string;
  readonly role: "user" | "assistant";
  readonly index: number;
};
export type PrimeSessionIdentity = {
  readonly name?: string;
  readonly forkPoints: ReadonlyArray<PrimeForkPoint>;
  readonly truncated?: true;
};

export const EMPTY_PRIME_SESSION_IDENTITY: PrimeSessionIdentity = Object.freeze({
  forkPoints: Object.freeze([]),
});

/** A blank native name means the session has no display name. */
export const primeSessionName = (value: string | undefined): string | undefined => {
  const name = boundedPrimeNoticeText(value, MAX_PRIME_SESSION_NAME);
  return name || undefined;
};

/**
 * Ids T3 cannot reproduce exactly are dropped rather than renamed. The wire
 * contract brands them as a leading letter followed by letters, digits, `_`,
 * or `-`, with at most 128 characters. Admitting anything else would only make
 * contract encoding throw inside the event pump. Duplicate ids keep the first
 * runtime occurrence, which is the only unambiguous action target.
 */
const CONTRACT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const exactForkPointId = (value: string): string | undefined => {
  const bounded = boundedPrimeNoticeText(value, MAX_PRIME_FORK_POINT_ID);
  return bounded && bounded === value && CONTRACT_ID.test(bounded) ? bounded : undefined;
};

/**
 * Maps Prime's fork choices without copying transcript content.
 *
 * The index counts every message Prime reported, including dropped identities,
 * so human numbering never shifts around an unrepresentable point. Only a
 * bounded preview becomes a label; otherwise the role and original position
 * provide a bounded fallback. The page keeps the last twenty representable
 * points because a fork chooser is about the user's most recent context, while
 * preserving Prime's ordering within that window.
 */
export const primeForkPoints = (
  messages: ReadonlyArray<PrimeRpcForkMessage>,
): { readonly points: ReadonlyArray<PrimeForkPoint>; readonly truncated: boolean } => {
  const representable: PrimeForkPoint[] = [];
  const seen = new Set<string>();
  for (const [index, message] of messages.entries()) {
    const forkPointId = exactForkPointId(message.messageId);
    if (!forkPointId || seen.has(forkPointId)) continue;
    seen.add(forkPointId);
    const preview = boundedPrimeNoticeText(message.preview, MAX_PRIME_FORK_POINT_LABEL);
    const fallback = `${message.role === "user" ? "User" : "Assistant"} message ${index + 1}`;
    representable.push({
      forkPointId,
      label: preview || boundedPrimeNoticeText(fallback, MAX_PRIME_FORK_POINT_LABEL),
      role: message.role,
      index,
    });
  }
  const truncated = representable.length > MAX_PRIME_FORK_POINTS;
  return {
    points: truncated ? representable.slice(-MAX_PRIME_FORK_POINTS) : representable,
    truncated,
  };
};

/** Builds the provider-neutral identity card from the latest native snapshot. */
export const primeSessionIdentity = (input: {
  readonly name?: string | undefined;
  readonly messages: ReadonlyArray<PrimeRpcForkMessage>;
}): PrimeSessionIdentity => {
  const name = primeSessionName(input.name);
  const { points: forkPoints, truncated } = primeForkPoints(input.messages);
  return {
    ...(name ? { name } : {}),
    forkPoints,
    ...(truncated ? { truncated: true as const } : {}),
  };
};

/** Byte-identical identity cards are dropped rather than republished. */
export const primeSessionIdentityFingerprint = (identity: PrimeSessionIdentity): string =>
  JSON.stringify(identity);

export const findPrimeForkPoint = (
  identity: PrimeSessionIdentity,
  forkPointId: string,
): PrimeForkPoint | undefined =>
  identity.forkPoints.find((point) => point.forkPointId === forkPointId);

export type PrimeForkRefusal = "unknown-fork-point" | "no-fork-points";
export type PrimeRenameRefusal = "name-unrepresentable";

/**
 * A missing id means Prime's whole-session clone. A point-specific fork is
 * allowed only from the current bounded identity card, so stale, omitted, and
 * foreign ids never reach the runtime.
 */
export const primeForkDecision = (
  identity: PrimeSessionIdentity,
  forkPointId: string | undefined,
):
  | { readonly allowed: true; readonly forkPoint?: PrimeForkPoint }
  | { readonly allowed: false; readonly reason: PrimeForkRefusal } => {
  if (forkPointId === undefined) return { allowed: true };
  if (identity.forkPoints.length === 0) return { allowed: false, reason: "no-fork-points" };
  const forkPoint = findPrimeForkPoint(identity, forkPointId);
  return forkPoint
    ? { allowed: true, forkPoint }
    : { allowed: false, reason: "unknown-fork-point" };
};

/**
 * Rename requests must survive bounding exactly after ordinary whitespace
 * trimming. T3 refuses anything else instead of silently asking Prime for a
 * different name than the user typed.
 */
export const primeRenameDecision = (
  name: string,
):
  | { readonly allowed: true; readonly name: string }
  | { readonly allowed: false; readonly reason: PrimeRenameRefusal } => {
  const bounded = boundedPrimeNoticeText(name, MAX_PRIME_SESSION_NAME);
  if (bounded.length === 0 || bounded !== name.trim())
    return { allowed: false, reason: "name-unrepresentable" };
  return { allowed: true, name: bounded };
};

export const primeForkRefusalMessage = (reason: PrimeForkRefusal): string => {
  switch (reason) {
    case "unknown-fork-point":
      return "Prime Agent no longer reports that fork point for this session.";
    case "no-fork-points":
      return "Prime Agent reports no message fork points for this session.";
  }
};

export const primeRenameRefusalMessage = (reason: PrimeRenameRefusal): string => {
  switch (reason) {
    case "name-unrepresentable":
      return `A Prime Agent session name must contain text and be at most ${MAX_PRIME_SESSION_NAME} characters.`;
  }
};

export const PRIME_FORK_NOT_RESUME_DISCLOSURE =
  "A fork starts a new Prime Agent session and a new T3 thread from the chosen point. The original thread is untouched. This is not durable resume of a past session.";
