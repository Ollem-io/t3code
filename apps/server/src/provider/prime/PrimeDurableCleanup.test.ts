// Durable cleanup is plain promise-based node fs, so its test drives the same
// APIs directly rather than through an Effect FileSystem it does not use.
// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeResumeScopeKey, type PrimeResumeCursorScope } from "@t3tools/contracts";

import {
  executePrimeCleanup,
  makeInMemoryPrimeCleanupJournalStore,
  planPrimeCleanup,
  primeCleanupReasonForLifecycle,
  primeRolloutTransition,
  redactPrimeCleanupReport,
  resumePrimeCleanup,
  PRIME_LIFECYCLE_EVENTS,
  type PrimeCleanupGuard,
  type PrimeCleanupJournalStore,
} from "./PrimeDurableCleanup.ts";
import { writePrimeOwnership } from "./PrimeOwnership.ts";
import {
  makePrimeResumeCursor,
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";

/**
 * PA-B05 destructive-lifecycle fixtures.
 *
 * Every run happens in a freshly created temporary T3 home, and each case that
 * deletes anything also asserts what survived: a second thread in the same
 * instance, a second T3 home, and an unowned sentinel that no cleanup path may
 * ever reach. Crash points are exercised by making the journal throw at an
 * exact write, never by timing.
 */

const THREAD = "thread-a";

const makeHome = async (label: string) => {
  // `realpath` because a symlinked temp root (macOS `/var`) is refused by the
  // ownership boundary, and rightly so: it will not act through a symlink.
  const home = await mkdtemp(join(await realpath(tmpdir()), `t3-pa-b05-${label}-`));
  const layout = (threadId: string) =>
    primeResourceLayout({ home, environmentId: "env-a", instanceId: "prime-agent", threadId });
  const scopeFor = (threadId: string): PrimeResumeCursorScope =>
    ({
      environmentId: "env-a",
      providerInstanceId: "prime-agent",
      projectId: "project-a",
      threadId,
      homeFingerprint: primeHomeFingerprint(home),
    }) as PrimeResumeCursorScope;
  return { home, layout, scopeFor };
};

/** Materializes exactly what a live Prime thread owns inside one home. */
const seedThread = async (
  home: string,
  threadId: string,
  scope: PrimeResumeCursorScope,
  pid = 71,
) => {
  const layout = primeResourceLayout({
    home,
    environmentId: "env-a",
    instanceId: "prime-agent",
    threadId,
  });
  await mkdir(layout.session, { recursive: true });
  await writeFile(join(layout.session, "owned"), "session");
  await writeFile(layout.config, "{}");
  await writePrimeOwnership(layout.ownership, {
    version: 1,
    environmentId: "env-a",
    instanceId: "prime-agent",
    threadId,
    process: { pid, startToken: "captured-start" },
  });
  await writePrimeResumeCursor(
    layout.resumeCursor,
    makePrimeResumeCursor({
      scope,
      sessionPathToken: primeSessionPathToken(home, layout.session),
      ownershipGeneration: 1,
      compatibility: { agentVersion: "0.7.2", band: "compatible" },
      capabilityDigest: "sha256:cap",
      recordedAt: "2026-08-16T00:00:00.000Z",
    }),
  );
  return layout;
};

const proofFor = (pid = 71) => ({
  processMatches: async (handle: { pid: number; startToken: string }) =>
    handle.pid === pid && handle.startToken === "captured-start",
});

/** Platform removal boundary: only the exact proven inode is ever unlinked. */
const remover = (events: string[]) => ({
  stopProcess: async (handle: { pid: number }) => {
    events.push(`stop:${handle.pid}`);
  },
  removeOwnedResource: async (resource: {
    readonly path: string;
    readonly identity: { readonly dev: string; readonly ino: string };
  }) => {
    const current = await stat(resource.path, { bigint: true }).catch(() => undefined);
    if (
      !current ||
      String(current.dev) !== resource.identity.dev ||
      String(current.ino) !== resource.identity.ino
    ) {
      return "retained" as const;
    }
    await rm(resource.path, { recursive: true, force: true });
    events.push(`removed:${resource.path.length > 0}`);
    return "removed" as const;
  },
});

const exists = async (path: string) =>
  await stat(path).then(
    () => true,
    () => false,
  );

const clock = () => {
  let value = 0;
  return () => `2026-08-16T00:00:${String(value++).padStart(2, "0")}.000Z`;
};

const clearGuard = async (): Promise<PrimeCleanupGuard> => ({ status: "clear" });

const confirmedRun = (input: {
  readonly home: string;
  readonly scope: PrimeResumeCursorScope;
  readonly journal: PrimeCleanupJournalStore;
  readonly guard?: () => Promise<PrimeCleanupGuard>;
  readonly events: string[];
  readonly cleanup?: Parameters<typeof executePrimeCleanup>[0]["cleanup"];
}) => {
  const plan = planPrimeCleanup({
    home: input.home,
    scope: input.scope,
    lifecycleEvent: "threadDelete",
    guard: { status: "clear" },
  });
  return executePrimeCleanup({
    plan,
    confirmation: { scopeDigest: plan.scopeDigest, acknowledged: true },
    journal: input.journal,
    guard: input.guard ?? clearGuard,
    proof: proofFor(),
    cleanup: input.cleanup ?? remover(input.events),
    now: clock(),
  });
};

describe("PrimeDurableCleanup", () => {
  it("never turns stop, archive, disable, rollout or rollback into deletion", async () => {
    const { home, scopeFor } = await makeHome("nondestructive");
    const scope = scopeFor(THREAD);
    const layout = await seedThread(home, THREAD, scope);
    const journal = makeInMemoryPrimeCleanupJournalStore();

    const nonDestructive = PRIME_LIFECYCLE_EVENTS.filter(
      (event) => primeCleanupReasonForLifecycle(event) === undefined,
    );
    assert.deepStrictEqual(
      [...nonDestructive],
      ["threadStop", "threadArchive", "instanceDisabled", "rollout", "rollback"],
    );

    for (const lifecycleEvent of nonDestructive) {
      const plan = planPrimeCleanup({ home, scope, lifecycleEvent, guard: { status: "clear" } });
      assert.deepStrictEqual(plan.decision, {
        action: "refuse",
        reason: "nonDestructiveLifecycle",
      });
      assert.deepStrictEqual([...plan.targets], []);
      const report = await executePrimeCleanup({
        plan,
        confirmation: { scopeDigest: plan.scopeDigest, acknowledged: true },
        journal,
        guard: clearGuard,
        proof: proofFor(),
        cleanup: remover([]),
        now: clock(),
      });
      assert.strictEqual(report.outcome, "refused");
      assert.strictEqual(report.reasonCode, "nonDestructiveLifecycle");
      // An audit record for a stop must not read as a refused delete: no
      // deletion reason is reported, because none was ever requested.
      assert.strictEqual(plan.reason, "none");
      assert.strictEqual(report.reason, "none");
    }

    // History, session and cursor all survive every one of those events.
    assert.ok(await exists(layout.session));
    assert.ok(await exists(layout.resumeCursor));
    assert.ok(await exists(layout.ownership));
    assert.strictEqual(journal.rows.size, 0);
  });

  it("plans a bounded manifest of exact paths inside this home only", async () => {
    const first = await makeHome("scope-a");
    const second = await makeHome("scope-b");
    const scope = first.scopeFor(THREAD);
    await seedThread(first.home, THREAD, scope);
    const other = await seedThread(second.home, THREAD, second.scopeFor(THREAD));

    const plan = planPrimeCleanup({
      home: first.home,
      scope,
      lifecycleEvent: "threadDelete",
      guard: { status: "clear" },
    });
    assert.strictEqual(plan.mode, "dryRun");
    assert.strictEqual(plan.requiresConfirmation, true);
    assert.strictEqual(plan.reason, "explicitDelete");
    assert.deepStrictEqual(
      plan.targets.map((target) => target.kind),
      ["resumeCursor", "ownedResources"],
    );
    for (const target of plan.targets) {
      assert.ok(target.path.startsWith(first.home), "target escaped its own T3 home");
      assert.ok(!target.path.startsWith(second.home));
      assert.ok(target.pathToken.startsWith("pct-"));
      assert.ok(!target.pathToken.includes(first.home));
    }
    // Planning reads nothing and removes nothing.
    assert.ok(await exists(other.session));
    assert.strictEqual(plan.scopeKey, primeResumeScopeKey(scope));
  });

  it("defers while a lease is held or an adoption is in flight, and re-checks at execution", async () => {
    const { home, scopeFor } = await makeHome("defer");
    const scope = scopeFor(THREAD);
    const layout = await seedThread(home, THREAD, scope);
    const journal = makeInMemoryPrimeCleanupJournalStore();
    const events: string[] = [];

    for (const guard of [
      { status: "leaseHeld", generation: 4 },
      { status: "adoptionInFlight" },
    ] as const) {
      const plan = planPrimeCleanup({ home, scope, lifecycleEvent: "threadDelete", guard });
      assert.deepStrictEqual(plan.decision, { action: "defer", reason: guard.status });
      const report = await executePrimeCleanup({
        plan,
        confirmation: { scopeDigest: plan.scopeDigest, acknowledged: true },
        journal,
        guard: async () => guard,
        proof: proofFor(),
        cleanup: remover(events),
        now: clock(),
      });
      assert.strictEqual(report.outcome, "deferred");
      assert.strictEqual(report.reasonCode, guard.status);
      assert.strictEqual(report.resumable, true);
    }

    // A plan produced while the scope was free must still lose the race to an
    // activation that started afterwards: the guard is re-read at execution.
    const raced = await confirmedRun({
      home,
      scope,
      journal,
      events,
      guard: async () => ({ status: "leaseHeld", generation: 5 }),
    });
    assert.strictEqual(raced.outcome, "deferred");
    assert.strictEqual(raced.reasonCode, "leaseHeld");
    assert.deepStrictEqual(events, []);
    assert.ok(await exists(layout.session));
    assert.ok(await exists(layout.resumeCursor));
    assert.strictEqual(journal.rows.size, 0, "a deferred run may not open a journal");
  });

  it("refuses a missing or mismatched confirmation", async () => {
    const { home, scopeFor } = await makeHome("confirm");
    const scope = scopeFor(THREAD);
    const layout = await seedThread(home, THREAD, scope);
    const journal = makeInMemoryPrimeCleanupJournalStore();
    const events: string[] = [];
    const plan = planPrimeCleanup({
      home,
      scope,
      lifecycleEvent: "threadDelete",
      guard: { status: "clear" },
    });

    for (const confirmation of [
      undefined,
      { scopeDigest: plan.scopeDigest, acknowledged: false },
      { scopeDigest: "pl-someone-else", acknowledged: true },
    ]) {
      const report = await executePrimeCleanup({
        plan,
        confirmation,
        journal,
        guard: clearGuard,
        proof: proofFor(),
        cleanup: remover(events),
        now: clock(),
      });
      assert.strictEqual(report.outcome, "refused");
      assert.ok(
        report.reasonCode === "confirmationMissing" || report.reasonCode === "confirmationMismatch",
      );
    }
    assert.deepStrictEqual(events, []);
    assert.ok(await exists(layout.session));
    assert.ok(await exists(layout.resumeCursor));
  });

  it("deletes exactly the confirmed scope and leaves every other resource alone", async () => {
    const first = await makeHome("delete-a");
    const second = await makeHome("delete-b");
    const scope = first.scopeFor(THREAD);
    const target = await seedThread(first.home, THREAD, scope);
    const sibling = await seedThread(first.home, "thread-b", first.scopeFor("thread-b"), 72);
    const otherHome = await seedThread(second.home, THREAD, second.scopeFor(THREAD), 73);
    const unowned = join(first.home, "userdata", "prime", "v1", "not-ours.json");
    await writeFile(unowned, "someone else");

    const journal = makeInMemoryPrimeCleanupJournalStore();
    const events: string[] = [];
    const report = await confirmedRun({ home: first.home, scope, journal, events });

    assert.strictEqual(report.outcome, "completed");
    assert.strictEqual(report.resumable, false);
    assert.deepStrictEqual(
      report.steps.map((step) => [step.kind, step.status]),
      [
        ["resumeCursor", "done"],
        ["ownedResources", "done"],
      ],
    );
    assert.ok(events.includes("stop:71"));
    assert.strictEqual(await exists(target.thread), false);
    assert.strictEqual(await exists(target.resumeCursor), false);
    assert.strictEqual(await exists(target.ownership), false);
    // Everything that was not confirmed survives, in this home and the other.
    assert.ok(await exists(sibling.thread));
    assert.ok(await exists(sibling.resumeCursor));
    assert.ok(await exists(otherHome.thread));
    assert.strictEqual(await readFile(unowned, "utf8"), "someone else");
    assert.strictEqual(journal.rows.size, 0, "a completed cleanup leaves no journal row");
  });

  it("resumes idempotently after a crash at any journal checkpoint", async () => {
    for (const crashAt of [1, 2, 3]) {
      const { home, scopeFor } = await makeHome(`crash-${crashAt}`);
      const scope = scopeFor(THREAD);
      const layout = await seedThread(home, THREAD, scope);
      const sibling = await seedThread(home, "thread-b", scopeFor("thread-b"), 72);
      const durable = makeInMemoryPrimeCleanupJournalStore();
      const events: string[] = [];

      // The crash is a hard stop at an exact write, so the durable rows are
      // whatever survived that point — the same state a killed process leaves.
      let writes = 0;
      const crashing: PrimeCleanupJournalStore = {
        read: durable.read,
        clear: durable.clear,
        write: async (entry) => {
          writes += 1;
          if (writes === crashAt) throw new Error("simulated crash");
          await durable.write(entry);
        },
      };

      await confirmedRun({ home, scope, journal: crashing, events }).then(
        () => assert.fail("cleanup should have crashed"),
        (error: Error) => assert.strictEqual(error.message, "simulated crash"),
      );

      const resumed = await resumePrimeCleanup({
        home,
        scope,
        journal: durable,
        guard: clearGuard,
        proof: proofFor(),
        cleanup: remover(events),
        now: clock(),
      });
      if (crashAt === 1) {
        // Nothing was journaled, so nothing is resumable — and nothing ran.
        assert.strictEqual(resumed, undefined);
        assert.ok(await exists(layout.thread));
        assert.deepStrictEqual(events, []);
      } else {
        assert.strictEqual(resumed?.outcome, "completed");
        assert.strictEqual(await exists(layout.thread), false);
        assert.strictEqual(await exists(layout.resumeCursor), false);
        // The captured process is signalled once across the crash boundary.
        assert.strictEqual(events.filter((event) => event === "stop:71").length, 1);
        assert.strictEqual(durable.rows.size, 0);
      }
      assert.ok(await exists(sibling.thread), "an unrelated thread survives every crash point");

      // Running the whole thing again is a no-op, not a second deletion.
      const again = await confirmedRun({ home, scope, journal: durable, events });
      assert.strictEqual(again.outcome, "completed");
      assert.strictEqual(
        events.filter((event) => event === "stop:71").length,
        crashAt === 1 ? 1 : 1,
      );
    }
  });

  it("reports a redacted, resumable partial failure when a resource is retained", async () => {
    const { home, scopeFor } = await makeHome("partial");
    const scope = scopeFor(THREAD);
    const layout = await seedThread(home, THREAD, scope);
    const journal = makeInMemoryPrimeCleanupJournalStore();

    // No platform removal callback: the ownership boundary fails closed.
    const report = await confirmedRun({
      home,
      scope,
      journal,
      events: [],
      cleanup: { stopProcess: async () => {} },
    });

    assert.strictEqual(report.outcome, "incomplete");
    assert.strictEqual(report.reasonCode, "resourceRetained");
    assert.strictEqual(report.resumable, true);
    assert.deepStrictEqual(
      report.steps.map((step) => [step.kind, step.status]),
      [
        ["resumeCursor", "done"],
        ["ownedResources", "retained"],
      ],
    );
    // The session and its ownership record — the handles a later pass needs —
    // are retained in full. Only the resume cursor, whose deletion the operator
    // confirmed and which is not a handle for anything, is already gone.
    assert.ok(await exists(layout.session));
    assert.ok(await exists(layout.ownership));
    assert.strictEqual(await exists(layout.resumeCursor), false);

    const row = journal.rows.get(primeResumeScopeKey(scope));
    assert.strictEqual(row?.status, "incomplete");
    assert.strictEqual(row?.version, 1);

    const redacted = JSON.stringify(redactPrimeCleanupReport(report));
    assert.ok(!redacted.includes(home));
    assert.ok(!redacted.includes(THREAD));
    assert.ok(!redacted.includes("project-a"));
    assert.ok(redacted.includes(report.scopeDigest));
    assert.ok(redacted.includes("actionable") === false);
    assert.ok(redacted.length < 1_000, "reports are bounded");

    // The retained run stays resumable, and succeeds once the boundary works.
    const events: string[] = [];
    const finished = await resumePrimeCleanup({
      home,
      scope,
      journal,
      guard: clearGuard,
      proof: proofFor(),
      cleanup: remover(events),
      now: clock(),
    });
    assert.strictEqual(finished?.outcome, "completed");
    assert.strictEqual(await exists(layout.thread), false);
  });

  it("retains a cursor that provably belongs to another scope", async () => {
    const { home, scopeFor } = await makeHome("foreign-cursor");
    const scope = scopeFor(THREAD);
    const layout = await seedThread(home, THREAD, scope);
    // A cursor recorded by another environment at this thread's derived path.
    await writePrimeResumeCursor(
      layout.resumeCursor,
      makePrimeResumeCursor({
        scope: { ...scope, environmentId: "env-other" } as PrimeResumeCursorScope,
        sessionPathToken: primeSessionPathToken(home, layout.session),
        ownershipGeneration: 1,
        compatibility: { agentVersion: "0.7.2", band: "compatible" },
        capabilityDigest: "sha256:cap",
        recordedAt: "2026-08-16T00:00:00.000Z",
      }),
    );

    const journal = makeInMemoryPrimeCleanupJournalStore();
    const report = await confirmedRun({ home, scope, journal, events: [] });
    // Terminal, not retryable: a foreign cursor at this derived path can never
    // become ours, so the run must not leave work startup recovery re-picks up
    // on every boot.
    assert.strictEqual(report.outcome, "refused");
    assert.strictEqual(report.reasonCode, "cursorScopeMismatch");
    assert.strictEqual(report.resumable, false);
    assert.deepStrictEqual(
      report.steps.map((step) => [step.kind, step.status, step.detail]),
      [
        ["resumeCursor", "retained", "cursorScopeMismatch"],
        ["ownedResources", "retained", "cursorScopeMismatch"],
      ],
    );
    assert.strictEqual(journal.rows.get(primeResumeScopeKey(scope))?.status, "refused");
    // A resume pass over the terminal row does nothing at all.
    assert.strictEqual(
      await resumePrimeCleanup({
        home,
        scope,
        journal,
        guard: async () => ({ status: "clear" }),
        proof: { processMatches: async () => false },
        cleanup: { stopProcess: async () => undefined },
        now: () => "2026-08-16T00:00:01.000Z",
      }),
      undefined,
    );
    const { state } = await readPrimeResumeCursor(layout.resumeCursor);
    assert.strictEqual(state.status, "available");
    // Unprovable scope means untouched: the session and its ownership record
    // are exactly where they were.
    assert.ok(await exists(layout.session));
    assert.ok(await exists(layout.ownership));
  });

  it("never lets a failing removal leak its host path into the report or the journal", async () => {
    const { home, scopeFor } = await makeHome("leak");
    const scope = scopeFor(THREAD);
    const layout = await seedThread(home, THREAD, scope);
    const journal = makeInMemoryPrimeCleanupJournalStore();

    // The realistic failure mode: the platform boundary throws a Node fs error,
    // whose message carries the absolute path it failed on — and a Prime layout
    // path carries base64-encoded environment, instance and thread ids with it.
    const report = await confirmedRun({
      home,
      scope,
      journal,
      events: [],
      cleanup: {
        stopProcess: async () => undefined,
        removeOwnedResource: async (resource) => {
          throw Object.assign(new Error(`EACCES: permission denied, rmdir '${resource.path}'`), {
            code: "EACCES",
          });
        },
      },
    });

    assert.strictEqual(report.outcome, "incomplete");
    const ownership = report.steps.find((step) => step.kind === "ownedResources");
    assert.ok(ownership !== undefined);
    assert.strictEqual(ownership.status, "retained");
    // A code from the closed vocabulary, not classified-and-truncated text.
    assert.strictEqual(ownership.detail, "ownershipCleanupFailedClosed");

    const journalled = journal.rows.get(primeResumeScopeKey(scope));
    assert.ok(journalled !== undefined);
    // The journal is host-local and keyed by scope, so it legitimately holds
    // the scope key; what it may never hold is a host path or raw error text.
    // The report additionally may not carry any id at all — it is the shape
    // allowed into logs, telemetry and a remote client.
    const hostSecrets = [home, layout.ownership, "EACCES", "/"];
    for (const [label, serialized, forbidden] of [
      [
        "report",
        JSON.stringify(redactPrimeCleanupReport(report)),
        [...hostSecrets, "id-", THREAD, "env-a"],
      ],
      ["steps", JSON.stringify(report.steps), [...hostSecrets, "id-", THREAD, "env-a"]],
      ["journal", JSON.stringify(journalled), hostSecrets],
    ] as const) {
      for (const needle of forbidden) {
        assert.ok(
          !serialized.includes(needle),
          `${label} disclosed ${JSON.stringify(needle)}: ${serialized}`,
        );
      }
    }
    // Failing closed means retaining: nothing was destroyed on the way out.
    assert.ok(await exists(layout.ownership));
    assert.ok(await exists(layout.session));
  });

  it("keeps its own source byte-clean so the security-critical diff stays reviewable", async () => {
    // A literal NUL in the path-token hash separator made git store this module
    // as a binary blob: no line diff, no blame, no three-way merge on the one
    // file that may destroy durable data. The escape hashes identically.
    const source = await readFile(new URL("./PrimeDurableCleanup.ts", import.meta.url));
    assert.strictEqual(source.includes(0), false);
    const { home, scopeFor } = await makeHome("token");
    const scope = scopeFor(THREAD);
    const plan = planPrimeCleanup({
      home,
      scope,
      lifecycleEvent: "threadDelete",
      guard: { status: "clear" },
    });
    // Tokens stay opaque and carry nothing from the path they name.
    for (const target of plan.targets) {
      assert.match(target.pathToken, /^pct-[0-9a-f]{16}$/);
      assert.ok(!target.pathToken.includes(home));
    }
  });

  it("keeps rollout and rollback provider-scoped and non-destructive", async () => {
    assert.deepStrictEqual(primeRolloutTransition({ enabled: false, previouslyEnabled: true }), {
      provider: "prime-agent",
      action: "disable",
      deletesDurableData: false,
      preservesUnknownData: true,
    });
    assert.strictEqual(
      primeRolloutTransition({ enabled: true, previouslyEnabled: true }).action,
      "noop",
    );
    assert.strictEqual(
      primeRolloutTransition({ enabled: true, previouslyEnabled: false }).action,
      "enable",
    );
    const rolledBack = primeRolloutTransition({
      enabled: false,
      previouslyEnabled: true,
      rollingBack: true,
    });
    assert.strictEqual(rolledBack.action, "rollback");
    assert.strictEqual(rolledBack.deletesDurableData, false);
  });
});
