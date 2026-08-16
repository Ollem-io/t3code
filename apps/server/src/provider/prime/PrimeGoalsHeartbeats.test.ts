// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import {
  HeartbeatId,
  OrchestrationSessionGoalBoard,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { spawnPrimeRpcTransport } from "./PrimeRpcProcessTransport.ts";
import { decodePrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";
import { makePrimeAdapter } from "../Layers/PrimeAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import {
  MAX_PRIME_HEARTBEATS,
  PRIME_GOAL_MUTATION_REFUSAL,
  PRIME_HEARTBEAT_DAEMON_DISCLOSURE,
  primeGoal,
  primeGoalBoard,
  primeGoalBoardFingerprint,
  primeHeartbeatCreateDecision,
  primeHeartbeatDecision,
  primeHeartbeatRefusalMessage,
  primeOwnedHeartbeats,
  type PrimeNativeHeartbeat,
} from "./PrimeGoalsHeartbeats.ts";

const heartbeat = (
  over: Partial<PrimeNativeHeartbeat> & { heartbeatId: string },
): PrimeNativeHeartbeat =>
  ({ title: "Check CI", intervalSeconds: 1_200, ...over }) as PrimeNativeHeartbeat;

const owned = (...ids: readonly string[]) => new Set(ids);
const decodeGoalBoard = Schema.decodeUnknownSync(OrchestrationSessionGoalBoard);
/** The ownership handle, read back exactly as the adapter wrote it. */
const decodeOwnershipRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ heartbeatIds: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

describe("Prime goal and heartbeat mapping", () => {
  it("shows only the heartbeats this environment created", () => {
    // The daemon hosts other people's schedules. None of them is listed, so
    // none of them can be rendered or targeted.
    const rows = primeOwnedHeartbeats(
      [
        heartbeat({ heartbeatId: "hb-mine" }),
        heartbeat({ heartbeatId: "hb-someone-else", title: "Nightly deploy" }),
        heartbeat({ heartbeatId: "hb-other-thread", title: "Other thread" }),
      ],
      owned("hb-mine"),
    );
    assert.deepStrictEqual(
      rows.map((row) => row.heartbeatId),
      ["hb-mine"],
    );
  });

  it("bounds the board, drops duplicates, and clamps display text", () => {
    const flood = Array.from({ length: 40 }, (_unused, index) =>
      heartbeat({ heartbeatId: `hb-${index}` }),
    );
    assert.equal(
      primeOwnedHeartbeats(flood, owned(...flood.map((row) => row.heartbeatId))).length,
      MAX_PRIME_HEARTBEATS,
    );
    const duplicated = primeOwnedHeartbeats(
      [
        heartbeat({ heartbeatId: "same", title: "First" }),
        heartbeat({ heartbeatId: "same", title: "Second" }),
      ],
      owned("same"),
    );
    assert.deepStrictEqual(
      duplicated.map((row) => row.title),
      ["First"],
    );
    const clamped = primeOwnedHeartbeats(
      [heartbeat({ heartbeatId: "hb", title: "x".repeat(400) })],
      owned("hb"),
    )[0]!;
    assert.equal(clamped.title.length, 120);
    // Control characters in a native string never reach a client.
    assert.equal(
      primeOwnedHeartbeats([heartbeat({ heartbeatId: "hb", title: "ab" })], owned("hb"))[0]?.title,
      "a b",
    );
  });

  it("refuses an identity or a schedule it cannot state exactly", () => {
    // Clamping an id would create an identity the runtime never issued.
    assert.deepStrictEqual(
      primeOwnedHeartbeats([heartbeat({ heartbeatId: "x".repeat(200) })], owned("x".repeat(200))),
      [],
    );
    for (const intervalSeconds of [30, 90_000, 60.5]) {
      assert.deepStrictEqual(
        primeOwnedHeartbeats([heartbeat({ heartbeatId: "hb", intervalSeconds })], owned("hb")),
        [],
      );
    }
  });

  it("never advertises a next run for a paused heartbeat", () => {
    const rows = primeOwnedHeartbeats(
      [
        heartbeat({ heartbeatId: "a", nextRunAt: "2026-08-16T09:20:00.000Z" }),
        heartbeat({ heartbeatId: "b", paused: true, nextRunAt: "2026-08-16T09:20:00.000Z" }),
        // A timestamp T3 cannot state exactly is absent rather than invented.
        heartbeat({ heartbeatId: "c", nextRunAt: "soon" }),
      ],
      owned("a", "b", "c"),
    );
    assert.deepStrictEqual(
      rows.map((row) => [row.status, row.nextRunAt]),
      [
        ["active", "2026-08-16T09:20:00.000Z"],
        ["paused", undefined],
        ["active", undefined],
      ],
    );
  });

  it("keeps goal state read-only and representable", () => {
    assert.deepStrictEqual(
      primeGoal({ goalId: "goal-1", title: "Finish review", status: "active", detail: "3 of 8" }),
      { goalId: "goal-1", title: "Finish review", status: "active", detail: "3 of 8" },
    );
    // A goal T3 cannot reproduce exactly is dropped rather than renamed.
    assert.equal(primeGoal({ goalId: "g".repeat(200), title: "x", status: "active" }), undefined);
    assert.equal(primeGoal(undefined), undefined);
    assert.ok(PRIME_GOAL_MUTATION_REFUSAL.includes("read-only"));
  });

  it("discloses residency only while an owned schedule needs it", () => {
    const store = [heartbeat({ heartbeatId: "hb" })];
    assert.deepStrictEqual(
      primeGoalBoard({
        heartbeats: store,
        owned: owned("hb"),
        resident: true,
        owner: "T3 thread t",
      }).resident,
      { owner: "T3 thread t" },
    );
    // Nothing owned means nothing keeps the session resident on T3's behalf, so
    // the reverse control is not offered against a claim we cannot back.
    assert.equal(
      primeGoalBoard({ heartbeats: store, owned: owned(), resident: true, owner: "T3 thread t" })
        .resident,
      undefined,
    );
    assert.equal(
      primeGoalBoard({
        heartbeats: store,
        owned: owned("hb"),
        resident: false,
        owner: "T3 thread t",
      }).resident,
      undefined,
    );
  });

  it("produces a board the canonical contract accepts", () => {
    const board = primeGoalBoard({
      goal: { goalId: "goal-1", title: "Finish review", status: "active" },
      heartbeats: [heartbeat({ heartbeatId: "hb" })],
      owned: owned("hb"),
      resident: true,
      owner: "T3 thread thread-1",
    });
    assert.equal(decodeGoalBoard(board).heartbeats.length, 1);
  });

  it("fingerprints byte-identical boards identically", () => {
    const build = () =>
      primeGoalBoard({
        heartbeats: [heartbeat({ heartbeatId: "hb" })],
        owned: owned("hb"),
        owner: "o",
      });
    assert.equal(primeGoalBoardFingerprint(build()), primeGoalBoardFingerprint(build()));
  });
});

describe("Prime heartbeat ownership decisions", () => {
  const board = primeGoalBoard({
    heartbeats: [
      heartbeat({ heartbeatId: "hb-active" }),
      heartbeat({ heartbeatId: "hb-paused", paused: true }),
    ],
    owned: owned("hb-active", "hb-paused"),
    owner: "T3 thread thread-1",
  });

  it("refuses every identity this session does not own", () => {
    // A stale id, another thread's schedule, and an id fished out of the daemon
    // fail the same way, because none of them is in this board.
    for (const id of ["hb-gone", "hb-other-thread", "hb-from-a-daemon"]) {
      assert.deepStrictEqual(primeHeartbeatDecision(board, id, "delete"), {
        allowed: false,
        reason: "unknown-heartbeat",
      });
    }
    assert.equal(primeHeartbeatDecision(board, "hb-active", "pause").allowed, true);
    assert.equal(primeHeartbeatDecision(board, "hb-paused", "resume").allowed, true);
    // Delete is always available, so creation is never a one-way door.
    assert.equal(primeHeartbeatDecision(board, "hb-paused", "delete").allowed, true);
  });

  it("refuses a state change that would not change anything", () => {
    assert.deepStrictEqual(primeHeartbeatDecision(board, "hb-paused", "pause"), {
      allowed: false,
      reason: "already-paused",
    });
    assert.deepStrictEqual(primeHeartbeatDecision(board, "hb-active", "resume"), {
      allowed: false,
      reason: "already-active",
    });
  });

  it("bounds creation the same way the board is bounded", () => {
    assert.deepStrictEqual(primeHeartbeatCreateDecision(board, 1_200), { allowed: true });
    for (const interval of [30, 90_000, 60.5]) {
      assert.deepStrictEqual(primeHeartbeatCreateDecision(board, interval), {
        allowed: false,
        reason: "interval-out-of-range",
      });
    }
    const full = primeGoalBoard({
      heartbeats: Array.from({ length: MAX_PRIME_HEARTBEATS }, (_unused, index) =>
        heartbeat({ heartbeatId: `hb-${index}` }),
      ),
      owned: owned(...Array.from({ length: MAX_PRIME_HEARTBEATS }, (_u, i) => `hb-${i}`)),
      owner: "o",
    });
    assert.deepStrictEqual(primeHeartbeatCreateDecision(full, 1_200), {
      allowed: false,
      reason: "limit-reached",
    });
  });

  it("states what happened without leaking anything about the host", () => {
    for (const reason of [
      "unknown-heartbeat",
      "already-paused",
      "already-active",
      "limit-reached",
      "interval-out-of-range",
    ] as const) {
      const message = primeHeartbeatRefusalMessage(reason);
      assert.ok(message.length > 0 && !message.includes("/"));
    }
    // The disclosure names the consequence, in advance, in plain language.
    assert.ok(PRIME_HEARTBEAT_DAEMON_DISCLOSURE.includes("resident"));
    assert.ok(PRIME_HEARTBEAT_DAEMON_DISCLOSURE.includes("only this T3-owned session"));
  });
});

/**
 * A real child process that owns a heartbeat store and one unrelated sentinel
 * schedule it never created through T3. Every assertion below therefore
 * exercises the shipped protocol boundary, adapter, and mapper together.
 */
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
const log=(x)=>appendFileSync(process.env.MARKER,JSON.stringify(x)+"\\n");
const models={models:[{id:"model",name:"Model",api:"api",provider:"provider",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:100,thinkingLevelMap:{}}]};
const out=x=>process.stdout.write(JSON.stringify(x)+"\\n");
// The sentinel belongs to someone else and must survive everything T3 does.
let store=[{heartbeatId:"hb-sentinel",title:"Someone else's nightly deploy",intervalSeconds:3600}];
let made=0;
const snapshot=()=>({heartbeats:store,resident:store.length>0});
createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{const c=JSON.parse(line);log(c);
 if(c.type==="get_available_models") return out({type:"response",id:c.id,command:c.type,success:true,data:models});
 if(c.type==="heartbeat_create"){made+=1;const heartbeatId="hb-t3-"+made;
  store=[...store,{heartbeatId,title:c.title,intervalSeconds:c.intervalSeconds,nextRunAt:"2026-08-16T09:20:00.000Z"}];
  return out({type:"response",id:c.id,command:c.type,success:true,data:{heartbeatId,...snapshot()}});}
 if(c.type==="heartbeat_get") return out({type:"response",id:c.id,command:c.type,success:true,data:snapshot()});
 if(c.type==="heartbeat_pause"||c.type==="heartbeat_resume"){
  store=store.map(h=>h.heartbeatId===c.heartbeatId?{...h,paused:c.type==="heartbeat_pause"}:h);
  return out({type:"response",id:c.id,command:c.type,success:true,data:{}});}
 if(c.type==="heartbeat_stop"){store=store.filter(h=>h.heartbeatId!==c.heartbeatId);
  return out({type:"response",id:c.id,command:c.type,success:true,data:{}});}
 out({type:"response",id:c.id,command:c.type,success:true,data:{state:"idle"}}); if(c.type!=="prompt") return;
 out({type:"turn_start"});
 if(c.message.includes("goal")) setTimeout(()=>out({type:"goal_update",goal:{goalId:"goal-1",title:"Finish provider adapter review",status:"active",detail:"3 of 8"}}),5);
});`;

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = ThreadId.make("prime-heartbeat-thread");

const setup = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "prime-heartbeat-"));
    const cwd = join(root, "cwd");
    const binary = join(root, "fake.mjs");
    const marker = join(root, "commands");
    await mkdir(cwd);
    await writeFile(binary, fakeSource);
    await chmod(binary, 0o755);
    return { root, cwd, binary, marker };
  }),
  (fixture) => Effect.promise(() => rm(fixture.root, { recursive: true, force: true })),
);
type Fixture = { root: string; cwd: string; binary: string; marker: string };
type Adapter = ProviderAdapterShape<ProviderAdapterError>;

const start = (f: Fixture) =>
  Effect.gen(function* () {
    const adapter = yield* makePrimeAdapter(
      { binaryPath: f.binary },
      {
        instanceId: INSTANCE,
        environmentId: "env",
        home: join(f.root, "home"),
        enabled: true,
        launch: (command, args, opts) =>
          spawnPrimeRpcTransport(command, args, {
            ...(opts ?? {}),
            env: { ...(opts?.env ?? {}), MARKER: f.marker },
          }),
      },
    );
    yield* adapter.startSession({
      threadId: THREAD,
      provider: PROVIDER,
      providerInstanceId: INSTANCE,
      cwd: f.cwd,
      runtimeMode: "approval-required" as const,
    });
    return adapter;
  });
const collect = (adapter: Adapter, count: number) =>
  Effect.map(Stream.runCollect(Stream.take(adapter.streamEvents, count)), (chunk) =>
    Array.from(chunk as Iterable<any>),
  );
const commands = (file: string) =>
  Effect.promise(async () =>
    (await readFile(file, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
/**
 * The next board snapshot. Session bootstrap also publishes a command catalog,
 * so the board is selected by type rather than by position.
 */
const nextBoard = (adapter: Adapter) =>
  Effect.map(
    Stream.runCollect(
      Stream.take(
        Stream.filter(adapter.streamEvents, (event: any) => event.type === "session.goals.updated"),
        1,
      ),
    ),
    (chunk) => Array.from(chunk as Iterable<any>)[0],
  );
const operation = (adapter: Adapter, operationInput: Record<string, unknown>) =>
  adapter.executeRuntimeOperation!({
    commandId: "cmd-heartbeat" as never,
    threadId: THREAD,
    ...operationInput,
  } as never);

describe("PrimeAdapter owned heartbeats", () => {
  it.effect("advertises the goals capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        assert.equal(adapter.capabilities.runtimeExtensions?.goals, true);
      }),
    ),
  );

  it.effect("creates, pauses, resumes, and deletes only its own heartbeat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* operation(adapter, {
          type: "heartbeat.create",
          heartbeatId: HeartbeatId.make("client-draft"),
          title: "Check CI",
          intervalSeconds: 1_200,
        });
        const created = yield* nextBoard(adapter);
        assert.equal(created.type, "session.goals.updated");
        // The sentinel is in the runtime's store and absent from the board.
        assert.deepStrictEqual(
          created.payload.heartbeats.map((row: any) => [row.heartbeatId, row.title, row.status]),
          [["hb-t3-1", "Check CI", "active"]],
        );
        assert.deepStrictEqual(created.payload.resident, { owner: `T3 thread ${THREAD}` });

        yield* operation(adapter, {
          type: "heartbeat.pause",
          heartbeatId: HeartbeatId.make("hb-t3-1"),
        });
        assert.equal((yield* nextBoard(adapter)).payload.heartbeats[0].status, "paused");
        yield* operation(adapter, {
          type: "heartbeat.resume",
          heartbeatId: HeartbeatId.make("hb-t3-1"),
        });
        assert.equal((yield* nextBoard(adapter)).payload.heartbeats[0].status, "active");
        yield* operation(adapter, {
          type: "heartbeat.delete",
          heartbeatId: HeartbeatId.make("hb-t3-1"),
        });
        const deleted = yield* nextBoard(adapter);
        assert.deepStrictEqual(deleted.payload.heartbeats, []);
        // With nothing owned left, T3 stops claiming the session is resident
        // on its behalf.
        assert.equal(deleted.payload.resident, undefined);

        const sent = yield* commands(f.marker);
        assert.deepStrictEqual(
          sent
            .filter((c) => String(c.type).startsWith("heartbeat_"))
            .map((c) => [c.type, c.heartbeatId ?? null]),
          [
            ["heartbeat_create", null],
            ["heartbeat_pause", "hb-t3-1"],
            ["heartbeat_get", null],
            ["heartbeat_resume", "hb-t3-1"],
            ["heartbeat_get", null],
            ["heartbeat_stop", "hb-t3-1"],
            ["heartbeat_get", null],
          ],
        );
        // Nothing T3 sent ever named the unrelated sentinel.
        assert.ok(!sent.some((c) => c.heartbeatId === "hb-sentinel"));
      }),
    ),
  );

  it.effect("refuses an unowned heartbeat and every goal mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        const refusal = yield* Effect.flip(
          operation(adapter, {
            type: "heartbeat.delete",
            heartbeatId: HeartbeatId.make("hb-sentinel"),
          }),
        );
        assert.match(String(refusal), /does not report this heartbeat as owned/);
        const goalRefusal = yield* Effect.flip(
          operation(adapter, {
            type: "goal.delete",
            goalId: "goal-1",
          }),
        );
        assert.match(String(goalRefusal), /no goal-change command/);
        const sent = yield* commands(f.marker);
        assert.ok(!sent.some((c) => String(c.type).startsWith("heartbeat_")));
        assert.ok(!sent.some((c) => String(c.type).startsWith("goal")));
      }),
    ),
  );

  it.effect("records the exact owned ids in the ownership handle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* operation(adapter, {
          type: "heartbeat.create",
          heartbeatId: HeartbeatId.make("client-draft"),
          title: "Check CI",
          intervalSeconds: 1_200,
        });
        yield* nextBoard(adapter);
        const layout = primeResourceLayout({
          home: join(f.root, "home"),
          environmentId: "env",
          instanceId: String(INSTANCE),
          threadId: String(THREAD),
        });
        const written = yield* Effect.promise(() =>
          readFile(layout.ownership, "utf8").catch(() => undefined),
        );
        // The record only exists where the platform can prove a process
        // incarnation (Linux `/proc`); elsewhere the adapter deliberately
        // writes no handle it could not later prove. Where it does exist, it
        // carries our ids and nothing else — never the sentinel.
        if (written !== undefined) {
          const record = decodeOwnershipRecord(written);
          assert.deepStrictEqual(record.heartbeatIds, ["hb-t3-1"]);
        }
      }),
    ),
  );

  it.effect("publishes read-only goal progress without a transcript row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* adapter.sendTurn({
          threadId: THREAD,
          input: "goal",
          modelSelection: {
            instanceId: INSTANCE,
            model: "model",
            nativeIdentity: { provider: "provider", modelId: "model" },
          },
        });
        const board = yield* nextBoard(adapter);
        // Goal progress is a board update, never a transcript row.
        assert.deepStrictEqual(board.payload.heartbeats, []);
        assert.deepStrictEqual(board.payload.goal, {
          goalId: "goal-1",
          title: "Finish provider adapter review",
          status: "active",
          detail: "3 of 8",
        });
      }),
    ),
  );
});

describe("Prime goal and heartbeat protocol boundary", () => {
  it("decodes the snapshots and refuses an unrecognized shape", () => {
    assert.equal(
      decodePrimeRpcEnvelope({ type: "heartbeat_update", heartbeats: [], resident: false })._tag,
      "known-event",
    );
    assert.equal(
      decodePrimeRpcEnvelope({
        type: "goal_update",
        goal: { goalId: "g", title: "t", status: "active" },
      })._tag,
      "known-event",
    );
    assert.equal(
      decodePrimeRpcEnvelope({
        type: "heartbeat_update",
        heartbeats: [{ heartbeatId: "a", title: "t", intervalSeconds: 60, surprise: true }],
      })._tag,
      "malformed",
    );
  });

  it("accepts the exact heartbeat commands and nothing daemon-wide", () => {
    assert.equal(
      decodePrimeRpcEnvelope({ type: "heartbeat_create", title: "t", intervalSeconds: 60 })._tag,
      "command",
    );
    for (const type of ["heartbeat_pause", "heartbeat_resume", "heartbeat_stop"]) {
      assert.equal(decodePrimeRpcEnvelope({ type, heartbeatId: "hb" })._tag, "command");
    }
    assert.equal(decodePrimeRpcEnvelope({ type: "heartbeat_get" })._tag, "command");
    // There is no list-all or stop-all variant to send.
    assert.equal(decodePrimeRpcEnvelope({ type: "heartbeat_stop_all" })._tag, "unknown-event");
  });
});
