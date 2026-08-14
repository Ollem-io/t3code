// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ProviderDriverKind, type PrimeAgentSettings, type ProviderRuntimeEvent, type ProviderSession, type ProviderSessionStartInput, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProviderAdapterProcessError, ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PrimeRpcClient } from "../prime/PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { primeResourceLayout } from "../prime/PrimeResourceLayout.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const HANDSHAKE_TIMEOUT_MS = 5_000;
type Transport = ReturnType<typeof spawnPrimeRpcTransport>;
type PrimeSessionContext = { readonly session: ProviderSession; readonly client: PrimeRpcClient; readonly transport: Transport };
export interface PrimeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly handshakeTimeoutMs?: number;
  readonly enabled?: boolean;
  readonly now?: () => Promise<string>;
  readonly launch?: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Transport;
  readonly sessionRoot?: (input: { home: string; environmentId: string; instanceId: string; threadId: string }) => string;
  readonly environmentId?: string;
}
const defaultNow = () => Effect.runPromise(Clock.currentTimeMillis).then((n) => new Date(n).toISOString());
const inputKey = (input: ProviderSessionStartInput, cwd: string, instanceId: ProviderInstanceId) => JSON.stringify({ threadId: input.threadId, cwd, instanceId, runtimeMode: input.runtimeMode, model: input.modelSelection?.model, native: input.modelSelection?.nativeIdentity });

export function makePrimeAdapter(settings: PrimeAgentSettings, options: PrimeAdapterOptions) {
  return Effect.gen(function* () {
    const config = yield* ServerConfig;
    const envService = yield* ServerEnvironment;
    const environmentId = options.environmentId ?? (yield* envService.getEnvironmentId);
    const sessions = new Map<ThreadId, PrimeSessionContext>();
    const starts = new Map<ThreadId, { key: string; promise: Promise<ProviderSession>; transport?: Transport }>();
    let closed = false;
    const launch = options.launch ?? ((command, args, launchOptions) => spawnPrimeRpcTransport(command, args, launchOptions));
    const root = options.sessionRoot ?? ((x) => primeResourceLayout({ home: x.home, environmentId: x.environmentId, instanceId: x.instanceId, threadId: x.threadId }).session);
    const now = options.now ?? defaultNow;
    const cleanEnv = (home: string, session: string): NodeJS.ProcessEnv => {
      const out: NodeJS.ProcessEnv = {};
      for (const k of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME"]) if (process.env[k] !== undefined) out[k] = process.env[k];
      out.HOME = session; out.T3_HOME = home; out.T3_SERVER_HOME = home; return out;
    };
    const closeContext = async (c: PrimeSessionContext) => { c.client.close(); await Promise.resolve(c.transport.close?.()).catch(() => undefined); await c.transport.terminal.catch(() => undefined); };
    const startOwned = async (input: ProviderSessionStartInput, key: string, record: { transport?: Transport }) => {
      if (closed) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Adapter is closed." });
      if (input.provider !== undefined && input.provider !== PROVIDER) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Input provider does not match prime-agent." });
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== options.instanceId) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Input provider instance does not match adapter." });
      if (input.resumeCursor !== undefined) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Prime Agent sessions are not resumable yet." });
      const cwd = input.cwd ?? config.cwd;
      if (!isAbsolute(cwd)) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "cwd must be absolute." });
      const stat = await NodeFSP.stat(cwd).catch(() => undefined);
      if (!stat?.isDirectory()) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "cwd must be an existing directory." });
      const sessionDir = root({ home: config.baseDir, environmentId, instanceId: options.instanceId, threadId: input.threadId });
      await NodeFSP.mkdir(sessionDir, { recursive: true });
      if (closed) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Adapter is closed." });
      const transport = launch(settings.binaryPath, ["--mode", "rpc", "--session-dir", sessionDir], { cwd, env: options.environment ?? cleanEnv(config.baseDir, sessionDir) }); record.transport = transport;
      const client = new PrimeRpcClient(transport, { defaultTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS, requestIdPrefix: "t3-prime" });
      try {
        const state = await client.command({ type: "get_state" });
        if (!state.success) throw new Error("Prime Agent rejected get_state");
        if (closed) { await closeContext({ session: undefined as never, client, transport }); throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Adapter is closed." }); }
        const timestamp = await now();
        const session: ProviderSession = { provider: PROVIDER, providerInstanceId: options.instanceId, status: "ready", runtimeMode: input.runtimeMode, cwd, ...(input.modelSelection ? { model: input.modelSelection.model } : {}), threadId: input.threadId, createdAt: timestamp, updatedAt: timestamp };
        const context = { session, client, transport }; sessions.set(input.threadId, context);
        void transport.terminal.finally(() => { if (sessions.get(input.threadId) === context) sessions.delete(input.threadId); });
        return session;
      } catch (cause) { client.close(); await Promise.resolve(transport.close?.()).catch(() => undefined); await transport.terminal.catch(() => undefined); if (cause instanceof ProviderAdapterValidationError) throw cause; throw new ProviderAdapterProcessError({ provider: PROVIDER, threadId: input.threadId, detail: "Prime Agent RPC readiness handshake failed.", cause }); }
    };
    const startSession = (input: ProviderSessionStartInput) => Effect.tryPromise({ try: () => {
      if (options.enabled === false) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Prime Agent is disabled." });
      const cwd = input.cwd ?? config.cwd; const key = inputKey(input, cwd, options.instanceId); const existing = sessions.get(input.threadId); if (existing) { const prior = starts.get(input.threadId); if (prior && prior.key !== key) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Thread already has a different pending start." }); return Promise.resolve(existing.session); }
      const pending = starts.get(input.threadId); if (pending) { if (pending.key !== key) throw new ProviderAdapterValidationError({ provider: PROVIDER, operation: "startSession", issue: "Thread already has a different pending start." }); return pending.promise; }
      const record: { transport?: Transport } = {}; const promise = startOwned(input, key, record).finally(() => { if (starts.get(input.threadId)?.promise === promise) starts.delete(input.threadId); }); starts.set(input.threadId, { key, promise, transport: record.transport }); return promise;
    }, catch: (cause) => cause instanceof ProviderAdapterValidationError || cause instanceof ProviderAdapterProcessError ? cause : new ProviderAdapterProcessError({ provider: PROVIDER, threadId: input.threadId, detail: "Prime Agent RPC process could not be started.", cause }) });
    const stopSession = (threadId: ThreadId) => Effect.tryPromise({ try: async () => { const pending = starts.get(threadId); if (pending) { closed = closed; await pending.promise.catch(() => undefined); } const context = sessions.get(threadId); if (context) { sessions.delete(threadId); await closeContext(context); } }, catch: (cause) => new ProviderAdapterProcessError({ provider: PROVIDER, threadId, detail: "Prime Agent RPC process did not stop cleanly.", cause }) });
    const unsupported = (operation: string) => Effect.fail(new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue: "This Prime Agent operation is not implemented yet." }));
    const adapter = { provider: PROVIDER, capabilities: { sessionModelSwitch: "unsupported" as const }, startSession, sendTurn: () => unsupported("sendTurn"), interruptTurn: () => unsupported("interruptTurn"), respondToRequest: () => unsupported("respondToRequest"), respondToUserInput: () => unsupported("respondToUserInput"), stopSession, listSessions: () => Effect.succeed(Array.from(sessions.values(), (x) => x.session)), hasSession: (id: ThreadId) => Effect.succeed(sessions.has(id)), readThread: (id: ThreadId) => sessions.has(id) ? unsupported("readThread") : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: id })), rollbackThread: (id: ThreadId) => sessions.has(id) ? unsupported("rollbackThread") : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: id })), stopAll: () => Effect.tryPromise({ try: async () => { closed = true; const pending = [...starts.values()]; await Promise.all(pending.map((x) => x.promise.catch(() => undefined))); await Promise.all([...sessions.keys()].map((id) => Effect.runPromise(stopSession(id)))); }, catch: () => undefined }), streamEvents: Stream.empty as Stream.Stream<ProviderRuntimeEvent> } satisfies ProviderAdapterShape<any>;
    yield* Effect.addFinalizer(() => adapter.stopAll()); return adapter;
  });
}
