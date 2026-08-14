// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TEXT_ATTACHMENT_BYTES,
  ProviderDriverKind,
  type PrimeAgentSettings,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  ThreadId,
  TurnId,
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
  selectedModel: { readonly provider: string; readonly modelId: string } | undefined;
  thinkingLevel: string | undefined;
};
type PendingStart = { readonly key: string; readonly promise: Promise<ProviderSession> };

export interface PrimeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: string;
  readonly home: string;
  readonly enabled: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly attachmentsDir?: string;
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

const threadAttachmentPrefix = (threadId: ThreadId) => threadId
  .trim().toLowerCase().replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-")
  .replace(/^[-_]+|[-_]+$/g, "").slice(0, 80).replace(/[-_]+$/g, "");

const resolvePrimeAttachmentPath = (
  attachmentsDir: string,
  threadId: ThreadId,
  attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
) => {
  const prefix = threadAttachmentPrefix(threadId);
  const match = attachment.id.toLowerCase().match(/^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  if (!prefix || match?.[1] !== prefix) return undefined;
  const allowed = attachment.type === "image"
    ? new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"])
    : new Set([".txt", ".md", ".log", ".json", ".xml", ".csv", ".yaml", ".yml", ".js", ".ts"]);
  const extension = extname(attachment.name).toLowerCase();
  const selected = allowed.has(extension) ? extension : attachment.type === "image" ? undefined : ".txt";
  if (!selected) return undefined;
  const root = resolve(attachmentsDir);
  const path = resolve(root, `${attachment.id}${selected}`);
  return path.startsWith(`${root}${sep}`) ? path : undefined;
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
        const context: SessionContext = {
          key, session, client, transport, selectedModel: undefined, thinkingLevel: undefined,
        };
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

    const requireContext = (threadId: ThreadId): SessionContext => {
      const context = sessions.get(threadId);
      if (!context) throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      return context;
    };

    const expectSuccess = async (context: SessionContext, command: Parameters<PrimeRpcClient["command"]>[0]) => {
      const response = await context.client.command(command);
      if (!response.success || response.command !== command.type) throw new Error(`${command.type} failed`);
    };

    const resolveTurnInput = async (input: ProviderSendTurnInput, context: SessionContext) => {
      if (!input.input && (input.attachments?.length ?? 0) === 0) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "sendTurn", issue: "A prompt or attachment is required.",
      });
      if (!input.modelSelection || input.modelSelection.instanceId !== options.instanceId) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "sendTurn", issue: "A Prime model selection for this instance is required.",
      });
      const modelsResponse = await context.client.command({ type: "get_available_models" });
      if (!modelsResponse.success || modelsResponse.command !== "get_available_models" ||
          !modelsResponse.data || typeof modelsResponse.data !== "object" || !("models" in modelsResponse.data)) {
        throw new Error("get_available_models failed");
      }
      const models = (modelsResponse.data as { models: ReadonlyArray<{
        id: string; provider: string; input: ReadonlyArray<"text" | "image">;
        thinkingLevelMap?: Readonly<Record<string, string | null>>;
      }> }).models;
      let identity = input.modelSelection.nativeIdentity;
      if (!identity) {
        const matching = models.filter((model) => model.id === input.modelSelection!.model);
        if (matching.length !== 1) throw new ProviderAdapterValidationError({
          provider: PROVIDER, operation: "sendTurn", issue: "Legacy model selection is unavailable or ambiguous; reselect the model.",
        });
        identity = { provider: matching[0]!.provider, modelId: matching[0]!.id };
      }
      const model = models.find((candidate) => candidate.provider === identity.provider && candidate.id === identity.modelId);
      if (!model) throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "sendTurn", issue: "Selected Prime model is unavailable; reselect the model.",
      });
      const textParts = input.input ? [input.input] : [];
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      for (const attachment of input.attachments ?? []) {
        if (!options.attachmentsDir) throw new ProviderAdapterValidationError({
          provider: PROVIDER, operation: "sendTurn", issue: `Attachment '${attachment.name}' cannot be resolved.`,
        });
        const path = resolvePrimeAttachmentPath(options.attachmentsDir, input.threadId, attachment);
        if (!path) throw new ProviderAdapterValidationError({
          provider: PROVIDER, operation: "sendTurn", issue: `Attachment '${attachment.name}' has an invalid id.`,
        });
        const stat = await NodeFSP.stat(path).catch(() => undefined);
        const limit = attachment.type === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_TEXT_ATTACHMENT_BYTES;
        if (!stat?.isFile() || stat.size !== attachment.sizeBytes || stat.size > limit) throw new ProviderAdapterValidationError({
          provider: PROVIDER, operation: "sendTurn", issue: `Attachment '${attachment.name}' is missing, unreadable, or oversized.`,
        });
        const bytes = await NodeFSP.readFile(path);
        if (attachment.type === "image") {
          if (!model.input.includes("image")) throw new ProviderAdapterValidationError({
            provider: PROVIDER, operation: "sendTurn", issue: `Model '${input.modelSelection.model}' does not support image attachment '${attachment.name}'.`,
          });
          images.push({ type: "image", data: bytes.toString("base64"), mimeType: attachment.mimeType });
        } else {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          textParts.push(`Attachment: ${attachment.name} (${attachment.mimeType})\n---\n${decoded}\n---`);
        }
      }
      const thinking = input.modelSelection.options?.find((option) => option.id === "thinkingLevel")?.value;
      if (thinking !== undefined && typeof thinking !== "string") throw new ProviderAdapterValidationError({
        provider: PROVIDER, operation: "sendTurn", issue: "Prime thinkingLevel must be a string.",
      });
      if (thinking !== undefined && (!model.thinkingLevelMap || !(thinking in model.thinkingLevelMap) || model.thinkingLevelMap[thinking] === null)) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER, operation: "sendTurn", issue: `Thinking level '${thinking}' is unavailable for the selected model.`,
        });
      }
      return { identity, thinking, message: textParts.join("\n\n"), images };
    };

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const context = requireContext(input.threadId);
          const resolved = await resolveTurnInput(input, context);
          if (!context.selectedModel || context.selectedModel.provider !== resolved.identity.provider || context.selectedModel.modelId !== resolved.identity.modelId) {
            await expectSuccess(context, { type: "set_model", provider: resolved.identity.provider, modelId: resolved.identity.modelId });
            context.selectedModel = resolved.identity;
          }
          if (resolved.thinking !== undefined && context.thinkingLevel !== resolved.thinking) {
            await expectSuccess(context, { type: "set_thinking_level", level: resolved.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" });
            context.thinkingLevel = resolved.thinking;
          }
          await expectSuccess(context, {
            type: "prompt", message: resolved.message,
            ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
          });
          return { threadId: input.threadId, turnId: TurnId.make(randomUUID()) };
        },
        catch: (cause) => cause instanceof ProviderAdapterValidationError || cause instanceof ProviderAdapterSessionNotFoundError
          ? cause : new ProviderAdapterProcessError({ provider: PROVIDER, threadId: input.threadId, detail: "Prime Agent turn input failed.", cause }),
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
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
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
