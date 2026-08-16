import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const actionStateColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(actionStateColumns, "action_state_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN action_state_json TEXT
    `;
  }

  // Re-read after the first ALTER. SQLite PRAGMA results describe the schema
  // at the time of the query; using a fresh read makes both additions safe
  // when this migration is resumed against a partially upgraded database.
  const runtimeCapabilitiesColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(runtimeCapabilitiesColumns, "runtime_capabilities_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN runtime_capabilities_json TEXT
    `;
  }
});
