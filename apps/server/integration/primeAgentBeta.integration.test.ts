// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics instanceOfSchema:off
// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  PRIME_RESUME_CURSOR_VERSION,
  PRIME_RESUME_FAILURE_REASONS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  capabilityForRuntimeOperation,
  primeResumeAllowsFreshStart,
  supportsRuntimeOperation,
  type PrimeResumeCursorScope,
  type PrimeResumeFailureReason,
  type PrimeResumeState,
  type ProviderRuntimeCapabilities,
  type ProviderRuntimeOperation,
} from "@t3tools/contracts";
import {
  PRIME_RESUME_COMPOSER_BLOCKED_REASON,
  initialPrimeResumeModel,
  primeResumeReduce,
  primeResumeSurface,
} from "../../../packages/client-runtime/src/primeResume.ts";
import { resolveSendDisabledReason } from "../../web/src/components/chat/sendDisabledReason.ts";

import { ProviderAdapterValidationError } from "../src/provider/Errors.ts";
import { makePrimeAdapter } from "../src/provider/Layers/PrimeAdapter.ts";
import { spawnPrimeRpcTransport } from "../src/provider/prime/PrimeRpcProcessTransport.ts";
import { classifyPrimeCompatibility } from "../src/provider/prime/PrimeCompatibility.ts";
import {
  PRIME_LIFECYCLE_EVENTS,
  planPrimeCleanup,
  primeCleanupReasonForLifecycle,
  primeRolloutTransition,
} from "../src/provider/prime/PrimeDurableCleanup.ts";
import {
  primeHomeFingerprint,
  primeResourceLayout,
} from "../src/provider/prime/PrimeResourceLayout.ts";
import {
  makeInMemoryPrimeSessionLeaseStore,
  makePrimeSessionLeaseService,
  makePrimeSessionWriteGate,
  PRIME_SESSION_LEASE_TTL_MS,
  type PrimeSessionLeaseStore,
} from "../src/provider/prime/PrimeSessionLease.ts";
import {
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "../src/provider/prime/PrimeResumeCursor.ts";

/**
 * PA-B06 — the Beta gate.
 *
 * Earlier Beta milestones each proved one mechanism in isolation: the cursor
 * codec (B01), exact resume (B02), arbitration (B03), the recovery surface
 * (B04), destructive cleanup (B05). This file is the matrix that composes
 * them, and it exists to answer exactly one question for every supported
 * lifecycle and connection scenario: *did anything silently start a fresh
 * session, or delete something it could not prove it owned?*
 *
 * Every run here is a real subprocess against a disposable T3 home under the
 * system temp directory. Time is a variable, nothing sleeps and nothing polls.
 * The real-binary lane is opt-in through `PRIME_AGENT_BIN`: when the binary is
 * absent that one test is skipped rather than passing without running.
 */

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = "thread-beta";

/**
 * The installed Prime Agent, if the operator opted this run into the real
 * lane. Absent here: `prime-agent` is not installed in this environment.
 */
const REAL_BINARY = process.env["PRIME_AGENT_BIN"];
const realBinaryLane =
  REAL_BINARY === undefined || REAL_BINARY.length === 0 ? it.effect.skip : it.effect;

/** Records its own session directory at boot, then answers the bootstrap probe. */
const fakeBinary = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
const dir = process.argv[process.argv.indexOf("--session-dir") + 1];
appendFileSync(process.env.MARKER, JSON.stringify({ type: "BOOT", dir, pid: process.pid }) + "\\n");
createInterface({input:process.stdin}).on("line",line=>{const c=JSON.parse(line);const data=c.type==="get_available_models"?{models:[]}:{state:"idle"};process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data})+"\\n")});`;

type Fixture = {
  readonly label: string;
  readonly environmentId: string;
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly binary: string;
  readonly marker: string;
  readonly store: PrimeSessionLeaseStore;
  readonly published: Array<readonly [string, PrimeResumeState]>;
  readonly clock: { now: number };
  readonly version: { value: string | undefined };
};

const fixture = async (label: string, environmentId: string): Promise<Fixture> => {
  // `realpath` because macOS hands out `/var/...` for the temp dir and the
  // Prime ownership proof refuses to walk a symlinked ancestor.
  const root = await mkdtemp(join(tmpdir(), `pa-b06-${label}-`)).then((made) => realpath(made));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const binary = join(root, "prime.mjs");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(binary, fakeBinary);
  await chmod(binary, 0o755);
  return {
    label,
    environmentId,
    root,
    home,
    cwd,
    binary,
    marker: join(root, "marker"),
    store: makeInMemoryPrimeSessionLeaseStore(),
    published: [],
    clock: { now: 1_000 },
    version: { value: "0.7.2" },
  };
};

const scopeFor = (input: Fixture, threadId: string): PrimeResumeCursorScope =>
  ({
    environmentId: input.environmentId,
    providerInstanceId: INSTANCE,
    projectId: "project-a",
    threadId,
    homeFingerprint: primeHomeFingerprint(input.home),
  }) as PrimeResumeCursorScope;

/** One "server process": its own adapter and writer identity, shared storage. */
const adapterFor = (input: Fixture, writerToken: string, enabled = true) =>
  makePrimeAdapter(
    { binaryPath: input.binary } as never,
    {
      instanceId: INSTANCE,
      environmentId: input.environmentId,
      home: input.home,
      enabled,
      agentVersion: async () => input.version.value,
      onResumeState: (threadId: string, state: PrimeResumeState) =>
        input.published.push([threadId, state]),
      writeGate: makePrimeSessionWriteGate({
        service: makePrimeSessionLeaseService({
          store: input.store,
          now: () => input.clock.now,
          authorize: () => true,
        }),
        writer: { clientToken: writerToken, processToken: writerToken },
        scopeForThread: (threadId: string) => Promise.resolve(scopeFor(input, threadId)),
        now: () => input.clock.now,
        // A manual ticker: renewal only happens when a test asks for it, so the
        // fixture never depends on a timer firing.
        scheduleRenewal: () => () => {},
      }),
      launch: (
        command: string,
        args: ReadonlyArray<string>,
        options?: { readonly env?: NodeJS.ProcessEnv },
      ) =>
        spawnPrimeRpcTransport(command, args, {
          ...(options ?? {}),
          env: { ...(options?.env ?? {}), MARKER: input.marker },
        }),
    } as never,
  );

const startInput = (input: Fixture, threadId = THREAD) => ({
  threadId: ThreadId.make(threadId),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd: input.cwd,
  runtimeMode: "approval-required" as const,
});

const layoutFor = (input: Fixture, threadId = THREAD) =>
  primeResourceLayout({
    home: input.home,
    environmentId: input.environmentId,
    instanceId: INSTANCE,
    threadId,
  });

const lastBootPid = async (input: Fixture): Promise<number> => {
  const boots = (await readFile(input.marker, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly type: string; readonly pid?: number })
    .filter((line) => line.type === "BOOT");
  const pid = boots.at(-1)?.pid;
  if (typeof pid !== "number") throw new Error("no booted child pid recorded");
  return pid;
};

const bootCount = async (input: Fixture) =>
  (await readFile(input.marker, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly type: string })
    .filter((line) => line.type === "BOOT").length;

/** Content-free identity of the stored cursor, for before/after comparison. */
const cursorIdentity = async (input: Fixture, threadId = THREAD) => {
  const { state } = await readPrimeResumeCursor(layoutFor(input, threadId).resumeCursor);
  if (state.status !== "available") return { status: state.status, reason: state.reason };
  return {
    status: state.status,
    version: state.cursor.version,
    sessionPathToken: state.cursor.sessionPathToken,
    scopeDigest: createHash("sha256")
      .update(JSON.stringify(state.cursor.scope))
      .digest("hex")
      .slice(0, 12),
    lifecycle: state.cursor.lifecycle,
  };
};

/** Seeds one durable session and stops it, leaving a recoverable cursor. */
const seedDurableSession = (input: Fixture, writer = "process-one", threadId = THREAD) =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* adapterFor(input, writer);
      yield* adapter.startSession(startInput(input, threadId));
      yield* adapter.stopSession(ThreadId.make(threadId));
    }),
  );

const withFixture = <A, E>(
  label: string,
  environmentId: string,
  use: (input: Fixture) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const input = yield* Effect.promise(() => fixture(label, environmentId));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(input.root, { recursive: true, force: true })),
    );
    return yield* use(input);
  }).pipe(Effect.scoped, Effect.orDie);

const lastState = (input: Fixture) => input.published.at(-1)?.[1];

/** How a client renders one published host state. Shared by web and mobile. */
const surfaceFor = (state: PrimeResumeState) =>
  primeResumeSurface(
    "prime-agent",
    primeResumeReduce(initialPrimeResumeModel, { type: "state", state }),
  );

describe("PA-B06 Beta gate: durable continuity matrix", () => {
  it.effect("recovers the exact session after a graceful stop and after an abrupt loss", () =>
    withFixture("exact", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const seeded = yield* Effect.promise(() => cursorIdentity(input));
        assert.equal(seeded.status, "available");
        // A first session is not a resume and must not claim to be one.
        assert.deepStrictEqual(input.published, []);

        // Graceful: the previous server released everything it held.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-two");
            yield* adapter.startSession(startInput(input));
          }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.deepStrictEqual(lastState(input), { status: "resumed", mode: "relaunched" });

        // Abrupt: this server owns the session and then dies without any
        // teardown — its scope is never closed, so nothing releases the lease
        // or stops the child; the native process is SIGKILLed directly. Only
        // the lease lapse frees the session for the next writer.
        const abandoned = yield* Scope.make();
        const owner = yield* adapterFor(input, "process-three").pipe(Scope.provide(abandoned));
        yield* owner.startSession(startInput(input));
        const killedPid = yield* Effect.promise(() => lastBootPid(input));
        process.kill(killedPid, "SIGKILL");
        // The crashed writer released nothing: a takeover inside the TTL must
        // still be refused, which is what proves this was not a graceful stop.
        const early = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-four");
            return yield* Effect.exit(adapter.startSession(startInput(input)));
          }),
        );
        assert.equal(early._tag, "Failure", "a live lease must fence the next writer");
        input.clock.now += PRIME_SESSION_LEASE_TTL_MS + 1;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-five");
            yield* adapter.startSession(startInput(input));
          }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.deepStrictEqual(lastState(input), { status: "resumed", mode: "relaunched" });
        // One durable session directory, reopened — never a second one. Four
        // boots: seed, graceful restart, the crashed owner, and the recovery.
        assert.equal(yield* Effect.promise(() => bootCount(input)), 4);
        yield* Scope.close(abandoned, Exit.void);
      }),
    ),
  );

  it.effect("disabling and re-enabling the instance never loses the durable session", () =>
    withFixture("disable", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const seeded = yield* Effect.promise(() => cursorIdentity(input));

        const refused = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-two", false);
            return yield* Effect.flip(adapter.startSession(startInput(input)));
          }),
        );
        assert.ok(refused instanceof ProviderAdapterValidationError);
        assert.include(refused.issue, "disabled");
        // A disabled instance touches nothing: no cursor change, no process.
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.equal(yield* Effect.promise(() => bootCount(input)), 1);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-three");
            yield* adapter.startSession(startInput(input));
          }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.deepStrictEqual(lastState(input), { status: "resumed", mode: "relaunched" });
      }),
    ),
  );

  it.effect("a compatible upgrade resumes; an incompatible build refuses without replacing", () =>
    withFixture("upgrade", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const seeded = yield* Effect.promise(() => cursorIdentity(input));

        // Compatible upgrade over the same durable session. An unknown newer
        // release is `advisory`: allowed to run, and allowed to resume.
        input.version.value = "0.7.3";
        assert.equal(classifyPrimeCompatibility("0.7.3"), "advisory");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-two");
            yield* adapter.startSession(startInput(input));
          }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.deepStrictEqual(lastState(input), { status: "resumed", mode: "relaunched" });

        // A downgrade below the supported floor refuses, and says so.
        const path = layoutFor(input).resumeCursor;
        const { state } = yield* Effect.promise(() => readPrimeResumeCursor(path));
        if (state.status !== "available") return assert.fail("expected a recorded cursor");
        yield* Effect.promise(() =>
          writePrimeResumeCursor(path, {
            ...state.cursor,
            compatibility: { agentVersion: "0.6.0", band: "incompatible" },
          }),
        );
        const before = yield* Effect.promise(() => cursorIdentity(input));
        const failure = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-three");
            return yield* Effect.flip(adapter.startSession(startInput(input)));
          }),
        );
        assert.ok(failure instanceof ProviderAdapterValidationError);
        assert.include(failure.issue, "incompatibleVersion");
        assert.include(failure.issue, "not replaced");
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), before);
        assert.deepStrictEqual(lastState(input), {
          status: "unavailable",
          reason: "incompatibleVersion",
        });
      }),
    ),
  );

  it.effect("a missing runtime binary refuses and preserves the cursor", () =>
    withFixture("missing-binary", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const seeded = yield* Effect.promise(() => cursorIdentity(input));
        yield* Effect.promise(() => rm(input.binary, { force: true }));

        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-two");
            return yield* Effect.exit(adapter.startSession(startInput(input)));
          }),
        );
        assert.equal(outcome._tag, "Failure", "a missing binary must fail the start");
        // Terminal refusal, and the durable record survives untouched.
        assert.deepStrictEqual(lastState(input), {
          status: "unavailable",
          reason: "launchFailed",
        });
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
      }),
    ),
  );

  it.effect("two environments on one host recover independently", () =>
    withFixture("env-a", "env-a", (first) =>
      withFixture("env-b", "env-b", (second) =>
        Effect.gen(function* () {
          yield* seedDurableSession(first);
          yield* seedDurableSession(second);
          const firstSeeded = yield* Effect.promise(() => cursorIdentity(first));
          const secondSeeded = yield* Effect.promise(() => cursorIdentity(second));
          // Same thread id, two homes and two environments: distinct sessions.
          assert.notEqual(firstSeeded.sessionPathToken, secondSeeded.sessionPathToken);
          assert.notEqual(firstSeeded.scopeDigest, secondSeeded.scopeDigest);

          const secondRaw = yield* Effect.promise(() =>
            readFile(layoutFor(second).resumeCursor, "utf8"),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const adapter = yield* adapterFor(first, "process-two");
              yield* adapter.startSession(startInput(first));
            }),
          );
          assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(first)), firstSeeded);
          // The other environment is byte-for-byte untouched, and its own
          // recovery is still available.
          assert.equal(
            yield* Effect.promise(() => readFile(layoutFor(second).resumeCursor, "utf8")),
            secondRaw,
          );
          assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(second)), secondSeeded);
          assert.deepStrictEqual(second.published, []);
        }),
      ),
    ),
  );

  it.effect("two clients racing one durable session produce exactly one writer", () =>
    withFixture("race", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const seeded = yield* Effect.promise(() => cursorIdentity(input));

        yield* Effect.scoped(
          Effect.gen(function* () {
            const holder = yield* adapterFor(input, "client-a");
            yield* holder.startSession(startInput(input));
            // A second client, second process, same durable scope, no lapse.
            const contender = yield* Effect.scoped(
              Effect.gen(function* () {
                const adapter = yield* adapterFor(input, "client-b");
                return yield* Effect.flip(adapter.startSession(startInput(input)));
              }),
            );
            assert.ok(contender instanceof ProviderAdapterValidationError);
            assert.include(contender.issue, "conflict");
            // The loser learns nothing about the winner.
            assert.equal(contender.issue.includes("client-a"), false);
            assert.equal(contender.issue.includes(input.home), false);
          }),
        );
        // One relaunch happened, not two, and the session is unchanged.
        assert.equal(yield* Effect.promise(() => bootCount(input)), 2);
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.deepStrictEqual(lastState(input), { status: "unavailable", reason: "conflict" });
      }),
    ),
  );

  it.effect("stop and archive retain the durable session; only delete may plan removal", () =>
    withFixture("retention", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const cursorPath = layoutFor(input).resumeCursor;
        const scope = scopeFor(input, THREAD);
        const before = yield* Effect.promise(() => readFile(cursorPath, "utf8"));

        for (const event of PRIME_LIFECYCLE_EVENTS) {
          const reason = primeCleanupReasonForLifecycle(event);
          const plan = planPrimeCleanup({
            home: input.home,
            scope,
            lifecycleEvent: event,
            guard: { status: "clear" },
          });
          if (reason === undefined) {
            assert.equal(plan.reason, "none", `${event} must not carry a delete reason`);
            assert.equal(plan.targets.length, 0, `${event} must plan no deletion`);
            assert.deepStrictEqual(plan.decision, {
              action: "refuse",
              reason: "nonDestructiveLifecycle",
            });
          } else {
            assert.equal(plan.reason, reason);
            assert.ok(plan.targets.length > 0, `${event} must be able to plan a deletion`);
            assert.equal(plan.requiresConfirmation, true);
            // A manifest never travels as a path.
            for (const target of plan.targets)
              assert.ok(target.pathToken.startsWith("pct-"), "target token must be opaque");
          }
        }
        // A held lease defers a destructive plan instead of proceeding.
        assert.deepStrictEqual(
          planPrimeCleanup({
            home: input.home,
            scope,
            lifecycleEvent: "threadDelete",
            guard: { status: "leaseHeld" },
          }).decision,
          { action: "defer", reason: "leaseHeld" },
        );
        // Planning is a dry run: it removed nothing.
        assert.equal(yield* Effect.promise(() => readFile(cursorPath, "utf8")), before);
        assert.ok(yield* Effect.promise(() => stat(cursorPath).then(() => true)));

        // Rollout and rollback are prime-agent scoped and never destructive.
        for (const transition of [
          primeRolloutTransition({ enabled: true, previouslyEnabled: false }),
          primeRolloutTransition({ enabled: false, previouslyEnabled: true }),
          primeRolloutTransition({ enabled: false, previouslyEnabled: true, rollingBack: true }),
        ]) {
          assert.equal(transition.provider, "prime-agent");
          assert.equal(transition.deletesDurableData, false);
          assert.equal(transition.preservesUnknownData, true);
        }
      }),
    ),
  );

  it.effect("a cursor from a newer build is unavailable, not corrupt, and is preserved", () =>
    withFixture("rollback", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const path = layoutFor(input).resumeCursor;
        const raw = yield* Effect.promise(() => readFile(path, "utf8"));
        const future = JSON.parse(raw) as Record<string, unknown>;
        future["version"] = PRIME_RESUME_CURSOR_VERSION + 1;
        yield* Effect.promise(() => writeFile(path, JSON.stringify(future)));

        const { state } = yield* Effect.promise(() => readPrimeResumeCursor(path));
        assert.deepStrictEqual(state, {
          status: "unavailable",
          reason: "unsupportedVersion",
          // The version is reported so an operator can see *which* build wrote
          // it; the record itself is left alone.
          storedVersion: PRIME_RESUME_CURSOR_VERSION + 1,
        });
        // Unavailable is not fresh: the client must not send into a new session.
        assert.equal(primeResumeAllowsFreshStart("unsupportedVersion"), false);

        const failure = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-two");
            return yield* Effect.flip(adapter.startSession(startInput(input)));
          }),
        );
        assert.ok(failure instanceof ProviderAdapterValidationError);
        assert.include(failure.issue, "unsupportedVersion");
        // The newer build's record is still on disk, unread and undamaged.
        assert.equal(yield* Effect.promise(() => readFile(path, "utf8")), JSON.stringify(future));
      }),
    ),
  );

  it("maps every refusal this matrix can publish to a client surface that cannot send", () => {
    // Every reason the Beta matrix can end on, including the ones the adapter
    // tests above assert directly. `missing` is the single reason a client may
    // send after, and it is the one that means nothing was ever lost.
    // The whole closed vocabulary, so a reason added later cannot land on a
    // client surface that nobody checked.
    const reasons: ReadonlyArray<PrimeResumeFailureReason> = PRIME_RESUME_FAILURE_REASONS;
    for (const reason of reasons) {
      const surface = surfaceFor({ status: "unavailable", reason });
      assert.equal(surface.reason, reason);
      assert.equal(
        surface.composerBlocked,
        !primeResumeAllowsFreshStart(reason),
        `${reason} composer gate`,
      );
      if (surface.composerBlocked)
        assert.ok(surface.choices.length > 0, `${reason} must offer a way out`);
      // No refusal ever names a device, a path or a host detail.
      assert.equal(/\//.test(surface.detail), false, `${reason} detail leaked a path`);
      // Web and mobile render the same shared surface; the web composer gate
      // is the one place the two differ in plumbing, so it is checked here too.
      assert.equal(
        resolveSendDisabledReason({
          primeResumeBlocked: surface.composerBlocked,
          threadDetailLoading: false,
          modelSelectionReason: null,
        }),
        surface.composerBlocked ? PRIME_RESUME_COMPOSER_BLOCKED_REASON : null,
      );
    }
    // The two success states are the only ones that reopen the composer.
    for (const state of [
      { status: "resumed", mode: "adopted" },
      { status: "resumed", mode: "relaunched" },
    ] as const) {
      assert.equal(surfaceFor(state).composerBlocked, false);
    }
    assert.equal(surfaceFor({ status: "reconnecting" }).composerBlocked, true);
  });

  it("keeps MVP and Alpha working on a capability-limited Beta build", () => {
    // A Beta-capable host talking to an older Prime Agent: durable recovery is
    // a host-side concern and must not turn Alpha's capability gate off.
    const limited = { steer: true } as unknown as ProviderRuntimeCapabilities;
    const steer = { type: "steer.add" } as ProviderRuntimeOperation;
    const compaction = { type: "compaction.request" } as ProviderRuntimeOperation;
    assert.equal(supportsRuntimeOperation(limited, steer), true);
    assert.equal(supportsRuntimeOperation(limited, compaction), false);
    assert.equal(capabilityForRuntimeOperation(compaction), "compaction");
    // The supported floor is unchanged by Beta.
    assert.equal(classifyPrimeCompatibility("0.7.2"), "compatible");
    assert.equal(classifyPrimeCompatibility("0.7.1"), "incompatible");
  });

  /**
   * The fork/fresh row of the matrix. A fork is a *new* session now — the
   * point of this test is that being new does not make it second-class:
   * docs/usage.md promises a forked thread is durable and resumable from that
   * point on, and that the thread it came from is untouched.
   */
  it.effect("a forked thread is durable on its own and leaves its source thread untouched", () =>
    withFixture("fork", "env-a", (input) =>
      Effect.gen(function* () {
        yield* seedDurableSession(input);
        const sourceSeeded = yield* Effect.promise(() => cursorIdentity(input));
        assert.equal(sourceSeeded.status, "available");

        const forkThread = "thread-beta-fork";
        yield* seedDurableSession(input, "fork-process-one", forkThread);
        const forkSeeded = yield* Effect.promise(() => cursorIdentity(input, forkThread));
        assert.equal(forkSeeded.status, "available");
        if (sourceSeeded.status !== "available" || forkSeeded.status !== "available")
          return assert.fail("expected durable cursors for source and fork");
        // A fork owns its durable state instead of borrowing the source's.
        assert.notEqual(forkSeeded.sessionPathToken, sourceSeeded.sessionPathToken);
        assert.notEqual(forkSeeded.scopeDigest, sourceSeeded.scopeDigest);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "fork-process-two");
            yield* adapter.startSession(startInput(input, forkThread));
          }),
        );
        assert.deepStrictEqual(
          yield* Effect.promise(() => cursorIdentity(input, forkThread)),
          forkSeeded,
        );
        // The resume is published against the fork, not against its source.
        assert.deepStrictEqual(input.published.at(-1), [
          forkThread,
          { status: "resumed", mode: "relaunched" },
        ]);
        // Resuming the fork cannot rewrite the thread it came from.
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), sourceSeeded);
      }),
    ),
  );

  /**
   * The documentation gate. PA-B06 graduates `docs/usage.md` to shipped, and
   * the one way that can go wrong is graduating a *claim* instead of a
   * behavior: section 20 describes a permanent-delete control and a
   * retain-or-delete choice on environment removal, and no such control is
   * reachable anywhere in the product. This test is the interlock. It does not
   * hard-code which way the answer goes — it asks the client and contract
   * sources whether an entry point exists, and requires the prose to match.
   * When a later milestone ships the control, this test starts demanding the
   * "not yet shipped" warning be *removed*.
   */
  it.effect("never claims a durable-cleanup control the product does not expose", () =>
    Effect.gen(function* () {
      const repoRoot = join(import.meta.dirname, "..", "..", "..");
      // Everything a user could touch: the three clients, the shared client
      // runtime, and the wire contract that any control would have to cross.
      const surfaceRoots = [
        join(repoRoot, "apps", "web", "src"),
        join(repoRoot, "apps", "mobile", "src"),
        join(repoRoot, "apps", "desktop", "src"),
        join(repoRoot, "packages", "client-runtime", "src"),
        join(repoRoot, "packages", "contracts", "src"),
      ];
      const walk = async (dir: string): Promise<ReadonlyArray<string>> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const found: Array<string> = [];
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) found.push(...(await walk(path)));
          else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
            found.push(path);
        }
        return found;
      };
      // The names any user-facing deletion would have to go through: the two
      // server APIs, or a wire op / label naming the action.
      const entryPoint = /planPrimeCleanup|executePrimeCleanup|prime\.cleanup|Delete Prime session/;
      let reachable = false;
      for (const root of surfaceRoots)
        for (const file of yield* Effect.promise(() => walk(root))) {
          const source = yield* Effect.promise(() => readFile(file, "utf8"));
          if (entryPoint.test(source)) reachable = true;
        }

      const usage = yield* Effect.promise(() =>
        readFile(join(repoRoot, "docs", "usage.md"), "utf8"),
      );
      const section = usage.slice(usage.indexOf("## 20. Durable cleanup and retention"));
      assert.ok(section.length > 0, "docs/usage.md lost section 20");
      const marked = section.includes("### Permanent deletion — proposed, not yet shipped");

      // The interlock, in both directions.
      assert.equal(
        marked,
        !reachable,
        reachable
          ? "a cleanup control is now reachable: drop the 'not yet shipped' warning from docs/usage.md section 20"
          : "docs/usage.md section 20 must mark permanent deletion as not yet shipped while no client, desktop, mobile or contract surface reaches planPrimeCleanup/executePrimeCleanup",
      );
      if (!reachable) {
        // The banner has to agree with the section, or a reader stops at line 1.
        assert.ok(
          usage
            .slice(0, usage.indexOf("## What runs where"))
            .includes("no control in the product deletes durable Prime data today"),
          "the usage.md banner still graduates cleanup that has no control",
        );
        // And the shipped half must not present the absent action as a step.
        const shipped = section.slice(0, section.indexOf("### Permanent deletion"));
        assert.equal(
          /\*\*Delete Prime session permanently\*\*/.test(shipped),
          false,
          "the shipped half of section 20 still tells the user to choose a delete control",
        );
      }
    }),
  );

  /**
   * The real-binary lane. It is opt-in, it installs nothing, and when
   * `PRIME_AGENT_BIN` is unset it is *skipped* rather than passed: a lane that
   * did not run must not be able to look like a lane that did.
   */
  realBinaryLane("real-binary lane: seeds and resumes against the installed binary", () =>
    withFixture("real", "env-a", (input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(input.binary, `#!/bin/sh\nexec ${REAL_BINARY} "$@"\n`),
        );
        yield* Effect.promise(() => chmod(input.binary, 0o755));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "real-one");
            yield* adapter.startSession(startInput(input));
            yield* adapter.stopSession(ThreadId.make(THREAD));
          }),
        );
        const seeded = yield* Effect.promise(() => cursorIdentity(input));
        assert.equal(seeded.status, "available");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "real-two");
            yield* adapter.startSession(startInput(input));
          }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
      }),
    ),
  );
});
