import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Adds the runtime agent roster column. Additive and nullable: existing
 * sessions simply have no roster until their runtime reports one, and a roster
 * is cleared rather than migrated when a session ends.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(columns, "agent_roster_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN agent_roster_json TEXT
    `;
  }
});
