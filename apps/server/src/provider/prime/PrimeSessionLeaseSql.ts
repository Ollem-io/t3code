// The lease store is a promise-facing port (the Prime adapter is promise-based),
// so each statement is run at that boundary against the client captured above;
// there is no ambient Effect context to inherit here.
// @effect-diagnostics runEffectInsideEffect:off
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { primeResumeScopeKey, type PrimeResumeCursorScope } from "@t3tools/contracts";

import { primeLeaseIso } from "./PrimeSessionLease.ts";
import type { PrimeSessionLeaseRecord, PrimeSessionLeaseStore } from "./PrimeSessionLease.ts";

/**
 * PA-B03 — durable backing for the single-writer lease.
 *
 * The lease lives in the nullable `lease_*` columns PA-B01 created on
 * `prime_resume_cursors`, which is the only durable identity a Prime session
 * has. A scope that has no cursor yet still needs arbitration (activation is
 * exactly when the first writer must be chosen), so a lease-only row is
 * inserted with `lifecycle_state = 'unavailable'` and an empty cursor payload:
 * "arbitration knows this scope, no cursor has been recorded for it". PA-B01's
 * reader already treats such a row as no cursor, so nothing can mistake it for
 * a resumable session.
 *
 * Atomicity is the point of this file. Acquisition is a compare-and-set on
 * `lease_generation` inside one transaction, and the row count decides the
 * race — two concurrent connections cannot both observe one update.
 */

type LeaseRow = {
  readonly lease_holder_token: string | null;
  readonly lease_generation: number | null;
  readonly lease_fence: number | null;
  readonly lease_expires_at: string | null;
};

const toRecord = (row: LeaseRow): PrimeSessionLeaseRecord | undefined =>
  row.lease_holder_token === null || row.lease_generation === null
    ? undefined
    : {
        holderToken: row.lease_holder_token,
        generation: row.lease_generation,
        fence: row.lease_fence ?? row.lease_generation,
        expiresAtMs: row.lease_expires_at === null ? 0 : Date.parse(row.lease_expires_at),
      };

/**
 * Builds a promise-facing store bound to one SQL client. Two clients over the
 * same database file behave as two processes, which is how the multi-process
 * race fixtures are written.
 */
export const makePrimeSessionLeaseSqlStore = (input: {
  readonly scope: PrimeResumeCursorScope;
  readonly nowIso: () => string;
}): Effect.Effect<PrimeSessionLeaseStore, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { scope } = input;
    const expectedScopeKey = primeResumeScopeKey(scope);

    const assertScope = (scopeKey: string) => {
      // One store serves one scope on purpose: a lease may never be taken for
      // a scope the caller did not prove it is operating on.
      if (scopeKey !== expectedScopeKey) {
        throw new Error("Prime lease store was asked for a scope it does not own");
      }
    };

    const read = async (scopeKey: string) => {
      assertScope(scopeKey);
      const result = await Effect.runPromise(
        sql<LeaseRow>`
          SELECT lease_holder_token, lease_generation, lease_fence, lease_expires_at
          FROM prime_resume_cursors
          WHERE scope_key = ${scopeKey}
        `.pipe(Effect.orDie),
      );
      const row = result[0];
      return row === undefined ? undefined : toRecord(row);
    };

    const compareAndSet = async ({
      scopeKey,
      expectedGeneration,
      next,
    }: {
      readonly scopeKey: string;
      readonly expectedGeneration: number | undefined;
      readonly next: PrimeSessionLeaseRecord | undefined;
    }) => {
      assertScope(scopeKey);
      const now = input.nowIso();
      const expected = expectedGeneration ?? null;
      const holder = next?.holderToken ?? null;
      const generation = next?.generation ?? null;
      const fence = next?.fence ?? null;
      const expiresAt = next === undefined ? null : primeLeaseIso(next.expiresAtMs);
      return await Effect.runPromise(
        Effect.gen(function* () {
          // A lease-only row: arbitration exists before any cursor does.
          yield* sql`
            INSERT OR IGNORE INTO prime_resume_cursors (
              scope_key, environment_id, provider_instance_id, project_id, thread_id,
              home_fingerprint, cursor_version, cursor_json, lifecycle_state,
              ownership_generation, session_path_token, created_at, updated_at
            ) VALUES (
              ${scopeKey}, ${scope.environmentId}, ${scope.providerInstanceId}, ${scope.projectId},
              ${scope.threadId}, ${scope.homeFingerprint}, 0, '{}', 'unavailable', 0, '', ${now}, ${now}
            )
          `;
          yield* sql`
            UPDATE prime_resume_cursors
            SET lease_holder_token = ${holder},
                lease_generation = ${generation},
                lease_fence = ${fence},
                lease_expires_at = ${expiresAt},
                updated_at = ${now}
            WHERE scope_key = ${scopeKey}
              AND lease_generation IS ${expected}
          `;
          const changed = yield* sql<{ readonly changed: number }>`SELECT changes() AS changed`;
          return Number(changed[0]?.changed ?? 0) === 1;
        }).pipe(sql.withTransaction, Effect.orDie),
      );
    };

    return { read, compareAndSet } satisfies PrimeSessionLeaseStore;
  });
