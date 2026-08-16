// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics instanceOfSchema:off
// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

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
appendFileSync(process.env.MARKER, JSON.stringify({ type: "BOOT", dir }) + "\\n");
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

const startInput = (input: Fixture) => ({
  threadId: ThreadId.make(THREAD),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd: input.cwd,
  runtimeMode: "approval-required" as const,
});

const layoutFor = (input: Fixture) =>
  primeResourceLayout({
    home: input.home,
    environmentId: input.environmentId,
    instanceId: INSTANCE,
    threadId: THREAD,
  });

const bootCount = async (input: Fixture) =>
  (await readFile(input.marker, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly type: string })
    .filter((line) => line.type === "BOOT").length;

/** Content-free identity of the stored cursor, for before/after comparison. */
const cursorIdentity = async (input: Fixture) => {
  const { state } = await readPrimeResumeCursor(layoutFor(input).resumeCursor);
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
const seedDurableSession = (input: Fixture, writer = "process-one") =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* adapterFor(input, writer);
      yield* adapter.startSession(startInput(input));
      yield* adapter.stopSession(ThreadId.make(THREAD));
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

        // Abrupt: that server never released; only the lease lapse frees it.
        input.clock.now += PRIME_SESSION_LEASE_TTL_MS + 1;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* adapterFor(input, "process-three");
            yield* adapter.startSession(startInput(input));
          }),
        );
        assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), seeded);
        assert.deepStrictEqual(lastState(input), { status: "resumed", mode: "relaunched" });
        // One durable session directory, reopened — never a second one.
        assert.equal(yield* Effect.promise(() => bootCount(input)), 3);
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
