// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationSessionAgentRoster,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
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
import { makePrimeAdapter } from "../Layers/PrimeAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import {
  MAX_PRIME_AGENTS,
  primeAgentRoster,
  primeAgentRosterFingerprint,
  primeObservationDecision,
  primeObservationRefusalMessage,
  type PrimeTaskEntry,
} from "./PrimeObservation.ts";

const task = (over: Partial<PrimeTaskEntry> & { taskId: string }): PrimeTaskEntry =>
  ({ status: "running", ...over }) as PrimeTaskEntry;

describe("Prime agent roster mapping", () => {
  it("keeps the runtime's own identities and reported parentage", () => {
    const roster = primeAgentRoster([
      task({ taskId: "root-1", title: "Refactor pass" }),
      task({ taskId: "sub-1", parentTaskId: "root-1", title: "Read the tests" }),
      task({ taskId: "sub-2", parentTaskId: "root-1", title: "Run the tests", status: "paused" }),
    ]);
    assert.deepStrictEqual(
      roster.map((agent) => [agent.agentId, agent.role, agent.status]),
      [
        ["root-1", "root", "running"],
        ["sub-1", "subagent", "running"],
        ["sub-2", "subagent", "paused"],
      ],
    );
    // Nothing is observed until this environment asks for it.
    assert.deepStrictEqual(
      roster.map((agent) => agent.observed),
      [false, false, false],
    );
  });

  it("bounds the roster, drops duplicates, and clamps display text", () => {
    const flood = Array.from({ length: 40 }, (_, index) =>
      task({ taskId: `t-${index}`, parentTaskId: "root", title: `Agent ${index}` }),
    );
    assert.equal(primeAgentRoster(flood).length, MAX_PRIME_AGENTS);
    const duplicated = primeAgentRoster([
      task({ taskId: "same", title: "First" }),
      task({ taskId: "same", title: "Second" }),
    ]);
    assert.deepStrictEqual(
      duplicated.map((agent) => agent.title),
      ["First"],
    );
    const clamped = primeAgentRoster([
      task({ taskId: "long", title: "x".repeat(400), detail: `line one${"y".repeat(400)}` }),
    ])[0]!;
    assert.equal(clamped.title.length, 120);
    assert.equal(clamped.detail?.length, 256);
    // Control characters in a native string never reach a client.
    assert.equal(primeAgentRoster([task({ taskId: "c", detail: "a\u0007b" })])[0]?.detail, "a b");
    // A title the runtime did not supply falls back to the identity we do have,
    // never to an invented one.
    assert.equal(primeAgentRoster([task({ taskId: "bare" })])[0]?.title, "bare");
  });

  it("refuses an identity it cannot reproduce exactly", () => {
    // Clamping an id would create an identity the runtime never issued, so the
    // row is dropped instead of renamed.
    assert.deepStrictEqual(primeAgentRoster([task({ taskId: "x".repeat(200) })]), []);
    assert.deepStrictEqual(primeAgentRoster([task({ taskId: "  " })]), []);
    // Trimming would store a different string than the runtime reported, so a
    // padded id is dropped rather than silently renamed.
    assert.deepStrictEqual(primeAgentRoster([task({ taskId: " a " })]), []);
  });

  it("keeps a title-less long id inside the wire contract", () => {
    // The id may be 128 chars while the contract caps a title at 120; an
    // unclamped fallback failed decode and dropped every roster update for the
    // thread.
    const agents = primeAgentRoster([task({ taskId: "a".repeat(128) })]);
    assert.equal(agents[0]?.title.length, 120);
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(OrchestrationSessionAgentRoster)({ agents }).agents.length,
      1,
    );
  });

  it("never reports a finished agent as observed", () => {
    const observed = new Set(["sub-1"]);
    const roster = primeAgentRoster(
      [
        task({ taskId: "sub-1", parentTaskId: "r", status: "completed" }),
        task({ taskId: "sub-2", parentTaskId: "r", status: "running" }),
      ],
      new Set([...observed, "sub-2"]),
    );
    assert.deepStrictEqual(
      roster.map((agent) => agent.observed),
      [false, true],
    );
  });

  it("fingerprints byte-identical rosters identically", () => {
    const tasks = [task({ taskId: "a" }), task({ taskId: "b", parentTaskId: "a" })];
    assert.equal(
      primeAgentRosterFingerprint(primeAgentRoster(tasks)),
      primeAgentRosterFingerprint(primeAgentRoster(tasks)),
    );
    assert.notEqual(
      primeAgentRosterFingerprint(primeAgentRoster(tasks)),
      primeAgentRosterFingerprint(primeAgentRoster(tasks, new Set(["b"]))),
    );
  });
});

describe("Prime observation ownership", () => {
  const roster = primeAgentRoster(
    [
      task({ taskId: "root-1" }),
      task({ taskId: "sub-1", parentTaskId: "root-1" }),
      task({ taskId: "done-1", parentTaskId: "root-1", status: "failed" }),
    ],
    new Set(["sub-1"]),
  );

  it("only allows agents this session currently reports", () => {
    assert.deepStrictEqual(primeObservationDecision(roster, "sub-9", "observe"), {
      allowed: false,
      reason: "unknown-agent",
    });
    // Same answer for an id belonging to some other session or daemon: it is
    // simply not in this roster, so no enumeration is possible through it.
    assert.deepStrictEqual(primeObservationDecision(roster, "other-thread-agent", "unobserve"), {
      allowed: false,
      reason: "unknown-agent",
    });
    assert.equal(primeObservationDecision(roster, "root-1", "observe").allowed, true);
  });

  it("refuses to observe a finished agent and to unobserve one it never observed", () => {
    assert.deepStrictEqual(primeObservationDecision(roster, "done-1", "observe"), {
      allowed: false,
      reason: "terminal-agent",
    });
    assert.deepStrictEqual(primeObservationDecision(roster, "root-1", "unobserve"), {
      allowed: false,
      reason: "not-observed",
    });
    assert.equal(primeObservationDecision(roster, "sub-1", "unobserve").allowed, true);
  });

  it("states what happened without leaking anything about the host", () => {
    for (const reason of ["unknown-agent", "terminal-agent", "not-observed"] as const) {
      const message = primeObservationRefusalMessage(reason);
      assert.ok(message.length > 0 && !message.includes("/"));
    }
  });
});

/**
 * A real child process that reports a root plus two subagents and answers
 * `observe` / `unobserve`. Every assertion below therefore exercises the
 * shipped protocol boundary, adapter, and mapper together.
 */
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
const log=(x)=>appendFileSync(process.env.MARKER,JSON.stringify(x)+"\\n");
const models={models:[{id:"model",name:"Model",api:"api",provider:"provider",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:100,thinkingLevelMap:{}}]};
const out=x=>process.stdout.write(JSON.stringify(x)+"\\n");
const tasks=[{taskId:"root-1",title:"Refactor pass",status:"running"},
 {taskId:"sub-1",parentTaskId:"root-1",title:"Read the tests",status:"running"},
 {taskId:"sub-2",parentTaskId:"root-1",title:"Run the tests",status:"running"}];
createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{const c=JSON.parse(line);log(c);
 if(c.type==="get_available_models") return out({type:"response",id:c.id,command:c.type,success:true,data:models});
 out({type:"response",id:c.id,command:c.type,success:true,data:{state:"idle"}}); if(c.type!=="prompt") return;
 out({type:"turn_start"}); const m=c.message;
 if(m.includes("spawn")){setTimeout(()=>out({type:"task_update",tasks}),5);setTimeout(()=>out({type:"task_update",tasks}),10);}
 if(m.includes("finish")){setTimeout(()=>out({type:"task_update",tasks}),5);
  setTimeout(()=>out({type:"task_update",tasks:tasks.map(t=>t.taskId==="sub-1"?{...t,status:"completed",detail:"12 tests read"}:t)}),20);}
});`;

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = ThreadId.make("prime-observation-thread");

const setup = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "prime-observation-"));
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
const turn = (adapter: Adapter, word: string) =>
  adapter.sendTurn({
    threadId: THREAD,
    input: word,
    modelSelection: {
      instanceId: INSTANCE,
      model: "model",
      nativeIdentity: { provider: "provider", modelId: "model" },
    },
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

describe("PrimeAdapter subagent observation", () => {
  it.effect("advertises the tasks capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        assert.equal(adapter.capabilities.runtimeExtensions?.tasks, true);
      }),
    ),
  );

  it.effect("publishes one roster snapshot and no transcript rows for repeated task stores", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "spawn");
        // Discovery snapshot, turn start, then exactly one roster snapshot: the
        // byte-identical repeat costs nothing.
        const events = yield* collect(adapter, 3);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["session.commands.updated", "turn.started", "session.agents.updated"],
        );
        assert.deepStrictEqual(
          events[2].payload.agents.map((agent: any) => [agent.agentId, agent.role, agent.observed]),
          [
            ["root-1", "root", false],
            ["sub-1", "subagent", false],
            ["sub-2", "subagent", false],
          ],
        );
      }),
    ),
  );

  it.effect("observes and unobserves an owned agent, and refuses an unowned one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "spawn");
        yield* collect(adapter, 3);
        const operation = (type: "task.observe" | "task.unobserve", taskId: string) =>
          adapter.executeRuntimeOperation!({
            type,
            commandId: RuntimeTaskId.make(`cmd-${type}-${taskId}`) as never,
            threadId: THREAD,
            taskId: RuntimeTaskId.make(taskId),
          });
        yield* operation("task.observe", "sub-1");
        const observedEvent = (yield* collect(adapter, 1))[0];
        assert.equal(
          observedEvent.payload.agents.find((agent: any) => agent.agentId === "sub-1").observed,
          true,
        );
        yield* operation("task.unobserve", "sub-1");
        const unobservedEvent = (yield* collect(adapter, 1))[0];
        assert.equal(
          unobservedEvent.payload.agents.find((agent: any) => agent.agentId === "sub-1").observed,
          false,
        );
        // An identity this session does not report never reaches the runtime.
        const refusal = yield* Effect.flip(operation("task.observe", "sub-from-another-daemon"));
        assert.match(String(refusal), /does not report this agent/);
        const sent = yield* commands(f.marker);
        assert.deepStrictEqual(
          sent
            .filter((c) => c.type === "observe" || c.type === "unobserve")
            .map((c) => [c.type, c.taskId]),
          [
            ["observe", "sub-1"],
            ["unobserve", "sub-1"],
          ],
        );
      }),
    ),
  );

  it.effect("drops an observation when its agent finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "finish");
        yield* collect(adapter, 3);
        yield* adapter.executeRuntimeOperation!({
          type: "task.observe",
          commandId: RuntimeTaskId.make("cmd-observe") as never,
          threadId: THREAD,
          taskId: RuntimeTaskId.make("sub-1"),
        });
        yield* collect(adapter, 1);
        const finished = (yield* collect(adapter, 1))[0];
        const row = finished.payload.agents.find((agent: any) => agent.agentId === "sub-1");
        assert.equal(row.status, "completed");
        assert.equal(row.observed, false);
        // Observed output is a bounded line on the row, never a transcript item.
        assert.equal(row.detail, "12 tests read");
        assert.equal(finished.type, "session.agents.updated");
      }),
    ),
  );
});

describe("Prime task protocol boundary", () => {
  it("decodes a task store snapshot and refuses an unrecognized shape", () => {
    const decoded = decodePrimeRpcEnvelope({
      type: "task_update",
      tasks: [{ taskId: "a", status: "running" }],
    });
    assert.equal(decoded._tag, "known-event");
    const malformed = decodePrimeRpcEnvelope({
      type: "task_update",
      tasks: [{ taskId: "a", status: "running", surprise: true }],
    });
    assert.equal(malformed._tag, "malformed");
  });

  it("accepts the exact observe/unobserve commands", () => {
    for (const type of ["observe", "unobserve"]) {
      assert.equal(decodePrimeRpcEnvelope({ type, taskId: "sub-1" })._tag, "command");
    }
  });
});
