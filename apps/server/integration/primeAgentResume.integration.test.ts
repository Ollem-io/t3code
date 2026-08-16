// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics instanceOfSchema:off
// @effect-diagnostics preferSchemaOverJson:off
import { assert, describe, it } from "@effect/vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type PrimeResumeCursorScope,
  type PrimeResumeState,
} from "@t3tools/contracts";

import { ProviderAdapterValidationError } from "../src/provider/Errors.ts";
import { makePrimeAdapter } from "../src/provider/Layers/PrimeAdapter.ts";
import { spawnPrimeRpcTransport } from "../src/provider/prime/PrimeRpcProcessTransport.ts";
import { primeResourceLayout } from "../src/provider/prime/PrimeResourceLayout.ts";
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
 * PA-B02 — exact adoption/resume across a restart, a lost process, and every
 * compatibility refusal.
 *
 * The "restart" here is a second `makePrimeAdapter` over the same T3 home and
 * the same durable lease store: a new adapter has no memory of the first, so
 * anything it recovers came out of durable storage. Time is a variable, the
 * fake runtime records everything it is asked, and nothing sleeps or polls.
 */

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = "thread-resume";
const ENVIRONMENT = "env-a";

/** Records its own session directory at boot, then answers the bootstrap probe. */
const fakeBinary = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
const dir = process.argv[process.argv.indexOf("--session-dir") + 1];
appendFileSync(process.env.MARKER, JSON.stringify({ type: "BOOT", dir }) + "\\n");
createInterface({input:process.stdin}).on("line",line=>{const c=JSON.parse(line);appendFileSync(process.env.MARKER,JSON.stringify({type:c.type})+"\\n");const data=c.type==="get_available_models"?{models:[]}:{state:"idle"};process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data})+"\\n")});`;

type Fixture = {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly binary: string;
  readonly marker: string;
  readonly store: PrimeSessionLeaseStore;
  readonly published: Array<readonly [string, PrimeResumeState]>;
  readonly clock: { now: number };
};

const scopeFor = (threadId: string): PrimeResumeCursorScope =>
  ({
    environmentId: ENVIRONMENT,
    providerInstanceId: INSTANCE,
    projectId: "project-a",
    threadId,
    homeFingerprint: "home-one",
  }) as PrimeResumeCursorScope;

const fixture = async (): Promise<Fixture> => {
  // `realpath` because macOS hands out `/var/...` for the temp dir and the
  // Prime ownership proof refuses to walk a symlinked ancestor.
  const root = await mkdtemp(join(tmpdir(), "pa-b02-int-")).then((made) => realpath(made));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const binary = join(root, "prime.mjs");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(binary, fakeBinary);
  await chmod(binary, 0o755);
  return {
    root,
    home,
    cwd,
    binary,
    marker: join(root, "marker"),
    store: makeInMemoryPrimeSessionLeaseStore(),
    published: [],
    clock: { now: 1_000 },
  };
};

/** One "server process": its own adapter, its own writer identity, shared storage. */
const adapterFor = (input: Fixture, writerToken: string) =>
  makePrimeAdapter(
    { binaryPath: input.binary } as never,
    {
      instanceId: INSTANCE,
      environmentId: ENVIRONMENT,
      home: input.home,
      enabled: true,
      agentVersion: async () => "0.7.3",
      onResumeState: (threadId: string, state: PrimeResumeState) =>
        input.published.push([threadId, state]),
      writeGate: makePrimeSessionWriteGate({
        service: makePrimeSessionLeaseService({
          store: input.store,
          now: () => input.clock.now,
          authorize: () => true,
        }),
        writer: { clientToken: writerToken, processToken: writerToken },
        scopeForThread,
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

const scopeForThread = (threadId: string) => Promise.resolve(scopeFor(threadId));

const startInput = (input: Fixture) => ({
  threadId: ThreadId.make(THREAD),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd: input.cwd,
  runtimeMode: "approval-required" as const,
});

const markerLines = async (input: Fixture) =>
  (await readFile(input.marker, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { readonly type: string; readonly dir?: string });

const layoutFor = (input: Fixture) =>
  primeResourceLayout({
    home: input.home,
    environmentId: ENVIRONMENT,
    instanceId: INSTANCE,
    threadId: THREAD,
  });

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

describe("PA-B02 Prime exact adoption and resume", () => {
  it.effect("resumes the exact durable session after a graceful restart", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      // First run: a thread with no cursor starts fresh and records one.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      const before = yield* Effect.promise(() => cursorIdentity(input));
      assert.equal(before.status, "available");
      // A fresh first session never claims to be a resume.
      assert.deepStrictEqual(input.published, []);

      // Second run: a brand new adapter, with no memory of the first.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-two");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      const after = yield* Effect.promise(() => cursorIdentity(input));
      // Exact session: same opaque storage token, same scope, same version.
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(input.published, [
        [THREAD, { status: "reconnecting" }],
        [THREAD, { status: "resumed", mode: "relaunched" }],
      ]);
      // Both runs opened the same durable session directory, and each of them
      // opened exactly one.
      const boots = (yield* Effect.promise(() => markerLines(input))).filter(
        (line) => line.type === "BOOT",
      );
      assert.equal(boots.length, 2);
      assert.equal(boots[0]!.dir, layoutFor(input).session);
      assert.equal(boots[1]!.dir, boots[0]!.dir);
    }).pipe(Effect.scoped, Effect.orDie),
  );

  it.effect("resumes the exact session after abrupt loss of the owning process", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      // The first server never releases: it is gone, and its lease lapses.
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          return yield* Effect.promise(() => cursorIdentity(input));
        }).pipe(Effect.map((identity) => identity)),
      );
      input.clock.now += PRIME_SESSION_LEASE_TTL_MS + 1;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-two");
          yield* adapter.startSession(startInput(input));
        }),
      );
      assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), first);
      assert.deepStrictEqual(
        input.published.map(([, state]) => state),
        [{ status: "reconnecting" }, { status: "resumed", mode: "relaunched" }],
      );
    }).pipe(Effect.scoped, Effect.orDie),
  );

  it.effect("never silently starts fresh when the recorded session is incompatible", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      const path = layoutFor(input).resumeCursor;
      const { state } = yield* Effect.promise(() => readPrimeResumeCursor(path));
      assert.equal(state.status, "available");
      if (state.status !== "available") return;
      // A supported binary recorded this session; an unsupported one now runs.
      yield* Effect.promise(() =>
        writePrimeResumeCursor(path, {
          ...state.cursor,
          compatibility: { agentVersion: "0.6.0", band: "incompatible" },
        }),
      );
      const before = yield* Effect.promise(() => cursorIdentity(input));
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-two");
          return yield* Effect.flip(adapter.startSession(startInput(input)));
        }),
      );
      assert.ok(failure instanceof ProviderAdapterValidationError);
      assert.include(failure.issue, "incompatibleVersion");
      // The refusal is truthful about what it did not do.
      assert.include(failure.issue, "not replaced");
      // No second process was launched and the cursor was left alone.
      const boots = (yield* Effect.promise(() => markerLines(input))).filter(
        (line) => line.type === "BOOT",
      );
      assert.equal(boots.length, 1);
      assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), before);
      assert.deepStrictEqual(input.published.at(-1), [
        THREAD,
        { status: "unavailable", reason: "incompatibleVersion" },
      ]);
    }).pipe(Effect.scoped, Effect.orDie),
  );

  it.effect("never adopts a cursor recorded by another environment", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      const path = layoutFor(input).resumeCursor;
      const { state } = yield* Effect.promise(() => readPrimeResumeCursor(path));
      if (state.status !== "available") return assert.fail("expected a recorded cursor");
      yield* Effect.promise(() =>
        writePrimeResumeCursor(path, {
          ...state.cursor,
          scope: { ...state.cursor.scope, environmentId: "env-other" as never },
        }),
      );
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-two");
          return yield* Effect.flip(adapter.startSession(startInput(input)));
        }),
      );
      assert.ok(failure instanceof ProviderAdapterValidationError);
      assert.include(failure.issue, "scopeMismatch");
      // Nothing about the other environment leaks into the refusal.
      assert.equal(failure.issue.includes("env-other"), false);
      assert.equal(failure.issue.includes(input.home), false);
    }).pipe(Effect.scoped, Effect.orDie),
  );

  it.effect("is idempotent: repeated recovery reopens one session, not two", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      const before = yield* Effect.promise(() => cursorIdentity(input));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-two");
          yield* adapter.startSession(startInput(input));
          // A second, redundant recovery for the same thread in the same
          // process: idempotent, and it must not start a second runtime.
          yield* adapter.startSession(startInput(input));
        }),
      );
      assert.deepStrictEqual(yield* Effect.promise(() => cursorIdentity(input)), before);
      const boots = (yield* Effect.promise(() => markerLines(input))).filter(
        (line) => line.type === "BOOT",
      );
      assert.equal(boots.length, 2);
    }).pipe(Effect.scoped, Effect.orDie),
  );

  it.effect("keeps the durable cursor free of content and host paths", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      const raw = yield* Effect.promise(() => readFile(layoutFor(input).resumeCursor, "utf8"));
      for (const secret of [input.home, input.cwd, input.root, input.binary]) {
        assert.equal(raw.includes(secret), false, `cursor leaked ${secret}`);
      }
    }).pipe(Effect.scoped, Effect.orDie),
  );

  // PA-B04 regression: a relaunch whose validation passed but whose process
  // launch failed must publish a terminal refusal — `reconnecting` is never
  // the last word on a thread, so the banner offers recovery instead of
  // spinning forever with the composer shut.
  it.effect("publishes a terminal refusal when the relaunch itself fails", () =>
    Effect.gen(function* () {
      const input = yield* Effect.promise(fixture);
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(input.root, { recursive: true, force: true })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-one");
          yield* adapter.startSession(startInput(input));
          yield* adapter.stopSession(ThreadId.make(THREAD));
        }),
      );
      // The recorded cursor still validates, but the runtime now dies at boot.
      yield* Effect.promise(() =>
        writeFile(input.binary, "#!/usr/bin/env node\nprocess.exit(17);\n"),
      );
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* adapterFor(input, "process-two");
          return yield* Effect.exit(adapter.startSession(startInput(input)));
        }),
      );
      assert.equal(outcome._tag, "Failure", "a dead runtime must fail the start");
      const states = input.published.map(([, state]) => state);
      assert.deepStrictEqual(states.at(-2), { status: "reconnecting" });
      assert.deepStrictEqual(states.at(-1), { status: "unavailable", reason: "launchFailed" });
    }).pipe(Effect.scoped, Effect.orDie),
  );
});
