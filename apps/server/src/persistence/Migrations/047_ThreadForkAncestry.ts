import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const hasColumn = (columns: ReadonlyArray<{ readonly name: string }>, name: string) =>
  columns.some((column) => column.name === name);

/**
 * Adds the two columns naming and forking need.
 *
 * `projection_threads.forked_from_json` is the ancestry of a forked thread: the
 * thread it came from, the label of the point it was taken at, and the source
 * thread's checkpoint at that moment. It is additive, nullable, and readable
 * with no Prime Agent installed — and it is deliberately not a resume cursor.
 *
 * `projection_thread_sessions.identity_card_json` is the live session's name
 * and fork-point page, which is cleared with the session rather than migrated.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!hasColumn(threadColumns, "forked_from_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN forked_from_json TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasColumn(sessionColumns, "identity_card_json")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN identity_card_json TEXT
    `;
  }
});
