import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceId, DEFAULT_PRIME_AGENT_SETTINGS } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { makePrimeAdapter } from "./PrimeAdapter.ts";

describe("PrimeAdapter session bootstrap", () => {
  it("validates launch configuration and coalesces duplicate starts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prime-cwd-")); const base = await mkdtemp(join(tmpdir(), "prime-base-"));
    let count = 0;
    const transport = { terminal: Promise.resolve({ kind: "exit" as const, code: 0 }), close: () => undefined, write: async () => undefined, stdout: new (await import("node:stream")).PassThrough(), stderr: new (await import("node:stream")).PassThrough() } as any;
    const adapter = await Effect.runPromise(makePrimeAdapter(DEFAULT_PRIME_AGENT_SETTINGS, { instanceId: ProviderInstanceId.make("x"), environmentId: "e", now: async () => "2020-01-01T00:00:00.000Z", launch: () => { count++; return transport; } }).pipe(Effect.provide(Layer.succeed(ServerConfig, { cwd, baseDir: base } as any))));
    expect((await Promise.all([Effect.runPromise(adapter.startSession({ threadId: "t" as any, runtimeMode: "web" })), Effect.runPromise(adapter.startSession({ threadId: "t" as any, runtimeMode: "web" }))]))[0]).toEqual((await Effect.runPromise(adapter.listSessions()))[0]); expect(count).toBe(1); await Effect.runPromise(adapter.stopAll());
  });
});
