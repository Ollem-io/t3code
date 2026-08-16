import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  findPrimeResumeRedactionViolation,
  PRIME_RESUME_CURSOR_VERSION,
  type PrimeResumeCursor,
  type PrimeResumeCursorLatest,
  type PrimeResumeCursorScope,
  type PrimeResumeCursorState,
  primeResumeCursorStateFromUnknown,
  primeResumeScopeKey,
  primeResumeScopeMatches,
} from "@t3tools/contracts";

import { assertPrimeContained, primeHomeFingerprint } from "./PrimeResourceLayout.ts";

/**
 * PA-B01 — codec and storage for the durable Prime resume cursor.
 *
 * Reading is total: a corrupt, partial, foreign or future-version cursor is
 * reported as an unavailable state, never an exception and never a fresh
 * session. Writing is atomic and keeps a backup of whatever it replaced; a
 * version this build cannot understand is additionally copied into a
 * write-once, version-keyed sidecar, so no sequence of downgraded writes can
 * destroy it. Nothing here activates or adopts a session.
 */

export const PRIME_RESUME_FILE_MODE = 0o600;
export const PRIME_RESUME_DIRECTORY_MODE = 0o700;
/** A cursor is small by construction; anything larger is treated as corrupt. */
export const PRIME_RESUME_MAX_BYTES = 16 * 1024;

/** Opaque, stable, non-reversible token for a session directory inside this home. */
export const primeSessionPathToken = (home: string, sessionPath: string): string => {
  const root = join(resolve(home), "userdata", "prime", "v1");
  assertPrimeContained(root, sessionPath);
  return `spt-${createHash("sha256")
    .update(`${primeHomeFingerprint(home)}\u0000${resolve(sessionPath)}`)
    .digest("hex")
    .slice(0, 32)}`;
};

export const makePrimeResumeCursor = (input: {
  readonly scope: PrimeResumeCursorScope;
  readonly sessionPathToken: string;
  readonly ownershipGeneration: number;
  readonly compatibility: PrimeResumeCursorLatest["compatibility"];
  readonly capabilityDigest: string;
  readonly recordedAt: string;
}): PrimeResumeCursorLatest => {
  const cursor: PrimeResumeCursorLatest = {
    version: PRIME_RESUME_CURSOR_VERSION,
    scope: input.scope,
    sessionPathToken: input.sessionPathToken,
    ownershipGeneration: input.ownershipGeneration,
    compatibility: input.compatibility,
    lifecycle: "recorded",
    recordedAt: input.recordedAt,
    capabilityDigest: input.capabilityDigest,
  };
  const violation = findPrimeResumeRedactionViolation(cursor);
  if (violation !== undefined) {
    throw new Error(`Prime resume cursor may not carry content or host paths (${violation})`);
  }
  return cursor;
};

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
};

/** Deterministic bytes: the same cursor always encodes to the same string. */
export const encodePrimeResumeCursor = (cursor: PrimeResumeCursor): string =>
  `${JSON.stringify(sortValue(cursor), undefined, 2)}\n`;

export const decodePrimeResumeCursor = (text: string): PrimeResumeCursorState => {
  if (Buffer.byteLength(text, "utf8") > PRIME_RESUME_MAX_BYTES) {
    return { status: "unavailable", reason: "corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unavailable", reason: "corrupt" };
  }
  const state = primeResumeCursorStateFromUnknown(parsed);
  if (state.status === "available" && findPrimeResumeRedactionViolation(parsed) !== undefined) {
    return { status: "unavailable", reason: "corrupt" };
  }
  return state;
};

/**
 * Where a cursor version this build cannot understand is kept forever. The
 * name is keyed by the stored version, so a rolling `.bak` slot can never
 * clobber it and every distinct unknown version keeps its own copy.
 */
export const primeResumeCursorPreservedPath = (path: string, storedVersion: number): string =>
  `${path}.preserved-v${storedVersion}`;

/** Only a plain non-negative integer version may become part of a file name. */
const preservableVersion = (state: PrimeResumeCursorState): number | undefined =>
  state.status === "unavailable" &&
  state.reason === "unsupportedVersion" &&
  typeof state.storedVersion === "number" &&
  Number.isSafeInteger(state.storedVersion) &&
  state.storedVersion >= 0
    ? state.storedVersion
    : undefined;

export const writePrimeResumeCursor = async (
  path: string,
  cursor: PrimeResumeCursor,
): Promise<void> => {
  const violation = findPrimeResumeRedactionViolation(cursor);
  if (violation !== undefined) {
    throw new Error(`Prime resume cursor may not carry content or host paths (${violation})`);
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: PRIME_RESUME_DIRECTORY_MODE });
  await chmod(directory, PRIME_RESUME_DIRECTORY_MODE).catch(() => {});

  // Anything already there is preserved before it is replaced, including a
  // version this build cannot read. Downgrades must not be destructive.
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) {
    // A version this build cannot read is kept in a version-keyed sidecar that
    // is written once and never replaced, so no number of later ordinary
    // writes can destroy it. `.bak` alone is a single rolling slot and would
    // lose the unknown row on the very next write.
    const unknownVersion = preservableVersion(decodePrimeResumeCursor(existing));
    if (unknownVersion !== undefined) {
      const preserved = primeResumeCursorPreservedPath(path, unknownVersion);
      // `wx` fails closed when a copy already exists: the first observation of
      // an unknown version is the one that survives.
      await writeFile(preserved, existing, { mode: PRIME_RESUME_FILE_MODE, flag: "wx" })
        .then(() => chmod(preserved, PRIME_RESUME_FILE_MODE))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
    }
    await writeFile(`${path}.bak`, existing, { mode: PRIME_RESUME_FILE_MODE });
    await chmod(`${path}.bak`, PRIME_RESUME_FILE_MODE);
  }

  const temporary = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(temporary, encodePrimeResumeCursor(cursor), { mode: PRIME_RESUME_FILE_MODE });
  await chmod(temporary, PRIME_RESUME_FILE_MODE);
  // rename over the final name is the commit point: a reader sees the old
  // cursor or the new one, never a half-written row.
  await rename(temporary, path);
};

export type PrimeResumeReadResult = {
  readonly state: PrimeResumeCursorState;
  /** Raw stored bytes, retained so an unreadable cursor is never rewritten away. */
  readonly raw?: string;
};

export const readPrimeResumeCursor = async (
  path: string,
  expectedScope?: PrimeResumeCursorScope,
): Promise<PrimeResumeReadResult> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: { status: "unavailable", reason: "missing" } };
    }
    throw error;
  }
  const state = decodePrimeResumeCursor(raw);
  if (
    state.status === "available" &&
    expectedScope !== undefined &&
    !primeResumeScopeMatches(state.cursor.scope, expectedScope)
  ) {
    return { state: { status: "unavailable", reason: "scopeMismatch" }, raw };
  }
  return { state, raw };
};

/** Marks a cursor unusable without deleting it; PA-B02 may re-validate later. */
export const invalidatePrimeResumeCursor = async (path: string): Promise<boolean> => {
  const { state } = await readPrimeResumeCursor(path);
  if (state.status !== "available") return false;
  await writePrimeResumeCursor(path, { ...state.cursor, lifecycle: "invalidated" });
  // The rolling backup now holds the pre-invalidation `recorded` copy; leaving
  // it would let a later backup-fallback path resurrect a cursor the operator
  // deliberately retired. Preserved unknown-version sidecars are untouched.
  await rm(`${path}.bak`, { force: true });
  return true;
};

/**
 * PA-B04 — deletes this thread's resume cursor so an explicitly confirmed fresh
 * start can actually start.
 *
 * Invalidating in place is not enough here: an `invalidated` cursor keeps
 * refusing, which is exactly the `capabilityMismatch` brick PA-B02 recorded as
 * debt. Deletion is therefore the point, and it is fenced twice. The path is
 * always one T3 derived from its own layout, and the file is removed only after
 * it is *proved* to be a cursor for the expected scope — a file that decodes to
 * someone else's scope is left untouched and reported as not discarded. The
 * rolling backup goes with it, because leaving it would let a later fallback
 * resurrect the cursor the user just chose to leave behind.
 *
 * Only the cursor is removed. The durable Prime session it pointed at, this
 * thread's messages, and its checkpoints are not this function's business and
 * are never touched.
 */
export const discardPrimeResumeCursor = async (
  path: string,
  expectedScope: PrimeResumeCursorScope,
): Promise<boolean> => {
  const { state, raw } = await readPrimeResumeCursor(path, expectedScope);
  if (state.status === "available") {
    if (!primeResumeScopeMatches(state.cursor.scope, expectedScope)) return false;
  } else if (state.reason === "missing") {
    // Nothing to discard is a satisfied post-condition, not a failure: the next
    // start is already a truthful fresh one.
    return false;
  } else if (state.reason === "scopeMismatch") {
    // Provably someone else's row at a path we derived. Refusing is the whole
    // reason this check exists.
    return false;
  } else if (raw === undefined) {
    return false;
  }
  // Corrupt, invalidated or unsupported-version rows fall through on purpose:
  // they are unreadable, they cannot be attributed to another scope, and they
  // are what makes a thread unstartable. Preserved version-keyed sidecars are
  // written under a different name and are deliberately not removed here.
  await rm(path, { force: true });
  await rm(`${path}.bak`, { force: true });
  return true;
};

export const primeResumeCursorFileMode = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

/**
 * The only shape allowed into logs, telemetry or client state. Identifiers are
 * reduced to a short digest so a diagnostic cannot re-identify a project, and
 * no host path, transcript or setting can travel with it.
 */
export const redactPrimeResumeDiagnostics = (input: {
  readonly scope: PrimeResumeCursorScope;
  readonly state: PrimeResumeCursorState;
}): {
  readonly scopeDigest: string;
  readonly status: PrimeResumeCursorState["status"];
  readonly reason?: string;
  readonly storedVersion?: number;
  readonly cursorVersion?: number;
} => ({
  scopeDigest: createHash("sha256")
    .update(primeResumeScopeKey(input.scope))
    .digest("hex")
    .slice(0, 12),
  status: input.state.status,
  ...(input.state.status === "unavailable"
    ? {
        reason: input.state.reason,
        ...(input.state.storedVersion !== undefined
          ? { storedVersion: input.state.storedVersion }
          : {}),
      }
    : { cursorVersion: input.state.cursor.version }),
});
