// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  ProviderDriverKind,
  type PrimeAgentSettings,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PrimeRpcClient } from "../prime/PrimeRpcClient.ts";
import {
  spawnPrimeRpcTransport,
} from "../prime/PrimeRpcProcessTransport.ts";
import { primeResourceLayout } from "../prime/PrimeResourceLayout.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const HANDSHAKE_TIMEOUT_MS = 5_000;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type SessionContext = {
  readonly key: string;
  readonly session: ProviderSession;
  readonly client: PrimeRpcClient;
  readonly transport: ReturnType<typeof spawnPrimeRpcTransport>;
};
type PendingStart = { readonly key: string; readonly promise: Promise<ProviderSession> };

export interface PrimeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: string;
  readonly home: string;
  readonly enabled: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly handshakeTimeoutMs?: number;
  readonly launch?: typeof spawnPrimeRpcTransport;
}

const startKey = (input: ProviderSessionStartInput, cwd: string) =>
  JSON.stringify({
    cwd,
    runtimeMode: input.runtimeMode,
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    model: input.modelSelection?.model,
    nativeIdentity: input.modelSelection?.nativeIdentity,
  });

const sanitizedEnvironment = (home: string, source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  const allowed = /^(?:PATH|PATHEXT|SystemRoot|WINDIR|ComSpec|LANG|LC_[A-Za-z0-9_]+)$/i;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.test(key)) result[key] = value;
  }
  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    TMPDIR: `${home}/tmp`,
    TMP: `${home}/tmp`,
    TEMP: `${home}/tmp`,
  };
};

export const makePrimeAdapter = (
  settings: PrimeAgentSettings,
  options: PrimeAdapterOptions,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const launch = options.launch ?? spawnPrimeRpcTransport;
    const sessions = new Map<ThreadId, SessionContext>();
    const pending = new Map<ThreadId, PendingStart>();
    let closed = false;

    const closeContext = async (context: SessionContext) => {
      context.client.close();
      await Promise.resolve(context.transport.close?.()).catch(() => undefined);
      await context.transport.terminal.catch(() => undefined);
    };

    const startOwned = async (
      input: ProviderSessionStartInput,
      cwd: string,
      key: string,
      timestamp: string,
    ): Promise<ProviderSession> => {
      const layout = primeResourceLayout({
        home: options.home,
        environmentId: options.environmentId,
        instanceId: options.instanceId,
        threadId: input.threadId,
      });
      await NodeFSP.mkdir(layout.session, { recursive: true, mode: 0o700 });
      const env = sanitizedEnvironment(layout.instance, options.environment ?? process.env);
      await NodeFSP.mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 });
      if (closed) throw new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "Prime Agent adapter is closed.",
      });
      const transport = launch(
        settings.binaryPath,
        ["--mode", "rpc", "--session-dir", layout.session],
        { cwd, env },
      );
      const client = new PrimeRpcClient(transport, {
        defaultTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        requestIdPrefix: "t3-prime-bootstrap",
      });
      try {
        const response = await client.command({ type: "get_state" });
        if (!response.success || response.command !== "get_state") throw new Error("get_state failed");
        if (closed) throw new Error("adapter closed during bootstrap");
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const context: SessionContext = { key, session, client, transport };
        sessions.set(input.threadId, context);
        void transport.terminal.then(() => {
          if (sessions.get(input.threadId) === context) sessions.delete(input.threadId);
        });
        return session;
      } catch (cause) {
        client.close();
        transport.close?.();
        await transport.terminal.catch(() => undefined);
        throw new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Prime Agent RPC readiness handshake failed.",
          cause,
        });
      }
    };

    const validateStart = async (input: ProviderSessionStartInput) => {
      if (!options.enabled) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "startSession", issue: "Prime Agent is disabled.",
      });
      if (closed) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "startSession", issue: "Prime Agent adapter is closed.",
      });
      if (input.provider !== undefined && input.provider !== PROVIDER) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "startSession", issue: "Provider does not match prime-agent.",
      });
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== options.instanceId)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER, operation: "startSession", issue: "Provider instance does not match adapter.",
        });
      if (input.resumeCursor !== undefined) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "startSession", issue: "Prime Agent resume is unavailable until Beta.",
      });
      if (!input.cwd || !isAbsolute(input.cwd)) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "startSession", issue: "An absolute workspace cwd is required.",
      });
      const stat = await NodeFSP.stat(input.cwd).catch(() => undefined);
      if (!stat?.isDirectory()) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "startSession", issue: "Workspace cwd must be an existing directory.",
      });
      return input.cwd;
    };

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      nowIso.pipe(
        Effect.flatMap((timestamp) =>
          Effect.tryPromise({
            try: async () => {
              const cwd = await validateStart(input);
              const key = startKey(input, cwd);
              const live = sessions.get(input.threadId);
              if (live) {
                if (live.key !== key) throw new ProviderAdapterValidationError({
                  provider: PROVIDER, operation: "startSession", issue: "Thread already has a different Prime session binding.",
                });
                return live.session;
              }
              const inFlight = pending.get(input.threadId);
              if (inFlight) {
                if (inFlight.key !== key) throw new ProviderAdapterValidationError({
                  provider: PROVIDER, operation: "startSession", issue: "Thread has a conflicting pending Prime start.",
                });
                return inFlight.promise;
              }
              const promise = startOwned(input, cwd, key, timestamp).finally(() => {
                if (pending.get(input.threadId)?.promise === promise) pending.delete(input.threadId);
              });
              pending.set(input.threadId, { key, promise });
              return promise;
            },
            catch: (cause) =>
              cause instanceof ProviderAdapterValidationError || cause instanceof ProviderAdapterProcessError
                ? cause
                : new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Prime Agent RPC process could not be started.",
                    cause,
                  }),
          }),
        ),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          await pending.get(threadId)?.promise.catch(() => undefined);
          const context = sessions.get(threadId);
          if (!context) return;
          sessions.delete(threadId);
          await closeContext(context);
        },
        catch: (cause) => new ProviderAdapterProcessError({
          provider: PROVIDER, threadId, detail: "Prime Agent RPC process did not stop cleanly.", cause,
        }),
      });

    const unsupported = (operation: string) => Effect.fail(new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation,
      issue: "This operation belongs to a later Prime Agent milestone.",
    }));

    const stopAll = () =>
      Effect.tryPromise({
        try: async () => {
          closed = true;
          await Promise.all(Array.from(pending.values(), (entry) => entry.promise.catch(() => undefined)));
          const contexts = Array.from(sessions.values());
          sessions.clear();
          await Promise.all(contexts.map(closeContext));
        },
        catch: (cause) => new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: ThreadId.make("adapter"),
          detail: "Prime Agent adapter teardown failed.",
          cause,
        }),
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn: () => unsupported("sendTurn"),
      interruptTurn: () => unsupported("interruptTurn"),
      respondToRequest: () => unsupported("respondToRequest"),
      respondToUserInput: () => unsupported("respondToUserInput"),
      stopSession,
      listSessions: () => Effect.succeed(Array.from(sessions.values(), ({ session }) => session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        sessions.has(threadId)
          ? unsupported("readThread")
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      rollbackThread: (threadId) =>
        sessions.has(threadId)
          ? unsupported("rollbackThread")
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      stopAll,
      streamEvents: Stream.empty,
    };
    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));
    return adapter;
  });
