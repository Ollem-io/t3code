import { createHash } from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  findSessionWriterReceiptViolation,
  isRetryableSessionWriterConflictReason,
  primeResumeScopeKey,
  type PrimeResumeCursorScope,
  type SessionWriterConflictReason,
  type SessionWriterConflictReceipt,
  type SessionWriterLeaseSnapshot,
} from "@t3tools/contracts";

/**
 * PA-B03 — server-side single-writer arbitration for one durable Prime session.
 *
 * The rules this module exists to make unavoidable:
 *
 * 1. **Authorization precedes arbitration.** An unauthorized caller is refused
 *    before the store is read, so it can neither acquire nor learn whether a
 *    lease exists, who holds it, or how many times it changed hands.
 * 2. **At most one writer.** Acquisition is a compare-and-set on the stored
 *    generation. Two callers that read the same state produce exactly one
 *    winner; the loser gets a typed, retryable conflict receipt.
 * 3. **A superseded writer can never commit.** Every write presents its
 *    generation. The stored fence only ever increases, so a stale holder that
 *    wakes up after a takeover is rejected — it is not allowed to "win late".
 * 4. **A crash resolves deterministically.** A lease carries an expiry. Once
 *    it lapses, the state is `expired` for everyone: the next authorized
 *    caller acquires at a higher generation, and the crashed holder's fence is
 *    permanently behind. Expiry is evaluated lazily on each call — nothing
 *    polls and nothing sleeps.
 * 5. **Only a crash looks like a crash.** A holder that is merely busy renews
 *    on a bounded schedule for as long as it owns the session, so a long turn
 *    can never be mistaken for a vanished writer and handed to a second
 *    process.
 *
 * Nothing here activates, adopts or resumes a session (that is PA-B02); this
 * is only the gate such a path must pass through first.
 */

/** Epoch milliseconds to ISO, total: an unrepresentable instant becomes the epoch. */
export const primeLeaseIso = (millis: number): string =>
  Option.match(DateTime.make(millis), {
    onSome: DateTime.formatIso,
    onNone: () => "1970-01-01T00:00:00.000Z",
  });

/** How long an acquisition stays valid without a renewal. */
export const PRIME_SESSION_LEASE_TTL_MS = 30_000;

/**
 * How often a held lease is renewed while its session is alive. A TTL only
 * decides what happens when a writer *disappears*; a writer that is merely busy
 * — a Prime turn routinely runs for minutes — must keep proving it is alive, or
 * the TTL would hand its live session to a second process. Comfortably below
 * the TTL so a skipped tick is survivable.
 */
export const PRIME_SESSION_LEASE_RENEW_INTERVAL_MS = 10_000;

/**
 * Starts a repeating renewal. Injected so tests drive ticks explicitly instead
 * of sleeping. The returned function must stop the schedule and be safe to call
 * more than once.
 */
export type PrimeLeaseRenewalScheduler = (run: () => void, intervalMs: number) => () => void;

const defaultRenewalScheduler: PrimeLeaseRenewalScheduler = (run, intervalMs) => {
  // The gate is a promise-facing port the adapter drives; no fiber carries a Schedule here.
  // @effect-diagnostics-next-line globalTimers:off
  const timer = setInterval(run, intervalMs);
  // Renewal must never be the reason a process refuses to exit.
  timer.unref?.();
  return () => clearInterval(timer);
};

export type PrimeSessionLeaseRecord = {
  readonly holderToken: string;
  readonly generation: number;
  readonly fence: number;
  readonly expiresAtMs: number;
};

/**
 * Durable storage for one scope's lease. `compareAndSet` must be atomic with
 * respect to other writers of the same scope and must return `false` — never
 * throw and never overwrite — when the stored generation moved on.
 */
export interface PrimeSessionLeaseStore {
  readonly read: (scopeKey: string) => Promise<PrimeSessionLeaseRecord | undefined>;
  readonly compareAndSet: (input: {
    readonly scopeKey: string;
    /** Generation the caller believes is stored; `undefined` means "no lease". */
    readonly expectedGeneration: number | undefined;
    /** `undefined` clears the lease. */
    readonly next: PrimeSessionLeaseRecord | undefined;
  }) => Promise<boolean>;
}

/** Process-local store. Used by fixtures and by the review artifact. */
export const makeInMemoryPrimeSessionLeaseStore = (): PrimeSessionLeaseStore & {
  readonly rows: Map<string, PrimeSessionLeaseRecord>;
} => {
  const rows = new Map<string, PrimeSessionLeaseRecord>();
  return {
    rows,
    read: async (scopeKey) => rows.get(scopeKey),
    compareAndSet: async ({ scopeKey, expectedGeneration, next }) => {
      const current = rows.get(scopeKey);
      if (current?.generation !== expectedGeneration) return false;
      if (next === undefined) rows.delete(scopeKey);
      else rows.set(scopeKey, next);
      return true;
    },
  };
};

/**
 * Identity of a would-be writer. `clientToken` is whatever the caller uses to
 * distinguish writers (an auth session id, a connection id); it is hashed on
 * the way in, so nothing reversible is ever stored or compared.
 */
export type PrimeSessionWriter = {
  readonly clientToken: string;
  /** Distinguishes two T3 processes holding the same client token. */
  readonly processToken: string;
};

export const primeSessionWriterToken = (writer: PrimeSessionWriter): string =>
  `pw-${createHash("sha256")
    .update(`${writer.clientToken}\u0000${writer.processToken}`)
    .digest("hex")
    .slice(0, 32)}`;

/** Opaque, non-reversible name for the contested scope. Safe for receipts. */
export const primeLeaseScopeDigest = (scope: PrimeResumeCursorScope): string =>
  createHash("sha256").update(primeResumeScopeKey(scope)).digest("hex").slice(0, 12);

export type PrimeSessionLeaseHandle = {
  readonly scope: PrimeResumeCursorScope;
  readonly holderToken: string;
  readonly generation: number;
  readonly fence: number;
  readonly expiresAtMs: number;
};

export type PrimeSessionLeaseOutcome =
  | { readonly status: "granted"; readonly handle: PrimeSessionLeaseHandle }
  | { readonly status: "conflict"; readonly receipt: SessionWriterConflictReceipt };

export const PRIME_LEASE_PROVIDER = "prime-agent";

export const makeSessionWriterConflictReceipt = (input: {
  readonly provider?: string;
  readonly operation: PrimeSessionLeaseOperation;
  readonly scope: PrimeResumeCursorScope;
  readonly reason: SessionWriterConflictReason;
  readonly occurredAt: string;
}): SessionWriterConflictReceipt => {
  const receipt: SessionWriterConflictReceipt = {
    kind: "sessionWriterConflict",
    provider: input.provider ?? PRIME_LEASE_PROVIDER,
    operation: input.operation,
    scopeDigest: primeLeaseScopeDigest(input.scope),
    reason: input.reason,
    retryable: isRetryableSessionWriterConflictReason(input.reason),
    occurredAt: input.occurredAt,
  };
  const violation = findSessionWriterReceiptViolation(receipt);
  if (violation !== undefined) {
    throw new Error(`Session writer conflict receipt may not carry ${violation}`);
  }
  return receipt;
};

/**
 * Thrown by the adapter gate. Carries the receipt so a caller that knows about
 * arbitration can react precisely, while a caller that does not sees an
 * ordinary error whose message names no owner.
 */
export class PrimeSessionLeaseConflictError extends Error {
  readonly receipt: SessionWriterConflictReceipt;
  constructor(receipt: SessionWriterConflictReceipt) {
    super(
      `Another writer is authoritative for this Prime session (${receipt.operation}: ${receipt.reason})`,
    );
    this.name = "PrimeSessionLeaseConflictError";
    this.receipt = receipt;
  }
}

/**
 * Closed set of arbitration operations. A receipt is client-visible, so the
 * operation label may never be caller-supplied text: it names a code path this
 * repository owns and nothing else.
 */
export const PRIME_SESSION_LEASE_OPERATIONS = [
  "activate",
  "send",
  "renew",
  "interrupt",
  "runtimeAction",
  "respond",
  "release",
  "startSession",
  "sendTurn",
] as const;
export type PrimeSessionLeaseOperation = (typeof PRIME_SESSION_LEASE_OPERATIONS)[number];

export type PrimeSessionLeaseRequest = {
  readonly scope: PrimeResumeCursorScope;
  readonly writer: PrimeSessionWriter;
  readonly operation: PrimeSessionLeaseOperation;
};

export type PrimeSessionLeaseServiceOptions = {
  readonly store: PrimeSessionLeaseStore;
  /**
   * Authorization is asked *first*, on every call, and is the only reason code
   * that is not retryable. It never receives lease state, so it cannot be
   * turned into an oracle for who holds what.
   */
  readonly authorize: (request: PrimeSessionLeaseRequest) => boolean | Promise<boolean>;
  /** Epoch milliseconds. Injected so fixtures never sleep. */
  readonly now: () => number;
  readonly ttlMs?: number;
};

export type PrimeSessionLeaseService = {
  readonly acquire: (request: PrimeSessionLeaseRequest) => Promise<PrimeSessionLeaseOutcome>;
  readonly renew: (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ) => Promise<PrimeSessionLeaseOutcome>;
  /** Proof-of-holder check a write must pass immediately before committing. */
  readonly authorizeWrite: (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ) => Promise<PrimeSessionLeaseOutcome>;
  readonly release: (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ) => Promise<PrimeSessionLeaseOutcome | { readonly status: "released" }>;
  /** Server-side introspection. Never exposed to a client. */
  readonly inspect: (
    scope: PrimeResumeCursorScope,
  ) => Promise<
    | { readonly status: "free" }
    | { readonly status: "expired"; readonly snapshot: SessionWriterLeaseSnapshot }
    | { readonly status: "held"; readonly snapshot: SessionWriterLeaseSnapshot }
  >;
};

const snapshotOf = (
  scopeKey: string,
  record: PrimeSessionLeaseRecord,
): SessionWriterLeaseSnapshot => ({
  scopeKey,
  holderToken: record.holderToken,
  generation: record.generation,
  fence: record.fence,
  expiresAtMs: record.expiresAtMs,
});

export const makePrimeSessionLeaseService = (
  options: PrimeSessionLeaseServiceOptions,
): PrimeSessionLeaseService => {
  const ttlMs = options.ttlMs ?? PRIME_SESSION_LEASE_TTL_MS;
  const { store } = options;

  const conflict = (
    request: PrimeSessionLeaseRequest,
    reason: SessionWriterConflictReason,
  ): PrimeSessionLeaseOutcome => ({
    status: "conflict",
    receipt: makeSessionWriterConflictReceipt({
      operation: request.operation,
      scope: request.scope,
      reason,
      occurredAt: primeLeaseIso(options.now()),
    }),
  });

  /** `true` when the caller may proceed to touch lease state at all. */
  const authorized = async (request: PrimeSessionLeaseRequest) =>
    (await options.authorize(request)) === true;

  const live = (record: PrimeSessionLeaseRecord | undefined, now: number) =>
    record !== undefined && record.expiresAtMs > now ? record : undefined;

  const acquire = async (request: PrimeSessionLeaseRequest): Promise<PrimeSessionLeaseOutcome> => {
    // Authorization first: no store read happens for a caller who may not write.
    if (!(await authorized(request))) return conflict(request, "unauthorized");
    const scopeKey = primeResumeScopeKey(request.scope);
    const holderToken = primeSessionWriterToken(request.writer);
    const now = options.now();
    const current = await store.read(scopeKey);
    const held = live(current, now);
    if (held !== undefined && held.holderToken !== holderToken) {
      return conflict(request, "heldByAnotherWriter");
    }
    // The fence never goes backwards, even across an expiry or a re-acquire by
    // the same holder, so a write issued under any earlier generation stays
    // provably old forever.
    const nextGeneration = (current?.generation ?? 0) + 1;
    const next: PrimeSessionLeaseRecord = {
      holderToken,
      generation: nextGeneration,
      fence: Math.max(current?.fence ?? 0, nextGeneration),
      expiresAtMs: now + ttlMs,
    };
    const committed = await store.compareAndSet({
      scopeKey,
      expectedGeneration: current?.generation,
      next,
    });
    // Losing the compare-and-set means someone else committed between our read
    // and our write. That is the race this milestone exists for: exactly one of
    // the two callers gets `granted`, the other a retryable conflict.
    if (!committed) return conflict(request, "heldByAnotherWriter");
    return {
      status: "granted",
      handle: {
        scope: request.scope,
        holderToken,
        generation: next.generation,
        fence: next.fence,
        expiresAtMs: next.expiresAtMs,
      },
    };
  };

  /** Shared holder proof for renew/write/release. */
  const validate = async (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ): Promise<
    { readonly ok: true; readonly record: PrimeSessionLeaseRecord } | PrimeSessionLeaseOutcome
  > => {
    if (!(await authorized(request))) return conflict(request, "unauthorized");
    const scopeKey = primeResumeScopeKey(request.scope);
    // A handle is not a bearer token. The caller must *be* the writer the
    // handle names and must be operating on the scope the handle was issued
    // for, otherwise possessing someone else's handle would be enough to write
    // as them, or to reach across scopes that happen to share a generation.
    if (
      primeSessionWriterToken(request.writer) !== handle.holderToken ||
      primeResumeScopeKey(handle.scope) !== scopeKey
    ) {
      return conflict(request, "notHolder");
    }
    const now = options.now();
    const current = await store.read(scopeKey);
    if (current === undefined) return conflict(request, "notHolder");
    if (current.holderToken !== handle.holderToken || current.generation !== handle.generation) {
      // Someone else owns it now, or this handle was already superseded. Either
      // way the late write is fenced rather than applied.
      return current.fence > handle.fence
        ? conflict(request, "fenced")
        : conflict(request, "notHolder");
    }
    if (current.expiresAtMs <= now) return conflict(request, "expired");
    return { ok: true, record: current };
  };

  const renew = async (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ): Promise<PrimeSessionLeaseOutcome> => {
    const checked = await validate(handle, request);
    if (!("ok" in checked)) return checked;
    const now = options.now();
    const scopeKey = primeResumeScopeKey(request.scope);
    const next: PrimeSessionLeaseRecord = { ...checked.record, expiresAtMs: now + ttlMs };
    const committed = await store.compareAndSet({
      scopeKey,
      expectedGeneration: checked.record.generation,
      next,
    });
    if (!committed) return conflict(request, "fenced");
    return { status: "granted", handle: { ...handle, expiresAtMs: next.expiresAtMs } };
  };

  /**
   * Taking the write slot is itself a compare-and-set, not a read: checking
   * and then writing would leave a window in which the lease lapses between
   * the check and the provider call. The successful CAS both proves the caller
   * is still the holder at that instant and pushes the expiry out by a full
   * TTL, so the in-flight write cannot be overtaken while it is on the wire.
   */
  const authorizeWrite = async (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ): Promise<PrimeSessionLeaseOutcome> => renew(handle, request);

  const release = async (
    handle: PrimeSessionLeaseHandle,
    request: PrimeSessionLeaseRequest,
  ): Promise<PrimeSessionLeaseOutcome | { readonly status: "released" }> => {
    const checked = await validate(handle, request);
    if (!("ok" in checked)) return checked;
    const scopeKey = primeResumeScopeKey(request.scope);
    // Clearing keeps the generation history: the store drops the holder, and
    // the next acquisition still counts up from the released generation.
    const committed = await store.compareAndSet({
      scopeKey,
      expectedGeneration: checked.record.generation,
      next: {
        holderToken: checked.record.holderToken,
        generation: checked.record.generation,
        fence: checked.record.fence,
        expiresAtMs: 0,
      },
    });
    return committed ? { status: "released" } : conflict(request, "fenced");
  };

  const inspect: PrimeSessionLeaseService["inspect"] = async (scope) => {
    const scopeKey = primeResumeScopeKey(scope);
    const current = await store.read(scopeKey);
    if (current === undefined) return { status: "free" };
    // A released row keeps its generation history but holds nothing: it is
    // free, not "expired after a crash". The two must stay distinguishable
    // because only one of them means a writer disappeared.
    if (current.expiresAtMs === 0) return { status: "free" };
    const snapshot = snapshotOf(scopeKey, current);
    return current.expiresAtMs > options.now()
      ? { status: "held", snapshot }
      : { status: "expired", snapshot };
  };

  return { acquire, renew, authorizeWrite, release, inspect };
};

/**
 * The narrow surface the Prime adapter is wired to. Everything the adapter
 * does that could make it the authoritative writer for a thread goes through
 * one of these three calls, and a refusal is thrown as a typed conflict rather
 * than degraded into "started anyway".
 */
export interface PrimeSessionWriteGate {
  /** Activation. Must succeed before any session process exists for the thread. */
  readonly acquire: (input: {
    readonly threadId: string;
    readonly operation: PrimeSessionLeaseOperation;
  }) => Promise<void>;
  /**
   * Re-proof immediately before any durable mutation leaves the server: a
   * turn, an abort, a compaction, or an answer to a native dialog. Every one
   * of those rewrites the durable session, so every one must prove the lease.
   */
  readonly authorizeWrite: (input: {
    readonly threadId: string;
    readonly operation: PrimeSessionLeaseOperation;
  }) => Promise<void>;
  /** Stop, crash teardown and provider-instance removal. Never throws. */
  readonly release: (input: { readonly threadId: string }) => Promise<void>;
  /**
   * The durable scope this gate arbitrates a thread under. PA-B02 validates a
   * stored cursor against exactly this scope, so resume and arbitration can
   * never disagree about which session they are talking about.
   */
  readonly scopeForThread: (threadId: string) => Promise<PrimeResumeCursorScope>;
}

export const makePrimeSessionWriteGate = (input: {
  /** One service for every scope. Mutually exclusive with `serviceForThread`. */
  readonly service?: PrimeSessionLeaseService;
  /**
   * One service per thread, resolved on demand. Durable stores are keyed by
   * scope (the SQL store owns exactly one), so a gate that spans threads has
   * to build its service where the scope is known.
   */
  readonly serviceForThread?: (threadId: string) => Promise<PrimeSessionLeaseService>;
  readonly writer: PrimeSessionWriter;
  /** May be async: production resolves the durable scope from persistence. */
  readonly scopeForThread: (
    threadId: string,
  ) => PrimeResumeCursorScope | Promise<PrimeResumeCursorScope>;
  /** Same clock the service uses, so a receipt this gate mints is comparable. */
  readonly now: () => number;
  /** Defaults to an unref'd interval; fixtures pass a manual ticker. */
  readonly scheduleRenewal?: PrimeLeaseRenewalScheduler;
  readonly renewIntervalMs?: number;
}): PrimeSessionWriteGate => {
  const handles = new Map<string, PrimeSessionLeaseHandle>();
  const renewals = new Map<string, () => void>();
  const scheduleRenewal = input.scheduleRenewal ?? defaultRenewalScheduler;
  const renewIntervalMs = input.renewIntervalMs ?? PRIME_SESSION_LEASE_RENEW_INTERVAL_MS;
  const stopRenewal = (threadId: string) => {
    const stop = renewals.get(threadId);
    if (stop === undefined) return;
    renewals.delete(threadId);
    stop();
  };
  const serviceFor = async (threadId: string): Promise<PrimeSessionLeaseService> => {
    if (input.service !== undefined) return input.service;
    if (input.serviceForThread === undefined)
      throw new Error("Prime write gate needs either a service or a per-thread service factory");
    return await input.serviceForThread(threadId);
  };
  const requestFor = async (
    threadId: string,
    operation: PrimeSessionLeaseOperation,
  ): Promise<PrimeSessionLeaseRequest> => ({
    scope: await input.scopeForThread(threadId),
    writer: input.writer,
    operation,
  });
  /**
   * Keeps a held lease alive for as long as this server owns the session. The
   * lease is only released by an explicit teardown or by this process dying, so
   * a busy writer is never mistaken for a crashed one. A renewal that is
   * refused means arbitration already moved on: the handle is dropped and the
   * schedule stops rather than trying to take the scope back.
   */
  const startRenewal = (threadId: string) => {
    if (renewals.has(threadId)) return;
    let inFlight = false;
    const tick = () => {
      if (inFlight) return;
      const handle = handles.get(threadId);
      if (handle === undefined) {
        stopRenewal(threadId);
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          const request = await requestFor(threadId, "renew");
          const service = await serviceFor(threadId);
          const outcome = await service.renew(handle, request);
          if (outcome.status === "granted") {
            if (handles.get(threadId) === handle) handles.set(threadId, outcome.handle);
            return;
          }
          if (handles.get(threadId) === handle) handles.delete(threadId);
          stopRenewal(threadId);
        } catch {
          // A transient store failure must not kill the schedule; the next tick
          // retries, and the TTL still bounds the damage if it never recovers.
        } finally {
          inFlight = false;
        }
      })();
    };
    renewals.set(threadId, scheduleRenewal(tick, renewIntervalMs));
  };
  const acquire: PrimeSessionWriteGate["acquire"] = async ({ threadId, operation }) => {
    const service = await serviceFor(threadId);
    const existing = handles.get(threadId);
    if (existing !== undefined) {
      // Re-activating a thread this process already holds is not a new claim:
      // renewing keeps the generation stable so an idempotent re-activation
      // cannot invalidate a handle or inflate the durable counter.
      const renewed = await service.renew(existing, await requestFor(threadId, operation));
      if (renewed.status === "granted") {
        handles.set(threadId, renewed.handle);
        startRenewal(threadId);
        return;
      }
      // The handle is provably dead. Fall through to a fresh acquire, which
      // still refuses if another writer claimed the scope in the meantime.
      handles.delete(threadId);
      stopRenewal(threadId);
    }
    const request = await requestFor(threadId, operation);
    const outcome = await service.acquire(request);
    if (outcome.status === "conflict") throw new PrimeSessionLeaseConflictError(outcome.receipt);
    handles.set(threadId, outcome.handle);
    startRenewal(threadId);
  };
  return {
    acquire,
    authorizeWrite: async ({ threadId, operation }) => {
      const request = await requestFor(threadId, operation);
      const handle = handles.get(threadId);
      if (handle === undefined) {
        throw new PrimeSessionLeaseConflictError(
          makeSessionWriterConflictReceipt({
            operation,
            scope: request.scope,
            reason: "notHolder",
            occurredAt: primeLeaseIso(input.now()),
          }),
        );
      }
      const outcome = await (await serviceFor(threadId)).authorizeWrite(handle, request);
      if (outcome.status === "conflict") {
        // A fenced or expired handle is dead: dropping it here stops the
        // adapter from re-presenting a lease it provably no longer owns.
        handles.delete(threadId);
        stopRenewal(threadId);
        // A lease that merely lapsed while this writer sat idle — nobody else
        // took it — is *our* lease to take again, at a higher generation. Only
        // that one reason may retry: `fenced`, `notHolder` and `unauthorized`
        // all mean someone else is authoritative, and re-acquiring on those
        // would be exactly the takeover this milestone forbids. The retry is a
        // plain acquire, so if another writer did claim the lapsed scope, it
        // refuses with `heldByAnotherWriter` instead of stealing it.
        if (outcome.receipt.reason === "expired") {
          await acquire({ threadId, operation });
          return;
        }
        throw new PrimeSessionLeaseConflictError(outcome.receipt);
      }
      // The successful write-slot CAS pushed the expiry out; keep the handle
      // in step so the next call presents the lease as the store sees it.
      handles.set(threadId, outcome.handle);
      startRenewal(threadId);
    },
    release: async ({ threadId }) => {
      const handle = handles.get(threadId);
      stopRenewal(threadId);
      if (handle === undefined) return;
      handles.delete(threadId);
      // Teardown must never fail because arbitration moved on: the lease has
      // a TTL, so the worst case is that the scope frees itself a bit later.
      await serviceFor(threadId)
        .then(async (service) => service.release(handle, await requestFor(threadId, "release")))
        .catch(() => undefined);
    },
    scopeForThread: async (threadId) => await input.scopeForThread(threadId),
  };
};

/**
 * The only lease shape allowed into logs or telemetry: a scope digest, a
 * coarse status and the generation counter. No holder token, ever.
 */
export const redactPrimeLeaseDiagnostics = (input: {
  readonly scope: PrimeResumeCursorScope;
  readonly status: "free" | "held" | "expired";
  readonly generation?: number;
}): {
  readonly scopeDigest: string;
  readonly status: string;
  readonly generation?: number;
} => ({
  scopeDigest: primeLeaseScopeDigest(input.scope),
  status: input.status,
  ...(input.generation !== undefined ? { generation: input.generation } : {}),
});
