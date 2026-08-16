// The cleanup journal is a promise-facing port (the Prime adapter is
// promise-based), so each statement is run at that boundary against the client
// captured above; there is no ambient Effect context to inherit here.
// @effect-diagnostics runEffectInsideEffect:off
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PRIME_CLEANUP_JOURNAL_VERSION,
  type PrimeCleanupJournalEntry,
  type PrimeCleanupJournalStore,
  type PrimeCleanupJournalStep,
} from "./PrimeDurableCleanup.ts";

/**
 * PA-B05 — durable backing for the cleanup journal.
 *
 * The row is written in one statement per transition, so a crash observes
 * either the previous step list or the next one. A row whose `journal_version`
 * this build does not know is reported as *no resumable journal* rather than
 * acted on: an unreadable plan must never authorize a deletion, and the row is
 * left in place for the build that wrote it.
 */

type JournalRow = {
  readonly scope_key: string;
  readonly journal_version: number;
  readonly scope_digest: string;
  readonly reason: string;
  readonly status: string;
  readonly steps_json: string;
  readonly started_at: string;
  readonly updated_at: string;
};

const STEP_KINDS = new Set(["ownedResources", "resumeCursor"]);
const STEP_STATUSES = new Set(["pending", "done", "retained"]);
const REASONS = new Set(["explicitDelete", "providerRemoval", "reconfigure", "migration"]);
const STATUSES = new Set(["running", "completed", "incomplete"]);

const decodeSteps = (text: string): readonly PrimeCleanupJournalStep[] | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const steps: PrimeCleanupJournalStep[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null) return undefined;
    const step = value as Record<string, unknown>;
    if (typeof step.kind !== "string" || !STEP_KINDS.has(step.kind)) return undefined;
    if (typeof step.status !== "string" || !STEP_STATUSES.has(step.status)) return undefined;
    if (step.detail !== undefined && typeof step.detail !== "string") return undefined;
    steps.push({
      kind: step.kind as PrimeCleanupJournalStep["kind"],
      status: step.status as PrimeCleanupJournalStep["status"],
      ...(typeof step.detail === "string" ? { detail: step.detail } : {}),
    });
  }
  return steps;
};

const decodeRow = (row: JournalRow): PrimeCleanupJournalEntry | undefined => {
  if (row.journal_version !== PRIME_CLEANUP_JOURNAL_VERSION) return undefined;
  if (!REASONS.has(row.reason) || !STATUSES.has(row.status)) return undefined;
  const steps = decodeSteps(row.steps_json);
  if (steps === undefined) return undefined;
  return {
    version: PRIME_CLEANUP_JOURNAL_VERSION,
    scopeKey: row.scope_key,
    scopeDigest: row.scope_digest,
    reason: row.reason as PrimeCleanupJournalEntry["reason"],
    status: row.status as PrimeCleanupJournalEntry["status"],
    steps,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
};

export const makePrimeCleanupJournalSqlStore = (): Effect.Effect<
  PrimeCleanupJournalStore & {
    /** Startup recovery: every scope with cleanup left unfinished. */
    readonly listUnfinished: () => Promise<readonly PrimeCleanupJournalEntry[]>;
  },
  never,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rowsFor = (scopeKey?: string) =>
      Effect.runPromise(
        (scopeKey === undefined
          ? sql<JournalRow>`
              SELECT * FROM prime_cleanup_journal WHERE status <> 'completed'
              ORDER BY started_at
            `
          : sql<JournalRow>`SELECT * FROM prime_cleanup_journal WHERE scope_key = ${scopeKey}`
        ).pipe(Effect.orDie),
      );

    return {
      read: async (scopeKey) => {
        const rows = await rowsFor(scopeKey);
        const row = rows[0];
        return row === undefined ? undefined : decodeRow(row);
      },
      listUnfinished: async () => {
        const rows = await rowsFor();
        return rows.flatMap((row) => {
          const entry = decodeRow(row);
          return entry === undefined ? [] : [entry];
        });
      },
      write: async (entry) => {
        await Effect.runPromise(
          sql`
            INSERT INTO prime_cleanup_journal (
              scope_key, journal_version, scope_digest, reason, status, steps_json,
              started_at, updated_at
            ) VALUES (
              ${entry.scopeKey}, ${entry.version}, ${entry.scopeDigest}, ${entry.reason},
              ${entry.status}, ${JSON.stringify(entry.steps)}, ${entry.startedAt},
              ${entry.updatedAt}
            )
            ON CONFLICT (scope_key) DO UPDATE SET
              journal_version = excluded.journal_version,
              scope_digest = excluded.scope_digest,
              reason = excluded.reason,
              status = excluded.status,
              steps_json = excluded.steps_json,
              updated_at = excluded.updated_at
          `.pipe(sql.withTransaction, Effect.orDie),
        );
      },
      clear: async (scopeKey) => {
        await Effect.runPromise(
          sql`DELETE FROM prime_cleanup_journal WHERE scope_key = ${scopeKey}`.pipe(Effect.orDie),
        );
      },
    };
  });
