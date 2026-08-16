import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionThreadSessionGoalBoard", (it) => {
  it.effect("adds a nullable goal board column and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* runMigrations({ toMigrationInclusive: 46 });
      // A second run must preserve the schema and report no pending work.
      yield* runMigrations({ toMigrationInclusive: 46 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const goalBoard = columns.find((column) => column.name === "goal_board_json");

      // Additive and nullable: a session that predates goals and heartbeats
      // simply has no board until its runtime reports one.
      assert.equal(goalBoard?.name, "goal_board_json");
      assert.equal(goalBoard?.notnull, 0);
    }),
  );
});
