import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_ProjectionThreadSessionActionState", (it) => {
  it.effect("adds both session runtime JSON columns after migration 40 and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* runMigrations({ toMigrationInclusive: 41 });
      // A second run must preserve the schema and report no pending work.
      yield* runMigrations({ toMigrationInclusive: 41 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const actionState = columns.find((column) => column.name === "action_state_json");
      const runtimeCapabilities = columns.find(
        (column) => column.name === "runtime_capabilities_json",
      );

      assert.equal(actionState?.name, "action_state_json");
      assert.equal(actionState?.notnull, 0);
      assert.equal(runtimeCapabilities?.name, "runtime_capabilities_json");
      assert.equal(runtimeCapabilities?.notnull, 0);
    }),
  );
});
