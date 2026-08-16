// @effect-diagnostics nodeBuiltinImport:off
// The ownership record and the fake runtime's store are plain JSON files on
// disk; reading them back byte-for-byte is the assertion.
// @effect-diagnostics preferSchemaOverJson:off
// The adapter's error channel is exercised through its public shape here.
// @effect-diagnostics anyUnknownInErrorContext:off
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  HeartbeatId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";

import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { primeResourceLayout } from "../prime/PrimeResourceLayout.ts";
import { makePrimeAdapter } from "./PrimeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = "thread-heartbeats";
const HOME_SUFFIX = "t3-home-heartbeats";

/**
 * A fake Prime runtime whose heartbeat store lives on disk, so it survives the
 * process the way a resident daemon's schedule really does. That persistence is
 * the whole point: it is what makes "the session restarted, is my heartbeat
 * still mine?" a question the adapter has to answer.
 *
 * `hb-sentinel` is seeded by the test as a schedule T3 never created. It is
 * reported in every store snapshot and must never be listed or targeted.
 *
 * A title prefixed `bad-` is echoed back with an interval T3 refuses to state
 * (30s), which is how the store and the renderable board are made to diverge.
 */
const fakeSource = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const store = process.env.T3_HB_STORE;
const load = () => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : { seq: 0, heartbeats: [] });
const save = (s) => writeFileSync(store, JSON.stringify(s));
const reply = (command, data) =>
  process.stdout.write(
    JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n",
  );
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") return reply(command, { state: "idle" });
  const state = load();
  let heartbeats = state.heartbeats;
  let seq = state.seq;
  let heartbeatId;
  if (command.type === "heartbeat_create") {
    seq += 1;
    heartbeatId = process.env.T3_HB_EMPTY_ID === "1" ? "" : "hb-" + seq;
    heartbeats = [
      ...heartbeats,
      {
        heartbeatId,
        title: command.title,
        intervalSeconds: String(command.title).startsWith("bad-") ? 30 : command.intervalSeconds,
        paused: false,
      },
    ];
    save({ seq, heartbeats });
  } else if (command.type === "heartbeat_pause" || command.type === "heartbeat_resume") {
    heartbeats = heartbeats.map((h) =>
      h.heartbeatId === command.heartbeatId
        ? { ...h, paused: command.type === "heartbeat_pause" }
        : h,
    );
    save({ seq, heartbeats });
  } else if (command.type === "heartbeat_stop") {
    heartbeats = heartbeats.filter((h) => h.heartbeatId !== command.heartbeatId);
    save({ seq, heartbeats });
  }
  reply(command, {
    ...(heartbeatId !== undefined ? { heartbeatId } : {}),
    heartbeats,
    resident: heartbeats.length > 0,
  });
});
`;

const makeInput = (cwd: string) => ({
  threadId: ThreadId.make(THREAD),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd,
  runtimeMode: "approval-required" as const,
});

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    // realpath: the ownership writer refuses a symlinked ancestor chain, and
    // macOS resolves the default temp root through a symlinked /var.
    const root = await realpath(await mkdtemp(join(tmpdir(), "prime-heartbeat-own-")));
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const binary = join(root, "fake.mjs");
    await writeFile(binary, fakeSource);
    await chmod(binary, 0o755);
    const store = join(root, "heartbeats.json");
    // A schedule T3 did not create, present in the store from the first boot.
    await writeFile(
      store,
      JSON.stringify({
        seq: 0,
        heartbeats: [
          {
            heartbeatId: "hb-sentinel",
            title: "someone else",
            intervalSeconds: 600,
            paused: false,
          },
        ],
      }),
    );
    return { root, cwd, binary, store };
  }),
  ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

const make = (f: { root: string; binary: string; store: string }, extra: NodeJS.ProcessEnv = {}) =>
  makePrimeAdapter(
    { binaryPath: f.binary },
    {
      instanceId: INSTANCE,
      environmentId: "env",
      home: join(f.root, HOME_SUFFIX),
      enabled: true,
      environment: { PATH: process.env.PATH },
      launch: (command, args, options) => {
        const transport = spawnPrimeRpcTransport(command, args, {
          ...(options ?? {}),
          env: { ...(options?.env ?? {}), T3_HB_STORE: f.store, ...extra },
        });
        // Process incarnation proof is Linux-only (/proc/<pid>/stat), so on
        // any other host the adapter would never write an ownership record at
        // all and this suite would silently assert nothing. A stated identity
        // keeps the record path — the thing under test — exercised everywhere.
        // Nothing here proves or stops a process; that is covered separately.
        return {
          ...transport,
          processIdentityReady: Promise.resolve({ pid: 424_242, startToken: "test-incarnation" }),
        };
      },
    },
  );

const ownershipPath = (root: string) =>
  primeResourceLayout({
    home: join(root, HOME_SUFFIX),
    environmentId: "env",
    instanceId: String(INSTANCE),
    threadId: THREAD,
  }).ownership;

const ownedIds = (root: string) =>
  Effect.promise(async () => {
    const record = JSON.parse(await readFile(ownershipPath(root), "utf8")) as {
      heartbeatIds?: readonly string[];
    };
    return [...(record.heartbeatIds ?? [])];
  });

const create = (
  adapter: { executeRuntimeOperation?: unknown },
  title: string,
  intervalSeconds = 300,
) =>
  (adapter as any).executeRuntimeOperation({
    type: "heartbeat.create",
    threadId: ThreadId.make(THREAD),
    commandId: CommandId.make(randomUUID()),
    heartbeatId: HeartbeatId.make("pending"),
    title,
    intervalSeconds,
  }) as Effect.Effect<void, unknown>;

const act = (adapter: unknown, type: string, heartbeatId: string) =>
  (adapter as any).executeRuntimeOperation({
    type,
    threadId: ThreadId.make(THREAD),
    commandId: CommandId.make(randomUUID()),
    heartbeatId: HeartbeatId.make(heartbeatId),
  }) as Effect.Effect<void, unknown>;

describe("PrimeAdapter owned-heartbeat handles across sessions", () => {
  it.effect(
    "rehydrates the recorded handles on the next session so a surviving heartbeat stays listable and stoppable",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        // First session: create one heartbeat, then let the session end.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* make(f);
            yield* adapter.startSession(makeInput(f.cwd));
            yield* create(adapter, "nightly");
          }),
        );
        assert.deepStrictEqual(yield* ownedIds(f.root), ["hb-1"]);

        // Second session on the same thread. The record is rewritten at start;
        // it must carry the handle forward rather than erase it.
        const second = yield* make(f);
        yield* second.startSession(makeInput(f.cwd));
        assert.deepStrictEqual(
          yield* ownedIds(f.root),
          ["hb-1"],
          "the new session erased the surviving heartbeat's ownership handle",
        );

        // Reachability: the rehydrated id is a real action target again, and
        // the reverse path (stop) still works on it.
        yield* act(second, "heartbeat.pause", "hb-1");
        assert.deepStrictEqual(yield* ownedIds(f.root), ["hb-1"]);
        yield* act(second, "heartbeat.resume", "hb-1");

        // The unowned sentinel is never a target, in this session or any other.
        const refused = yield* Effect.exit(act(second, "heartbeat.pause", "hb-sentinel"));
        assert.strictEqual(refused._tag, "Failure");
        assert.deepStrictEqual(yield* ownedIds(f.root), ["hb-1"]);

        yield* act(second, "heartbeat.delete", "hb-1");
        const after = JSON.parse(yield* Effect.promise(() => readFile(f.store, "utf8"))) as {
          heartbeats: ReadonlyArray<{ heartbeatId: string }>;
        };
        assert.deepStrictEqual(
          after.heartbeats.map((h) => h.heartbeatId),
          ["hb-sentinel"],
          "stopping ours must leave the unowned schedule exactly alone",
        );
        assert.deepStrictEqual(yield* ownedIds(f.root), []);
      }),
  );

  it.effect("never adopts a handle the ownership record could not hold", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // An empty id is not an id the ownership record can hold; adopting it
      // would make the write throw after the heartbeat already exists.
      const adapter = yield* make(f, { T3_HB_EMPTY_ID: "1" });
      yield* adapter.startSession(makeInput(f.cwd));
      const outcome = yield* Effect.exit(create(adapter, "nightly"));
      assert.strictEqual(
        outcome._tag,
        "Success",
        "adopting an unholdable id makes the ownership write throw after the heartbeat already exists",
      );
      assert.deepStrictEqual(yield* ownedIds(f.root), []);
    }),
  );

  it.effect("keeps an owned handle actionable after the runtime drifts its row off the board", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const adapter = yield* make(f);
      yield* adapter.startSession(makeInput(f.cwd));
      yield* create(adapter, "steady");
      const [ownedId] = yield* ownedIds(f.root);
      assert.ok(ownedId, "creation must record the owned handle");
      // The runtime later drifts the schedule to an interval T3 refuses to
      // state (e.g. a TUI edit); the next re-read drops the row from the
      // board while the handle stays owned.
      const drifted = JSON.parse(yield* Effect.promise(() => readFile(f.store, "utf8"))) as {
        seq: number;
        heartbeats: Array<{ heartbeatId: string; intervalSeconds: number }>;
      };
      for (const row of drifted.heartbeats)
        if (row.heartbeatId === ownedId) row.intervalSeconds = 30;
      yield* Effect.promise(() => writeFile(f.store, JSON.stringify(drifted)));
      // Pause still targets the (stale-rendered) row and re-reads, which
      // removes it from the board but not from the owned set.
      yield* act(adapter, "heartbeat.pause", ownedId);
      assert.deepStrictEqual(yield* ownedIds(f.root), [ownedId]);
      // Delete must remain reachable through the raw owned id even though
      // the board can no longer render the row.
      yield* act(adapter, "heartbeat.delete", ownedId);
      assert.deepStrictEqual(yield* ownedIds(f.root), []);
      const after = JSON.parse(yield* Effect.promise(() => readFile(f.store, "utf8"))) as {
        heartbeats: ReadonlyArray<{ heartbeatId: string }>;
      };
      assert.deepStrictEqual(
        after.heartbeats.map((h) => h.heartbeatId),
        ["hb-sentinel"],
        "the drifted owned schedule is gone; the unowned sentinel untouched",
      );
    }),
  );

  it.effect(
    "caps creation on the handles it would persist, not only on the rows it can render",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f);
        yield* adapter.startSession(makeInput(f.cwd));
        // A schedule the runtime reports back with an interval T3 refuses to
        // state is stopped at creation rather than kept as an owned row the
        // board cannot render, so it never counts against the cap.
        const diverged = yield* Effect.exit(create(adapter, "bad-divergent"));
        assert.strictEqual(diverged._tag, "Failure", "unrenderable creation must be refused");
        assert.deepStrictEqual(yield* ownedIds(f.root), []);
        const divergedStore = JSON.parse(
          yield* Effect.promise(() => readFile(f.store, "utf8")),
        ) as { heartbeats: ReadonlyArray<{ heartbeatId: string }> };
        assert.deepStrictEqual(
          divergedStore.heartbeats.map((h) => h.heartbeatId),
          ["hb-sentinel"],
          "the divergent schedule must be stopped, the unowned sentinel untouched",
        );
        for (let i = 0; i < 8; i += 1) yield* create(adapter, `ok-${i}`);
        const owned = yield* ownedIds(f.root);
        assert.strictEqual(owned.length, 8);
        const before = JSON.parse(yield* Effect.promise(() => readFile(f.store, "utf8"))) as {
          heartbeats: ReadonlyArray<unknown>;
        };
        const refused = yield* Effect.exit(create(adapter, "ninth"));
        assert.strictEqual(
          refused._tag,
          "Failure",
          "a ninth handle would exceed the record bound and be lost after the heartbeat really exists",
        );
        // The refusal has to land before the runtime is touched. Failing after
        // creation would leave a real schedule running with no recorded handle.
        const after = JSON.parse(yield* Effect.promise(() => readFile(f.store, "utf8"))) as {
          heartbeats: ReadonlyArray<unknown>;
        };
        assert.strictEqual(after.heartbeats.length, before.heartbeats.length);
        assert.deepStrictEqual(yield* ownedIds(f.root), owned);
      }),
  );
});
