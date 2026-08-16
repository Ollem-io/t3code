// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics instanceOfSchema:off
// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  primeResumeScopeKey,
  type PrimeResumeCursorScope,
} from "@t3tools/contracts";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { makePrimeAdapter } from "../src/provider/Layers/PrimeAdapter.ts";
import { spawnPrimeRpcTransport } from "../src/provider/prime/PrimeRpcProcessTransport.ts";
import {
  makePrimeSessionLeaseService,
  makePrimeSessionWriteGate,
  PRIME_SESSION_LEASE_TTL_MS,
  PrimeSessionLeaseConflictError,
  type PrimeSessionLeaseStore,
} from "../src/provider/prime/PrimeSessionLease.ts";
import { makePrimeSessionLeaseSqlStore } from "../src/provider/prime/PrimeSessionLeaseSql.ts";
import { ProviderAdapterValidationError } from "../src/provider/Errors.ts";

/**
 * PA-B03 — two clients and two processes contending for one durable Prime
 * session.
 *
 * "Two processes" here means two independent SQLite connections over one
 * database file: each has its own statement cache and transaction state, so a
 * compare-and-set that both observe is decided by the database, not by shared
 * memory. Every interleaving is driven explicitly — there is no sleep, no
 * timer and no polling anywhere in this file.
 */

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = "thread-race";

const scope: PrimeResumeCursorScope = {
  environmentId: "env-a",
  providerInstanceId: INSTANCE,
  projectId: "project-a",
  threadId: THREAD,
  homeFingerprint: "home-one",
} as PrimeResumeCursorScope;

const clientA = { clientToken: "session-a", processToken: "process-1" };
const clientB = { clientToken: "session-b", processToken: "process-2" };

/** A fake Prime binary that answers the bootstrap probe and logs every command. */
const fakeBinary = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line",line=>{const c=JSON.parse(line);appendFileSync(process.env.MARKER,JSON.stringify(c)+"\\n");const data=c.type==="get_available_models"?{models:[{id:"m",name:"M",api:"x",provider:"alpha",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1,maxTokens:1}]}:{state:"idle"};process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data})+"\\n")});`;

const withDatabases = <A, E>(
  use: (input: {
    readonly root: string;
    readonly stores: readonly [PrimeSessionLeaseStore, PrimeSessionLeaseStore];
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    // `realpath` because macOS hands out `/var/...` for the temp dir, and the
    // Prime ownership proof refuses to walk a symlinked ancestor.
    const root = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "pa-b03-")).then((made) => realpath(made)),
    );
    const filename = join(root, "state.sqlite");
    const nowIso = () => "2026-08-16T00:00:00.000Z";
    const open = (migrate: boolean) =>
      Effect.gen(function* () {
        // Each connection is built into this test's scope and stays open for
        // the whole fixture, so the two behave as two live processes.
        const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
        return yield* Effect.gen(function* () {
          if (migrate) yield* runMigrations();
          return yield* makePrimeSessionLeaseSqlStore({ scope, nowIso });
        }).pipe(Effect.provide(context));
      }).pipe(Effect.orDie);
    // Two connections opened independently: the second never sees the first's
    // in-process state, only what is committed to the file.
    const storeA = yield* open(true);
    const storeB = yield* open(false);
    return yield* use({ root, stores: [storeA, storeB] }).pipe(
      Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true }))),
    );
  });

describe("PA-B03 Prime durable session arbitration race", () => {
  it.effect("lets exactly one of two processes activate from the same observed state", () =>
    Effect.scoped(
      withDatabases(({ stores: [storeA, storeB] }) =>
        Effect.promise(async () => {
          let time = 1_000;
          const leaseA = makePrimeSessionLeaseService({
            store: storeA,
            now: () => time,
            authorize: () => true,
          });
          const leaseB = makePrimeSessionLeaseService({
            store: storeB,
            now: () => time,
            authorize: () => true,
          });
          // Barrier: both processes read the free scope before either writes.
          assert.equal(await storeA.read(primeResumeScopeKey(scope)), undefined);
          assert.equal(await storeB.read(primeResumeScopeKey(scope)), undefined);
          const outcomes = await Promise.all([
            leaseA.acquire({ scope, writer: clientA, operation: "activate" }),
            leaseB.acquire({ scope, writer: clientB, operation: "activate" }),
          ]);
          assert.equal(outcomes.filter((o) => o.status === "granted").length, 1);
          const loser = outcomes.find((o) => o.status === "conflict");
          assert.ok(loser && loser.status === "conflict");
          assert.equal(loser.receipt.reason, "heldByAnotherWriter");
          assert.equal(loser.receipt.retryable, true);
          // Both connections agree on who holds it.
          const seenByA = await leaseA.inspect(scope);
          const seenByB = await leaseB.inspect(scope);
          assert.equal(seenByA.status, "held");
          assert.deepStrictEqual(seenByA, seenByB);

          // A crash of the winner leaves a deterministic recoverable state: the
          // lease lapses, the other process takes over at a higher fence, and
          // the crashed writer can never commit again.
          const winner = outcomes.find((o) => o.status === "granted");
          assert.ok(winner && winner.status === "granted");
          time += PRIME_SESSION_LEASE_TTL_MS + 1;
          assert.equal((await leaseB.inspect(scope)).status, "expired");
          const recovered = await leaseB.acquire({
            scope,
            writer: clientB,
            operation: "activate",
          });
          assert.equal(recovered.status, "granted");
          assert.ok(recovered.status === "granted" && recovered.handle.fence > winner.handle.fence);
          const late = await leaseA.authorizeWrite(winner.handle, {
            scope,
            writer: clientA,
            operation: "send",
          });
          assert.equal(late.status === "conflict" && late.receipt.reason, "fenced");
          // Recovery is idempotent: repeating it changes nothing for the loser.
          const lateAgain = await leaseA.authorizeWrite(winner.handle, {
            scope,
            writer: clientA,
            operation: "send",
          });
          assert.deepStrictEqual(
            { ...(late.status === "conflict" ? late.receipt : {}), occurredAt: "" },
            { ...(lateAgain.status === "conflict" ? lateAgain.receipt : {}), occurredAt: "" },
          );
        }),
      ),
    ),
  );

  it.effect("refuses an unauthorized process without revealing that a lease exists", () =>
    Effect.scoped(
      withDatabases(({ stores: [storeA, storeB] }) =>
        Effect.promise(async () => {
          const leaseA = makePrimeSessionLeaseService({
            store: storeA,
            now: () => 1_000,
            authorize: () => true,
          });
          let reads = 0;
          const watched: PrimeSessionLeaseStore = {
            read: async (key) => {
              reads++;
              return storeB.read(key);
            },
            compareAndSet: storeB.compareAndSet,
          };
          const leaseB = makePrimeSessionLeaseService({
            store: watched,
            now: () => 1_000,
            authorize: () => false,
          });
          const denied = await leaseB.acquire({ scope, writer: clientB, operation: "activate" });
          assert.equal(denied.status === "conflict" && denied.receipt.reason, "unauthorized");
          assert.equal(reads, 0);
          await leaseA.acquire({ scope, writer: clientA, operation: "activate" });
          const deniedAgain = await leaseB.acquire({
            scope,
            writer: clientB,
            operation: "activate",
          });
          assert.equal(reads, 0, "an unauthorized caller must never reach lease state");
          assert.deepStrictEqual(
            { ...(denied.status === "conflict" ? denied.receipt : {}) },
            { ...(deniedAgain.status === "conflict" ? deniedAgain.receipt : {}) },
            "the refusal must be identical before and after a lease exists",
          );
        }),
      ),
    ),
  );

  it.effect("gates the adapter: one client activates, the fenced client cannot prompt", () =>
    Effect.scoped(
      withDatabases(({ root, stores: [storeA, storeB] }) =>
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(async () => {
            const cwd = join(root, "workspace");
            const binary = join(root, "fake.mjs");
            await mkdir(cwd, { recursive: true });
            await writeFile(binary, fakeBinary);
            await chmod(binary, 0o755);
            return { cwd, binary, marker: join(root, "marker") };
          });
          let time = 1_000;
          const scopeForThread = (threadId: string) =>
            ({ ...scope, threadId }) as PrimeResumeCursorScope;
          const gateFor = (store: PrimeSessionLeaseStore, writer: typeof clientA) =>
            makePrimeSessionWriteGate({
              service: makePrimeSessionLeaseService({
                store,
                now: () => time,
                authorize: () => true,
              }),
              writer,
              scopeForThread,
              now: () => time,
            });
          const adapterOptions = (gate: ReturnType<typeof gateFor>, home: string) => ({
            instanceId: INSTANCE,
            environmentId: "env-a",
            home,
            enabled: true,
            writeGate: gate,
            launch: (
              command: string,
              args: ReadonlyArray<string>,
              o?: { readonly env?: NodeJS.ProcessEnv },
            ) =>
              spawnPrimeRpcTransport(command, args, {
                ...(o ?? {}),
                env: { ...(o?.env ?? {}), MARKER: fixture.marker },
              }),
          });
          const adapterA = yield* makePrimeAdapter(
            { binaryPath: fixture.binary },
            adapterOptions(gateFor(storeA, clientA), join(root, "home-a")) as never,
          );
          const adapterB = yield* makePrimeAdapter(
            { binaryPath: fixture.binary },
            adapterOptions(gateFor(storeB, clientB), join(root, "home-b")) as never,
          );
          const start = {
            threadId: ThreadId.make(THREAD),
            provider: PROVIDER,
            providerInstanceId: INSTANCE,
            cwd: fixture.cwd,
            runtimeMode: "approval-required" as const,
          };
          const marker = () => Effect.promise(() => readFile(fixture.marker, "utf8"));
          yield* adapterA.startSession(start);
          const blocked = yield* Effect.flip(adapterB.startSession(start));
          assert.ok(blocked instanceof ProviderAdapterValidationError);
          assert.ok(blocked.cause instanceof PrimeSessionLeaseConflictError);
          assert.equal(blocked.cause.receipt.reason, "heldByAnotherWriter");
          assert.equal(blocked.cause.receipt.retryable, true);
          // The receipt names no owner, no thread and no host path.
          const serialized = JSON.stringify(blocked.cause.receipt);
          for (const secret of [THREAD, root, clientA.clientToken, "project-a"]) {
            assert.equal(serialized.includes(secret), false, `receipt leaked ${secret}`);
          }
          // Client B never reached a process: exactly one session bootstrapped,
          // and nothing B asked for was ever sent.
          const bootstrapped = (yield* marker())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).type as string);
          assert.equal(bootstrapped.filter((type) => type === "get_state").length, 1);
          assert.equal(bootstrapped.includes("prompt"), false);

          // A's lease lapses (its process was lost); B takes over and A's next
          // prompt is fenced before any RPC leaves the server.
          time += PRIME_SESSION_LEASE_TTL_MS + 1;
          yield* adapterB.startSession(start);
          const turn = {
            threadId: start.threadId,
            input: "hello",
            modelSelection: {
              instanceId: INSTANCE,
              model: "m",
              nativeIdentity: { provider: "alpha", modelId: "m" },
            },
          };
          const fenced = yield* Effect.flip(adapterA.sendTurn(turn));
          assert.ok(fenced instanceof ProviderAdapterValidationError);
          assert.ok(fenced.cause instanceof PrimeSessionLeaseConflictError);
          assert.equal(fenced.cause.receipt.reason, "fenced");
          assert.equal(
            (yield* marker()).includes('"prompt"'),
            false,
            "a fenced writer must never reach the model",
          );
          // The authoritative writer is unaffected and can still send.
          yield* adapterB.sendTurn(turn);
          assert.ok(
            (yield* marker()).includes('"prompt"'),
            "the authoritative writer must still be able to send",
          );
        }),
      ),
    ),
  );

  it.effect("keeps the lease inside one T3 home and one environment", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const store = yield* makePrimeSessionLeaseSqlStore({
        scope,
        nowIso: () => "2026-08-16T00:00:00.000Z",
      });
      const lease = makePrimeSessionLeaseService({
        store,
        now: () => 1_000,
        authorize: () => true,
      });
      const granted = yield* Effect.promise(() =>
        lease.acquire({ scope, writer: clientA, operation: "activate" }),
      );
      assert.equal(granted.status, "granted");
      const rows = yield* sql<{
        readonly lifecycle_state: string;
        readonly cursor_json: string;
        readonly lease_holder_token: string | null;
        readonly home_fingerprint: string;
      }>`SELECT lifecycle_state, cursor_json, lease_holder_token, home_fingerprint FROM prime_resume_cursors`;
      assert.equal(rows.length, 1);
      // A lease-only row records arbitration, never a resumable cursor.
      assert.equal(rows[0]!.lifecycle_state, "unavailable");
      assert.equal(rows[0]!.cursor_json, "{}");
      assert.equal(rows[0]!.home_fingerprint, "home-one");
      assert.ok(rows[0]!.lease_holder_token?.startsWith("pw-"));
      // The stored holder token is opaque: nothing about the client survives.
      assert.equal(rows[0]!.lease_holder_token?.includes(clientA.clientToken), false);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()), Effect.orDie),
  );
});
