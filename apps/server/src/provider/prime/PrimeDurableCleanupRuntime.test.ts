// The fixture materializes real owned inodes so the exact remover can prove
// them; that needs the raw fs primitives, same as the module under test.
// @effect-diagnostics nodeBuiltinImport:off
// The redaction assertions inspect the serialized report exactly as a log line
// would carry it, and the lease fixture writes a wall-clock expiry the way a
// real writer does.
// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics globalDateInEffect:off
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { primeResumeScopeKey, type PrimeResumeCursorScope } from "@t3tools/contracts";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { PRIME_CLEANUP_JOURNAL_VERSION } from "./PrimeDurableCleanup.ts";
import { makePrimeCleanupJournalSqlStore } from "./PrimeDurableCleanupSql.ts";
import { resumeUnfinishedPrimeCleanup } from "./PrimeDurableCleanupRuntime.ts";
import { writePrimeOwnership } from "./PrimeOwnership.ts";
import {
  makePrimeResumeCursor,
  primeSessionPathToken,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";

/**
 * PA-B05 production reachability.
 *
 * The planner/executor being correct is worth nothing if nothing in the running
 * server ever calls them. These cases pin the one automatic path that does:
 * startup recovery, driven by `PrimeDriver.create`, finishing a confirmed
 * cleanup a crash interrupted — and refusing to touch a row that belongs to
 * another instance, another environment or another T3 home.
 */

const ENVIRONMENT = "env-a";
const INSTANCE = "prime-agent";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const makeHome = async (label: string) =>
  await NodeFSP.mkdtemp(
    NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), `t3-pa-b05-runtime-${label}-`),
  );

const scopeFor = (home: string, overrides?: Partial<Record<string, string>>) =>
  ({
    environmentId: ENVIRONMENT,
    providerInstanceId: INSTANCE,
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: primeHomeFingerprint(home),
    ...overrides,
  }) as PrimeResumeCursorScope;

/** Materializes exactly what a live Prime thread owns inside one home. */
const seedThread = async (home: string, scope: PrimeResumeCursorScope) => {
  const layout = primeResourceLayout({
    home,
    environmentId: String(scope.environmentId),
    instanceId: String(scope.providerInstanceId),
    threadId: String(scope.threadId),
  });
  await NodeFSP.mkdir(layout.session, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(layout.session, "owned"), "session");
  await NodeFSP.writeFile(layout.config, "{}");
  await writePrimeOwnership(layout.ownership, {
    version: 1,
    environmentId: String(scope.environmentId),
    instanceId: String(scope.providerInstanceId),
    threadId: String(scope.threadId),
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

const journalRow = (scope: PrimeResumeCursorScope) =>
  ({
    version: PRIME_CLEANUP_JOURNAL_VERSION,
    scopeKey: primeResumeScopeKey(scope),
    scopeDigest: "digest-abc",
    reason: "explicitDelete",
    status: "running",
    // Exactly the crash point PA-B05 cares about: the cursor step was already
    // proven done and the irreversible step never ran.
    steps: [
      { kind: "resumeCursor", status: "done" },
      { kind: "ownedResources", status: "pending" },
    ],
    startedAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:01.000Z",
  }) as const;

const exists = async (path: string) =>
  await NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

layer("PrimeDurableCleanupRuntime", (it) => {
  it.effect("finishes a crash-interrupted cleanup this instance owns", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 50 });
      const home = yield* Effect.promise(() => makeHome("owned"));
      const scope = scopeFor(home);
      const layout = yield* Effect.promise(() => seedThread(home, scope));
      const journal = yield* makePrimeCleanupJournalSqlStore();
      yield* Effect.promise(() => journal.write(journalRow(scope)));

      const reports = yield* resumeUnfinishedPrimeCleanup({
        environmentId: ENVIRONMENT,
        instanceId: INSTANCE,
        home,
      });

      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.outcome, "completed");
      // The report is the redacted shape, so it names no path and no id.
      const serialized = JSON.stringify(reports[0]);
      for (const needle of [home, "/", "thread-a", ENVIRONMENT]) {
        assert.isFalse(serialized.includes(needle), `report disclosed ${needle}: ${serialized}`);
      }
      assert.isFalse(yield* Effect.promise(() => exists(layout.ownership)));
      // A finished run leaves no row for the next startup to pick up.
      assert.deepEqual(yield* Effect.promise(() => journal.listUnfinished()), []);
    }),
  );

  it.effect("never resumes a row belonging to another instance, environment or home", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 50 });
      const home = yield* Effect.promise(() => makeHome("foreign"));
      const journal = yield* makePrimeCleanupJournalSqlStore();

      const foreign = [
        scopeFor(home, { providerInstanceId: "prime-agent-2" }),
        scopeFor(home, { environmentId: "env-b" }),
        scopeFor(home, { homeFingerprint: "another-home" }),
      ];
      for (const scope of foreign) {
        yield* Effect.promise(() => seedThread(home, scope));
        yield* Effect.promise(() => journal.write(journalRow(scope)));
      }

      const reports = yield* resumeUnfinishedPrimeCleanup({
        environmentId: ENVIRONMENT,
        instanceId: INSTANCE,
        home,
      });

      assert.deepEqual([...reports], []);
      // Every foreign row and every foreign resource is exactly as it was.
      assert.equal((yield* Effect.promise(() => journal.listUnfinished())).length, foreign.length);
      for (const scope of foreign) {
        const layout = primeResourceLayout({
          home,
          environmentId: String(scope.environmentId),
          instanceId: String(scope.providerInstanceId),
          threadId: String(scope.threadId),
        });
        assert.isTrue(yield* Effect.promise(() => exists(layout.ownership)));
        assert.isTrue(yield* Effect.promise(() => exists(layout.session)));
      }
    }),
  );

  it.effect("stays reachable from the production driver and the production registry", () =>
    Effect.gen(function* () {
      // The original PA-B05 defect was that every one of these paths existed
      // and nothing in the running server called them. These assertions fail
      // the moment the wiring is dropped again.
      const driver = yield* Effect.promise(() =>
        NodeFSP.readFile(new URL("../Drivers/PrimeDriver.ts", import.meta.url), "utf8"),
      );
      assert.include(driver, "resumeUnfinishedPrimeCleanup({");
      assert.include(driver, "PrimeDurableCleanupRuntime.ts");

      const hydration = yield* Effect.promise(() =>
        NodeFSP.readFile(
          new URL("../Layers/ProviderInstanceRegistryHydration.ts", import.meta.url),
          "utf8",
        ),
      );
      assert.include(hydration, "onInstanceRemoved:");
    }),
  );

  it.effect("defers to a live single-writer lease instead of deleting under it", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 50 });
      const home = yield* Effect.promise(() => makeHome("lease"));
      const scope = scopeFor(home);
      const layout = yield* Effect.promise(() => seedThread(home, scope));
      const journal = yield* makePrimeCleanupJournalSqlStore();
      yield* Effect.promise(() => journal.write(journalRow(scope)));

      const sql = yield* SqlClient.SqlClient;
      const expires = new Date(Date.now() + 60_000).toISOString();
      // Another writer holds a live lease on exactly this scope.
      yield* sql`
        INSERT INTO prime_resume_cursors (
          scope_key, environment_id, provider_instance_id, project_id, thread_id,
          home_fingerprint, cursor_version, cursor_json, lifecycle_state,
          ownership_generation, session_path_token, lease_holder_token,
          lease_generation, lease_fence, lease_expires_at, created_at, updated_at
        ) VALUES (
          ${primeResumeScopeKey(scope)}, ${String(scope.environmentId)},
          ${String(scope.providerInstanceId)}, ${String(scope.projectId)},
          ${String(scope.threadId)}, ${String(scope.homeFingerprint)}, 2, '{}', 'recorded',
          1, 'spt-token', 'other-writer', 4, 4, ${expires},
          '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
        )
      `;

      const reports = yield* resumeUnfinishedPrimeCleanup({
        environmentId: ENVIRONMENT,
        instanceId: INSTANCE,
        home,
      });

      assert.equal(reports[0]?.outcome, "deferred");
      assert.equal(reports[0]?.reasonCode, "leaseHeld");
      assert.isTrue(yield* Effect.promise(() => exists(layout.ownership)));
      assert.isTrue(yield* Effect.promise(() => exists(layout.session)));
    }),
  );
});
