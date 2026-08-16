// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics instanceOfSchema:off
// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  EnvironmentId,
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
import {
  executePrimeCleanup,
  planPrimeCleanup,
  resumePrimeCleanup,
  type PrimeCleanupGuard,
  type PrimeCleanupJournalEntry,
} from "../src/provider/prime/PrimeDurableCleanup.ts";
import { makePrimeCleanupJournalSqlStore } from "../src/provider/prime/PrimeDurableCleanupSql.ts";
import { writePrimeOwnership } from "../src/provider/prime/PrimeOwnership.ts";
import {
  makePrimeResumeCursor,
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "../src/provider/prime/PrimeResumeCursor.ts";
import { ProviderAdapterValidationError } from "../src/provider/Errors.ts";
import { PrimeDriver } from "../src/provider/Drivers/PrimeDriver.ts";
import {
  primeHomeFingerprint,
  primeResourceLayout,
} from "../src/provider/prime/PrimeResourceLayout.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";

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
const DRIVER_ENVIRONMENT = "env-driver";

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

/**
 * A fake Prime binary that also records its own exit, so a test can prove the
 * process was gone *before* the lease that authorized it was handed back.
 */
const fakeBinaryRecordingExit = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
process.on("exit",()=>{try{appendFileSync(process.env.MARKER,JSON.stringify({type:"EXIT"})+"\\n")}catch{}});
createInterface({input:process.stdin}).on("line",line=>{const c=JSON.parse(line);appendFileSync(process.env.MARKER,JSON.stringify(c)+"\\n");const data=c.type==="get_available_models"?{models:[{id:"m",name:"M",api:"x",provider:"alpha",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1,maxTokens:1}]}:{state:"idle"};process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data})+"\\n")});`;

/** Same bootstrap answers, but usable when the adapter sanitizes MARKER away. */
const fakeBinaryQuiet = `#!/usr/bin/env node
import { createInterface } from "node:readline";
createInterface({input:process.stdin}).on("line",line=>{const c=JSON.parse(line);const data=c.type==="get_available_models"?{models:[{id:"m",name:"M",api:"x",provider:"alpha",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1,maxTokens:1}]}:{state:"idle"};process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data})+"\\n")});`;

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

          // Every other durable mutation is gated too: compaction rewrites the
          // transcript, an abort ends the turn, and a dialog answer commits
          // work — a fenced writer may do none of them.
          const compact = yield* Effect.flip(
            adapterA.executeRuntimeOperation!({
              threadId: start.threadId,
              type: "compaction.request",
            } as never),
          );
          assert.ok(compact instanceof ProviderAdapterValidationError);
          assert.ok(compact.cause instanceof PrimeSessionLeaseConflictError);
          const interrupted = yield* Effect.flip(adapterA.interruptTurn(start.threadId));
          assert.ok(interrupted instanceof ProviderAdapterValidationError);
          assert.ok(interrupted.cause instanceof PrimeSessionLeaseConflictError);
          const afterFenced = yield* marker();
          assert.equal(
            afterFenced.includes('"compact"'),
            false,
            "a fenced writer must never compact the durable session",
          );
          assert.equal(
            afterFenced.includes('"abort"'),
            false,
            "a fenced writer must never abort the durable session",
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
  it.effect("hands the lease back only after the process it authorized is gone", () =>
    Effect.scoped(
      withDatabases(({ root, stores: [storeA] }) =>
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(async () => {
            const cwd = join(root, "workspace");
            const binary = join(root, "fake-exit.mjs");
            await mkdir(cwd, { recursive: true });
            await writeFile(binary, fakeBinaryRecordingExit);
            await chmod(binary, 0o755);
            return { cwd, binary, marker: join(root, "marker-release") };
          });
          // The barrier is the release compare-and-set itself: whatever is
          // true at that instant is what a second writer would find if it
          // acquired the freed lease right then.
          let processAlive = false;
          let aliveAtRelease: boolean | undefined;
          const watched: PrimeSessionLeaseStore = {
            read: storeA.read,
            compareAndSet: async (input) => {
              if (input.next?.expiresAtMs === 0 && aliveAtRelease === undefined)
                aliveAtRelease = processAlive;
              return storeA.compareAndSet(input);
            },
          };
          const gate = makePrimeSessionWriteGate({
            service: makePrimeSessionLeaseService({
              store: watched,
              now: () => 1_000,
              authorize: () => true,
            }),
            writer: clientA,
            scopeForThread: (threadId) => ({ ...scope, threadId }) as PrimeResumeCursorScope,
            now: () => 1_000,
          });
          const adapter = yield* makePrimeAdapter({ binaryPath: fixture.binary }, {
            instanceId: INSTANCE,
            environmentId: "env-a",
            home: join(root, "home-release"),
            enabled: true,
            writeGate: gate,
            launch: (
              command: string,
              args: ReadonlyArray<string>,
              o?: { readonly env?: NodeJS.ProcessEnv },
            ) => {
              const transport = spawnPrimeRpcTransport(command, args, {
                ...(o ?? {}),
                env: { ...(o?.env ?? {}), MARKER: fixture.marker },
              });
              processAlive = true;
              void transport.terminal
                .catch(() => undefined)
                .finally(() => {
                  processAlive = false;
                });
              return transport;
            },
          } as never);
          const start = {
            threadId: ThreadId.make(THREAD),
            provider: PROVIDER,
            providerInstanceId: INSTANCE,
            cwd: fixture.cwd,
            runtimeMode: "approval-required" as const,
          };
          yield* adapter.startSession(start);
          assert.equal(processAlive, true);
          yield* adapter.stopSession(start.threadId);
          assert.ok(
            aliveAtRelease !== undefined,
            "stopping must release the lease it acquired on activation",
          );
          assert.equal(
            aliveAtRelease,
            false,
            "the native process must be gone before the lease is handed back, or a second writer could launch a second process for the same durable thread",
          );
        }),
      ),
    ),
  );

  it.effect("the shipped PrimeDriver arbitrates: activation takes a durable lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "pa-b03-driver-")).then((made) => realpath(made)),
        );
        const cwd = join(root, "workspace");
        const binary = join(root, "fake.mjs");
        yield* Effect.promise(async () => {
          await mkdir(cwd, { recursive: true });
          await writeFile(binary, fakeBinaryQuiet);
          await chmod(binary, 0o755);
        });
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        // The durable scope is read from the projection, never invented.
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${THREAD}, 'project-driver', 'race', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const instance = yield* PrimeDriver.create({
          instanceId: INSTANCE,
          enabled: true,
          config: { binaryPath: binary },
        } as never).pipe(Effect.orDie);
        yield* instance.adapter
          .startSession({
            threadId: ThreadId.make(THREAD),
            provider: PROVIDER,
            providerInstanceId: INSTANCE,
            cwd,
            runtimeMode: "approval-required" as const,
          })
          .pipe(Effect.orDie);
        const rows = yield* sql<{
          readonly lease_holder_token: string | null;
          readonly project_id: string;
        }>`SELECT lease_holder_token, project_id FROM prime_resume_cursors WHERE thread_id = ${THREAD}`;
        // Without production wiring this table stays empty: the shipped server
        // would activate with no arbitration at all.
        assert.equal(rows.length, 1, "the shipped driver must arbitrate, not just the fixtures");
        assert.ok(rows[0]!.lease_holder_token?.startsWith("pw-"));
        assert.equal(rows[0]!.project_id, "project-driver");

        // A second T3 process over the same home and thread is refused.
        const driverScope = {
          environmentId: DRIVER_ENVIRONMENT,
          providerInstanceId: INSTANCE,
          projectId: "project-driver",
          threadId: THREAD,
          homeFingerprint: primeHomeFingerprint(serverConfig.stateDir),
        } as PrimeResumeCursorScope;
        const otherProcess = makePrimeSessionLeaseService({
          store: yield* makePrimeSessionLeaseSqlStore({
            scope: driverScope,
            nowIso: () => new Date().toISOString(),
          }),
          now: () => Date.now(),
          authorize: () => true,
        });
        const refused = yield* Effect.promise(() =>
          otherProcess.acquire({
            scope: driverScope,
            writer: { clientToken: "other", processToken: "other-process" },
            operation: "activate",
          }),
        );
        assert.equal(refused.status, "conflict");
        assert.equal(
          refused.status === "conflict" && refused.receipt.reason,
          "heldByAnotherWriter",
        );
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeSqliteClient.layerMemory(),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make(DRIVER_ENVIRONMENT)),
            getDescriptor: Effect.die("unused"),
          }),
          // A real (realpath'd) home: the Prime ownership proof refuses to
          // walk a symlinked ancestor such as macOS's /var.
          Layer.unwrap(
            Effect.promise(async () => {
              const base = await realpath(await mkdtemp(join(tmpdir(), "pa-b03-home-")));
              return ServerConfig.layerTest(base, base);
            }),
          ).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
      Effect.orDie,
    ),
  );
});

/**
 * PA-B05 — destructive cleanup contending with activation and a crash, over
 * one durable database file.
 *
 * The two-connection setup above is reused, because "cleanup lost the race to
 * an activation" has to be decided by committed state, not by a shared object.
 * Every interleaving is explicit; the only clock is a counter.
 */
describe("PA-B05 Prime durable cleanup race", () => {
  const nowIso = () => "2026-08-16T00:00:00.000Z";

  /** One connection = one process: its own lease store and cleanup journal. */
  const openProcess = (filename: string, migrate: boolean) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
      return yield* Effect.gen(function* () {
        if (migrate) yield* runMigrations();
        return {
          lease: yield* makePrimeSessionLeaseSqlStore({ scope, nowIso }),
          journal: yield* makePrimeCleanupJournalSqlStore(),
        };
      }).pipe(Effect.provide(context));
    }).pipe(Effect.orDie);

  const seedThread = async (
    home: string,
    threadId: string,
    threadScope: PrimeResumeCursorScope,
  ) => {
    const layout = primeResourceLayout({
      home,
      environmentId: threadScope.environmentId,
      instanceId: threadScope.providerInstanceId,
      threadId,
    });
    await mkdir(layout.session, { recursive: true });
    await writeFile(join(layout.session, "owned"), "session");
    await writeFile(layout.config, "{}");
    await writePrimeOwnership(layout.ownership, {
      version: 1,
      environmentId: threadScope.environmentId,
      instanceId: threadScope.providerInstanceId,
      threadId,
      process: { pid: 4242, startToken: "captured-start" },
    });
    await writePrimeResumeCursor(
      layout.resumeCursor,
      makePrimeResumeCursor({
        scope: threadScope,
        sessionPathToken: primeSessionPathToken(home, layout.session),
        ownershipGeneration: 1,
        compatibility: { agentVersion: "0.7.2", band: "compatible" },
        capabilityDigest: "sha256:cap",
        recordedAt: "2026-08-16T00:00:00.000Z",
      }),
    );
    return layout;
  };

  const proof = { processMatches: async () => true };
  const remover = (stopped: string[]) => ({
    stopProcess: async (handle: { pid: number }) => {
      stopped.push(`stop:${handle.pid}`);
    },
    removeOwnedResource: async (resource: {
      readonly path: string;
      readonly identity: { readonly dev: string; readonly ino: string };
    }) => {
      const current = await stat(resource.path, { bigint: true }).catch(() => undefined);
      if (
        !current ||
        String(current.dev) !== resource.identity.dev ||
        String(current.ino) !== resource.identity.ino
      ) {
        return "retained" as const;
      }
      await rm(resource.path, { recursive: true, force: true });
      return "removed" as const;
    },
  });

  const present = async (path: string) =>
    await stat(path).then(
      () => true,
      () => false,
    );

  it.effect("defers to an active writer, then deletes one thread and resumes a crash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "pa-b05-")).then((made) => realpath(made)),
        );
        const filename = join(root, "state.sqlite");
        const writerProcess = yield* openProcess(filename, true);
        const cleanupProcess = yield* openProcess(filename, false);

        const siblingScope = { ...scope, threadId: "thread-keep" } as PrimeResumeCursorScope;
        const target = yield* Effect.promise(() => seedThread(root, THREAD, scope));
        const sibling = yield* Effect.promise(() => seedThread(root, "thread-keep", siblingScope));

        let time = 1_000;
        const writer = makePrimeSessionLeaseService({
          store: writerProcess.lease,
          now: () => time,
          authorize: () => true,
        });
        const observer = makePrimeSessionLeaseService({
          store: cleanupProcess.lease,
          now: () => time,
          authorize: () => true,
        });
        // The cleanup process derives its guard from committed arbitration
        // state, which is the only thing it can honestly know about the writer.
        const guard = async (): Promise<PrimeCleanupGuard> => {
          const seen = await observer.inspect(scope);
          return seen.status === "held" ? { status: "leaseHeld" } : { status: "clear" };
        };
        const plan = () =>
          planPrimeCleanup({
            home: root,
            scope,
            lifecycleEvent: "threadDelete",
            guard: { status: "clear" },
          });
        const stopped: Array<string> = [];
        const run = (journal: typeof cleanupProcess.journal) =>
          executePrimeCleanup({
            plan: plan(),
            confirmation: { scopeDigest: plan().scopeDigest, acknowledged: true },
            journal,
            guard,
            proof,
            cleanup: remover(stopped),
            now: nowIso,
          });

        // 1. Another process is actively writing: cleanup defers and touches
        //    nothing, not even the journal.
        const granted = yield* Effect.promise(() =>
          writer.acquire({ scope, writer: clientA, operation: "activate" }),
        );
        assert.equal(granted.status, "granted");
        const deferred = yield* Effect.promise(() => run(cleanupProcess.journal));
        assert.equal(deferred.outcome, "deferred");
        assert.equal(deferred.reasonCode, "leaseHeld");
        assert.equal(yield* Effect.promise(() => present(target.thread)), true);
        assert.deepStrictEqual(
          yield* Effect.promise(() => cleanupProcess.journal.listUnfinished()),
          [],
        );

        // 2. The writer is gone (its lease lapsed). Cleanup crashes right after
        //    a journal write — the same state a killed process leaves.
        time += PRIME_SESSION_LEASE_TTL_MS + 1;
        let writes = 0;
        const crashing = {
          ...cleanupProcess.journal,
          write: async (entry: PrimeCleanupJournalEntry) => {
            writes += 1;
            await cleanupProcess.journal.write(entry);
            if (writes === 2) throw new Error("simulated crash");
          },
        };
        const crashed = yield* Effect.promise(() =>
          run(crashing).then(
            () => "did not crash",
            (error: Error) => error.message,
          ),
        );
        assert.equal(crashed, "simulated crash");
        const unfinished = yield* Effect.promise(() => cleanupProcess.journal.listUnfinished());
        assert.equal(unfinished.length, 1, "the crash left a durable, resumable journal row");
        assert.equal(unfinished[0]!.scopeKey, primeResumeScopeKey(scope));
        assert.equal(unfinished[0]!.scopeDigest.includes(THREAD), false);

        // 3. A restarted process reads the journal and finishes idempotently.
        const restarted = yield* openProcess(filename, false);
        const resumed = yield* Effect.promise(() =>
          resumePrimeCleanup({
            home: root,
            scope,
            journal: restarted.journal,
            guard,
            proof,
            cleanup: remover(stopped),
            now: nowIso,
          }),
        );
        assert.equal(resumed?.outcome, "completed");
        assert.equal(stopped.filter((event) => event === "stop:4242").length, 1);
        assert.equal(yield* Effect.promise(() => present(target.thread)), false);
        assert.equal(yield* Effect.promise(() => present(target.resumeCursor)), false);
        assert.deepStrictEqual(yield* Effect.promise(() => restarted.journal.listUnfinished()), []);

        // 4. Nothing else in this home moved, and the deleted thread reads as
        //    "no cursor" rather than as a silently fresh session.
        assert.equal(yield* Effect.promise(() => present(sibling.thread)), true);
        assert.equal(yield* Effect.promise(() => present(sibling.resumeCursor)), true);
        const after = yield* Effect.promise(() =>
          readPrimeResumeCursor(target.resumeCursor, scope),
        );
        assert.deepStrictEqual(after.state, { status: "unavailable", reason: "missing" });

        // 5. Re-running the whole cleanup is a no-op, never a second deletion.
        const again = yield* Effect.promise(() => run(restarted.journal));
        assert.equal(again.outcome, "completed");
        assert.equal(stopped.filter((event) => event === "stop:4242").length, 1);

        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }),
    ),
  );
});
