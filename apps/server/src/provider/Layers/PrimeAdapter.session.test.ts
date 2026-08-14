// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";

import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { makePrimeAdapter } from "./PrimeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.T3_MARKER, JSON.stringify({ event: "start", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() }) + "\n");
process.on("exit", () => appendFileSync(process.env.T3_MARKER, JSON.stringify({ event: "exit", pid: process.pid }) + "\n"));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (process.env.T3_CRASH === "1") process.exit(17);
  if (process.env.T3_EVENTS === "1") { process.stdout.write(JSON.stringify({type:"turn_start"})+"\n"); process.stdout.write(JSON.stringify({type:"message_start",message:{role:"assistant"}})+"\n"); }
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { state: "idle" } }) + "\n"), Number(process.env.T3_DELAY || 0));
});
`;

const makeInput = (
  thread: string,
  cwd: string,
  runtimeMode: "approval-required" | "full-access" = "approval-required",
) => ({
  threadId: ThreadId.make(thread),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd,
  runtimeMode,
});

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-adapter-"));
    const cwd = join(root, "workspace");
    await import("node:fs/promises").then((fs) => fs.mkdir(cwd));
    const binary = join(root, "fake.mjs");
    const marker = join(root, "marker.jsonl");
    await writeFile(binary, fakeSource);
    await chmod(binary, 0o755);
    return { root, cwd, binary, marker };
  }),
  ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);
const records = (marker: string) =>
  Effect.promise(async () =>
    (await readFile(marker, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  );
const make = (
  f: { root: string; binary: string; marker: string },
  instanceId = INSTANCE,
  extra: NodeJS.ProcessEnv = {},
) =>
  makePrimeAdapter(
    { binaryPath: f.binary },
    {
      instanceId,
      environmentId: "env",
      home: join(f.root, `t3-home-${instanceId}`),
      enabled: true,
      environment: { PATH: process.env.PATH },
      launch: (command, args, options) =>
        spawnPrimeRpcTransport(command, args, {
          ...(options ?? {}),
          env: { ...(options?.env ?? {}), T3_MARKER: f.marker, ...extra },
        }),
    },
  );

const waitFor = (predicate: () => Promise<boolean>, timeoutMs = 3_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

describe("PrimeAdapter session bootstrap", () => {
  it("coalesces duplicate starts, isolates threads, and records owned argv/cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f);
        const input = makeInput("thread-a", f.cwd);
        const [a, b] = yield* Effect.all(
          [adapter.startSession(input), adapter.startSession(input)],
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(a, b);
        yield* adapter.startSession(makeInput("thread-b", f.cwd));
        assert.strictEqual((yield* adapter.listSessions()).length, 2);
        const started = (yield* records(f.marker)).filter((r) => r.event === "start");
        assert.strictEqual(started.length, 2);
        assert.ok(started.every((r) => r.cwd === f.cwd));
        assert.ok(
          started.every(
            (r) =>
              JSON.stringify(r.argv.slice(0, 3)) ===
              JSON.stringify(["--mode", "rpc", "--session-dir"]),
          ),
        );
        assert.ok(started.every((r) => /userdata\/prime\/v1/.test(r.argv[3])));
        yield* adapter.stopSession(input.threadId);
        assert.strictEqual(yield* adapter.hasSession(input.threadId), false);
        assert.strictEqual(yield* adapter.hasSession(ThreadId.make("thread-b")), true);
      }),
    ));

  it("rejects a conflicting in-flight binding without spawning another child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f, INSTANCE, { T3_DELAY: "150" });
        const first = Effect.forkChild(adapter.startSession(makeInput("thread-c", f.cwd)));
        yield* Effect.sleep("20 millis");
        const conflict = yield* Effect.exit(
          adapter.startSession(makeInput("thread-c", f.cwd, "full-access")),
        );
        assert.strictEqual(conflict._tag, "Failure");
        yield* Fiber.join(yield* first);
        assert.strictEqual((yield* records(f.marker)).filter((r) => r.event === "start").length, 1);
      }),
    ));

  it("isolates two instances and closes only children owned by the released scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const scopeA = yield* Scope.make();
        const scopeB = yield* Scope.make();
        const a = yield* Effect.provideService(
          make(f, ProviderInstanceId.make("prime_a")),
          Scope.Scope,
          scopeA,
        );
        const b = yield* Effect.provideService(
          make(f, ProviderInstanceId.make("prime_b")),
          Scope.Scope,
          scopeB,
        );
        yield* a.startSession({
          ...makeInput("thread-d", f.cwd),
          providerInstanceId: ProviderInstanceId.make("prime_a"),
        });
        yield* b.startSession({
          ...makeInput("thread-d", f.cwd),
          providerInstanceId: ProviderInstanceId.make("prime_b"),
        });
        const starts = (yield* records(f.marker)).filter((r) => r.event === "start");
        assert.strictEqual(starts.length, 2);
        yield* Scope.close(scopeA, Exit.void);
        yield* waitFor(
          async () =>
            (await Effect.runPromise(records(f.marker))).filter((r) => r.event === "exit").length >=
            1,
        );
        assert.strictEqual(yield* b.hasSession(ThreadId.make("thread-d")), true);
        yield* Scope.close(scopeB, Exit.void);
      }),
    ));

  it("removes a crashed child without affecting another live thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const stable = yield* make(f);
        yield* stable.startSession(makeInput("stable", f.cwd));
        const crashing = yield* make(f, ProviderInstanceId.make("prime_crash"), { T3_CRASH: "1" });
        const exit = yield* Effect.exit(
          crashing.startSession({
            ...makeInput("crash", f.cwd),
            providerInstanceId: ProviderInstanceId.make("prime_crash"),
          }),
        );
        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(yield* stable.hasSession(ThreadId.make("stable")), true);
      }),
    ));

  it("rejects disabled adapters without spawning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* makePrimeAdapter(
          { binaryPath: f.binary },
          { instanceId: INSTANCE, environmentId: "env", home: f.root, enabled: false },
        );
        assert.strictEqual(
          (yield* Effect.exit(adapter.startSession(makeInput("disabled", f.cwd))))._tag,
          "Failure",
        );
        assert.strictEqual((yield* adapter.listSessions()).length, 0);
      }),
    ));

  it("drains native events before explicit-stop terminal records", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f, INSTANCE, { T3_EVENTS: "1" });
        const eventsFiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(adapter.streamEvents, 5)),
        );
        const input = makeInput("ordered-stop", f.cwd);
        yield* adapter.startSession(input);
        yield* adapter.stopSession(input.threadId);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["turn.started", "item.started", "turn.completed", "runtime.error", "session.exited"],
        );
      }),
    ));
});
