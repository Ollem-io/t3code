import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionThreadSessionAgentRoster", (it) => {
  it.effect("adds a nullable agent roster column and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* runMigrations({ toMigrationInclusive: 45 });
      // A second run must preserve the schema and report no pending work.
      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const agentRoster = columns.find((column) => column.name === "agent_roster_json");

      // Additive and nullable: a session that predates observation simply has
      // no roster until its runtime reports one.
      assert.equal(agentRoster?.name, "agent_roster_json");
      assert.equal(agentRoster?.notnull, 0);
    }),
  );
});
