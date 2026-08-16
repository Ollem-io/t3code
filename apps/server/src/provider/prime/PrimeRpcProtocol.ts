import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Runtime boundary for the subset of Prime Agent's 0.7.2 RPC protocol used by
 * the MVP. This deliberately models native JSON, not T3 provider contracts.
 */
export const PRIME_RPC_VERSION = "0.7.2" as const;

const RequestId = Schema.String;
const ThinkingLevelMapValue = Schema.Union([Schema.String, Schema.Null]);
const ThinkingLevelMap = Schema.Struct({
  off: Schema.optional(ThinkingLevelMapValue),
  minimal: Schema.optional(ThinkingLevelMapValue),
  low: Schema.optional(ThinkingLevelMapValue),
  medium: Schema.optional(ThinkingLevelMapValue),
  high: Schema.optional(ThinkingLevelMapValue),
  xhigh: Schema.optional(ThinkingLevelMapValue),
  max: Schema.optional(ThinkingLevelMapValue),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

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
  input: Schema.Array(Schema.Literals(["text", "image"])),
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
  }),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  thinkingLevelMap: Schema.optional(ThinkingLevelMap),
  featured: Schema.optional(Schema.Boolean),
  // Prime may serialize these optional compatibility settings for a model.
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  compat: Schema.optional(Schema.Unknown),
});

// Heartbeats and goal state arrive as bounded native snapshots, never as logs.
// As with the action and task stores, `onExcessProperty: error` keeps an
// unrecognized shape incompatible rather than silently reinterpreted.
const PrimeRpcHeartbeatEntry = Schema.Struct({
  heartbeatId: Schema.String.check(Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  intervalSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31_536_000 })),
  paused: Schema.optional(Schema.Boolean),
  nextRunAt: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
// The daemon may host schedules for other owners; T3 filters the store down to
// the ids it created, so this bound is a protocol guard, not an ownership one.
const PrimeRpcHeartbeatList = Schema.Array(PrimeRpcHeartbeatEntry).check(Schema.isMaxLength(64));
const PrimeRpcGoal = Schema.Struct({
  goalId: Schema.String.check(Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  status: Schema.Literals(["active", "completed", "cancelled"]),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const CommandEnvelope = Schema.Struct({ id: Schema.optional(RequestId), type: Schema.String });
export const PrimeRpcExtensionUiResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    cancelled: Schema.Literal(true),
  }),
]);
const PromptCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("prompt"),
  message: Schema.String,
  images: Schema.optional(Schema.Array(PrimeRpcImageInput)),
  streamingBehavior: Schema.optional(Schema.Literals(["steer", "followUp"])),
});
const QueuedPromptCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literals(["steer", "follow_up"]),
  message: Schema.String,
  images: Schema.optional(Schema.Array(PrimeRpcImageInput)),
});
const NoArgumentCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  // `get_session_stats`, `compact`, and `get_commands` are part of the
  // declaration-verified 0.7.2 command baseline; none takes arguments and none
  // is inferred from a response we merely observed.
  type: Schema.Literals([
    "abort",
    "get_state",
    "get_available_models",
    "get_session_stats",
    "compact",
    "get_commands",
  ]),
});
const NewSessionCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("new_session"),
  parentSession: Schema.optional(Schema.String),
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
  level: Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
/**
 * Observation attaches this environment to one task's output and detaches from
 * it again. Both take an exact runtime-owned task id; T3 never invents one and
 * never sends a daemon-wide variant of either command.
 */
const ObservationCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literals(["observe", "unobserve"]),
  taskId: Schema.String,
});
/**
 * Heartbeat lifecycle. Creation carries only a bounded label and an interval —
 * never a prompt body — and every other command takes an exact runtime-owned
 * heartbeat id that T3 created and recorded. There is no list-all variant here
 * on purpose: T3 has no business enumerating schedules it does not own.
 */
const HeartbeatCreateCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("heartbeat_create"),
  title: Schema.String,
  intervalSeconds: Schema.Int,
});
const HeartbeatTargetCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literals(["heartbeat_pause", "heartbeat_resume", "heartbeat_stop"]),
  heartbeatId: Schema.String,
});
const HeartbeatGetCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("heartbeat_get"),
});
/**
 * Naming and forking.
 *
 * `set_session_name` renames the live session; the runtime is the authority on
 * the name it accepted, so T3 re-reads rather than echoing what it sent.
 * `get_fork_messages` lists the points a fork may start from — identity and a
 * bounded label only, never message bodies. `fork` starts a new session from
 * one of those points and `clone` copies the whole session; both answer with
 * the new native session id, which is the only id T3 ever claims.
 */
const SetSessionNameCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("set_session_name"),
  name: Schema.String,
});
const GetForkMessagesCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("get_fork_messages"),
});
const ForkCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("fork"),
  messageId: Schema.String,
});
const CloneCommand = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("clone"),
});
export const PrimeRpcCommand = Schema.Union([
  ObservationCommand,
  HeartbeatCreateCommand,
  HeartbeatTargetCommand,
  HeartbeatGetCommand,
  SetSessionNameCommand,
  GetForkMessagesCommand,
  ForkCommand,
  CloneCommand,
  PromptCommand,
  QueuedPromptCommand,
  NoArgumentCommand,
  NewSessionCommand,
  SetModelCommand,
  SetThinkingLevelCommand,
  PrimeRpcExtensionUiResponse,
]);

export const PrimeRpcAvailableModelsResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.Literal("get_available_models"),
  success: Schema.Literal(true),
  data: Schema.Struct({ models: Schema.Array(PrimeRpcModel) }),
});
/**
 * `heartbeat_create` and `heartbeat_get` answer with the whole owned-relevant
 * store. Creation also names the id it just made, which is the only way T3
 * learns which heartbeat is its own — an id T3 never receives is an id T3 never
 * claims to own.
 */
export const PrimeRpcHeartbeatResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.Literals(["heartbeat_create", "heartbeat_get"]),
  success: Schema.Literal(true),
  data: Schema.Struct({
    heartbeatId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
    heartbeats: PrimeRpcHeartbeatList,
    resident: Schema.optional(Schema.Boolean),
  }),
});
/**
 * The fork-point list. Bounded at this untrusted boundary like every other
 * native store, and deliberately identity plus a short label: a fork chooser
 * does not need message bodies, so the protocol never carries them.
 */
const PrimeRpcForkMessage = Schema.Struct({
  messageId: Schema.String.check(Schema.isMaxLength(128)),
  role: Schema.Literals(["user", "assistant"]),
  preview: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/**
 * Deliberately validated by the adapter rather than routed at the envelope
 * boundary like the heartbeat store is. Naming and forking are an optional
 * extension probed at session start; a runtime whose answer this build cannot
 * read must cost the fork page, not the session the user is working in.
 */
export const PrimeRpcForkMessagesResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.Literal("get_fork_messages"),
  success: Schema.Literal(true),
  data: Schema.Struct({
    messages: Schema.Array(PrimeRpcForkMessage).check(Schema.isMaxLength(256)),
  }),
});
/**
 * `fork` and `clone` answer with the session they just made. T3 records that
 * id as its own; a creation that answers without one is not adopted.
 */
export const PrimeRpcForkResponse = Schema.Struct({
  id: Schema.optional(RequestId),
  type: Schema.Literal("response"),
  command: Schema.Literals(["fork", "clone"]),
  success: Schema.Literal(true),
  data: Schema.Struct({
    sessionId: Schema.String.check(Schema.isMaxLength(256)),
    name: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  }),
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
const PrimeRpcAvailableModelsResult = Schema.Union([
  PrimeRpcAvailableModelsResponse,
  FailureResponse,
]);
const PrimeRpcHeartbeatResult = Schema.Union([PrimeRpcHeartbeatResponse, FailureResponse]);
export const PrimeRpcResponse = Schema.Union([
  PrimeRpcAvailableModelsResponse,
  PrimeRpcHeartbeatResponse,
  SuccessResponse,
  FailureResponse,
]);

const AgentStartEvent = Schema.Struct({ type: Schema.Literal("agent_start") });
const AgentEndEvent = Schema.Struct({
  type: Schema.Literal("agent_end"),
  messages: Schema.Array(Schema.Unknown),
});
const TurnStartEvent = Schema.Struct({ type: Schema.Literal("turn_start") });
const TurnEndEvent = Schema.Struct({
  type: Schema.Literal("turn_end"),
  message: Schema.Unknown,
  toolResults: Schema.Array(Schema.Unknown),
});
const MessageStartEvent = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Unknown,
});
const MessageUpdateEvent = Schema.Struct({
  type: Schema.Literal("message_update"),
  message: Schema.Unknown,
  assistantMessageEvent: Schema.Unknown,
});
const MessageEndEvent = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Unknown,
});
const ToolExecutionStart = Schema.Struct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
});
const ToolExecutionUpdate = Schema.Struct({
  type: Schema.Literal("tool_execution_update"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.Unknown,
  partialResult: Schema.Unknown,
});
const ToolExecutionEnd = Schema.Struct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.Unknown,
  isError: Schema.Boolean,
});
// The 0.7.2 action store is a complete snapshot, not an action log. Bound it
// at this untrusted RPC boundary so a malformed native event cannot allocate
// an unbounded client-visible queue. `onExcessProperty: error` intentionally
// makes additions to this known event incompatible rather than silently using
// a shape whose semantics we have not established.
const PrimeRpcActionText = Schema.String.check(Schema.isMaxLength(4_096));
const PrimeRpcActionList = Schema.Array(PrimeRpcActionText).check(Schema.isMaxLength(32));
const PrimeRpcSessionActionSnapshot = Schema.Struct({
  queuedCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32 })),
  steering: PrimeRpcActionList,
  followUps: PrimeRpcActionList,
  active: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["turn", "session_command"]),
      phase: Schema.Literals(["preparing", "committing", "running"]),
      label: Schema.optional(PrimeRpcActionText),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
// Compaction and retry status arrive as bounded native status snapshots. As
// with the action store, `onExcessProperty: error` keeps an unrecognized shape
// incompatible rather than silently reinterpreted.
const CompactionUpdateEvent = Schema.Struct({
  type: Schema.Literal("compaction_update"),
  phase: Schema.Literals(["started", "completed", "failed", "cancelled"]),
  trigger: Schema.Literals(["manual", "automatic"]),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  // Prime legitimately reports no usage until it recomputes after compaction.
  usedTokens: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
  ),
  maxTokens: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000_000 })),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const RetryUpdateEvent = Schema.Struct({
  type: Schema.Literal("retry_update"),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
  maxAttempts: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const SessionActionUpdateEvent = Schema.Struct({
  type: Schema.Literal("session_action_update"),
  actions: PrimeRpcSessionActionSnapshot,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
// The 0.7.2 task store is a whole snapshot, not a task log. As with the action
// store it is bounded at this untrusted boundary, and `onExcessProperty: error`
// keeps an unrecognized shape incompatible rather than silently reinterpreted.
const PrimeRpcTaskEntry = Schema.Struct({
  taskId: Schema.String.check(Schema.isMaxLength(128)),
  // Absent means this is a root agent. Parentage is reported, never inferred.
  parentTaskId: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  status: Schema.Literals(["running", "paused", "completed", "cancelled", "failed"]),
  // Newest observed line for this task. Bounded here and clamped again on the way out.
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/**
 * Goal state is reported, never negotiated: 0.7.2 has no goal-change command,
 * so this event is the only goal surface and T3 keeps it read-only.
 */
const GoalUpdateEvent = Schema.Struct({
  type: Schema.Literal("goal_update"),
  goal: Schema.optional(PrimeRpcGoal),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/**
 * The whole heartbeat store plus whether the session is currently resident in
 * the daemon because of it. Residency is reported by the runtime rather than
 * inferred from the fact that a heartbeat exists.
 */
const HeartbeatUpdateEvent = Schema.Struct({
  type: Schema.Literal("heartbeat_update"),
  heartbeats: PrimeRpcHeartbeatList,
  resident: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
/**
 * The session's current name, reported whole. An absent name means the session
 * has none; T3 never invents one and never keeps a name the runtime dropped.
 */
const SessionNameUpdateEvent = Schema.Struct({
  type: Schema.Literal("session_name_update"),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const TaskUpdateEvent = Schema.Struct({
  type: Schema.Literal("task_update"),
  tasks: Schema.Array(PrimeRpcTaskEntry).check(Schema.isMaxLength(64)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const ExtensionUiRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("select"),
    title: Schema.String,
    options: Schema.Array(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("confirm"),
    title: Schema.String,
    message: Schema.String,
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("input"),
    title: Schema.String,
    placeholder: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("editor"),
    title: Schema.String,
    prefill: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("notify"),
    message: Schema.String,
    notifyType: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setStatus"),
    statusKey: Schema.String,
    statusText: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setWidget"),
    widgetKey: Schema.String,
    widgetLines: Schema.optional(Schema.Array(Schema.String)),
    widgetPlacement: Schema.optional(Schema.Literals(["aboveEditor", "belowEditor"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setTitle"),
    title: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("set_editor_text"),
    text: Schema.String,
  }),
]);
export const PrimeRpcKnownEvent = Schema.Union([
  AgentStartEvent,
  AgentEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  ToolExecutionStart,
  ToolExecutionUpdate,
  ToolExecutionEnd,
  ExtensionUiRequest,
  SessionActionUpdateEvent,
  CompactionUpdateEvent,
  RetryUpdateEvent,
  TaskUpdateEvent,
  GoalUpdateEvent,
  HeartbeatUpdateEvent,
  SessionNameUpdateEvent,
]);
export type PrimeRpcCommand = typeof PrimeRpcCommand.Type;
export type PrimeRpcResponse = typeof PrimeRpcResponse.Type;
export type PrimeRpcKnownEvent = typeof PrimeRpcKnownEvent.Type;
export type PrimeRpcForkMessagesResponse = typeof PrimeRpcForkMessagesResponse.Type;
export type PrimeRpcForkResponse = typeof PrimeRpcForkResponse.Type;
export type PrimeRpcForkMessage = PrimeRpcForkMessagesResponse["data"]["messages"][number];
export type PrimeRpcImageInput = typeof PrimeRpcImageInput.Type;
export type PrimeRpcModel = typeof PrimeRpcModel.Type;

export type PrimeRpcEnvelope =
  | { readonly _tag: "command"; readonly value: PrimeRpcCommand }
  | { readonly _tag: "response"; readonly value: PrimeRpcResponse }
  | { readonly _tag: "known-event"; readonly value: PrimeRpcKnownEvent }
  | {
      readonly _tag: "unknown-event";
      readonly type: string;
      readonly value: Record<string, unknown>;
    }
  | { readonly _tag: "malformed"; readonly error: PrimeRpcCompatibilityError };

/** A local protocol-boundary failure; raw records are intentionally not retained. */
export class PrimeRpcCompatibilityError extends Error {
  readonly _tag = "PrimeRpcCompatibilityError";
  readonly envelopeClass: "command" | "response" | "event" | "unknown";
  constructor(envelopeClass: "command" | "response" | "event" | "unknown") {
    super(`Prime Agent RPC ${PRIME_RPC_VERSION} ${envelopeClass} is incompatible`);
    this.envelopeClass = envelopeClass;
  }
}

const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A | undefined => {
  const result = Schema.decodeUnknownResult(schema)(value);
  return Result.isSuccess(result) ? result.success : undefined;
};

/** JSON has no undefined: exactly one response payload form is required. */
const isExclusiveExtensionUiResponse = (value: Record<string, unknown>): boolean => {
  const forms = [
    typeof value.value === "string",
    typeof value.confirmed === "boolean",
    value.cancelled === true,
  ];
  return forms.filter(Boolean).length === 1;
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
    const response =
      object.command === "get_available_models"
        ? decode(PrimeRpcAvailableModelsResult, value)
        : object.command === "heartbeat_create" || object.command === "heartbeat_get"
          ? decode(PrimeRpcHeartbeatResult, value)
          : decode(PrimeRpcResponse, value);
    return response
      ? { _tag: "response", value: response }
      : { _tag: "malformed", error: new PrimeRpcCompatibilityError("response") };
  }
  if (envelope.type === "extension_ui_response") {
    const command = decode(PrimeRpcExtensionUiResponse, value);
    return command && isExclusiveExtensionUiResponse(object)
      ? { _tag: "command", value: command }
      : { _tag: "malformed", error: new PrimeRpcCompatibilityError("command") };
  }
  const command = decode(PrimeRpcCommand, value);
  if (command) return { _tag: "command", value: command };
  const event = decode(PrimeRpcKnownEvent, value);
  if (event) return { _tag: "known-event", value: event };
  const knownCommandTypes = new Set([
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "get_state",
    "get_available_models",
    "new_session",
    "set_model",
    "set_thinking_level",
    "get_session_stats",
    "compact",
    "get_commands",
    "observe",
    "unobserve",
    "heartbeat_create",
    "heartbeat_get",
    "heartbeat_pause",
    "heartbeat_resume",
    "heartbeat_stop",
    "set_session_name",
    "get_fork_messages",
    "fork",
    "clone",
  ]);
  const knownEventTypes = new Set([
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "extension_ui_request",
    "session_action_update",
    "compaction_update",
    "retry_update",
    "task_update",
    "goal_update",
    "heartbeat_update",
    "session_name_update",
  ]);
  if (knownCommandTypes.has(envelope.type))
    return { _tag: "malformed", error: new PrimeRpcCompatibilityError("command") };
  if (knownEventTypes.has(envelope.type))
    return { _tag: "malformed", error: new PrimeRpcCompatibilityError("event") };
  return { _tag: "unknown-event", type: envelope.type, value: object };
};
