import { assert, describe, it } from "@effect/vitest";

import {
  findSessionWriterReceiptViolation,
  primeResumeScopeKey,
  type PrimeResumeCursorScope,
} from "@t3tools/contracts";

import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  makePrimeSessionWriteGate,
  PRIME_SESSION_LEASE_TTL_MS,
  PrimeSessionLeaseConflictError,
  primeLeaseScopeDigest,
  primeSessionWriterToken,
  redactPrimeLeaseDiagnostics,
  type PrimeSessionLeaseStore,
} from "./PrimeSessionLease.ts";

/**
 * PA-B03 arbitration fixtures. Every race below is barrier-controlled: the
 * test decides the exact interleaving of read and compare-and-set, so there is
 * no sleep, no timer and no flake.
 */

const scope = (overrides: Partial<PrimeResumeCursorScope> = {}): PrimeResumeCursorScope =>
  ({
    environmentId: "env-a",
    providerInstanceId: "prime-agent",
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: "home-one",
    ...overrides,
  }) as PrimeResumeCursorScope;

const clientA = { clientToken: "session-a", processToken: "process-1" };
const clientB = { clientToken: "session-b", processToken: "process-2" };

const clock = (start = 1_000) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

/** Store wrapper that lets a test hold every write at a barrier. */
const barrierStore = (inner: PrimeSessionLeaseStore) => {
  const gates: Array<() => void> = [];
  let hold = false;
  return {
    store: {
      read: inner.read,
      compareAndSet: async (input: Parameters<PrimeSessionLeaseStore["compareAndSet"]>[0]) => {
        if (hold) await new Promise<void>((resolve) => gates.push(resolve));
        return inner.compareAndSet(input);
      },
    } satisfies PrimeSessionLeaseStore,
    holdWrites: () => {
      hold = true;
    },
    releaseWrites: () => {
      hold = false;
      for (const gate of gates.splice(0)) gate();
    },
    waiting: () => gates.length,
  };
};

const service = (
  store: PrimeSessionLeaseStore,
  now: () => number,
  authorize: (input: { readonly writer: { readonly clientToken: string } }) => boolean = () => true,
) => makePrimeSessionLeaseService({ store, now, authorize });

describe("PrimeSessionLease", () => {
  it("grants exactly one writer when two acquire from the same observed state", async () => {
    const time = clock();
    const barrier = barrierStore(makeInMemoryPrimeSessionLeaseStore());
    const lease = service(barrier.store, time.now);
    barrier.holdWrites();
    const first = lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    const second = lease.acquire({ scope: scope(), writer: clientB, operation: "activate" });
    // Both have read "no lease" before either is allowed to write.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(barrier.waiting(), 2);
    barrier.releaseWrites();
    const outcomes = await Promise.all([first, second]);
    const granted = outcomes.filter((outcome) => outcome.status === "granted");
    const conflicts = outcomes.filter((outcome) => outcome.status === "conflict");
    assert.equal(granted.length, 1);
    assert.equal(conflicts.length, 1);
    const loser = conflicts[0];
    assert.ok(loser?.status === "conflict");
    assert.equal(loser.receipt.reason, "heldByAnotherWriter");
    assert.equal(loser.receipt.retryable, true);
  });

  it("refuses a second writer while the lease is live and admits it after expiry", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    const first = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    assert.equal(first.status, "granted");
    const blocked = await lease.acquire({ scope: scope(), writer: clientB, operation: "activate" });
    assert.equal(blocked.status === "conflict" && blocked.receipt.reason, "heldByAnotherWriter");
    assert.equal((await lease.inspect(scope())).status, "held");
    time.advance(PRIME_SESSION_LEASE_TTL_MS + 1);
    assert.equal((await lease.inspect(scope())).status, "expired");
    const takeover = await lease.acquire({
      scope: scope(),
      writer: clientB,
      operation: "activate",
    });
    assert.equal(takeover.status, "granted");
    assert.equal(
      takeover.status === "granted" && takeover.handle.generation,
      first.status === "granted" ? first.handle.generation + 1 : -1,
    );
  });

  it("fences a stale owner so it cannot commit after a takeover", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    const stale = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    assert.equal(stale.status, "granted");
    if (stale.status !== "granted") return;
    time.advance(PRIME_SESSION_LEASE_TTL_MS + 1);
    const fresh = await lease.acquire({ scope: scope(), writer: clientB, operation: "activate" });
    assert.equal(fresh.status, "granted");
    if (fresh.status !== "granted") return;
    assert.ok(fresh.handle.fence > stale.handle.fence);
    for (const attempt of [
      await lease.authorizeWrite(stale.handle, {
        scope: scope(),
        writer: clientA,
        operation: "send",
      }),
      await lease.renew(stale.handle, { scope: scope(), writer: clientA, operation: "renew" }),
      await lease.release(stale.handle, { scope: scope(), writer: clientA, operation: "release" }),
    ]) {
      assert.equal(attempt.status, "conflict");
      assert.equal(attempt.status === "conflict" && attempt.receipt.reason, "fenced");
    }
    // The new owner is untouched by the stale writer's attempts.
    const write = await lease.authorizeWrite(fresh.handle, {
      scope: scope(),
      writer: clientB,
      operation: "send",
    });
    assert.equal(write.status, "granted");
  });

  it("refuses an unauthorized caller before reading any lease state", async () => {
    const time = clock();
    const inner = makeInMemoryPrimeSessionLeaseStore();
    let reads = 0;
    const counting: PrimeSessionLeaseStore = {
      read: async (key) => {
        reads++;
        return inner.read(key);
      },
      compareAndSet: inner.compareAndSet,
    };
    const lease = service(counting, time.now, ({ writer }) => writer.clientToken === "session-a");
    const owner = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    assert.equal(owner.status, "granted");
    const before = reads;
    const denied = await lease.acquire({ scope: scope(), writer: clientB, operation: "activate" });
    assert.equal(denied.status === "conflict" && denied.receipt.reason, "unauthorized");
    assert.equal(denied.status === "conflict" && denied.receipt.retryable, false);
    // No read happened, so the refusal cannot be used to probe for an owner.
    assert.equal(reads, before);
    // An unauthorized refusal for a free scope is byte-identical apart from time.
    const free = await lease.acquire({
      scope: scope({ threadId: "thread-free" } as Partial<PrimeResumeCursorScope>),
      writer: clientB,
      operation: "activate",
    });
    assert.equal(free.status === "conflict" && free.receipt.reason, "unauthorized");
    assert.equal(reads, before);
  });

  it("keeps owner identity out of the receipt and out of diagnostics", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    const conflict = await lease.acquire({ scope: scope(), writer: clientB, operation: "send" });
    assert.equal(conflict.status, "conflict");
    if (conflict.status !== "conflict") return;
    assert.equal(findSessionWriterReceiptViolation(conflict.receipt), undefined);
    const serialized = JSON.stringify(conflict.receipt);
    for (const secret of [
      primeSessionWriterToken(clientA),
      clientA.clientToken,
      clientA.processToken,
      "thread-a",
      "project-a",
      "env-a",
      "home-one",
      primeResumeScopeKey(scope()),
    ]) {
      assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
    }
    assert.equal(conflict.receipt.scopeDigest, primeLeaseScopeDigest(scope()));
    const diagnostics = JSON.stringify(
      redactPrimeLeaseDiagnostics({ scope: scope(), status: "held", generation: 1 }),
    );
    for (const secret of ["thread-a", "project-a", primeSessionWriterToken(clientA)]) {
      assert.equal(diagnostics.includes(secret), false);
    }
  });

  it("scopes a lease to one environment, instance, project, thread and home", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    for (const other of [
      scope({ threadId: "thread-b" } as Partial<PrimeResumeCursorScope>),
      scope({ projectId: "project-b" } as Partial<PrimeResumeCursorScope>),
      scope({ homeFingerprint: "home-two" } as Partial<PrimeResumeCursorScope>),
      scope({ environmentId: "env-b" } as Partial<PrimeResumeCursorScope>),
    ]) {
      const outcome = await lease.acquire({ scope: other, writer: clientB, operation: "activate" });
      assert.equal(outcome.status, "granted", "an unrelated scope must not be blocked");
    }
  });

  it("releases to a free scope and refuses a second release of the same handle", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    const owner = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    assert.equal(owner.status, "granted");
    if (owner.status !== "granted") return;
    assert.deepStrictEqual(
      await lease.release(owner.handle, {
        scope: scope(),
        writer: clientA,
        operation: "release",
      }),
      { status: "released" },
    );
    assert.equal((await lease.inspect(scope())).status, "free");
    const again = await lease.release(owner.handle, {
      scope: scope(),
      writer: clientA,
      operation: "release",
    });
    assert.equal(again.status, "conflict");
    const next = await lease.acquire({ scope: scope(), writer: clientB, operation: "activate" });
    assert.equal(next.status, "granted");
    // Generations never restart, so the released holder stays fenced forever.
    assert.ok(next.status === "granted" && next.handle.fence > owner.handle.fence);
  });

  it("renews without changing generation and stays idempotent under repetition", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    const owner = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    if (owner.status !== "granted") return assert.fail("acquire must grant");
    time.advance(1_000);
    const renewed = await lease.renew(owner.handle, {
      scope: scope(),
      writer: clientA,
      operation: "renew",
    });
    assert.equal(renewed.status, "granted");
    assert.equal(
      renewed.status === "granted" && renewed.handle.generation,
      owner.handle.generation,
    );
    assert.ok(
      renewed.status === "granted" && renewed.handle.expiresAtMs > owner.handle.expiresAtMs,
    );
    // Re-acquiring as the same writer is safe and does not lock anyone out.
    const reacquired = await lease.acquire({
      scope: scope(),
      writer: clientA,
      operation: "activate",
    });
    assert.equal(reacquired.status, "granted");
  });

  it("treats a handle as proof of identity, not as a bearer token", async () => {
    const time = clock();
    const lease = service(makeInMemoryPrimeSessionLeaseStore(), time.now);
    const owner = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    if (owner.status !== "granted") return assert.fail("acquire must grant");
    // Another *authorized* writer that got hold of A's handle is still not A.
    for (const operation of ["send", "renew", "release"] as const) {
      const stolen =
        operation === "send"
          ? await lease.authorizeWrite(owner.handle, {
              scope: scope(),
              writer: clientB,
              operation,
            })
          : operation === "renew"
            ? await lease.renew(owner.handle, { scope: scope(), writer: clientB, operation })
            : await lease.release(owner.handle, { scope: scope(), writer: clientB, operation });
      assert.equal(stolen.status, "conflict");
      assert.equal(stolen.status === "conflict" && stolen.receipt.reason, "notHolder");
    }
    // A handle issued for one scope cannot be replayed against another.
    const elsewhere = await lease.authorizeWrite(owner.handle, {
      scope: scope({ threadId: "thread-other" } as Partial<PrimeResumeCursorScope>),
      writer: clientA,
      operation: "send",
    });
    assert.equal(elsewhere.status === "conflict" && elsewhere.receipt.reason, "notHolder");
    // The real owner is unaffected by any of it.
    const mine = await lease.authorizeWrite(owner.handle, {
      scope: scope(),
      writer: clientA,
      operation: "send",
    });
    assert.equal(mine.status, "granted");
  });

  it("takes the write slot atomically and pushes the expiry out", async () => {
    const time = clock();
    const store = makeInMemoryPrimeSessionLeaseStore();
    const lease = service(store, time.now);
    const owner = await lease.acquire({ scope: scope(), writer: clientA, operation: "activate" });
    if (owner.status !== "granted") return assert.fail("acquire must grant");
    // Almost lapsed: a read-only check would let the lease expire while the
    // prompt is on the wire. The write slot is a compare-and-set instead.
    time.advance(PRIME_SESSION_LEASE_TTL_MS - 1);
    const write = await lease.authorizeWrite(owner.handle, {
      scope: scope(),
      writer: clientA,
      operation: "send",
    });
    assert.equal(write.status, "granted");
    if (write.status !== "granted") return;
    assert.equal(write.handle.generation, owner.handle.generation);
    assert.equal(write.handle.expiresAtMs, time.now() + PRIME_SESSION_LEASE_TTL_MS);
    const stored = store.rows.get(primeResumeScopeKey(scope()));
    assert.equal(stored?.expiresAtMs, write.handle.expiresAtMs);
    // Another writer still cannot slip in while the write is in flight.
    const blocked = await lease.acquire({ scope: scope(), writer: clientB, operation: "activate" });
    assert.equal(blocked.status === "conflict" && blocked.receipt.reason, "heldByAnotherWriter");
  });

  it("gates adapter activation, send and release through the same lease", async () => {
    const time = clock();
    const store = makeInMemoryPrimeSessionLeaseStore();
    const leaseA = service(store, time.now);
    const leaseB = service(store, time.now);
    const scopeForThread = (threadId: string) =>
      scope({ threadId } as Partial<PrimeResumeCursorScope>);
    const gateA = makePrimeSessionWriteGate({
      service: leaseA,
      writer: clientA,
      scopeForThread,
      now: time.now,
    });
    const gateB = makePrimeSessionWriteGate({
      service: leaseB,
      writer: clientB,
      scopeForThread,
      now: time.now,
    });
    await gateA.acquire({ threadId: "thread-a", operation: "activate" });
    const denied = await gateB
      .acquire({ threadId: "thread-a", operation: "activate" })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(denied instanceof PrimeSessionLeaseConflictError);
    assert.equal(denied.receipt.reason, "heldByAnotherWriter");
    await gateA.authorizeWrite({ threadId: "thread-a", operation: "send" });
    // A send with no lease at all is refused without touching the session.
    const orphan = await gateB
      .authorizeWrite({ threadId: "thread-a", operation: "send" })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(orphan instanceof PrimeSessionLeaseConflictError);
    assert.equal(orphan.receipt.reason, "notHolder");
    await gateA.release({ threadId: "thread-a" });
    await gateB.acquire({ threadId: "thread-a", operation: "activate" });
    // The first writer's handle is gone; its next send is refused, not applied.
    const fenced = await gateA
      .authorizeWrite({ threadId: "thread-a", operation: "send" })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(fenced instanceof PrimeSessionLeaseConflictError);
    // Releasing what you do not hold is a no-op, never a takeover.
    await gateA.release({ threadId: "thread-a" });
    assert.equal((await leaseB.inspect(scopeForThread("thread-a"))).status, "held");
  });
});
