import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * PA-B01 — durable storage for the Prime resume cursor.
 *
 * Purely additive: nothing existing is read, rewritten or dropped, so data
 * written before Prime (and by the MVP/Alpha milestones) stays exactly as it
 * was and a downgraded build simply ignores this table. `cursor_json` is the
 * opaque cursor payload — never a transcript, prompt, setting or host path —
 * and it is stored verbatim so a version this build cannot decode survives a
 * round trip instead of being deleted.
 *
 * The lease columns are nullable placeholders owned by PA-B03. They exist here
 * because the arbitration schema has to be present before PA-B02 may activate
 * a cursor; this migration never populates them.
 *
 * `CREATE ... IF NOT EXISTS` in one transactional migration makes an
 * interrupted run atomic and a repeated run a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS prime_resume_cursors (
      scope_key TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      home_fingerprint TEXT NOT NULL,
      cursor_version INTEGER NOT NULL,
      cursor_json TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      ownership_generation INTEGER NOT NULL,
      session_path_token TEXT NOT NULL,
      lease_holder_token TEXT,
      lease_generation INTEGER,
      lease_fence INTEGER,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // One cursor per environment/instance/project/thread inside one T3 home:
  // a second home has a different fingerprint and therefore its own row.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS prime_resume_cursors_identity
    ON prime_resume_cursors (
      home_fingerprint,
      environment_id,
      provider_instance_id,
      project_id,
      thread_id
    )
  `;

  // Indexed lookup for the two questions resume asks: "this thread" and
  // "everything this instance owns". Neither needs a table scan.
  yield* sql`
    CREATE INDEX IF NOT EXISTS prime_resume_cursors_thread
    ON prime_resume_cursors (thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS prime_resume_cursors_instance
    ON prime_resume_cursors (environment_id, provider_instance_id, lifecycle_state)
  `;
});
