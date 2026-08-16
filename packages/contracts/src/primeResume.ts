import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * PA-B01 — the durable identity a Prime session can later be resumed from.
 *
 * The cursor is deliberately opaque: it names *which* session belongs to
 * *which* environment, provider instance, project and thread, and nothing
 * about what was said inside it. No prompt, transcript, model output, setting
 * or host path may ever be encoded here — the session is referenced by an
 * opaque path token the host derives, never by its filesystem location.
 *
 * Storing a cursor does not adopt or activate anything. Activation is PA-B02
 * and only under the PA-B03 single-writer lease.
 */

/** Newest cursor version this build writes. */
export const PRIME_RESUME_CURSOR_VERSION = 2 as const;

/** Versions this build can read. Older versions stay readable; newer ones do not crash. */
export const SUPPORTED_PRIME_RESUME_CURSOR_VERSIONS = [1, 2] as const;

export const PrimeResumeCursorScope = Schema.Struct({
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  projectId: ProjectId,
  threadId: ThreadId,
  /** Opaque per-user/per-home discriminator so two T3 homes never collide. */
  homeFingerprint: TrimmedNonEmptyString,
});
export type PrimeResumeCursorScope = typeof PrimeResumeCursorScope.Type;

const separated = (value: string) => `${value.length}:${value}`;

/**
 * Stable identity key. Every component is length-prefixed so no two different
 * scopes can ever produce the same key by shuffling separators between ids.
 */
export const primeResumeScopeKey = (scope: PrimeResumeCursorScope): string =>
  [
    scope.environmentId,
    scope.providerInstanceId,
    scope.projectId,
    scope.threadId,
    scope.homeFingerprint,
  ]
    .map(separated)
    .join("|");

export const primeResumeScopeMatches = (
  left: PrimeResumeCursorScope,
  right: PrimeResumeCursorScope,
): boolean => primeResumeScopeKey(left) === primeResumeScopeKey(right);

export const PrimeResumeCompatibility = Schema.Struct({
  agentVersion: TrimmedNonEmptyString,
  band: Schema.Literals(["compatible", "advisory", "incompatible"]),
});
export type PrimeResumeCompatibility = typeof PrimeResumeCompatibility.Type;

/**
 * Lifecycle is storage-level only. `recorded` means "a cursor exists"; it
 * never means the session is live, adopted or activated.
 */
export const PrimeResumeLifecycleState = Schema.Literals([
  "recorded",
  "unavailable",
  "invalidated",
]);
export type PrimeResumeLifecycleState = typeof PrimeResumeLifecycleState.Type;

const PrimeResumeCursorCommon = {
  scope: PrimeResumeCursorScope,
  /** Opaque token for the Prime session/path. Never the path itself. */
  sessionPathToken: TrimmedNonEmptyString,
  /** PA-M06 ownership generation this cursor was written under. */
  ownershipGeneration: NonNegativeInt,
  compatibility: PrimeResumeCompatibility,
  lifecycle: PrimeResumeLifecycleState,
  recordedAt: IsoDateTime,
};

export const PrimeResumeCursorV1 = Schema.Struct({
  version: Schema.Literal(1),
  ...PrimeResumeCursorCommon,
});
export type PrimeResumeCursorV1 = typeof PrimeResumeCursorV1.Type;

export const PrimeResumeCursorV2 = Schema.Struct({
  version: Schema.Literal(2),
  ...PrimeResumeCursorCommon,
  /** Opaque digest of the capability set the session was created with. */
  capabilityDigest: TrimmedNonEmptyString,
});
export type PrimeResumeCursorV2 = typeof PrimeResumeCursorV2.Type;

export const PrimeResumeCursor = Schema.Union([PrimeResumeCursorV1, PrimeResumeCursorV2]);
export type PrimeResumeCursor = typeof PrimeResumeCursor.Type;

/** Latest-version cursor, what new writes produce. */
export type PrimeResumeCursorLatest = PrimeResumeCursorV2;

export const PrimeResumeUnavailableReason = Schema.Literals([
  "missing",
  "corrupt",
  "unsupportedVersion",
  "scopeMismatch",
  "invalidated",
]);
export type PrimeResumeUnavailableReason = typeof PrimeResumeUnavailableReason.Type;

/**
 * What a client is allowed to know. Until PA-B04 this is intentionally coarse:
 * either a cursor exists, or it does not and here is a reason code. Reason
 * codes are a closed set so no host detail can leak through them.
 */
export const PrimeResumeCursorState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available"), cursor: PrimeResumeCursor }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: PrimeResumeUnavailableReason,
    /** Present only for `unsupportedVersion`, so a downgrade can explain itself. */
    storedVersion: Schema.optional(NonNegativeInt),
  }),
]);
export type PrimeResumeCursorState = typeof PrimeResumeCursorState.Type;

const decodeCursor = Schema.decodeUnknownOption(PrimeResumeCursor);

const readVersion = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as { readonly version?: unknown }).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : undefined;
};

/**
 * Never throws. A future version, a partially written row, or outright garbage
 * all become a readable unavailable state instead of a crash.
 */
export const primeResumeCursorStateFromUnknown = (value: unknown): PrimeResumeCursorState => {
  const decoded = decodeCursor(value);
  if (Option.isSome(decoded)) {
    return decoded.value.lifecycle === "recorded"
      ? { status: "available", cursor: decoded.value }
      : {
          status: "unavailable",
          reason: decoded.value.lifecycle === "invalidated" ? "invalidated" : "corrupt",
        };
  }
  const version = readVersion(value);
  return version !== undefined &&
    !(SUPPORTED_PRIME_RESUME_CURSOR_VERSIONS as ReadonlyArray<number>).includes(version)
    ? { status: "unavailable", reason: "unsupportedVersion", storedVersion: version }
    : { status: "unavailable", reason: "corrupt" };
};

/**
 * Keys that must never appear in a stored cursor or in a diagnostic derived
 * from one. This is a hard boundary, not a style rule: PA-B01 explicitly
 * excludes transcript, settings and telemetry content.
 */
export const PRIME_RESUME_FORBIDDEN_KEYS: ReadonlyArray<string> = [
  "prompt",
  "prompts",
  "message",
  "messages",
  "text",
  "transcript",
  "content",
  "output",
  "completion",
  "reasoning",
  "settings",
  "telemetry",
  "token",
  "apiKey",
  "path",
  "cwd",
  "home",
  "file",
  "filePath",
];

const looksLikeHostPath = (value: string) =>
  value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value);

/**
 * Structural redaction proof used by storage and by the review artifact.
 * Returns the offending key path, or `undefined` when the value is clean.
 */
export const findPrimeResumeRedactionViolation = (
  value: unknown,
  keyPath: ReadonlyArray<string> = [],
): string | undefined => {
  if (typeof value === "string") {
    return looksLikeHostPath(value) ? [...keyPath, "<host-path>"].join(".") : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const violation = findPrimeResumeRedactionViolation(entry, [...keyPath, String(index)]);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      if (
        PRIME_RESUME_FORBIDDEN_KEYS.some(
          (forbidden) =>
            lowered === forbidden.toLowerCase() ||
            (lowered.endsWith(forbidden.toLowerCase()) && lowered !== "sessionpathtoken"),
        )
      ) {
        return [...keyPath, key].join(".");
      }
      const violation = findPrimeResumeRedactionViolation(entry, [...keyPath, key]);
      if (violation !== undefined) return violation;
    }
  }
  return undefined;
};
