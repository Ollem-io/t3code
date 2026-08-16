// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { makePrimeAdapter } from "./PrimeAdapter.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = ThreadId.make("extension-ui-thread");

/**
 * A real child process. Each prompt word deterministically produces one
 * fire-and-forget or blocking extension UI record, which is what makes the
 * mapping assertions below end-to-end rather than unit-shaped.
 */
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
const log=(x)=>appendFileSync(process.env.MARKER,JSON.stringify(x)+"\\n");
const models={models:[{id:"model",name:"Model",api:"api",provider:"provider",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:100,thinkingLevelMap:{}}]};
const out=x=>process.stdout.write(JSON.stringify(x)+"\\n");
const emit=x=>setTimeout(()=>out({type:"extension_ui_request",...x}),5);
createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{const c=JSON.parse(line);log(c);
 if(c.type==="get_available_models") return out({type:"response",id:c.id,command:c.type,success:true,data:models});
 out({type:"response",id:c.id,command:c.type,success:true,data:{state:"idle"}}); if(c.type!=="prompt") return; out({type:"turn_start"}); const m=c.message;
 if(m.includes("notify")){emit({id:"n-1",method:"notify",message:"Indexing failed",notifyType:"error"});}
 else if(m.includes("status")){emit({id:"s-1",method:"setStatus",statusKey:"index",statusText:"Indexing 40%"});emit({id:"s-2",method:"setStatus",statusKey:"index",statusText:"Indexing 90%"});}
 else if(m.includes("clear")){emit({id:"s-3",method:"setStatus",statusKey:"index",statusText:"Indexing 40%"});emit({id:"s-4",method:"setStatus",statusKey:"index"});}
 else if(m.includes("widget")){emit({id:"w-1",method:"setWidget",widgetKey:"tips",widgetLines:["one","two"],widgetPlacement:"aboveEditor"});}
 else if(m.includes("title")){emit({id:"t-1",method:"setTitle",title:"Refactor pass"});}
 else if(m.includes("editortext")){emit({id:"e-1",method:"set_editor_text",text:"npm test"});}
 else if(m.includes("flood")){for(let i=0;i<20;i++)emit({id:"f-"+i,method:"setStatus",statusKey:"k"+i,statusText:"line "+i});}
 else if(m.includes("future")){emit({id:"x-1",method:"quantumPrompt",title:"From the future"});}
 else if(m.includes("timeout")){emit({id:"to-1",method:"input",title:"Name",timeout:1});}
 else if(m.includes("hang")){emit({id:"h-1",method:"confirm",title:"Approve",message:"Run it?"});}
});`;

const setup = Effect.acquireRelease(
  Effect.promise(async () => {
    // Ownership recovery refuses to walk a symlinked path, and the system temp
    // directory is one on macOS. Resolve it so the fixture is a real directory
    // chain on every platform.
    const root = await mkdtemp(join(await realpath(tmpdir()), "prime-extension-ui-"));
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
const input = (f: Fixture) => ({
  threadId: THREAD,
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd: f.cwd,
  runtimeMode: "approval-required" as const,
});
const make = (f: Fixture) =>
  makePrimeAdapter(
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
const commands = (file: string) =>
  Effect.promise(async () =>
    (await readFile(file, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
const start = (f: Fixture) =>
  Effect.gen(function* () {
    const adapter = yield* make(f);
    yield* adapter.startSession(input(f));
    return adapter;
  });
type Adapter = ProviderAdapterShape<ProviderAdapterError>;
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

describe("PrimeAdapter extension UI status", () => {
  it.effect("maps a notification onto the bounded transient board, not the transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "notify");
        // Discovery publishes one catalog snapshot at session start; the turn
        // then produces exactly one status snapshot and no transcript row.
        const events = yield* collect(adapter, 3);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["session.commands.updated", "turn.started", "session.notices.updated"],
        );
        assert.deepStrictEqual(events[2].payload, {
          notices: [
            {
              key: "notification:error",
              kind: "notification",
              severity: "error",
              text: "Indexing failed",
            },
          ],
        });
        // Fire-and-forget: nothing is answered, so the runtime is never told a
        // notification was "cancelled".
        const sent = yield* commands(f.marker);
        assert.equal(sent.filter((c) => c.type === "extension_ui_response").length, 0);
      }),
    ),
  );

  it.effect("replaces a status by key instead of appending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "status");
        const events = yield* collect(adapter, 4);
        const boards = events
          .filter((event) => event.type === "session.notices.updated")
          .map((event) => event.payload.notices);
        assert.deepStrictEqual(
          boards.map((notices: any) => notices.length),
          [1, 1],
        );
        assert.equal(boards[1][0].text, "Indexing 90%");
        assert.equal(boards[1][0].key, "status:index");
      }),
    ),
  );

  it.effect("clears an entry when the runtime clears its own status text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "clear");
        const events = yield* collect(adapter, 4);
        const boards = events
          .filter((event) => event.type === "session.notices.updated")
          .map((event) => event.payload.notices);
        assert.deepStrictEqual(
          boards.map((notices: any) => notices.length),
          [1, 0],
        );
      }),
    ),
  );

  it.effect("maps widget, title, and suggested editor text as typed entries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const widgetAdapter = yield* start(f);
        yield* turn(widgetAdapter, "widget");
        const widget = (yield* collect(widgetAdapter, 3))[2].payload.notices[0];
        assert.deepStrictEqual(widget, {
          key: "widget:tips",
          kind: "widget",
          severity: "info",
          text: "one",
          lines: ["one", "two"],
        });
        yield* turn(widgetAdapter, "title");
        const title = (yield* collect(widgetAdapter, 2))[1].payload.notices.at(-1);
        assert.equal(title.kind, "title");
        assert.equal(title.text, "Refactor pass");
        yield* turn(widgetAdapter, "editortext");
        const editorText = (yield* collect(widgetAdapter, 2))[1].payload.notices.at(-1);
        assert.equal(editorText.kind, "editor-text");
        assert.equal(editorText.text, "npm test");
      }),
    ),
  );

  it.effect("bounds the board so a chatty extension cannot flood a client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "flood");
        const events = yield* collect(adapter, 22);
        const boards = events
          .filter((event) => event.type === "session.notices.updated")
          .map((event) => event.payload.notices);
        assert.equal(Math.max(...boards.map((notices: any) => notices.length)), 8);
        // Oldest out, newest kept: the last board ends with the last status.
        assert.equal(boards.at(-1).at(-1).text, "line 19");
      }),
    ),
  );

  // "Unsupported methods never hang": a method this build cannot decode fails
  // the session closed at the strict transport rather than parking a dialog
  // nobody can answer. The terminal sequence is the visible, truthful outcome.
  it.effect("fails closed on an extension UI method this build cannot decode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "future");
        const events = yield* collect(adapter, 5);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          [
            "session.commands.updated",
            "turn.started",
            "turn.completed",
            "runtime.error",
            "session.exited",
          ],
        );
        assert.equal(yield* adapter.hasSession(THREAD), false);
        // No answer is invented for a record whose correlation id was never
        // validated: T3 does not respond to something it could not decode.
        const sent = yield* commands(f.marker);
        assert.equal(sent.filter((c) => c.type === "extension_ui_response").length, 0);
      }),
    ),
  );

  it.effect("resolves a timed-out dialog truthfully instead of leaving it pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "timeout");
        const events = yield* collect(adapter, 5);
        assert.deepStrictEqual(
          events.map((event) => event.type),
          [
            "session.commands.updated",
            "turn.started",
            "user-input.requested",
            "user-input.resolved",
            "runtime.warning",
          ],
        );
        // Resolution says cancelled, never answered, and states the cause.
        assert.equal(events[3].payload.cancelled, true);
        assert.deepStrictEqual(events[3].payload.answers, {});
        assert.match(events[3].payload.reason, /timed out after 1s/);
        const sent = yield* commands(f.marker);
        assert.deepStrictEqual(sent.at(-1), {
          type: "extension_ui_response",
          id: "to-1",
          cancelled: true,
        });
      }),
    ),
  );

  it.effect("cancels a pending dialog when the session stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* start(f);
        yield* turn(adapter, "hang");
        const opened = yield* collect(adapter, 3);
        assert.equal(opened[2].type, "request.opened");
        const fiber = yield* Effect.forkChild(collect(adapter, 5));
        yield* adapter.stopSession(THREAD);
        const events = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          events.map((event: any) => event.type),
          [
            "request.resolved",
            "runtime.warning",
            "turn.completed",
            "runtime.error",
            "session.exited",
          ],
        );
        assert.equal(events[0].payload.decision, "cancel");
        assert.equal(yield* adapter.hasSession(THREAD), false);
      }),
    ),
  );

  it.effect("advertises the interaction capability so clients can gate the surface", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup;
        const adapter = yield* make(f);
        assert.equal(adapter.capabilities?.runtimeExtensions?.interactions, true);
      }),
    ),
  );
});
