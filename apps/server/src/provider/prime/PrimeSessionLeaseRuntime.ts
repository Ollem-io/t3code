// The gate is a promise-facing port (the Prime adapter is promise-based), so
// each statement runs at that boundary against the client captured on layer
// construction; there is no ambient Effect context inside those callbacks.
// @effect-diagnostics runEffectInsideEffect:off
// The lease clock is read inside promise callbacks the adapter drives, where
// there is no fiber to carry an Effect Clock.
// @effect-diagnostics globalDate:off
import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PrimeResumeCursorScope } from "@t3tools/contracts";

import { primeHomeFingerprint } from "./PrimeResourceLayout.ts";
import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  makePrimeSessionWriteGate,
  primeLeaseIso,
  type PrimeSessionLeaseService,
  type PrimeSessionWriteGate,
} from "./PrimeSessionLease.ts";
import { makePrimeSessionLeaseSqlStore } from "./PrimeSessionLeaseSql.ts";

/**
 * PA-B03 — the production construction of the single-writer gate.
 *
 * One T3 server process is one Prime writer: inside the process the adapter
 * already binds a thread to a single session and the command reactor already
 * serializes turns, so the arbitration that actually has to be proved is
 * between *processes* sharing one T3 home — a second server, a relayed host, a
 * restarted server whose predecessor is still alive. That is what the durable
 * lease decides, which is why the writer identity below is per process and the
 * store is the shared database whenever there is one.
 *
 * A thread with no projection row yet has no durable identity to arbitrate on,
 * so it falls back to a process-local store: still one writer inside this
 * server, and nothing invented is written to the database for it.
 */

/** Stable for the life of this process; two processes never collide. */
const PRIME_WRITER_PROCESS_TOKEN = `${process.pid}:${randomUUID()}`;

const UNRESOLVED_PROJECT = "t3-unresolved-project";

export const makePrimeServerWriteGate = (input: {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly home: string;
}): Effect.Effect<PrimeSessionWriteGate> =>
  Effect.gen(function* () {
    // Optional on purpose: a driver constructed outside the server runtime
    // (CLI probes, fixtures) still gets in-process arbitration rather than
    // none at all.
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const homeFingerprint = primeHomeFingerprint(input.home);
    const scopes = new Map<string, PrimeResumeCursorScope>();
    const services = new Map<string, PrimeSessionLeaseService>();

    const projectIdFor = async (threadId: string): Promise<string | undefined> => {
      if (Option.isNone(sql)) return undefined;
      const client = sql.value;
      const rows = await Effect.runPromise(
        client<{
          readonly project_id: string | null;
        }>`SELECT project_id FROM projection_threads WHERE thread_id = ${threadId}`.pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly project_id: string | null }>),
        ),
      );
      return rows[0]?.project_id ?? undefined;
    };

    const scopeForThread = async (threadId: string): Promise<PrimeResumeCursorScope> => {
      const cached = scopes.get(threadId);
      if (cached !== undefined) return cached;
      const projectId = await projectIdFor(threadId);
      const scope = {
        environmentId: input.environmentId,
        providerInstanceId: input.instanceId,
        projectId: projectId ?? UNRESOLVED_PROJECT,
        threadId,
        homeFingerprint,
      } as PrimeResumeCursorScope;
      scopes.set(threadId, scope);
      return scope;
    };

    const serviceForThread = async (threadId: string): Promise<PrimeSessionLeaseService> => {
      const existing = services.get(threadId);
      if (existing !== undefined) return existing;
      const scope = await scopeForThread(threadId);
      // Only a scope with a real durable identity is arbitrated in the shared
      // database; anything else stays inside this process.
      const store =
        Option.isSome(sql) && scope.projectId !== UNRESOLVED_PROJECT
          ? await Effect.runPromise(
              makePrimeSessionLeaseSqlStore({
                scope,
                nowIso: () => primeLeaseIso(Date.now()),
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql.value)),
            )
          : makeInMemoryPrimeSessionLeaseStore();
      const service = makePrimeSessionLeaseService({
        store,
        now: () => Date.now(),
        // The server host is the authority for its own environment: a request
        // that reached the adapter has already passed connection auth, and the
        // gate must never become a second, weaker auth decision.
        authorize: () => true,
      });
      services.set(threadId, service);
      return service;
    };

    return makePrimeSessionWriteGate({
      serviceForThread,
      writer: {
        clientToken: `${input.environmentId}:${input.instanceId}`,
        processToken: PRIME_WRITER_PROCESS_TOKEN,
      },
      scopeForThread,
      now: () => Date.now(),
    });
  });
