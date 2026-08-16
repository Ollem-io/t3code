import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ThreadForkAncestry", (it) => {
  it.effect("adds nullable fork ancestry and identity card columns, and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 47 });
      // A second run must preserve the schema and report no pending work.
      yield* runMigrations({ toMigrationInclusive: 47 });

      const threadColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const sessionColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const forkedFrom = threadColumns.find((column) => column.name === "forked_from_json");
      const identityCard = sessionColumns.find((column) => column.name === "identity_card_json");

      // Additive and nullable: every thread that was simply created has no
      // ancestry, and a session whose runtime reports no name or fork points
      // has no card.
      assert.equal(forkedFrom?.name, "forked_from_json");
      assert.equal(forkedFrom?.notnull, 0);
      assert.equal(identityCard?.name, "identity_card_json");
      assert.equal(identityCard?.notnull, 0);
    }),
  );
});
