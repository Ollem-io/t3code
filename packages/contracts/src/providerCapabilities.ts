/**
 * Provider-neutral, opt-in runtime-extension vocabulary.
 *
 * This module is deliberately contract-only: advertising a capability is not
 * an implementation promise, and a missing flag is always unsupported.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const ErrorCode = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/),
);

export const RuntimeExtensionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/),
).pipe(Schema.brand("RuntimeExtensionId"));
export type RuntimeExtensionId = typeof RuntimeExtensionId.Type;
export const FollowUpId = RuntimeExtensionId.pipe(Schema.brand("FollowUpId"));
export type FollowUpId = typeof FollowUpId.Type;
export const CompactionId = RuntimeExtensionId.pipe(Schema.brand("CompactionId"));
export type CompactionId = typeof CompactionId.Type;
export const InteractionId = RuntimeExtensionId.pipe(Schema.brand("InteractionId"));
export type InteractionId = typeof InteractionId.Type;
export const GoalId = RuntimeExtensionId.pipe(Schema.brand("GoalId"));
export type GoalId = typeof GoalId.Type;
export const HeartbeatId = RuntimeExtensionId.pipe(Schema.brand("HeartbeatId"));
export type HeartbeatId = typeof HeartbeatId.Type;

/** Independent flags; no umbrella flag may accidentally enable an operation. */
export const ProviderRuntimeCapabilities = Schema.Struct({
  /** Steering interrupts at the next model boundary; independent from follow-up queueing. */
  steer: Schema.optional(Schema.Boolean),
  /** Queue-after-run. */
  followUps: Schema.optional(Schema.Boolean),
  /** Cancellation is independent: some native runtimes expose enqueue but no action-id cancellation RPC. */
  followUpCancel: Schema.optional(Schema.Boolean),
  compaction: Schema.optional(Schema.Boolean),
  /** Cancellation is independent: a runtime may start compaction with no cancel RPC. */
  compactionCancel: Schema.optional(Schema.Boolean),
  commandDiscovery: Schema.optional(Schema.Boolean),
  interactions: Schema.optional(Schema.Boolean),
  tasks: Schema.optional(Schema.Boolean),
  goals: Schema.optional(Schema.Boolean),
  namingAndForking: Schema.optional(Schema.Boolean),
  usageAndRetry: Schema.optional(Schema.Boolean),
});
export type ProviderRuntimeCapabilities = typeof ProviderRuntimeCapabilities.Type;
export type ProviderRuntimeCapability = keyof ProviderRuntimeCapabilities;
export const EMPTY_PROVIDER_RUNTIME_CAPABILITIES: ProviderRuntimeCapabilities = {};

const OperationBase = { commandId: CommandId, threadId: ThreadId };
const FollowUpBase = { ...OperationBase, followUpId: FollowUpId };
const SteerBase = { ...OperationBase, steerId: FollowUpId };

export const ProviderRuntimeOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("steer.add"), ...SteerBase, text: Text }),
  Schema.Struct({ type: Schema.Literal("follow-up.add"), ...FollowUpBase, text: Text }),
  Schema.Struct({ type: Schema.Literal("follow-up.edit"), ...FollowUpBase, text: Text }),
  Schema.Struct({
    type: Schema.Literal("follow-up.reorder"),
    ...FollowUpBase,
    position: NonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literal("follow-up.cancel"), ...FollowUpBase }),
  Schema.Struct({
    type: Schema.Literal("follow-up.reverse"),
    ...FollowUpBase,
    targetCommandId: CommandId,
  }),
  Schema.Struct({
    type: Schema.Literal("compaction.request"),
    ...OperationBase,
    compactionId: CompactionId,
    reason: Schema.optional(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction.cancel"),
    ...OperationBase,
    compactionId: CompactionId,
  }),
  Schema.Struct({
    type: Schema.Literal("compaction.reverse"),
    ...OperationBase,
    compactionId: CompactionId,
    targetCommandId: CommandId,
  }),
  Schema.Struct({
    type: Schema.Literal("command.discover"),
    ...OperationBase,
    query: Schema.optional(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("command.invoke"),
    ...OperationBase,
    commandName: ShortText,
    input: Schema.optional(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("skill.discover"),
    ...OperationBase,
    query: Schema.optional(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("skill.invoke"),
    ...OperationBase,
    skillName: ShortText,
    input: Schema.optional(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("interaction.respond"),
    ...OperationBase,
    interactionId: InteractionId,
    choiceId: Schema.optional(ShortText),
    input: Schema.optional(Text),
  }).check(
    Schema.makeFilter(
      (value) =>
        value.choiceId !== undefined ||
        value.input !== undefined ||
        "choiceId or input is required",
    ),
  ),
  Schema.Struct({
    type: Schema.Literal("interaction.cancel"),
    ...OperationBase,
    interactionId: InteractionId,
  }),
  Schema.Struct({ type: Schema.Literal("task.observe"), ...OperationBase, taskId: RuntimeTaskId }),
  Schema.Struct({ type: Schema.Literal("task.cancel"), ...OperationBase, taskId: RuntimeTaskId }),
  Schema.Struct({ type: Schema.Literal("task.pause"), ...OperationBase, taskId: RuntimeTaskId }),
  Schema.Struct({ type: Schema.Literal("task.resume"), ...OperationBase, taskId: RuntimeTaskId }),
  Schema.Struct({
    type: Schema.Literal("goal.create"),
    ...OperationBase,
    goalId: GoalId,
    title: ShortText,
    detail: Schema.optional(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("goal.update"),
    ...OperationBase,
    goalId: GoalId,
    title: Schema.optional(ShortText),
    detail: Schema.optional(Text),
  }),
  Schema.Struct({ type: Schema.Literal("goal.delete"), ...OperationBase, goalId: GoalId }),
  Schema.Struct({
    type: Schema.Literal("goal.reverse"),
    ...OperationBase,
    goalId: GoalId,
    targetCommandId: CommandId,
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat.create"),
    ...OperationBase,
    heartbeatId: HeartbeatId,
    intervalSeconds: NonNegativeInt,
    title: ShortText,
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat.update"),
    ...OperationBase,
    heartbeatId: HeartbeatId,
    intervalSeconds: Schema.optional(NonNegativeInt),
    title: Schema.optional(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat.pause"),
    ...OperationBase,
    heartbeatId: HeartbeatId,
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat.resume"),
    ...OperationBase,
    heartbeatId: HeartbeatId,
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat.delete"),
    ...OperationBase,
    heartbeatId: HeartbeatId,
  }),
  Schema.Struct({
    type: Schema.Literal("heartbeat.reverse"),
    ...OperationBase,
    heartbeatId: HeartbeatId,
    targetCommandId: CommandId,
  }),
  Schema.Struct({ type: Schema.Literal("thread.rename"), ...OperationBase, title: ShortText }),
  Schema.Struct({
    type: Schema.Literal("thread.fork"),
    ...OperationBase,
    sourceTurnId: Schema.optional(TurnId),
    title: Schema.optional(ShortText),
  }),
  Schema.Struct({
    type: Schema.Literal("usage.snapshot.retry"),
    ...OperationBase,
    requestId: RuntimeRequestId,
  }),
]);
export type ProviderRuntimeOperation = typeof ProviderRuntimeOperation.Type;

/** The one authoritative operation-to-capability gate. */
export function capabilityForRuntimeOperation(
  operation: Pick<ProviderRuntimeOperation, "type">,
): ProviderRuntimeCapability {
  if (operation.type.startsWith("steer.")) return "steer";
  if (operation.type === "follow-up.cancel") return "followUpCancel";
  if (operation.type.startsWith("follow-up.")) return "followUps";
  if (operation.type === "compaction.cancel") return "compactionCancel";
  if (operation.type.startsWith("compaction.")) return "compaction";
  if (operation.type.startsWith("command.") || operation.type.startsWith("skill."))
    return "commandDiscovery";
  if (operation.type.startsWith("interaction.")) return "interactions";
  if (operation.type.startsWith("task.")) return "tasks";
  if (operation.type.startsWith("goal.") || operation.type.startsWith("heartbeat.")) return "goals";
  if (operation.type.startsWith("thread.")) return "namingAndForking";
  return "usageAndRetry";
}
export function supportsRuntimeOperation(
  capabilities: ProviderRuntimeCapabilities | undefined,
  operation: Pick<ProviderRuntimeOperation, "type">,
): boolean {
  return capabilities?.[capabilityForRuntimeOperation(operation)] === true;
}

export const ProviderRuntimeDiscoveredCommand = Schema.Struct({
  name: ShortText,
  description: Schema.optional(Text),
});
export const ProviderRuntimeDiscoveredSkill = Schema.Struct({
  name: ShortText,
  description: Schema.optional(Text),
});
export const ProviderRuntimeInteractionChoice = Schema.Struct({
  id: ShortText,
  label: ShortText,
  detail: Schema.optional(Text),
});
export const ProviderRuntimeInteraction = Schema.Struct({
  interactionId: InteractionId,
  prompt: Text,
  choices: Schema.Array(ProviderRuntimeInteractionChoice),
  acceptsInput: Schema.Boolean,
});
export const ProviderRuntimeTask = Schema.Struct({
  taskId: RuntimeTaskId,
  title: ShortText,
  status: Schema.Literals(["running", "paused", "completed", "cancelled", "failed"]),
});

/**
 * Successful results are correlated to their operation family. This prevents a
 * structurally valid but unrelated payload from completing an operation.
 */
export const ProviderRuntimeAcknowledgement = Schema.Struct({ acknowledged: Schema.Literal(true) });
/** A terminal answer to an interaction, without carrying provider-native content. */
export const ProviderRuntimeInteractionResponse = Schema.Struct({
  status: Schema.Literals(["responded", "cancelled"]),
});
/** A terminal command invocation, deliberately limited to its public name and status. */
export const ProviderRuntimeCommandInvocation = Schema.Struct({
  name: ShortText,
  status: Schema.Literal("completed"),
});
/** A terminal skill invocation, deliberately limited to its public name and status. */
export const ProviderRuntimeSkillInvocation = Schema.Struct({
  name: ShortText,
  status: Schema.Literal("completed"),
});
export const ProviderRuntimeUsageSnapshot = Schema.Struct({
  retriedAt: IsoDateTime,
  retryCount: NonNegativeInt,
});
export const ProviderRuntimeForkedThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(ShortText),
});
export const ProviderRuntimeOperationResult = Schema.Union([
  Schema.Struct({ commands: Schema.Array(ProviderRuntimeDiscoveredCommand) }),
  Schema.Struct({ skills: Schema.Array(ProviderRuntimeDiscoveredSkill) }),
  Schema.Struct({ interaction: ProviderRuntimeInteraction }),
  Schema.Struct({ interactionResponse: ProviderRuntimeInteractionResponse }),
  Schema.Struct({ commandInvocation: ProviderRuntimeCommandInvocation }),
  Schema.Struct({ skillInvocation: ProviderRuntimeSkillInvocation }),
  Schema.Struct({ task: ProviderRuntimeTask }),
  Schema.Struct({ usage: ProviderRuntimeUsageSnapshot }),
  Schema.Struct({ thread: ProviderRuntimeForkedThread }),
  ProviderRuntimeAcknowledgement,
]);
export type ProviderRuntimeOperationResult = typeof ProviderRuntimeOperationResult.Type;

const RuntimeOperationType = Schema.Literals([
  "steer.add",
  "follow-up.add",
  "follow-up.edit",
  "follow-up.reorder",
  "follow-up.cancel",
  "follow-up.reverse",
  "compaction.request",
  "compaction.cancel",
  "compaction.reverse",
  "command.discover",
  "command.invoke",
  "skill.discover",
  "skill.invoke",
  "interaction.respond",
  "interaction.cancel",
  "task.observe",
  "task.cancel",
  "task.pause",
  "task.resume",
  "goal.create",
  "goal.update",
  "goal.delete",
  "goal.reverse",
  "heartbeat.create",
  "heartbeat.update",
  "heartbeat.pause",
  "heartbeat.resume",
  "heartbeat.delete",
  "heartbeat.reverse",
  "thread.rename",
  "thread.fork",
  "usage.snapshot.retry",
]);
const RuntimeOperationCapability = Schema.Literals([
  "steer",
  "followUps",
  "followUpCancel",
  "compaction",
  "compactionCancel",
  "commandDiscovery",
  "interactions",
  "tasks",
  "goals",
  "namingAndForking",
  "usageAndRetry",
]);
const OutcomeBase = {
  commandId: CommandId,
  type: RuntimeOperationType,
  capability: RuntimeOperationCapability,
};

function isCorrelatedSuccessResult(
  type: ProviderRuntimeOperation["type"],
  result: ProviderRuntimeOperationResult,
): boolean {
  if (type === "command.discover") return "commands" in result;
  if (type === "skill.discover") return "skills" in result;
  if (type === "interaction.respond")
    return "interactionResponse" in result && result.interactionResponse.status === "responded";
  if (type === "interaction.cancel")
    return "interactionResponse" in result && result.interactionResponse.status === "cancelled";
  if (type === "command.invoke") return "commandInvocation" in result;
  if (type === "skill.invoke") return "skillInvocation" in result;
  if (["task.observe", "task.cancel", "task.pause", "task.resume"].includes(type))
    return "task" in result;
  if (type === "usage.snapshot.retry") return "usage" in result;
  if (type === "thread.fork") return "thread" in result;
  if (type.endsWith(".reverse")) return false;
  return "acknowledged" in result;
}

/** Lifecycle event for every provider-side extension operation. */
export const ProviderRuntimeOperationOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), ...OutcomeBase }),
  Schema.Struct({
    status: Schema.Literal("succeeded"),
    ...OutcomeBase,
    result: ProviderRuntimeOperationResult,
  }).check(
    Schema.makeFilter(
      (value) =>
        isCorrelatedSuccessResult(value.type as ProviderRuntimeOperation["type"], value.result) ||
        "result must match the operation type",
    ),
  ),
  Schema.Struct({
    status: Schema.Literal("failed"),
    ...OutcomeBase,
    errorCode: ErrorCode,
    message: Schema.optional(Text),
  }),
  Schema.Struct({
    status: Schema.Literal("reversed"),
    ...OutcomeBase,
    type: Schema.Literals([
      "follow-up.reverse",
      "compaction.reverse",
      "goal.reverse",
      "heartbeat.reverse",
    ]),
    reverseCommandId: CommandId,
  }),
]).check(
  Schema.makeFilter(
    (value) =>
      capabilityForRuntimeOperation(value as Pick<ProviderRuntimeOperation, "type">) ===
        value.capability || "capability must match the operation type",
  ),
);
export type ProviderRuntimeOperationOutcome = typeof ProviderRuntimeOperationOutcome.Type;

/** Current provider extension state; every optional branch is independently typed. */
export const ProviderRuntimeExtensionState = Schema.Struct({
  capabilities: ProviderRuntimeCapabilities.pipe(
    Schema.withDecodingDefault(Effect.succeed(EMPTY_PROVIDER_RUNTIME_CAPABILITIES)),
  ),
  followUps: Schema.optional(
    Schema.Array(Schema.Struct({ followUpId: FollowUpId, text: Text, position: NonNegativeInt })),
  ),
  compaction: Schema.optional(
    Schema.Struct({ compactionId: CompactionId, reason: Schema.optional(Text) }),
  ),
  interactions: Schema.optional(Schema.Array(ProviderRuntimeInteraction)),
  goals: Schema.optional(
    Schema.Array(
      Schema.Struct({ goalId: GoalId, title: ShortText, detail: Schema.optional(Text) }),
    ),
  ),
  heartbeats: Schema.optional(
    Schema.Array(
      Schema.Struct({
        heartbeatId: HeartbeatId,
        title: ShortText,
        intervalSeconds: NonNegativeInt,
        paused: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  thread: Schema.optional(
    Schema.Struct({ title: ShortText, forkedFromThreadId: Schema.optional(ThreadId) }),
  ),
  tasks: Schema.optional(Schema.Array(ProviderRuntimeTask)),
  usage: Schema.optional(Schema.Struct({ retriedAt: IsoDateTime, retryCount: NonNegativeInt })),
});
export type ProviderRuntimeExtensionState = typeof ProviderRuntimeExtensionState.Type;
