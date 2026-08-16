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
  type PrimeLeaseRenewalScheduler,
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

/**
 * Manual renewal schedule. Renewal is the one thing in this module that is
 * time-driven in production, so the fixture owns the ticks: no timer runs and
 * no test waits on one.
 */
const manualRenewals = () => {
  const ticks = new Set<() => void>();
  const schedule: PrimeLeaseRenewalScheduler = (run) => {
    ticks.add(run);
    return () => ticks.delete(run);
  };
  return {
    schedule,
    scheduled: () => ticks.size,
    tick: async () => {
      for (const run of Array.from(ticks)) run();
      // Two macrotask hops: the renewal body awaits scope, service and store.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
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
  it("retakes its own lapsed lease, but never one another writer claimed", async () => {
    const time = clock();
    const store = makeInMemoryPrimeSessionLeaseStore();
    const scopeForThread = (threadId: string) =>
      scope({ threadId } as Partial<PrimeResumeCursorScope>);
    const gateA = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientA,
      scopeForThread,
      now: time.now,
    });
    const gateB = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientB,
      scopeForThread,
      now: time.now,
    });
    await gateA.acquire({ threadId: "thread-a", operation: "activate" });
    // A session that sat idle past the TTL is still this writer's session: a
    // gate that refused here would leave the user unable to send, interrupt or
    // stop a live Prime process it alone owns.
    time.advance(PRIME_SESSION_LEASE_TTL_MS + 1);
    await gateA.authorizeWrite({ threadId: "thread-a", operation: "send" });
    assert.equal(
      (await service(store, time.now).inspect(scopeForThread("thread-a"))).status,
      "held",
    );
    // But once another writer has claimed the lapsed scope, the retry is a
    // refusal, not a takeover.
    time.advance(PRIME_SESSION_LEASE_TTL_MS + 1);
    await gateB.acquire({ threadId: "thread-a", operation: "activate" });
    const refused = await gateA
      .authorizeWrite({ threadId: "thread-a", operation: "send" })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(refused instanceof PrimeSessionLeaseConflictError);
    assert.equal(refused.receipt.retryable, true);
  });

  it("keeps a busy writer's lease alive so a live session is never handed to a second process", async () => {
    const time = clock();
    const store = makeInMemoryPrimeSessionLeaseStore();
    const scopeForThread = (threadId: string) =>
      scope({ threadId } as Partial<PrimeResumeCursorScope>);
    const renewals = manualRenewals();
    const gateA = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientA,
      scopeForThread,
      now: time.now,
      scheduleRenewal: renewals.schedule,
    });
    const gateB = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientB,
      scopeForThread,
      now: time.now,
    });
    await gateA.acquire({ threadId: "thread-a", operation: "activate" });
    // The turn starts here and the model works for longer than a whole TTL.
    await gateA.authorizeWrite({ threadId: "thread-a", operation: "send" });
    for (let elapsed = 0; elapsed < PRIME_SESSION_LEASE_TTL_MS * 3; elapsed += 10_000) {
      time.advance(10_000);
      await renewals.tick();
      // The incumbent is busy, not gone: no window ever opens for writer B.
      const stolen = await gateB
        .acquire({ threadId: "thread-a", operation: "activate" })
        .then(() => undefined)
        .catch((error: unknown) => error);
      assert.ok(stolen instanceof PrimeSessionLeaseConflictError);
      assert.equal(stolen.receipt.reason, "heldByAnotherWriter");
    }
    // And the busy writer is still the holder when its turn finally lands.
    await gateA.authorizeWrite({ threadId: "thread-a", operation: "send" });
    assert.equal(
      (await service(store, time.now).inspect(scopeForThread("thread-a"))).status,
      "held",
    );
    assert.equal(renewals.scheduled(), 1);
    // Teardown stops the schedule; nothing keeps renewing a released scope.
    await gateA.release({ threadId: "thread-a" });
    assert.equal(renewals.scheduled(), 0);
  });

  it("stops renewing instead of stealing back a scope another writer owns", async () => {
    const time = clock();
    const store = makeInMemoryPrimeSessionLeaseStore();
    const scopeForThread = (threadId: string) =>
      scope({ threadId } as Partial<PrimeResumeCursorScope>);
    const renewals = manualRenewals();
    const gateA = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientA,
      scopeForThread,
      now: time.now,
      scheduleRenewal: renewals.schedule,
    });
    const gateB = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientB,
      scopeForThread,
      now: time.now,
    });
    await gateA.acquire({ threadId: "thread-a", operation: "activate" });
    // A crashed writer renews nothing; B legitimately takes the lapsed scope.
    time.advance(PRIME_SESSION_LEASE_TTL_MS + 1);
    await gateB.acquire({ threadId: "thread-a", operation: "activate" });
    const beforeTick = await service(store, time.now).inspect(scopeForThread("thread-a"));
    await renewals.tick();
    const afterTick = await service(store, time.now).inspect(scopeForThread("thread-a"));
    assert.ok(beforeTick.status === "held" && afterTick.status === "held");
    assert.equal(afterTick.snapshot.holderToken, beforeTick.snapshot.holderToken);
    assert.equal(afterTick.snapshot.generation, beforeTick.snapshot.generation);
    // The dead schedule cleans itself up rather than ticking forever.
    assert.equal(renewals.scheduled(), 0);
    const refused = await gateA
      .authorizeWrite({ threadId: "thread-a", operation: "send" })
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(refused instanceof PrimeSessionLeaseConflictError);
    assert.equal(refused.receipt.reason, "notHolder");
  });

  it("treats re-activating a thread it already holds as a renewal, not a new claim", async () => {
    const time = clock();
    const store = makeInMemoryPrimeSessionLeaseStore();
    const scopeForThread = (threadId: string) =>
      scope({ threadId } as Partial<PrimeResumeCursorScope>);
    const renewals = manualRenewals();
    const gate = makePrimeSessionWriteGate({
      service: service(store, time.now),
      writer: clientA,
      scopeForThread,
      now: time.now,
      scheduleRenewal: renewals.schedule,
    });
    await gate.acquire({ threadId: "thread-a", operation: "activate" });
    const first = await service(store, time.now).inspect(scopeForThread("thread-a"));
    time.advance(1_000);
    await gate.acquire({ threadId: "thread-a", operation: "activate" });
    const second = await service(store, time.now).inspect(scopeForThread("thread-a"));
    assert.ok(first.status === "held" && second.status === "held");
    assert.equal(second.snapshot.generation, first.snapshot.generation);
    assert.equal(second.snapshot.fence, first.snapshot.fence);
    // The idempotent re-activation still pushed the expiry out, and still runs
    // exactly one renewal schedule.
    assert.ok(second.snapshot.expiresAtMs > first.snapshot.expiresAtMs);
    assert.equal(renewals.scheduled(), 1);
    // The handle held by the gate is the one the store agrees with.
    await gate.authorizeWrite({ threadId: "thread-a", operation: "send" });
  });
});
