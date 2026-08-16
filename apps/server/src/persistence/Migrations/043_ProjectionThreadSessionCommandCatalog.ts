import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Adds the runtime command catalog snapshot column. Additive and nullable:
 * existing sessions simply have no catalog until their runtime reports one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(columns, "command_catalog_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN command_catalog_json TEXT
    `;
  }
});
