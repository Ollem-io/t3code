import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * PA-B03 — the generic single-writer arbitration vocabulary.
 *
 * Exactly one writer may be authoritative for one durable session at a time.
 * The lease that grants that right is server-owned; a client never sees it.
 * What a client sees is the receipt below: a closed set of reason codes, a
 * retry flag, and an opaque digest of the contested scope.
 *
 * The receipt deliberately carries no owner identity, no holder token, no
 * device, no session path and no generation of the *other* writer. Losing a
 * race must not tell you who won, only that you did not.
 *
 * The shape is provider-agnostic on purpose (Prime Agent is the first
 * adopter): every client can render "someone else is writing, try again"
 * without knowing anything about Prime.
 */

/**
 * Why a write was refused.
 *
 * - `heldByAnotherWriter` — a live lease belongs to someone else.
 * - `fenced` — the caller's lease was superseded; its late write is rejected.
 * - `notHolder` — the caller holds no lease for this scope at all.
 * - `expired` — the caller's lease lapsed (typically a crash or a stall).
 * - `unauthorized` — the caller may not write here. Never says whether a
 *   lease exists, so an unauthorized caller cannot probe for owners.
 */
export const SessionWriterConflictReason = Schema.Literals([
  "heldByAnotherWriter",
  "fenced",
  "notHolder",
  "expired",
  "unauthorized",
]);
export type SessionWriterConflictReason = typeof SessionWriterConflictReason.Type;

/** Which of these a client should offer to retry after the authoritative turn. */
export const SESSION_WRITER_RETRYABLE_REASONS: ReadonlyArray<SessionWriterConflictReason> = [
  "heldByAnotherWriter",
  "fenced",
  "notHolder",
  "expired",
];

export const isRetryableSessionWriterConflictReason = (
  reason: SessionWriterConflictReason,
): boolean => SESSION_WRITER_RETRYABLE_REASONS.includes(reason);

export const SessionWriterConflictReceipt = Schema.Struct({
  kind: Schema.Literal("sessionWriterConflict"),
  /** Provider driver kind, so a client can phrase the message; not an id. */
  provider: TrimmedNonEmptyString,
  /** What was attempted: `activate`, `send`, `stop`, ... Never an argument. */
  operation: TrimmedNonEmptyString,
  /** Non-reversible digest of the contested scope. Never a path or an id. */
  scopeDigest: TrimmedNonEmptyString,
  reason: SessionWriterConflictReason,
  retryable: Schema.Boolean,
  occurredAt: IsoDateTime,
});
export type SessionWriterConflictReceipt = typeof SessionWriterConflictReceipt.Type;

const decodeReceipt = Schema.decodeUnknownOption(SessionWriterConflictReceipt);

/** Never throws: an unrecognized payload is simply not a conflict receipt. */
export const sessionWriterConflictReceiptFromUnknown = (
  value: unknown,
): SessionWriterConflictReceipt | undefined => {
  const decoded = decodeReceipt(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/**
 * The lease state a *server-side* caller may observe. Clients never receive
 * this: `holderToken` names the authoritative writer and is exactly the datum
 * the receipt above must not carry.
 */
export const SessionWriterLeaseSnapshot = Schema.Struct({
  scopeKey: TrimmedNonEmptyString,
  holderToken: TrimmedNonEmptyString,
  /** Bumped on every acquisition; the value a holder must present to write. */
  generation: NonNegativeInt,
  /**
   * Monotonic fence. Equal to the generation that issued it, and never
   * decreasing for a scope, so a write from a superseded holder is provably
   * old and is rejected instead of committed.
   */
  fence: NonNegativeInt,
  expiresAtMs: NonNegativeInt,
});
export type SessionWriterLeaseSnapshot = typeof SessionWriterLeaseSnapshot.Type;

/**
 * Keys that must never appear in a conflict receipt. Structural, not stylistic:
 * PA-B03 requires that losing a race leaks neither owner identity nor content.
 */
export const SESSION_WRITER_RECEIPT_FORBIDDEN_KEYS: ReadonlyArray<string> = [
  "holder",
  "holderToken",
  "owner",
  "ownerId",
  "clientId",
  "deviceId",
  "sessionId",
  "generation",
  "fence",
  "prompt",
  "message",
  "text",
  "transcript",
  "content",
  "path",
  "cwd",
  "home",
  "token",
];

const looksLikeHostPath = (value: string) =>
  value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value);

/**
 * Returns the offending key path, or `undefined` when the receipt is clean.
 * Used by the receipt factory and by the PA-B03 review artifact.
 */
export const findSessionWriterReceiptViolation = (
  value: unknown,
  keyPath: ReadonlyArray<string> = [],
): string | undefined => {
  if (typeof value === "string") {
    return looksLikeHostPath(value) ? [...keyPath, "<host-path>"].join(".") : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const violation = findSessionWriterReceiptViolation(entry, [...keyPath, String(index)]);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      if (
        SESSION_WRITER_RECEIPT_FORBIDDEN_KEYS.some(
          (forbidden) => lowered === forbidden.toLowerCase(),
        )
      ) {
        return [...keyPath, key].join(".");
      }
      const violation = findSessionWriterReceiptViolation(entry, [...keyPath, key]);
      if (violation !== undefined) return violation;
    }
  }
  return undefined;
};
