import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * PA-B05 — write-ahead journal for destructive Prime cleanup.
 *
 * One row per scope, holding the versioned step list cleanup writes *before*
 * it removes anything. A crash therefore always leaves a durable statement of
 * what was already proven done, and the resumed run skips exactly those steps.
 *
 * Purely additive, like PA-B01's cursor table: nothing existing is read or
 * rewritten, an older build ignores the table, and a rollback loses no cursor,
 * ownership record or unknown field. `journal_version` is explicit so a future
 * schema can refuse a row it cannot interpret instead of acting on it.
 *
 * `CREATE ... IF NOT EXISTS` in one transactional migration makes an
 * interrupted run atomic and a repeated run a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS prime_cleanup_journal (
      scope_key TEXT PRIMARY KEY,
      journal_version INTEGER NOT NULL,
      scope_digest TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Startup recovery asks exactly one question: "is any cleanup unfinished?".
  yield* sql`
    CREATE INDEX IF NOT EXISTS prime_cleanup_journal_status
    ON prime_cleanup_journal (status)
  `;
});
