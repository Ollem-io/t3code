import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Adds the runtime context/compaction/retry snapshot column. Additive and
 * nullable: existing sessions simply have no snapshot until their runtime
 * reports one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(columns, "context_state_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN context_state_json TEXT
    `;
  }
});
