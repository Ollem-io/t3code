// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

import { makePrimeAdapter } from "./PrimeAdapter.ts";
import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.T3_MARKER, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { state: "idle" } }) + "\n");
});
`;

const makeInput = (thread: string, cwd: string) => ({
  threadId: ThreadId.make(thread),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd,
  runtimeMode: "approval-required" as const,
});

describe("PrimeAdapter session bootstrap", () => {
  it("coalesces exact duplicate starts and records scoped argv/cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "prime-adapter-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const cwd = join(root, "workspace");
        yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.mkdir(cwd)));
        const binary = join(root, "fake.mjs");
        const marker = join(root, "marker.jsonl");
        yield* Effect.promise(async () => { await writeFile(binary, fakeSource); await chmod(binary, 0o755); });
        const adapter = yield* makePrimeAdapter(
          { binaryPath: binary },
          {
            instanceId: INSTANCE,
            environmentId: "env",
            home: join(root, "t3-home"),
            enabled: true,
            environment: { PATH: process.env.PATH },
            launch: (command, args, options) =>
              spawnPrimeRpcTransport(command, args, { ...(options ?? {}), env: { ...(options?.env ?? {}), T3_MARKER: marker } }),
          },
        );
          const input = makeInput("thread-a", cwd);
          const [a, b] = yield* Effect.all([adapter.startSession(input), adapter.startSession(input)], { concurrency: "unbounded" });
          assert.deepStrictEqual(a, b);
          assert.strictEqual((yield* adapter.listSessions()).length, 1);
          const records = (yield* Effect.promise(() => readFile(marker, "utf8"))).trim().split("\n").map((line) => JSON.parse(line));
          assert.strictEqual(records.length, 1);
          assert.strictEqual(records[0].cwd, cwd);
          assert.deepStrictEqual(records[0].argv.slice(0, 2), ["--mode", "rpc"]);
          assert.match(records[0].argv[3], /userdata\/prime\/v1/);
          yield* adapter.stopSession(input.threadId);
          assert.strictEqual(yield* adapter.hasSession(input.threadId), false);
      }),
    ),
  );

  it("rejects disabled and conflicting bindings without another child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "prime-adapter-disabled-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const adapter = yield* makePrimeAdapter(
          { binaryPath: "/missing" },
          { instanceId: INSTANCE, environmentId: "env", home: root, enabled: false },
        );
        const exit = yield* Effect.exit(adapter.startSession(makeInput("thread-b", root)));
        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual((yield* adapter.listSessions()).length, 0);
      }),
    ),
  );
});
