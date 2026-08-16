import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ProjectionThreadSessionResumeState", (it) => {
  it.effect("adds a nullable resume state column and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 49 });
      // A second run must preserve the schema and report no pending work.
      yield* runMigrations({ toMigrationInclusive: 49 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      const resumeState = columns.find((column) => column.name === "resume_state_json");

      // Additive and nullable: a session with no durable resume simply has
      // none.
      assert.equal(resumeState?.name, "resume_state_json");
      assert.equal(resumeState?.notnull, 0);
    }),
  );
});
