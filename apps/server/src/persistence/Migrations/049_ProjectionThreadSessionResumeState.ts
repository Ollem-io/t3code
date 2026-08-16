import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Adds the durable session resume state column. Additive and nullable: existing
 * sessions and a session with no durable resume simply have none.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(columns, "resume_state_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN resume_state_json TEXT
    `;
  }
});
