// @effect-diagnostics nodeBuiltinImport:off
// The fake runtime's command log is a plain JSON file on disk; reading it back
// is the assertion.
// @effect-diagnostics preferSchemaOverJson:off
// The adapter's error channel is exercised through its public shape here.
// @effect-diagnostics anyUnknownInErrorContext:off
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeExtensionId,
  ThreadId,
} from "@t3tools/contracts";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";

import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { makePrimeAdapter } from "./PrimeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");

/**
 * A fake Prime runtime that answers the naming and forking commands and appends
 * every command it received to a log on disk. The log is what proves the
 * adapter sent the exact native command — and, just as importantly, that it did
 * not send one when it refused.
 *
 * `msg-9!` is reported as a fork point the wire contract cannot brand: it must
 * never be offered and never be forked from.
 */
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.T3_FORK_LOG;
const reply = (command, data) =>
  process.stdout.write(
    JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n",
  );
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  appendFileSync(log, JSON.stringify(command) + "\\n");
  if (command.type === "get_state") return reply(command, { state: "idle" });
  if (command.type === "get_fork_messages" && process.env.T3_FORK_BAD === "1")
    return reply(command, { nonsense: true });
  if (command.type === "get_fork_messages")
    return reply(command, {
      messages: [
        { messageId: "msg-1", role: "user", preview: "Start the adapter" },
        { messageId: "msg-2", role: "assistant", preview: "Adapter drafted" },
        { messageId: "msg-9!", role: "user", preview: "Unbrandable" },
      ],
    });
  if (command.type === "fork" || command.type === "clone")
    return reply(command, { sessionId: "session-forked-1" });
  reply(command, {});
});
`;

const makeInput = (cwd: string, threadId: string) => ({
  threadId: ThreadId.make(threadId),
  provider: PROVIDER,
  providerInstanceId: INSTANCE,
  cwd,
  runtimeMode: "approval-required" as const,
});

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "prime-fork-")));
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const binary = join(root, "fake.mjs");
    await writeFile(binary, fakeSource);
    await chmod(binary, 0o755);
    const log = join(root, "commands.ndjson");
    await writeFile(log, "");
    return { root, cwd, binary, log };
  }),
  ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

const make = (f: { root: string; binary: string; log: string }, extra: NodeJS.ProcessEnv = {}) =>
  makePrimeAdapter(
    { binaryPath: f.binary },
    {
      instanceId: INSTANCE,
      environmentId: "env",
      home: join(f.root, "t3-home-fork"),
      enabled: true,
      environment: { PATH: process.env.PATH },
      launch: (command, args, options) =>
        spawnPrimeRpcTransport(command, args, {
          ...(options ?? {}),
          env: { ...(options?.env ?? {}), T3_FORK_LOG: f.log, ...extra },
        }),
    },
  );

const commands = (log: string) =>
  Effect.promise(async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) => JSON.parse(line) as { readonly type: string; readonly [key: string]: unknown },
      ),
  );

const run = (adapter: unknown, operation: Record<string, unknown>) =>
  (adapter as any).executeRuntimeOperation({
    threadId: ThreadId.make("thread-fork-source"),
    commandId: CommandId.make(randomUUID()),
    ...operation,
  }) as Effect.Effect<void, unknown>;

describe("PrimeAdapter session naming and forking", () => {
  it.effect("renames the live session with exactly the name it was given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f);
        yield* adapter.startSession(makeInput(f.cwd, "thread-fork-source"));
        yield* run(adapter, { type: "thread.rename", title: "Migration work" });

        const sent = yield* commands(f.log);
        assert.deepStrictEqual(
          sent.filter((command) => command.type === "set_session_name"),
          [
            {
              type: "set_session_name",
              name: "Migration work",
              id: sent.find((c) => c.type === "set_session_name")?.id,
            },
          ],
        );

        // A name T3 cannot set exactly is refused, and nothing reaches the
        // runtime: renaming a session to something other than what the user
        // typed is worse than saying no.
        const refused = yield* Effect.exit(
          run(adapter, { type: "thread.rename", title: "x".repeat(200) }),
        );
        assert.strictEqual(refused._tag, "Failure");
        assert.strictEqual(
          (yield* commands(f.log)).filter((command) => command.type === "set_session_name").length,
          1,
        );
      }),
    ),
  );

  it.effect("forks only from a point the runtime actually offers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f);
        yield* adapter.startSession(makeInput(f.cwd, "thread-fork-source"));
        // The page is read at session start, so the offer exists before any
        // client asks for it.
        assert.ok(
          (yield* commands(f.log)).some((command) => command.type === "get_fork_messages"),
          "the fork-point page was never read",
        );

        yield* run(adapter, {
          type: "thread.fork",
          forkThreadId: ThreadId.make("thread-forked"),
          forkPointId: RuntimeExtensionId.make("msg-2"),
        });
        assert.deepStrictEqual(
          (yield* commands(f.log))
            .filter((command) => command.type === "fork")
            .map((command) => command.messageId),
          ["msg-2"],
        );

        // An id the runtime reported but the contract cannot brand was never
        // offered, so it is not a fork target either.
        const unbrandable = yield* Effect.exit(
          run(adapter, {
            type: "thread.fork",
            forkThreadId: ThreadId.make("thread-forked-2"),
            forkPointId: RuntimeExtensionId.make("msg-9"),
          }),
        );
        assert.strictEqual(unbrandable._tag, "Failure");
        assert.strictEqual(
          (yield* commands(f.log)).filter((command) => command.type === "fork").length,
          1,
        );

        // The whole-session choice is a clone, not a fork from nothing.
        yield* run(adapter, {
          type: "thread.fork",
          forkThreadId: ThreadId.make("thread-cloned"),
        });
        assert.strictEqual(
          (yield* commands(f.log)).filter((command) => command.type === "clone").length,
          1,
        );
      }),
    ),
  );

  it.effect("keeps the session when the fork-point answer cannot be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f, { T3_FORK_BAD: "1" });
        // An optional probe answered in a shape this build does not recognize
        // must cost the fork page and nothing else: the session starts, and
        // everything that does not depend on fork points still works.
        const session = yield* adapter.startSession(makeInput(f.cwd, "thread-fork-source"));
        assert.strictEqual(session.status, "ready");
        yield* run(adapter, { type: "thread.rename", title: "Migration work" });
        assert.strictEqual(
          (yield* commands(f.log)).filter((command) => command.type === "set_session_name").length,
          1,
        );
        // ...and with no page, there is no fork point to offer or accept.
        const refused = yield* Effect.exit(
          run(adapter, {
            type: "thread.fork",
            forkThreadId: ThreadId.make("thread-forked-none"),
            forkPointId: RuntimeExtensionId.make("msg-2"),
          }),
        );
        assert.strictEqual(refused._tag, "Failure");
      }),
    ),
  );

  it.effect("hands the forked session to the thread it was made for, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const adapter = yield* make(f);
        yield* adapter.startSession(makeInput(f.cwd, "thread-fork-source"));
        yield* run(adapter, {
          type: "thread.fork",
          forkThreadId: ThreadId.make("thread-forked"),
        });

        yield* adapter.startSession(makeInput(f.cwd, "thread-forked"));
        const adopted = (yield* commands(f.log)).filter(
          (command) => command.type === "new_session",
        );
        assert.deepStrictEqual(
          adopted.map((command) => command.parentSession),
          ["session-forked-1"],
        );

        // The handoff is one-shot: an unrelated thread that starts afterwards
        // gets a fresh session, never somebody else's fork.
        yield* adapter.startSession(makeInput(f.cwd, "thread-unrelated"));
        assert.strictEqual(
          (yield* commands(f.log)).filter((command) => command.type === "new_session").length,
          1,
        );
      }),
    ),
  );
});
