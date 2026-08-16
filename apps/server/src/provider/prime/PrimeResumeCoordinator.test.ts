// Storage-facing fixture: the resume cursor lives on the filesystem, like the
// production code it exercises, and the recorded timestamp is a fixed literal.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { assert, describe, it } from "@effect/vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PrimeResumeCursorLatest,
  PrimeResumeFailureReason,
  PrimeResumeCursorScope,
  PrimeResumeState,
} from "@t3tools/contracts";

import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";
import {
  makePrimeResumeCoordinator,
  primeCapabilityDigest,
  primeResumeRefusalMessage,
  type PrimeResumeCoordinatorDeps,
} from "./PrimeResumeCoordinator.ts";
import {
  makePrimeResumeCursor,
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import {
  makeSessionWriterConflictReceipt,
  PrimeSessionLeaseConflictError,
} from "./PrimeSessionLease.ts";

/**
 * PA-B02 — the adoption/resume state machine.
 *
 * Every case here is about the same question: may this build reopen the exact
 * durable session, and if not, does it refuse instead of quietly starting a new
 * one? The lease is a pair of counters so acquisition order is observable
 * without a clock, and nothing in this file sleeps or polls.
 */

const CAPABILITIES = primeCapabilityDigest({ runtimeExtensions: { steer: true } });

const layoutFor = (root: string, threadId = "thread-a") =>
  primeResourceLayout({ home: root, environmentId: "env-a", instanceId: "prime", threadId });

const scopeFor = (root: string, overrides?: Partial<PrimeResumeCursorScope>) =>
  ({
    environmentId: "env-a",
    providerInstanceId: "prime",
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: primeHomeFingerprint(root),
    ...overrides,
  }) as PrimeResumeCursorScope;

const cursorFor = (root: string, overrides?: Partial<PrimeResumeCursorLatest>) =>
  ({
    ...makePrimeResumeCursor({
      scope: scopeFor(root),
      sessionPathToken: primeSessionPathToken(root, layoutFor(root).session),
      ownershipGeneration: 1,
      compatibility: { agentVersion: "0.7.2", band: "compatible" },
      capabilityDigest: CAPABILITIES,
      recordedAt: "2026-08-16T00:00:00.000Z",
    }),
    ...overrides,
  }) as PrimeResumeCursorLatest;

type Harness = {
  readonly root: string;
  readonly published: PrimeResumeState[];
  readonly lease: { acquires: number; releases: number; refuse?: unknown };
  readonly coordinator: ReturnType<typeof makePrimeResumeCoordinator>;
};

const harness = async (
  overrides: Partial<PrimeResumeCoordinatorDeps> = {},
  options: { readonly seedCursor?: PrimeResumeCursorLatest | false } = {},
): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "pa-b02-"));
  const layout = layoutFor(root);
  await mkdir(layout.session, { recursive: true });
  if (options.seedCursor !== false)
    await writePrimeResumeCursor(layout.resumeCursor, options.seedCursor ?? cursorFor(root));
  const published: PrimeResumeState[] = [];
  const lease = { acquires: 0, releases: 0, refuse: undefined as unknown };
  const coordinator = makePrimeResumeCoordinator({
    scopeForThread: async () => scopeFor(root),
    cursorPath: (threadId) => layoutFor(root, threadId).resumeCursor,
    sessionPathToken: (threadId) => primeSessionPathToken(root, layoutFor(root, threadId).session),
    sessionStorageExists: async () => true,
    ownershipGeneration: async () => 1,
    agentVersion: async () => "0.7.3",
    capabilityDigest: () => CAPABILITIES,
    liveSession: () => undefined,
    acquireLease: async () => {
      if (lease.refuse !== undefined) throw lease.refuse;
      lease.acquires += 1;
    },
    releaseLease: async () => {
      lease.releases += 1;
    },
    publish: (_threadId, state) => published.push(state),
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    ...overrides,
  });
  return { root, published, lease, coordinator };
};

const conflict = (reason: "heldByAnotherWriter" | "unauthorized") =>
  new PrimeSessionLeaseConflictError(
    makeSessionWriterConflictReceipt({
      operation: "activate",
      scope: scopeFor("/tmp/unused"),
      reason,
      occurredAt: "2026-08-16T00:00:00.000Z",
    }),
  );

describe("PrimeResumeCoordinator", () => {
  it("resumes the exact session and only then takes the lease", async () => {
    const { root, coordinator, lease, published } = await harness();
    const decision = await coordinator.resume("thread-a");
    assert.equal(decision.plan.kind, "relaunch");
    assert.equal(decision.leaseHeld, true);
    assert.equal(lease.acquires, 1);
    // A decision is not a live session: only `recordSession` may say "resumed".
    assert.deepStrictEqual(published, [{ status: "reconnecting" }]);
    await coordinator.recordSession({ threadId: "thread-a", mode: "relaunched" });
    assert.deepStrictEqual(published, [
      { status: "reconnecting" },
      { status: "resumed", mode: "relaunched" },
    ]);
    await rm(root, { recursive: true, force: true });
  });

  it("adopts a still-live owned session instead of reopening storage", async () => {
    const { root, coordinator } = await harness({ liveSession: () => async () => true });
    const decision = await coordinator.resume("thread-a");
    assert.equal(decision.plan.kind, "adopt");
    await rm(root, { recursive: true, force: true });
  });

  it("does not adopt a session whose process incarnation cannot be proven", async () => {
    const { root, coordinator } = await harness({ liveSession: () => async () => false });
    const decision = await coordinator.resume("thread-a");
    assert.equal(decision.plan.kind, "relaunch");
    await rm(root, { recursive: true, force: true });
  });

  it("starts fresh only when no cursor exists at all", async () => {
    const { root, coordinator, lease, published } = await harness({}, { seedCursor: false });
    const decision = await coordinator.resume("thread-a");
    assert.equal(decision.plan.kind, "fresh");
    assert.equal(decision.leaseHeld, false);
    // Nothing to reconnect to, so nothing is claimed and nothing is announced.
    assert.equal(lease.acquires, 0);
    assert.deepStrictEqual(published, []);
    await rm(root, { recursive: true, force: true });
  });

  const refusals: ReadonlyArray<
    readonly [string, Partial<PrimeResumeCoordinatorDeps>, PrimeResumeFailureReason]
  > = [
    ["a different provider instance", {}, "instanceMismatch"],
    ["a different project workspace", {}, "workspaceMismatch"],
    ["a different environment", {}, "scopeMismatch"],
    ["missing durable storage", { sessionStorageExists: async () => false }, "storageMismatch"],
    ["a retired ownership generation", { ownershipGeneration: async () => 0 }, "ownershipMismatch"],
    [
      "an incompatible installed runtime",
      { agentVersion: async () => "0.6.0" },
      "incompatibleVersion",
    ],
    ["a changed capability set", { capabilityDigest: () => "cap-other" }, "capabilityMismatch"],
  ];

  for (const [label, deps, reason] of refusals) {
    it(`refuses ${label} without starting a new session`, async () => {
      const root = await mkdtemp(join(tmpdir(), "pa-b02-refuse-"));
      const layout = layoutFor(root);
      await mkdir(layout.session, { recursive: true });
      const scopeOverride: Partial<PrimeResumeCursorScope> =
        reason === "instanceMismatch"
          ? ({ providerInstanceId: "prime-other" } as Partial<PrimeResumeCursorScope>)
          : reason === "workspaceMismatch"
            ? ({ projectId: "project-b" } as Partial<PrimeResumeCursorScope>)
            : reason === "scopeMismatch"
              ? ({ environmentId: "env-b" } as Partial<PrimeResumeCursorScope>)
              : {};
      await writePrimeResumeCursor(
        layout.resumeCursor,
        cursorFor(root, { scope: scopeFor(root, scopeOverride) }),
      );
      const published: PrimeResumeState[] = [];
      let acquires = 0;
      const coordinator = makePrimeResumeCoordinator({
        scopeForThread: async () => scopeFor(root),
        cursorPath: () => layout.resumeCursor,
        sessionPathToken: () => primeSessionPathToken(root, layout.session),
        sessionStorageExists: async () => true,
        ownershipGeneration: async () => 1,
        agentVersion: async () => "0.7.3",
        capabilityDigest: () => CAPABILITIES,
        liveSession: () => undefined,
        acquireLease: async () => {
          acquires += 1;
        },
        releaseLease: async () => {},
        publish: (_threadId, state) => published.push(state),
        ...deps,
      });
      const decision = await coordinator.resume("thread-a");
      assert.deepStrictEqual(decision.plan, { kind: "unavailable", reason });
      assert.deepStrictEqual(decision.state, { status: "unavailable", reason });
      // The refusal happens before arbitration, and it never rewrites storage.
      assert.equal(acquires, 0);
      const stored = await readPrimeResumeCursor(layout.resumeCursor);
      assert.equal(stored.state.status, "available");
      // A refusal is loud: it is published, and it never says "fresh".
      assert.deepStrictEqual(published.at(-1), { status: "unavailable", reason });
      assert.include(primeResumeRefusalMessage(reason), reason);
      await rm(root, { recursive: true, force: true });
    });
  }

  it("reports a corrupt cursor as unavailable rather than throwing or starting fresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "pa-b02-corrupt-"));
    const layout = layoutFor(root);
    await mkdir(layout.session, { recursive: true });
    await writeFile(layout.resumeCursor, "{not json");
    const { coordinator } = await harness(
      { cursorPath: () => layout.resumeCursor },
      { seedCursor: false },
    );
    const decision = await coordinator.resume("thread-a");
    assert.deepStrictEqual(decision.plan, { kind: "unavailable", reason: "corrupt" });
    await rm(root, { recursive: true, force: true });
  });

  it("reports a future cursor version as unavailable, never as a fresh thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "pa-b02-future-"));
    const layout = layoutFor(root);
    await mkdir(layout.session, { recursive: true });
    await writeFile(layout.resumeCursor, JSON.stringify({ version: 99, lifecycle: "recorded" }));
    const { coordinator } = await harness(
      { cursorPath: () => layout.resumeCursor },
      { seedCursor: false },
    );
    const decision = await coordinator.resume("thread-a");
    assert.deepStrictEqual(decision.plan, {
      kind: "unavailable",
      reason: "unsupportedVersion",
    });
    await rm(root, { recursive: true, force: true });
  });

  it("maps a lease refusal to a conflict and never activates", async () => {
    const { root, coordinator, lease } = await harness();
    lease.refuse = conflict("heldByAnotherWriter");
    const decision = await coordinator.resume("thread-a");
    assert.deepStrictEqual(decision.plan, { kind: "unavailable", reason: "conflict" });
    assert.equal(decision.leaseHeld, false);
    assert.equal(lease.releases, 0);
    await rm(root, { recursive: true, force: true });
  });

  it("maps an unauthorized writer to its own reason", async () => {
    const { root, coordinator, lease } = await harness();
    lease.refuse = conflict("unauthorized");
    const decision = await coordinator.resume("thread-a");
    assert.deepStrictEqual(decision.plan, { kind: "unavailable", reason: "unauthorized" });
    await rm(root, { recursive: true, force: true });
  });

  it("hands the lease back when the cursor changed under it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pa-b02-race-"));
    const layout = layoutFor(root);
    await mkdir(layout.session, { recursive: true });
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    let releases = 0;
    const coordinator = makePrimeResumeCoordinator({
      scopeForThread: async () => scopeFor(root),
      cursorPath: () => layout.resumeCursor,
      sessionPathToken: () => primeSessionPathToken(root, layout.session),
      sessionStorageExists: async () => true,
      ownershipGeneration: async () => 1,
      agentVersion: async () => "0.7.3",
      capabilityDigest: () => CAPABILITIES,
      liveSession: () => undefined,
      // The barrier: the other writer commits between validation and the
      // revalidation this coordinator performs under its own lease.
      acquireLease: async () => {
        await writePrimeResumeCursor(
          layout.resumeCursor,
          cursorFor(root, { recordedAt: "2026-08-16T09:09:09.000Z" }),
        );
      },
      releaseLease: async () => {
        releases += 1;
      },
    });
    const decision = await coordinator.resume("thread-a");
    assert.deepStrictEqual(decision.plan, { kind: "unavailable", reason: "conflict" });
    assert.equal(releases, 1);
    await rm(root, { recursive: true, force: true });
  });

  it("is idempotent: repeated recovery reaches the same decision", async () => {
    const { root, coordinator } = await harness();
    const [first, second] = await Promise.all([
      coordinator.resume("thread-a"),
      coordinator.resume("thread-a"),
    ]);
    assert.deepStrictEqual(first, second);
    const third = await coordinator.resume("thread-a");
    assert.deepStrictEqual(third.plan, first.plan);
    await rm(root, { recursive: true, force: true });
  });

  it("records a fresh session's cursor without ever claiming it was resumed", async () => {
    const { root, coordinator, published } = await harness({}, { seedCursor: false });
    await coordinator.recordSession({ threadId: "thread-a" });
    assert.deepStrictEqual(published, []);
    const stored = await readPrimeResumeCursor(layoutFor(root).resumeCursor);
    assert.equal(stored.state.status, "available");
    assert.equal(
      stored.state.status === "available" && stored.state.cursor.compatibility.agentVersion,
      "0.7.3",
    );
    // The recorded cursor is now recoverable by the same coordinator.
    assert.equal((await coordinator.resume("thread-a")).plan.kind, "relaunch");
    await rm(root, { recursive: true, force: true });
  });

  // PA-B04 regression: a retry the user pressed must produce a visible answer.
  // Before this, a cursor whose read fails refused *before* anything was
  // published, so the retry published a state byte-identical to the one already
  // on the thread, the projection dropped it as unchanged, and the client sat
  // on its locally-entered "reconnecting" with a blocked composer and disabled
  // buttons until the app was reloaded.
  it("answers an announced retry with reconnecting and then the repeated refusal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pa-b04-retry-"));
    const layout = layoutFor(root);
    await mkdir(layout.session, { recursive: true });
    await writeFile(layout.resumeCursor, "{not json");
    const { coordinator, published } = await harness(
      { cursorPath: () => layout.resumeCursor },
      { seedCursor: false },
    );
    const first = await coordinator.resume("thread-a");
    assert.deepStrictEqual(first.plan, { kind: "unavailable", reason: "corrupt" });
    assert.deepStrictEqual(published, [{ status: "unavailable", reason: "corrupt" }]);

    published.length = 0;
    coordinator.forget("thread-a");
    const retried = await coordinator.resume("thread-a", { announce: true });
    assert.deepStrictEqual(retried.plan, { kind: "unavailable", reason: "corrupt" });
    assert.deepStrictEqual(published, [
      { status: "reconnecting" },
      { status: "unavailable", reason: "corrupt" },
    ]);
    await rm(root, { recursive: true, force: true });
  });

  // PA-B04 regression: a confirmed fresh start used to publish nothing at all
  // (discarding the cursor makes the next decision a `fresh` plan, and a fresh
  // plan was silent), so the refusal that the user had just resolved stayed on
  // the session row and kept the composer shut for good.
  it("publishes a terminal state when a confirmed fresh start discards the refusing cursor", async () => {
    const { root, coordinator, published } = await harness({
      // The capability set moved on since the cursor was written: the
      // `capabilityMismatch` brick whose only way out is a fresh start.
      capabilityDigest: () => primeCapabilityDigest({ runtimeExtensions: { steer: false } }),
    });
    const refused = await coordinator.resume("thread-a");
    assert.deepStrictEqual(refused.plan, { kind: "unavailable", reason: "capabilityMismatch" });
    assert.deepStrictEqual(published.at(-1), {
      status: "unavailable",
      reason: "capabilityMismatch",
    });

    published.length = 0;
    assert.equal(await coordinator.discardCursor("thread-a"), true);
    const afterFresh = await coordinator.resume("thread-a", { announce: true });
    assert.deepStrictEqual(afterFresh.plan, { kind: "fresh" });
    // `missing` is the only truthful terminal here — there is now no durable
    // session — and it is the non-blocking surface that reopens the composer.
    assert.deepStrictEqual(published, [
      { status: "reconnecting" },
      { status: "unavailable", reason: "missing" },
    ]);
    await rm(root, { recursive: true, force: true });
  });

  // PA-B04 regression: the fresh start that a slow orphan un-did. `forget` and
  // `discardCursor` orphan a running validation instead of cancelling it, so a
  // late verdict from before the discard could land *after* the terminal state
  // and put the refusal the user just resolved back on the thread.
  it("silences a superseded attempt so it cannot overwrite a newer answer", async () => {
    let releaseSlowRead: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlowRead = resolve;
    });
    let reads = 0;
    const { root, coordinator, published } = await harness({
      // The first attempt blocks before it reads the cursor; the fresh start
      // then runs to completion underneath it.
      scopeForThread: async () => {
        if ((reads += 1) === 1) await slow;
        return scopeFor(root);
      },
      capabilityDigest: () => primeCapabilityDigest({ runtimeExtensions: { steer: false } }),
    });
    const orphan = coordinator.resume("thread-a", { announce: true });
    coordinator.forget("thread-a");
    assert.equal(await coordinator.discardCursor("thread-a"), true);
    const afterFresh = await coordinator.resume("thread-a", { announce: true });
    assert.deepStrictEqual(afterFresh.plan, { kind: "fresh" });
    releaseSlowRead?.();
    assert.deepStrictEqual((await orphan).plan, { kind: "fresh" });
    // The winning attempt's terminal state is the last word. The orphan may
    // have announced itself before it was superseded — a repeated
    // `reconnecting` is deduplicated downstream and changes nothing — but its
    // verdict never lands.
    assert.deepStrictEqual(published.at(-1), { status: "unavailable", reason: "missing" });
    assert.equal(
      published.filter((state) => state.status === "unavailable").length,
      1,
      "a superseded attempt must not publish a verdict",
    );
    await rm(root, { recursive: true, force: true });
  });

  it("stays silent for an ordinary start on a thread that never had a session", async () => {
    const { root, coordinator, published } = await harness({}, { seedCursor: false });
    assert.deepStrictEqual((await coordinator.resume("thread-a")).plan, { kind: "fresh" });
    assert.deepStrictEqual(published, []);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a cursor recorded under an unreadable runtime version out of the compatible band", async () => {
    const { root, coordinator } = await harness(
      { agentVersion: async () => undefined },
      { seedCursor: false },
    );
    await coordinator.recordSession({ threadId: "thread-a", mode: "relaunched" });
    const stored = await readPrimeResumeCursor(layoutFor(root).resumeCursor);
    assert.deepStrictEqual(
      stored.state.status === "available" ? stored.state.cursor.compatibility : undefined,
      { agentVersion: "unknown", band: "advisory" },
    );
    await rm(root, { recursive: true, force: true });
  });
});

describe("primeCapabilityDigest", () => {
  it("is stable under key order and changes when a capability changes", () => {
    assert.equal(
      primeCapabilityDigest({ a: true, b: { c: 1, d: 2 } }),
      primeCapabilityDigest({ b: { d: 2, c: 1 }, a: true }),
    );
    assert.notEqual(primeCapabilityDigest({ a: true }), primeCapabilityDigest({ a: false }));
    // No capability shape may travel with the digest itself.
    assert.match(primeCapabilityDigest({ steer: true }), /^cap-[0-9a-f]{32}$/);
  });
});
