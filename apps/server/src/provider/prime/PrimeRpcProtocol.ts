import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

/**
 * Runtime boundary for the subset of Prime Agent's 0.7.2 RPC protocol used by
 * the MVP. This deliberately models native JSON, not T3 provider contracts.
 */
export const PRIME_RPC_VERSION = "0.7.2" as const;

const RequestId = Schema.String;
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

export const PrimeRpcImageInput = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

export const PrimeRpcModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  api: Schema.String,
  provider: Schema.String,
  baseUrl: Schema.String,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.Literal("text", "image")),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  thinkingLevelMap: Schema.optional(JsonObject),
  featured: Schema.optional(Schema.Boolean),
});

const CommandEnvelope = Schema.Struct({ id: Schema.optional(RequestId), type: Schema.String });
export const PrimeRpcExtensionUiResponse = Schema.Struct({
  type: Schema.Literal("extension_ui_response"),
  id: Schema.String,
  value: Schema.optional(Schema.String),
  confirmed: Schema.optional(Schema.Boolean),
  cancelled: Schema.optional(Schema.Literal(true)),
});
const PromptCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("prompt", "steer", "follow_up"),
  message: Schema.String,
  images: Schema.optional(Schema.Array(PrimeRpcImageInput)),
  streamingBehavior: Schema.optional(Schema.Literal("steer", "followUp")),
});
const NoArgumentCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("abort", "get_state", "get_available_models", "new_session"),
});
const SetModelCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("set_model"),
  provider: Schema.String,
  modelId: Schema.String,
});
const SetThinkingLevelCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("set_thinking_level"),
  level: Schema.Literal("off", "minimal", "low", "medium", "high", "xhigh"),
});
export const PrimeRpcCommand = Schema.Union(
  PromptCommand,
  NoArgumentCommand,
  SetModelCommand,
  SetThinkingLevelCommand,
  PrimeRpcExtensionUiResponse,
);

export const PrimeRpcAvailableModelsResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.Literal("get_available_models"),
  success: Schema.Literal(true),
  data: Schema.Struct({ models: Schema.Array(PrimeRpcModel) }),
});
const SuccessResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Literal(true),
  data: Schema.optional(Schema.Unknown),
});
const FailureResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Literal(false),
  error: Schema.String,
});
export const PrimeRpcResponse = Schema.Union(
  PrimeRpcAvailableModelsResponse,
  SuccessResponse,
  FailureResponse,
);

const AgentStartEvent = Schema.Struct({ type: Schema.Literal("agent_start") });
const AgentEndEvent = Schema.Struct({ type: Schema.Literal("agent_end"), messages: Schema.Array(Schema.Unknown) });
const TurnStartEvent = Schema.Struct({ type: Schema.Literal("turn_start") });
const TurnEndEvent = Schema.Struct({
  type: Schema.Literal("turn_end"),
  message: Schema.Unknown,
  toolResults: Schema.Array(Schema.Unknown),
});
const MessageEvent = Schema.Struct({
  type: Schema.Literal("message_start", "message_update", "message_end"),
  message: Schema.Unknown,
  assistantMessageEvent: Schema.optional(Schema.Unknown),
});
const ToolExecutionStart = Schema.Struct({ type: Schema.Literal("tool_execution_start"), toolCallId: Schema.String, toolName: Schema.String, args: Schema.Unknown });
const ToolExecutionUpdate = Schema.Struct({ type: Schema.Literal("tool_execution_update"), toolCallId: Schema.String, toolName: Schema.String, args: Schema.Unknown, partialResult: Schema.Unknown });
const ToolExecutionEnd = Schema.Struct({ type: Schema.Literal("tool_execution_end"), toolCallId: Schema.String, toolName: Schema.String, args: Schema.Unknown, result: Schema.Unknown, isError: Schema.Boolean });
const ExtensionUiRequest = Schema.Union(
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("select"), title: Schema.String, options: Schema.Array(Schema.String), timeout: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("confirm"), title: Schema.String, message: Schema.String, timeout: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("input"), title: Schema.String, placeholder: Schema.optional(Schema.String), timeout: Schema.optional(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("editor"), title: Schema.String, prefill: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("notify"), message: Schema.String, notifyType: Schema.optional(Schema.Literal("info", "warning", "error")) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("setStatus"), statusKey: Schema.String, statusText: Schema.UndefinedOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("setWidget"), widgetKey: Schema.String, widgetLines: Schema.UndefinedOr(Schema.Array(Schema.String)), widgetPlacement: Schema.optional(Schema.Literal("aboveEditor", "belowEditor")) }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("setTitle"), title: Schema.String }),
  Schema.Struct({ type: Schema.Literal("extension_ui_request"), id: Schema.String, method: Schema.Literal("set_editor_text"), text: Schema.String }),
);
export const PrimeRpcKnownEvent = Schema.Union(
  AgentStartEvent,
  AgentEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  MessageEvent,
  ToolExecutionStart,
  ToolExecutionUpdate,
  ToolExecutionEnd,
  ExtensionUiRequest,
);
export type PrimeRpcCommand = typeof PrimeRpcCommand.Type;
export type PrimeRpcResponse = typeof PrimeRpcResponse.Type;
export type PrimeRpcKnownEvent = typeof PrimeRpcKnownEvent.Type;
export type PrimeRpcImageInput = typeof PrimeRpcImageInput.Type;
export type PrimeRpcModel = typeof PrimeRpcModel.Type;

export type PrimeRpcEnvelope =
  | { readonly _tag: "command"; readonly value: PrimeRpcCommand }
  | { readonly _tag: "response"; readonly value: PrimeRpcResponse }
  | { readonly _tag: "known-event"; readonly value: PrimeRpcKnownEvent }
  | { readonly _tag: "unknown-event"; readonly type: string; readonly value: Record<string, unknown> }
  | { readonly _tag: "malformed"; readonly error: PrimeRpcCompatibilityError };

/** A local protocol-boundary failure; raw records are intentionally not retained. */
export class PrimeRpcCompatibilityError extends Error {
  readonly _tag = "PrimeRpcCompatibilityError";
  constructor(readonly envelopeClass: "command" | "response" | "event" | "unknown") {
    super(`Prime Agent RPC ${PRIME_RPC_VERSION} ${envelopeClass} is incompatible`);
  }
}

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown): A | undefined => {
  const result = Schema.decodeUnknownEither(schema)(value);
  return Either.isRight(result) ? result.right : undefined;
};

/** Classifies untrusted parsed JSON without throwing on new event types. */
export const decodePrimeRpcEnvelope = (value: unknown): PrimeRpcEnvelope => {
  const envelope = decode(CommandEnvelope, value);
  if (!envelope || !value || typeof value !== "object" || Array.isArray(value)) {
    return { _tag: "malformed", error: new PrimeRpcCompatibilityError("unknown") };
  }
  const object = value as Record<string, unknown>;
  if (envelope.type === "response") {
    // Command-specific data is validated before the generic response envelope.
    const response = object.command === "get_available_models"
      ? decode(PrimeRpcAvailableModelsResponse, value)
      : decode(PrimeRpcResponse, value);
    return response
      ? { _tag: "response", value: response }
      : { _tag: "malformed", error: new PrimeRpcCompatibilityError("response") };
  }
  if (envelope.type === "extension_ui_response") {
    const command = decode(PrimeRpcExtensionUiResponse, value);
    return command
      ? { _tag: "command", value: command }
      : { _tag: "malformed", error: new PrimeRpcCompatibilityError("command") };
  }
  const command = decode(PrimeRpcCommand, value);
  if (command) return { _tag: "command", value: command };
  const event = decode(PrimeRpcKnownEvent, value);
  if (event) return { _tag: "known-event", value: event };
  if (typeof object.type === "string") return { _tag: "unknown-event", type: object.type, value: object };
  return { _tag: "malformed", error: new PrimeRpcCompatibilityError("event") };
};
