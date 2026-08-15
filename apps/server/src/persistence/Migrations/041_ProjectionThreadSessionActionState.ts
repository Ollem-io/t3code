import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_thread_sessions)`;
  if (!columns.some((column) => column.name === "action_state_json")) yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN action_state_json TEXT`;
  if (!columns.some((column) => column.name === "runtime_capabilities_json")) yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN runtime_capabilities_json TEXT`;
});
