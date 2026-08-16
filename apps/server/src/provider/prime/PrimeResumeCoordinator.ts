// The coordinator is a promise-facing port, like the PA-B03 write gate: the
// Prime adapter drives it from promise callbacks with no ambient Effect
// context and no fiber to carry a Clock.
// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";

import {
  type PrimeResumeCursor,
  type PrimeResumeCursorScope,
  type PrimeResumeCursorState,
  type PrimeResumeFailureReason,
  type PrimeResumeMode,
  type PrimeResumeState,
  primeResumeAllowsFreshStart,
} from "@t3tools/contracts";

import { classifyPrimeCompatibility } from "./PrimeCompatibility.ts";
import {
  encodePrimeResumeCursor,
  makePrimeResumeCursor,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { PrimeSessionLeaseConflictError } from "./PrimeSessionLease.ts";

/**
 * PA-B02 — recovering the *exact* durable Prime session, or refusing.
 *
 * The whole point of this file is the thing it never does: start a new session
 * because recovery was inconvenient. A cursor that exists and cannot be proven
 * to name this environment, this provider instance, this project, this storage,
 * this ownership generation and a runtime that can still reopen it becomes an
 * `unavailable` state with a reason code. Only the complete absence of a cursor
 * — a thread that never had a Prime session — is allowed to start fresh.
 *
 * Nothing here activates anything either. Activation happens under the PA-B03
 * lease, which this coordinator acquires *after* validation and revalidates
 * against the durable cursor before handing back a plan; if any of that fails
 * the lease goes straight back rather than sitting on the scope for a TTL.
 */

/**
 * Opaque digest of the capability set a session was driven with.
 *
 * Keys are sorted so the digest depends on the capability set and not on the
 * order a build happened to declare it in, and the value is hashed so nothing
 * about the shape of T3's capability object travels in a stored cursor.
 */
export const primeCapabilityDigest = (capabilities: unknown): string => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return value;
  };
  return `cap-${createHash("sha256")
    .update(JSON.stringify(canonical(capabilities)))
    .digest("hex")
    .slice(0, 32)}`;
};

export type PrimeResumePlan =
  /** A session this process still owns and has proven alive. Reuse it. */
  | { readonly kind: "adopt" }
  /** Exact durable storage validated; relaunch the scoped RPC against it. */
  | { readonly kind: "relaunch"; readonly cursor: PrimeResumeCursor }
  /** No cursor at all: this thread never had a Prime session. */
  | { readonly kind: "fresh" }
  /** A session existed and could not be recovered. Never start fresh here. */
  | { readonly kind: "unavailable"; readonly reason: PrimeResumeFailureReason };

export type PrimeResumeDecision = {
  readonly plan: PrimeResumePlan;
  readonly state: PrimeResumeState;
  /** True once the PA-B03 lease is held for this thread by this process. */
  readonly leaseHeld: boolean;
};

export type PrimeResumeCoordinatorDeps = {
  /** Durable scope this thread must match. Resolved from persistence. */
  readonly scopeForThread: (threadId: string) => Promise<PrimeResumeCursorScope>;
  /** Absolute path of the cursor file for this thread (PA-B01 layout). */
  readonly cursorPath: (threadId: string) => string;
  /** Opaque token for the scoped session directory this build would use. */
  readonly sessionPathToken: (threadId: string) => string;
  /** Whether the recorded durable session storage still exists. */
  readonly sessionStorageExists: (threadId: string) => Promise<boolean>;
  /** PA-M06 ownership generation currently recorded for this thread. */
  readonly ownershipGeneration: (threadId: string) => Promise<number>;
  /** Installed runtime version, or `undefined` when it could not be read. */
  readonly agentVersion: () => Promise<string | undefined>;
  /** Digest of the capability set this build would drive the session with. */
  readonly capabilityDigest: () => string;
  /**
   * A session this process still holds, with a proof callback. Returning
   * `undefined`, or a proof that answers `false`, means nothing may be adopted
   * and the exact session has to be reopened from storage instead.
   */
  readonly liveSession: (threadId: string) => (() => Promise<boolean>) | undefined;
  /** PA-B03 gate. Acquire precedes activation; release undoes a failed one. */
  readonly acquireLease: (threadId: string) => Promise<void>;
  readonly releaseLease: (threadId: string) => Promise<void>;
  /** Coarse state for clients/telemetry. Reason codes only, never detail. */
  readonly publish?: (threadId: string, state: PrimeResumeState) => void;
  readonly now?: () => Date;
};

export interface PrimeResumeCoordinator {
  /** Validate, arbitrate and decide. Safe to call repeatedly. */
  readonly resume: (threadId: string) => Promise<PrimeResumeDecision>;
  /**
   * Records the cursor for a session that is now live under our lease. `mode`
   * is present only when this session came from a recovery: a first, fresh
   * session gets a cursor so it can be recovered later, but must never publish
   * a "resumed" state it did not earn.
   */
  readonly recordSession: (input: {
    readonly threadId: string;
    readonly mode?: PrimeResumeMode;
  }) => Promise<void>;
  /** Forgets memoized state for a thread whose session is gone. */
  readonly forget: (threadId: string) => void;
}

const unavailable = (reason: PrimeResumeFailureReason): PrimeResumeDecision => ({
  plan:
    reason === "missing" ? { kind: "fresh" } : ({ kind: "unavailable", reason } as PrimeResumePlan),
  state: { status: "unavailable", reason },
  leaseHeld: false,
});

/** Cursor-level reasons are already a closed set; they carry through unchanged. */
const cursorReason = (state: PrimeResumeCursorState): PrimeResumeFailureReason | undefined =>
  state.status === "unavailable" ? state.reason : undefined;

/**
 * Which component of the scope disagreed. Distinct codes are deliberate: a
 * client can only offer the right recovery if "someone else's project" and
 * "a different provider instance" are not the same word.
 */
const scopeMismatchReason = (
  recorded: PrimeResumeCursorScope,
  expected: PrimeResumeCursorScope,
): PrimeResumeFailureReason | undefined => {
  if (
    recorded.environmentId !== expected.environmentId ||
    recorded.homeFingerprint !== expected.homeFingerprint ||
    recorded.threadId !== expected.threadId
  )
    return "scopeMismatch";
  if (recorded.providerInstanceId !== expected.providerInstanceId) return "instanceMismatch";
  if (recorded.projectId !== expected.projectId) return "workspaceMismatch";
  return undefined;
};

const leaseFailureReason = (cause: unknown): PrimeResumeFailureReason =>
  cause instanceof PrimeSessionLeaseConflictError && cause.receipt.reason === "unauthorized"
    ? "unauthorized"
    : "conflict";

export const makePrimeResumeCoordinator = (
  deps: PrimeResumeCoordinatorDeps,
): PrimeResumeCoordinator => {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<PrimeResumeDecision>>();
  const publish = (threadId: string, state: PrimeResumeState) => deps.publish?.(threadId, state);

  const decide = async (threadId: string): Promise<PrimeResumeDecision> => {
    const expected = await deps.scopeForThread(threadId);
    const path = deps.cursorPath(threadId);
    const first = await readPrimeResumeCursor(path);
    const readReason = cursorReason(first.state);
    if (readReason !== undefined) return unavailable(readReason);
    if (first.state.status !== "available") return unavailable("corrupt");
    const cursor = first.state.cursor;
    // Only now is there something to reconnect *to*. A thread that never had a
    // Prime session must never flash a recovery state it has no reason to show.
    publish(threadId, { status: "reconnecting" });

    const mismatch = scopeMismatchReason(cursor.scope, expected);
    if (mismatch !== undefined) return unavailable(mismatch);
    if (cursor.sessionPathToken !== deps.sessionPathToken(threadId))
      return unavailable("storageMismatch");
    if (!(await deps.sessionStorageExists(threadId))) return unavailable("storageMismatch");
    if ((await deps.ownershipGeneration(threadId)) !== cursor.ownershipGeneration)
      return unavailable("ownershipMismatch");

    // A supported upgrade must resume: the installed version may differ from
    // the recorded one, it just may not be a version this build refuses to
    // drive. A version that cannot be read at all is not proof of anything, so
    // it is not treated as an upgrade either way.
    if (cursor.compatibility.band === "incompatible") return unavailable("incompatibleVersion");
    const installed = await deps.agentVersion();
    if (installed !== undefined && classifyPrimeCompatibility(installed) === "incompatible")
      return unavailable("incompatibleVersion");
    if ("capabilityDigest" in cursor && cursor.capabilityDigest !== deps.capabilityDigest())
      return unavailable("capabilityMismatch");

    // Everything the cursor claims now holds. Arbitration comes next and
    // nothing below may run without it.
    try {
      await deps.acquireLease(threadId);
    } catch (cause) {
      return unavailable(leaseFailureReason(cause));
    }

    // Revalidation under the lease: between the read above and the acquire, the
    // authoritative writer may have been someone else and may have rewritten or
    // retired the cursor. Adopting the row we read before we had the right to
    // read it would be exactly the stale-pointer bug this milestone forbids.
    const second = await readPrimeResumeCursor(path);
    if (
      second.state.status !== "available" ||
      encodePrimeResumeCursor(second.state.cursor) !== encodePrimeResumeCursor(cursor)
    ) {
      await deps.releaseLease(threadId);
      return unavailable(second.state.status === "available" ? "conflict" : "invalidated");
    }

    const proveLive = deps.liveSession(threadId);
    const adopted = proveLive !== undefined && (await proveLive());
    // Deliberately not published here: a decision is not a resumed session.
    // "resumed" is announced by `recordSession`, once the session is provably
    // live under this lease, so a client can never be told a session came back
    // that then failed to start.
    const state: PrimeResumeState = {
      status: "resumed",
      mode: adopted ? "adopted" : "relaunched",
    };
    return {
      plan: adopted ? { kind: "adopt" } : { kind: "relaunch", cursor },
      state,
      leaseHeld: true,
    };
  };

  const resume: PrimeResumeCoordinator["resume"] = (threadId) => {
    // Repeated recovery is idempotent by construction: concurrent callers share
    // one decision, and a later call re-runs the same total validation rather
    // than trusting a cached verdict about durable state that may have moved.
    const existing = inFlight.get(threadId);
    if (existing !== undefined) return existing;
    const promise = decide(threadId)
      .catch((cause): PrimeResumeDecision => {
        // A validation step that throws is a refusal, never a fresh start.
        void cause;
        return unavailable("corrupt");
      })
      .then((decision) => {
        if (decision.plan.kind !== "fresh" && decision.state.status === "unavailable")
          publish(threadId, decision.state);
        return decision;
      })
      .finally(() => {
        if (inFlight.get(threadId) === promise) inFlight.delete(threadId);
      });
    inFlight.set(threadId, promise);
    return promise;
  };

  const recordSession: PrimeResumeCoordinator["recordSession"] = async ({ threadId, mode }) => {
    const scope = await deps.scopeForThread(threadId);
    const installed = await deps.agentVersion();
    const cursor = makePrimeResumeCursor({
      scope,
      sessionPathToken: deps.sessionPathToken(threadId),
      ownershipGeneration: await deps.ownershipGeneration(threadId),
      compatibility: {
        agentVersion: installed ?? "unknown",
        band: installed === undefined ? "advisory" : classifyPrimeCompatibility(installed),
      },
      capabilityDigest: deps.capabilityDigest(),
      recordedAt: now().toISOString(),
    });
    await writePrimeResumeCursor(deps.cursorPath(threadId), cursor);
    if (mode !== undefined) publish(threadId, { status: "resumed", mode });
  };

  return { resume, recordSession, forget: (threadId) => inFlight.delete(threadId) };
};

/** Explains a refusal without naming anything the client may not know. */
export const primeResumeRefusalMessage = (reason: PrimeResumeFailureReason): string =>
  primeResumeAllowsFreshStart(reason)
    ? "Prime Agent has no durable session for this thread."
    : `Prime Agent could not reopen the exact durable session for this thread (${reason}). It was not replaced with a new session; retry, or choose a recovery action.`;
