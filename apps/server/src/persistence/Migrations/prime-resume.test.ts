import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { primeResumeScopeKey } from "@t3tools/contracts";

import {
  decodePrimeResumeCursor,
  encodePrimeResumeCursor,
} from "../../provider/prime/PrimeResumeCursor.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

/**
 * PA-B01 migration fixture matrix: no-Prime data, MVP/Alpha data, every
 * supported cursor version, corrupt/partial rows, an unknown future version,
 * an interrupted migration, a rollback, and two T3 homes.
 */

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const scope = (overrides?: Partial<Record<string, string>>) => ({
  environmentId: "env-a",
  providerInstanceId: "prime",
  projectId: "project-a",
  threadId: "thread-a",
  homeFingerprint: "home-one",
  ...overrides,
});

const cursor = (overrides?: Record<string, unknown>) => ({
  version: 2,
  scope: scope(),
  sessionPathToken: "spt-0123456789abcdef0123456789abcdef",
  ownershipGeneration: 2,
  compatibility: { agentVersion: "0.7.2", band: "compatible" },
  lifecycle: "recorded",
  recordedAt: "2026-08-16T00:00:00.000Z",
  capabilityDigest: "sha256:cap",
  ...overrides,
});

type Row = {
  readonly scope_key: string;
  readonly cursor_version: number;
  readonly cursor_json: string;
  readonly lifecycle_state: string;
  readonly lease_holder_token: string | null;
};

const insertCursor = (payload: {
  readonly scopeInput: ReturnType<typeof scope>;
  readonly value: Record<string, unknown> | string;
  readonly version: number;
  readonly lifecycle?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Rows are encoded with the production codec so the fixtures are the exact
    // bytes storage would write; the corrupt fixture is passed through raw.
    const json =
      typeof payload.value === "string"
        ? payload.value
        : encodePrimeResumeCursor(payload.value as never);
    yield* sql`
      INSERT INTO prime_resume_cursors (
        scope_key, environment_id, provider_instance_id, project_id, thread_id,
        home_fingerprint, cursor_version, cursor_json, lifecycle_state,
        ownership_generation, session_path_token, created_at, updated_at
      ) VALUES (
        ${primeResumeScopeKey(payload.scopeInput as never)},
        ${payload.scopeInput.environmentId},
        ${payload.scopeInput.providerInstanceId},
        ${payload.scopeInput.projectId},
        ${payload.scopeInput.threadId},
        ${payload.scopeInput.homeFingerprint},
        ${payload.version},
        ${json},
        ${payload.lifecycle ?? "recorded"},
        2,
        'spt-0123456789abcdef0123456789abcdef',
        '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z'
      )
    `;
  });

// The in-memory database is shared by every test in this layer, so each test
// owns its own environment id and only ever looks at its own rows.
const rows = (environmentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<Row>`
      SELECT * FROM prime_resume_cursors
      WHERE environment_id = ${environmentId}
      ORDER BY scope_key
    `;
  });

layer("048_PrimeResumeCursors", (it) => {
  it.effect("is additive over pre-Prime and MVP/Alpha data, and idempotent when interrupted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // A database that has never seen Prime: migrate up to the last
      // pre-B01 migration and write representative MVP/Alpha rows.
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, forked_from_json)
        VALUES ('thread-a', 'project-a', 'alpha thread', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '{"threadId":"thread-root"}')
      `;
      const before = yield* sql<{
        readonly thread_id: string;
        readonly forked_from_json: string | null;
      }>`SELECT thread_id, forked_from_json FROM projection_threads`;

      // Interrupted migration: the run is retried, then repeated. Both are
      // safe because the migration only creates missing objects.
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const after = yield* sql<{
        readonly thread_id: string;
        readonly forked_from_json: string | null;
      }>`SELECT thread_id, forked_from_json FROM projection_threads`;
      assert.deepEqual(after, before, "existing rows are untouched by the cursor migration");
      assert.deepEqual(yield* rows("env-a"), [], "no cursor is invented for existing threads");

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'prime_resume_cursors'
      `;
      const names = indexes.map((index) => index.name);
      assert.include(names, "prime_resume_cursors_identity");
      assert.include(names, "prime_resume_cursors_thread");

      // The PA-B03 lease columns exist and stay empty here.
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(prime_resume_cursors)
      `;
      for (const lease of [
        "lease_holder_token",
        "lease_generation",
        "lease_fence",
        "lease_expires_at",
      ]) {
        assert.equal(columns.find((column) => column.name === lease)?.notnull, 0);
      }
    }),
  );

  it.effect("keeps every stored version readable and turns bad rows into unavailable state", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 48 });

      const fixtures = [
        { name: "v1", value: { ...cursor(), version: 1, capabilityDigest: undefined }, version: 1 },
        { name: "v2", value: cursor(), version: 2 },
        { name: "future", value: { ...cursor(), version: 99, futureOnly: { a: 1 } }, version: 99 },
        { name: "partial", value: { version: 2 }, version: 2 },
        { name: "corrupt", value: "{not json", version: 2 },
        { name: "invalidated", value: { ...cursor(), lifecycle: "invalidated" }, version: 2 },
      ] as const;

      for (const fixture of fixtures) {
        yield* insertCursor({
          scopeInput: scope({ environmentId: "env-fixtures", threadId: `thread-${fixture.name}` }),
          value: fixture.value as never,
          version: fixture.version,
          lifecycle: fixture.name === "invalidated" ? "invalidated" : "recorded",
        });
      }

      const stored = yield* rows("env-fixtures");
      assert.equal(stored.length, fixtures.length);

      const statusFor = (name: string) =>
        decodePrimeResumeCursor(
          stored.find((entry) => entry.scope_key.includes(`thread-${name}`))!.cursor_json,
        );

      assert.equal(statusFor("v1").status, "available");
      assert.equal(statusFor("v2").status, "available");
      assert.deepEqual(statusFor("future"), {
        status: "unavailable",
        reason: "unsupportedVersion",
        storedVersion: 99,
      });
      assert.deepEqual(statusFor("partial"), { status: "unavailable", reason: "corrupt" });
      assert.deepEqual(statusFor("corrupt"), { status: "unavailable", reason: "corrupt" });
      assert.deepEqual(statusFor("invalidated"), { status: "unavailable", reason: "invalidated" });
    }),
  );

  it.effect("preserves unknown future payloads across a rollback to the previous schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      const future = encodePrimeResumeCursor({
        ...cursor(),
        version: 99,
        futureOnly: { keep: "me" },
      } as never);
      yield* insertCursor({
        scopeInput: scope({ environmentId: "env-rollback" }),
        value: future,
        version: 99,
      });

      // Rollback in this repository means running an older build, whose loader
      // simply stops at 47. The newer table and its unknown rows must survive
      // that untouched, and a re-upgrade must not rewrite them.
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const stored = yield* rows("env-rollback");
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.cursor_json, future, "unknown data is preserved verbatim");
      assert.equal(stored[0]!.cursor_version, 99);

      const applied = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.equal(applied.at(-1)?.name, "PrimeResumeCursors");
      assert.equal(applied.filter((row) => row.migration_id === 48).length, 1);
    }),
  );

  it.effect("cannot confuse two T3 homes or two scopes for one thread", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 48 });
      const one = scope({ environmentId: "env-homes" });
      const two = scope({ environmentId: "env-homes", homeFingerprint: "home-two" });
      yield* insertCursor({ scopeInput: one, value: cursor({ scope: one }), version: 2 });
      yield* insertCursor({ scopeInput: two, value: cursor({ scope: two }), version: 2 });

      const stored = yield* rows("env-homes");
      assert.equal(stored.length, 2, "the same thread in two homes keeps two independent rows");
      assert.equal(new Set(stored.map((row) => row.scope_key)).size, 2);
      assert.deepEqual(
        stored.map((row) => row.lease_holder_token),
        [null, null],
      );

      const duplicate = yield* insertCursor({
        scopeInput: one,
        value: cursor({ scope: one }),
        version: 2,
      }).pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure", "the identity index rejects a duplicate scope");
    }),
  );
});
