import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProviderItemId,
  PositiveInt,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const RuntimeEventRawSource = Schema.Union([
  Schema.Literal("codex.app-server.notification"),
  Schema.Literal("codex.app-server.request"),
  Schema.Literal("codex.eventmsg"),
  Schema.Literal("claude.sdk.message"),
  Schema.Literal("claude.sdk.permission"),
  Schema.Literal("codex.sdk.thread-event"),
  Schema.Literal("opencode.sdk.event"),
  Schema.Literal("prime.agent.rpc"),
  Schema.Literal("acp.jsonrpc"),
  Schema.TemplateLiteral(["acp.", Schema.String, ".extension"]),
]);
export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyStringSchema),
  messageType: Schema.optional(TrimmedNonEmptyStringSchema),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

const ProviderRequestId = TrimmedNonEmptyStringSchema;
export type ProviderRequestId = typeof ProviderRequestId.Type;

const ProviderRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

const RuntimeSessionState = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type RuntimeSessionState = typeof RuntimeSessionState.Type;

const RuntimeThreadState = Schema.Literals([
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
]);
export type RuntimeThreadState = typeof RuntimeThreadState.Type;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimePlanStepStatus = Schema.Literals(["pending", "inProgress", "completed"]);
export type RuntimePlanStepStatus = typeof RuntimePlanStepStatus.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const CanonicalItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
]);
export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "tool_user_input",
  "dynamic_tool_call",
  "auth_tokens_refresh",
  "unknown",
]);
export type CanonicalRequestType = typeof CanonicalRequestType.Type;

const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "runtime.warning",
  "runtime.error",
  "session.actions.updated",
  "session.context.updated",
  "session.commands.updated",
  "session.notices.updated",
  "session.agents.updated",
]);
export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

const SessionStartedType = Schema.Literal("session.started");
const SessionConfiguredType = Schema.Literal("session.configured");
const SessionStateChangedType = Schema.Literal("session.state.changed");
const SessionExitedType = Schema.Literal("session.exited");
const ThreadStartedType = Schema.Literal("thread.started");
const ThreadStateChangedType = Schema.Literal("thread.state.changed");
const ThreadMetadataUpdatedType = Schema.Literal("thread.metadata.updated");
const ThreadTokenUsageUpdatedType = Schema.Literal("thread.token-usage.updated");
const ThreadRealtimeStartedType = Schema.Literal("thread.realtime.started");
const ThreadRealtimeItemAddedType = Schema.Literal("thread.realtime.item-added");
const ThreadRealtimeAudioDeltaType = Schema.Literal("thread.realtime.audio.delta");
const ThreadRealtimeErrorType = Schema.Literal("thread.realtime.error");
const ThreadRealtimeClosedType = Schema.Literal("thread.realtime.closed");
const TurnStartedType = Schema.Literal("turn.started");
const TurnCompletedType = Schema.Literal("turn.completed");
const TurnAbortedType = Schema.Literal("turn.aborted");
const TurnPlanUpdatedType = Schema.Literal("turn.plan.updated");
const TurnProposedDeltaType = Schema.Literal("turn.proposed.delta");
const TurnProposedCompletedType = Schema.Literal("turn.proposed.completed");
const TurnDiffUpdatedType = Schema.Literal("turn.diff.updated");
const ItemStartedType = Schema.Literal("item.started");
const ItemUpdatedType = Schema.Literal("item.updated");
const ItemCompletedType = Schema.Literal("item.completed");
const ContentDeltaType = Schema.Literal("content.delta");
const RequestOpenedType = Schema.Literal("request.opened");
const RequestResolvedType = Schema.Literal("request.resolved");
const UserInputRequestedType = Schema.Literal("user-input.requested");
const UserInputResolvedType = Schema.Literal("user-input.resolved");
const TaskStartedType = Schema.Literal("task.started");
const TaskProgressType = Schema.Literal("task.progress");
const TaskUpdatedType = Schema.Literal("task.updated");
const TaskCompletedType = Schema.Literal("task.completed");
const HookStartedType = Schema.Literal("hook.started");
const HookProgressType = Schema.Literal("hook.progress");
const HookCompletedType = Schema.Literal("hook.completed");
const ToolProgressType = Schema.Literal("tool.progress");
const ToolSummaryType = Schema.Literal("tool.summary");
const AuthStatusType = Schema.Literal("auth.status");
const AccountUpdatedType = Schema.Literal("account.updated");
const AccountRateLimitsUpdatedType = Schema.Literal("account.rate-limits.updated");
const McpStatusUpdatedType = Schema.Literal("mcp.status.updated");
const McpOauthCompletedType = Schema.Literal("mcp.oauth.completed");
const ModelReroutedType = Schema.Literal("model.rerouted");
const ConfigWarningType = Schema.Literal("config.warning");
const DeprecationNoticeType = Schema.Literal("deprecation.notice");
const FilesPersistedType = Schema.Literal("files.persisted");
const ToolDeniedType = Schema.Literal("tool.denied");
const RuntimeWarningType = Schema.Literal("runtime.warning");
const RuntimeErrorType = Schema.Literal("runtime.error");
const SessionActionsUpdatedType = Schema.Literal("session.actions.updated");
const SessionContextUpdatedType = Schema.Literal("session.context.updated");
const SessionCommandsUpdatedType = Schema.Literal("session.commands.updated");
const SessionNoticesUpdatedType = Schema.Literal("session.notices.updated");
const SessionAgentsUpdatedType = Schema.Literal("session.agents.updated");

const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. See providerInstance.ts
  // for the routing-key-vs-driver-id distinction. Once every emitter
  // populates it (post-slice-4), routing flips to instance-id-only.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});
export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

const SessionStartedPayload = Schema.Struct({
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  resume: Schema.optional(Schema.Unknown),
});
export type SessionStartedPayload = typeof SessionStartedPayload.Type;

const SessionConfiguredPayload = Schema.Struct({
  config: UnknownRecordSchema,
});
export type SessionConfiguredPayload = typeof SessionConfiguredPayload.Type;

const SessionStateChangedPayload = Schema.Struct({
  state: RuntimeSessionState,
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(Schema.Unknown),
});
export type SessionStateChangedPayload = typeof SessionStateChangedPayload.Type;

const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  recoverable: Schema.optional(Schema.Boolean),
  exitKind: Schema.optional(RuntimeSessionExitKind),
});
export type SessionExitedPayload = typeof SessionExitedPayload.Type;

const ThreadStartedPayload = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadStartedPayload = typeof ThreadStartedPayload.Type;

const ThreadStateChangedPayload = Schema.Struct({
  state: RuntimeThreadState,
  detail: Schema.optional(Schema.Unknown),
});
export type ThreadStateChangedPayload = typeof ThreadStateChangedPayload.Type;

const ThreadMetadataUpdatedPayload = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  metadata: Schema.optional(UnknownRecordSchema),
});
export type ThreadMetadataUpdatedPayload = typeof ThreadMetadataUpdatedPayload.Type;

export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

const ThreadTokenUsageUpdatedPayload = Schema.Struct({
  usage: ThreadTokenUsageSnapshot,
});
export type ThreadTokenUsageUpdatedPayload = typeof ThreadTokenUsageUpdatedPayload.Type;

const ThreadRealtimeStartedPayload = Schema.Struct({
  realtimeSessionId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadRealtimeStartedPayload = typeof ThreadRealtimeStartedPayload.Type;

const ThreadRealtimeItemAddedPayload = Schema.Struct({
  item: Schema.Unknown,
});
export type ThreadRealtimeItemAddedPayload = typeof ThreadRealtimeItemAddedPayload.Type;

const ThreadRealtimeAudioDeltaPayload = Schema.Struct({
  audio: Schema.Unknown,
});
export type ThreadRealtimeAudioDeltaPayload = typeof ThreadRealtimeAudioDeltaPayload.Type;

const ThreadRealtimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
});
export type ThreadRealtimeErrorPayload = typeof ThreadRealtimeErrorPayload.Type;

const ThreadRealtimeClosedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadRealtimeClosedPayload = typeof ThreadRealtimeClosedPayload.Type;

const TurnStartedPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnStartedPayload = typeof TurnStartedPayload.Type;

const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(UnknownRecordSchema),
  totalCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

const TurnAbortedPayload = Schema.Struct({
  reason: TrimmedNonEmptyStringSchema,
});
export type TurnAbortedPayload = typeof TurnAbortedPayload.Type;

const RuntimePlanStep = Schema.Struct({
  step: TrimmedNonEmptyStringSchema,
  status: RuntimePlanStepStatus,
});
export type RuntimePlanStep = typeof RuntimePlanStep.Type;

const TurnPlanUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  plan: Schema.Array(RuntimePlanStep),
});
export type TurnPlanUpdatedPayload = typeof TurnPlanUpdatedPayload.Type;

const TurnProposedDeltaPayload = Schema.Struct({
  delta: Schema.String,
});
export type TurnProposedDeltaPayload = typeof TurnProposedDeltaPayload.Type;

const TurnProposedCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyStringSchema,
});
export type TurnProposedCompletedPayload = typeof TurnProposedCompletedPayload.Type;

const TurnDiffUpdatedPayload = Schema.Struct({
  unifiedDiff: Schema.String,
});
export type TurnDiffUpdatedPayload = typeof TurnDiffUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
  /**
   * Owning agent when this item ran inside a subagent (resolved from the
   * SDK's parent_tool_use_id). Clients re-home attributed items out of the
   * main timeline and into the owning agent's Agents-surface row.
   */
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentToolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Unknown),
});
export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyStringSchema),
  resolution: Schema.optional(Schema.Unknown),
});
export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: TrimmedNonEmptyStringSchema,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

const UserInputResolvedPayload = Schema.Struct({
  answers: UnknownRecordSchema,
  /**
   * Set only when the runtime closed the request without a user answer
   * (cancelled, superseded, or timed out). Clients drop the pending dialog
   * either way; the flag is what lets them say which of the two happened
   * instead of implying the user answered.
   */
  cancelled: Schema.optional(Schema.Boolean),
  reason: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
});
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

/**
 * Typed per-task usage rollup. Field names match the orchestration-v2 subagent
 * usage vocabulary (#4779) so the eventual migration is a rename, not a remap.
 * Claude reports per-activation deltas; Codex reports cumulative totals — the
 * merge strategy is provider-specific and lives in client-runtime.
 */
export const RuntimeTaskUsage = Schema.Struct({
  totalTokens: NonNegativeInt,
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
});
export type RuntimeTaskUsage = typeof RuntimeTaskUsage.Type;

export const TaskWorkflowPhase = Schema.Struct({
  index: NonNegativeInt,
  title: TrimmedNonEmptyStringSchema,
});
export type TaskWorkflowPhase = typeof TaskWorkflowPhase.Type;

export const TaskRunHandles = Schema.Struct({
  runId: Schema.optional(TrimmedNonEmptyStringSchema),
  scriptPath: Schema.optional(TrimmedNonEmptyStringSchema),
  transcriptDir: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Only http/https URLs may be stored here — sanitized at the adapter. */
  sessionUrl: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskRunHandles = typeof TaskRunHandles.Type;

/**
 * Watch-loop task types: Monitor-tool tasks plus background shells (a shell
 * that outlives its turn is in practice a watch loop). Canonical single copy —
 * the server liveness registry, ingestion's agentKind stamp, and the client
 * fold's legacy fallback all classify with these sets.
 */
export const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
]);
/** Task types that are neither agents nor watch loops (plan-mode bookkeeping). */
export const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

/**
 * Agent-vs-background classification, stamped by ingestion as `agentKind` so
 * persisted rows are self-describing. A deliberate denylist: the SDK's
 * agent-flavored type names drift (subagent, local_agent, local_workflow, …)
 * and an allowlist silently dropped real subagents when "local_agent"
 * appeared. A task launched from inside a subagent (agentId set) is
 * agent-internal background work UNLESS it is itself agent-flavored — a
 * nested agent can outlive its parent and stays in the roster.
 */
export function classifyTaskAgentKind(input: {
  readonly taskType?: string | undefined;
  readonly agentId?: string | undefined;
}): "agent" | "background" {
  const { taskType, agentId } = input;
  const nonAgentType =
    taskType !== undefined && (MONITOR_TASK_TYPES.has(taskType) || INERT_TASK_TYPES.has(taskType));
  if (agentId !== undefined && agentId.trim().length > 0) {
    return taskType === undefined || nonAgentType ? "background" : "agent";
  }
  return nonAgentType ? "background" : "agent";
}

/**
 * Optional agent-identity linkage carried on every task lifecycle payload.
 * Repeated on progress and terminal rows (not just start) so client folds can
 * reconstruct an agent even when its start row aged out of activity retention.
 * All fields optional: old emitters and old rows decode unchanged.
 */
const taskAgentLinkageFields = {
  /** SDK task_type (subagent/shell/monitor/local_workflow/…), repeated on
   * every row so folds can classify without the start row. */
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
  /**
   * Server-stamped classification (classifyTaskAgentKind at ingestion).
   * Clients trust this stamp outright; rows without it (legacy, pre-stamp)
   * fall back to client-side heuristics.
   */
  agentKind: Schema.optional(Schema.Literals(["agent", "background"])),
  /**
   * Owning agent when the task itself was launched from inside a subagent
   * (e.g. a subagent's background shell). Clients treat such tasks as
   * agent-internal and keep them out of the parent work log.
   */
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  role: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Reasoning effort when known (e.g. "high"). Open string: provider vocabularies differ. */
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentAgentId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowName: Schema.optional(TrimmedNonEmptyStringSchema),
  agentIndex: Schema.optional(NonNegativeInt),
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  phases: Schema.optional(Schema.Array(TaskWorkflowPhase)),
  attempt: Schema.optional(NonNegativeInt),
  runHandles: Schema.optional(TaskRunHandles),
  outputFile: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Codex agent hierarchy path, e.g. "/root/marlow". */
  agentPath: Schema.optional(TrimmedNonEmptyStringSchema),
  /**
   * Set on provider-synthesized child-agent events (Codex) whose activity
   * belongs in the Agents surface, never the parent timeline.
   */
  timelineBypass: Schema.optional(Schema.Boolean),
} as const;

export const TaskAgentLinkage = Schema.Struct(taskAgentLinkageFields);
export type TaskAgentLinkage = typeof TaskAgentLinkage.Type;

const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  ...taskAgentLinkageFields,
});
export type TaskStartedPayload = typeof TaskStartedPayload.Type;

export const RuntimeTaskStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RuntimeTaskStatus = typeof RuntimeTaskStatus.Type;

const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyStringSchema,
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  typedUsage: Schema.optional(RuntimeTaskUsage),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  /** Present on synthesized member/child progress rows that carry state. */
  status: Schema.optional(RuntimeTaskStatus),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
  ...taskAgentLinkageFields,
});
export type TaskProgressPayload = typeof TaskProgressPayload.Type;

/**
 * Non-terminal status patch (from the Claude SDK's task_updated, which main
 * previously dropped). killed→cancelled and paused→idle are mapped at the
 * adapter so the wire only carries the shared vocabulary.
 */
const TaskUpdatedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.optional(RuntimeTaskStatus),
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
  endedAt: Schema.optional(IsoDateTime),
  isBackgrounded: Schema.optional(Schema.Boolean),
  ...taskAgentLinkageFields,
});
export type TaskUpdatedPayload = typeof TaskUpdatedPayload.Type;

const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  typedUsage: Schema.optional(RuntimeTaskUsage),
  ...taskAgentLinkageFields,
});
export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

const HookStartedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  hookName: TrimmedNonEmptyStringSchema,
  hookEvent: TrimmedNonEmptyStringSchema,
});
export type HookStartedPayload = typeof HookStartedPayload.Type;

const HookProgressPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
export type HookProgressPayload = typeof HookProgressPayload.Type;

const HookCompletedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
});
export type HookCompletedPayload = typeof HookCompletedPayload.Type;

const ToolProgressPayload = Schema.Struct({
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  toolName: Schema.optional(TrimmedNonEmptyStringSchema),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  elapsedSeconds: Schema.optional(Schema.Number),
  /** Owning task/agent when the tool ran inside a subagent. */
  taskId: Schema.optional(RuntimeTaskId),
  parentToolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ToolProgressPayload = typeof ToolProgressPayload.Type;

const ToolSummaryPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  precedingToolUseIds: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});
export type ToolSummaryPayload = typeof ToolSummaryPayload.Type;

const AuthStatusPayload = Schema.Struct({
  isAuthenticating: Schema.optional(Schema.Boolean),
  output: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type AuthStatusPayload = typeof AuthStatusPayload.Type;

const AccountUpdatedPayload = Schema.Struct({
  account: Schema.Unknown,
});
export type AccountUpdatedPayload = typeof AccountUpdatedPayload.Type;

const AccountRateLimitsUpdatedPayload = Schema.Struct({
  rateLimits: Schema.Unknown,
});
export type AccountRateLimitsUpdatedPayload = typeof AccountRateLimitsUpdatedPayload.Type;

const McpStatusUpdatedPayload = Schema.Struct({
  status: Schema.Unknown,
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

const McpOauthCompletedPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type McpOauthCompletedPayload = typeof McpOauthCompletedPayload.Type;

const ModelReroutedPayload = Schema.Struct({
  fromModel: TrimmedNonEmptyStringSchema,
  toModel: TrimmedNonEmptyStringSchema,
  reason: TrimmedNonEmptyStringSchema,
});
export type ModelReroutedPayload = typeof ModelReroutedPayload.Type;

const ConfigWarningPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  details: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  range: Schema.optional(Schema.Unknown),
});
export type ConfigWarningPayload = typeof ConfigWarningPayload.Type;

const DeprecationNoticePayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  details: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type DeprecationNoticePayload = typeof DeprecationNoticePayload.Type;

const FilesPersistedPayload = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: TrimmedNonEmptyStringSchema,
      fileId: TrimmedNonEmptyStringSchema,
    }),
  ),
  failed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: TrimmedNonEmptyStringSchema,
        error: TrimmedNonEmptyStringSchema,
      }),
    ),
  ),
});
export type FilesPersistedPayload = typeof FilesPersistedPayload.Type;

const ToolDeniedPayload = Schema.Struct({
  toolName: TrimmedNonEmptyStringSchema,
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ToolDeniedPayload = typeof ToolDeniedPayload.Type;

const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

/** Provider-neutral projection of Prime 0.7.2 `session_action_update`.
 * Native snapshot contains lane text and active state, but no externally addressable action IDs.
 */
const SessionActionText = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(4_096));
const SessionActionList = Schema.Array(SessionActionText).check(Schema.isMaxLength(32));
const SessionActionsUpdatedPayload = Schema.Struct({
  queuedCount: NonNegativeInt.check(Schema.isLessThanOrEqualTo(32)),
  steering: SessionActionList,
  followUps: SessionActionList,
  active: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["turn", "session_command"]),
      phase: Schema.Literals(["preparing", "committing", "running"]),
      label: Schema.optional(SessionActionText),
    }),
  ),
});
export type SessionActionsUpdatedPayload = typeof SessionActionsUpdatedPayload.Type;

/** Authoritative, provider-neutral view of a native action snapshot.
 * There are deliberately no client-generated IDs here: 0.7.2 returns only
 * lane text/count, so replacing this value is the sole safe reconciliation.
 */
export interface ProviderSessionActionState {
  readonly queuedCount: number;
  readonly steering: ReadonlyArray<string>;
  readonly followUps: ReadonlyArray<string>;
  readonly active?: {
    readonly kind: "turn" | "session_command";
    readonly phase: "preparing" | "committing" | "running";
    readonly label?: string;
  };
}
export const EMPTY_PROVIDER_SESSION_ACTION_STATE: ProviderSessionActionState = Object.freeze({
  queuedCount: 0,
  steering: Object.freeze([]),
  followUps: Object.freeze([]),
});
/** Apply canonical runtime events in arrival order. Full snapshots make this
 * deterministic for every attached client; session termination clears stale UI. */
export const reduceProviderSessionActionState = (
  current: ProviderSessionActionState = EMPTY_PROVIDER_SESSION_ACTION_STATE,
  event: ProviderRuntimeEvent,
): ProviderSessionActionState => {
  if (event.type === "session.actions.updated") {
    const payload = event.payload;
    return {
      queuedCount: payload.queuedCount,
      steering: [...payload.steering],
      followUps: [...payload.followUps],
      ...(payload.active
        ? {
            active: {
              kind: payload.active.kind,
              phase: payload.active.phase,
              ...(payload.active.label === undefined ? {} : { label: payload.active.label }),
            },
          }
        : {}),
    };
  }
  return event.type === "session.exited" ? EMPTY_PROVIDER_SESSION_ACTION_STATE : current;
};

/**
 * Provider-neutral context/compaction/retry status. This is deliberately a full
 * snapshot with no identifiers of its own: a runtime reports what is happening
 * to its own context window, and replacing the value is the only safe
 * reconciliation. Compaction here is the *runtime's* context management; it is
 * unrelated to T3 checkpoints and never reverts user work.
 */
const CompactionStatus = Schema.Literals(["idle", "running", "succeeded", "failed", "cancelled"]);
const CompactionTrigger = Schema.Literals(["manual", "automatic"]);
const SessionContextUpdatedPayload = Schema.Struct({
  compaction: Schema.Struct({
    status: CompactionStatus,
    trigger: CompactionTrigger,
    /** Runtime-supplied explanation. Never native transcript content. */
    reason: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  }),
  retry: Schema.optional(
    Schema.Struct({
      attempt: NonNegativeInt.check(Schema.isLessThanOrEqualTo(64)),
      maxAttempts: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(64))),
      reason: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
    }),
  ),
  /** Post-compaction usage is legitimately absent until the runtime reports it. */
  usage: Schema.optional(ThreadTokenUsageSnapshot),
  /**
   * True only when this snapshot carries a compaction phase transition. A
   * snapshot published for retry or usage alone still repeats the last known
   * compaction status, so consumers that report compaction *events* (durable
   * activities) must require this marker rather than reading `compaction.status`
   * — otherwise every retry restates a compaction that did not happen.
   */
  compactionTransitioned: Schema.optional(Schema.Boolean),
});
export type SessionContextUpdatedPayload = typeof SessionContextUpdatedPayload.Type;

export interface ProviderSessionContextState {
  readonly compaction: {
    readonly status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
    readonly trigger: "manual" | "automatic";
    readonly reason?: string;
  };
  readonly retry?: {
    readonly attempt: number;
    readonly maxAttempts?: number;
    readonly reason?: string;
  };
  readonly usage?: ThreadTokenUsageSnapshot;
}
export const EMPTY_PROVIDER_SESSION_CONTEXT_STATE: ProviderSessionContextState = Object.freeze({
  compaction: Object.freeze({ status: "idle" as const, trigger: "automatic" as const }),
});
/**
 * Apply canonical runtime events in arrival order. Snapshots replace, so every
 * attached client converges; session termination clears stale status.
 */
export const reduceProviderSessionContextState = (
  current: ProviderSessionContextState = EMPTY_PROVIDER_SESSION_CONTEXT_STATE,
  event: ProviderRuntimeEvent,
): ProviderSessionContextState => {
  if (event.type === "session.context.updated") {
    const payload = event.payload;
    return {
      compaction: {
        status: payload.compaction.status,
        trigger: payload.compaction.trigger,
        ...(payload.compaction.reason === undefined ? {} : { reason: payload.compaction.reason }),
      },
      ...(payload.retry === undefined
        ? {}
        : {
            retry: {
              attempt: payload.retry.attempt,
              ...(payload.retry.maxAttempts === undefined
                ? {}
                : { maxAttempts: payload.retry.maxAttempts }),
              ...(payload.retry.reason === undefined ? {} : { reason: payload.retry.reason }),
            },
          }),
      ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    };
  }
  return event.type === "session.exited" ? EMPTY_PROVIDER_SESSION_CONTEXT_STATE : current;
};

/**
 * Provider-neutral catalog of runtime-supplied commands, prompts, and skills.
 *
 * Deliberately a full snapshot with no identifiers: a runtime reports what it
 * currently offers and replacing the value is the only safe reconciliation, so
 * a removed command disappears everywhere instead of lingering per client.
 *
 * `location` is a display label only. Absolute host paths never reach this
 * contract, because a remote client must not learn the host filesystem layout.
 */
const CommandCatalogName = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(64));
const CommandCatalogEntry = Schema.Struct({
  name: CommandCatalogName,
  kind: Schema.Literals(["command", "prompt", "skill"]),
  description: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  source: Schema.Literals(["builtin", "user", "project", "extension"]),
  location: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(64))),
});
export type ProviderSessionCommandEntry = typeof CommandCatalogEntry.Type;
const SessionCommandsUpdatedPayload = Schema.Struct({
  commands: Schema.Array(CommandCatalogEntry).check(Schema.isMaxLength(128)),
});
export type SessionCommandsUpdatedPayload = typeof SessionCommandsUpdatedPayload.Type;

export interface ProviderSessionCommandCatalog {
  readonly commands: ReadonlyArray<ProviderSessionCommandEntry>;
}
export const EMPTY_PROVIDER_SESSION_COMMAND_CATALOG: ProviderSessionCommandCatalog = Object.freeze({
  commands: Object.freeze([]),
});
/**
 * Apply canonical runtime events in arrival order. Snapshots replace, so a
 * command deleted on the host stops being offered on every attached client;
 * session termination clears the catalog rather than leaving stale entries.
 */
export const reduceProviderSessionCommandCatalog = (
  current: ProviderSessionCommandCatalog = EMPTY_PROVIDER_SESSION_COMMAND_CATALOG,
  event: ProviderRuntimeEvent,
): ProviderSessionCommandCatalog => {
  if (event.type === "session.commands.updated") return { commands: [...event.payload.commands] };
  return event.type === "session.exited" ? EMPTY_PROVIDER_SESSION_COMMAND_CATALOG : current;
};

/**
 * Provider-neutral transient status surface.
 *
 * Runtimes emit fire-and-forget UI operations: notifications, a status string,
 * a small widget, a window title, suggested editor text. None of that belongs
 * in the transcript — each describes *now*, is replaced by key, and a whole
 * snapshot is the only safe reconciliation across attached clients. The board
 * is deliberately tiny so a chatty extension cannot flood a client.
 */
const SessionNoticeKind = Schema.Literals([
  "notification",
  "status",
  "widget",
  "title",
  "editor-text",
]);
export type ProviderSessionNoticeKind = typeof SessionNoticeKind.Type;
const SessionNoticeEntry = Schema.Struct({
  /** Stable replacement key: a repeated key replaces, it never appends. */
  key: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(96)),
  kind: SessionNoticeKind,
  severity: Schema.Literals(["info", "warning", "error"]),
  text: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256)),
  lines: Schema.optional(
    Schema.Array(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(160))).check(
      Schema.isMaxLength(4),
    ),
  ),
});
export type ProviderSessionNotice = typeof SessionNoticeEntry.Type;
export const PROVIDER_SESSION_NOTICE_LIMIT = 8;
const SessionNoticesUpdatedPayload = Schema.Struct({
  notices: Schema.Array(SessionNoticeEntry).check(
    Schema.isMaxLength(PROVIDER_SESSION_NOTICE_LIMIT),
  ),
});
export type SessionNoticesUpdatedPayload = typeof SessionNoticesUpdatedPayload.Type;

export interface ProviderSessionNoticeBoard {
  readonly notices: ReadonlyArray<ProviderSessionNotice>;
}
export const EMPTY_PROVIDER_SESSION_NOTICE_BOARD: ProviderSessionNoticeBoard = Object.freeze({
  notices: Object.freeze([]),
});
/**
 * Apply canonical runtime events in arrival order. Status is transient by
 * definition, so session termination clears the board instead of leaving a dead
 * runtime's status text on screen.
 */
export const reduceProviderSessionNoticeBoard = (
  current: ProviderSessionNoticeBoard = EMPTY_PROVIDER_SESSION_NOTICE_BOARD,
  event: ProviderRuntimeEvent,
): ProviderSessionNoticeBoard => {
  if (event.type === "session.notices.updated") return { notices: [...event.payload.notices] };
  return event.type === "session.exited" ? EMPTY_PROVIDER_SESSION_NOTICE_BOARD : current;
};

/**
 * Provider-neutral agent roster.
 *
 * A runtime that delegates work to subagents needs somewhere to show that work
 * that is *not* the main transcript: duplicating a subagent's output into the
 * thread is exactly the flood this surface exists to avoid. The roster is a
 * bounded current-state snapshot — one row per agent, the root included, each
 * with its own identity, state, and whether this environment is observing it.
 *
 * Identities are opaque and adapter-owned. Nothing here is invented by T3, and
 * an identity absent from the roster is not a legal action target.
 */
const SessionAgentRole = Schema.Literals(["root", "subagent"]);
export type ProviderSessionAgentRole = typeof SessionAgentRole.Type;
const SessionAgentStatus = Schema.Literals([
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
export type ProviderSessionAgentStatus = typeof SessionAgentStatus.Type;
const SessionAgentEntry = Schema.Struct({
  /** Opaque runtime-owned identity; the only legal target of an agent action. */
  agentId: RuntimeTaskId,
  role: SessionAgentRole,
  status: SessionAgentStatus,
  title: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(120)),
  /** True while this environment holds an observation on the agent. */
  observed: Schema.Boolean,
  /** Newest bounded observed line; deliberately a status, not scrollback. */
  detail: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
});
export type ProviderSessionAgent = typeof SessionAgentEntry.Type;
export const PROVIDER_SESSION_AGENT_LIMIT = 16;
const SessionAgentsUpdatedPayload = Schema.Struct({
  agents: Schema.Array(SessionAgentEntry).check(Schema.isMaxLength(PROVIDER_SESSION_AGENT_LIMIT)),
});
export type SessionAgentsUpdatedPayload = typeof SessionAgentsUpdatedPayload.Type;

export interface ProviderSessionAgentRoster {
  readonly agents: ReadonlyArray<ProviderSessionAgent>;
}
export const EMPTY_PROVIDER_SESSION_AGENT_ROSTER: ProviderSessionAgentRoster = Object.freeze({
  agents: Object.freeze([]),
});
/**
 * Apply canonical runtime events in arrival order. Snapshots replace, so every
 * attached client converges on the same roster; a session that exits keeps no
 * agents, because an observation cannot outlive the session that owned it.
 */
export const reduceProviderSessionAgentRoster = (
  current: ProviderSessionAgentRoster = EMPTY_PROVIDER_SESSION_AGENT_ROSTER,
  event: ProviderRuntimeEvent,
): ProviderSessionAgentRoster => {
  if (event.type === "session.agents.updated") return { agents: [...event.payload.agents] };
  return event.type === "session.exited" ? EMPTY_PROVIDER_SESSION_AGENT_ROSTER : current;
};

const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStartedType,
  payload: SessionStartedPayload,
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

const ProviderRuntimeSessionConfiguredEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionConfiguredType,
  payload: SessionConfiguredPayload,
});
export type ProviderRuntimeSessionConfiguredEvent =
  typeof ProviderRuntimeSessionConfiguredEvent.Type;

const ProviderRuntimeSessionStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStateChangedType,
  payload: SessionStateChangedPayload,
});
export type ProviderRuntimeSessionStateChangedEvent =
  typeof ProviderRuntimeSessionStateChangedEvent.Type;

const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionExitedType,
  payload: SessionExitedPayload,
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStartedType,
  payload: ThreadStartedPayload,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

const ProviderRuntimeThreadStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStateChangedType,
  payload: ThreadStateChangedPayload,
});
export type ProviderRuntimeThreadStateChangedEvent =
  typeof ProviderRuntimeThreadStateChangedEvent.Type;

const ProviderRuntimeThreadMetadataUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadMetadataUpdatedType,
  payload: ThreadMetadataUpdatedPayload,
});
export type ProviderRuntimeThreadMetadataUpdatedEvent =
  typeof ProviderRuntimeThreadMetadataUpdatedEvent.Type;

const ProviderRuntimeThreadTokenUsageUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadTokenUsageUpdatedType,
  payload: ThreadTokenUsageUpdatedPayload,
});
export type ProviderRuntimeThreadTokenUsageUpdatedEvent =
  typeof ProviderRuntimeThreadTokenUsageUpdatedEvent.Type;

const ProviderRuntimeThreadRealtimeStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeStartedType,
  payload: ThreadRealtimeStartedPayload,
});
export type ProviderRuntimeThreadRealtimeStartedEvent =
  typeof ProviderRuntimeThreadRealtimeStartedEvent.Type;

const ProviderRuntimeThreadRealtimeItemAddedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeItemAddedType,
  payload: ThreadRealtimeItemAddedPayload,
});
export type ProviderRuntimeThreadRealtimeItemAddedEvent =
  typeof ProviderRuntimeThreadRealtimeItemAddedEvent.Type;

const ProviderRuntimeThreadRealtimeAudioDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeAudioDeltaType,
  payload: ThreadRealtimeAudioDeltaPayload,
});
export type ProviderRuntimeThreadRealtimeAudioDeltaEvent =
  typeof ProviderRuntimeThreadRealtimeAudioDeltaEvent.Type;

const ProviderRuntimeThreadRealtimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeErrorType,
  payload: ThreadRealtimeErrorPayload,
});
export type ProviderRuntimeThreadRealtimeErrorEvent =
  typeof ProviderRuntimeThreadRealtimeErrorEvent.Type;

const ProviderRuntimeThreadRealtimeClosedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeClosedType,
  payload: ThreadRealtimeClosedPayload,
});
export type ProviderRuntimeThreadRealtimeClosedEvent =
  typeof ProviderRuntimeThreadRealtimeClosedEvent.Type;

const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnStartedType,
  payload: TurnStartedPayload,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnCompletedType,
  payload: TurnCompletedPayload,
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

const ProviderRuntimeTurnAbortedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnAbortedType,
  payload: TurnAbortedPayload,
});
export type ProviderRuntimeTurnAbortedEvent = typeof ProviderRuntimeTurnAbortedEvent.Type;

const ProviderRuntimeTurnPlanUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnPlanUpdatedType,
  payload: TurnPlanUpdatedPayload,
});
export type ProviderRuntimeTurnPlanUpdatedEvent = typeof ProviderRuntimeTurnPlanUpdatedEvent.Type;

const ProviderRuntimeTurnProposedDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedDeltaType,
  payload: TurnProposedDeltaPayload,
});
export type ProviderRuntimeTurnProposedDeltaEvent =
  typeof ProviderRuntimeTurnProposedDeltaEvent.Type;

const ProviderRuntimeTurnProposedCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedCompletedType,
  payload: TurnProposedCompletedPayload,
});
export type ProviderRuntimeTurnProposedCompletedEvent =
  typeof ProviderRuntimeTurnProposedCompletedEvent.Type;

const ProviderRuntimeTurnDiffUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnDiffUpdatedType,
  payload: TurnDiffUpdatedPayload,
});
export type ProviderRuntimeTurnDiffUpdatedEvent = typeof ProviderRuntimeTurnDiffUpdatedEvent.Type;

const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemStartedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemUpdatedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemCompletedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ContentDeltaType,
  payload: ContentDeltaPayload,
});
export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestOpenedType,
  payload: RequestOpenedPayload,
});
export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestResolvedType,
  payload: RequestResolvedPayload,
});
export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputRequestedType,
  payload: UserInputRequestedPayload,
});
export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputResolvedType,
  payload: UserInputResolvedPayload,
});
export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;

const ProviderRuntimeTaskStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskStartedType,
  payload: TaskStartedPayload,
});
export type ProviderRuntimeTaskStartedEvent = typeof ProviderRuntimeTaskStartedEvent.Type;

const ProviderRuntimeTaskProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskProgressType,
  payload: TaskProgressPayload,
});
export type ProviderRuntimeTaskProgressEvent = typeof ProviderRuntimeTaskProgressEvent.Type;

const ProviderRuntimeTaskUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskUpdatedType,
  payload: TaskUpdatedPayload,
});
export type ProviderRuntimeTaskUpdatedEvent = typeof ProviderRuntimeTaskUpdatedEvent.Type;

const ProviderRuntimeTaskCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskCompletedType,
  payload: TaskCompletedPayload,
});
export type ProviderRuntimeTaskCompletedEvent = typeof ProviderRuntimeTaskCompletedEvent.Type;

const ProviderRuntimeHookStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookStartedType,
  payload: HookStartedPayload,
});
export type ProviderRuntimeHookStartedEvent = typeof ProviderRuntimeHookStartedEvent.Type;

const ProviderRuntimeHookProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookProgressType,
  payload: HookProgressPayload,
});
export type ProviderRuntimeHookProgressEvent = typeof ProviderRuntimeHookProgressEvent.Type;

const ProviderRuntimeHookCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookCompletedType,
  payload: HookCompletedPayload,
});
export type ProviderRuntimeHookCompletedEvent = typeof ProviderRuntimeHookCompletedEvent.Type;

const ProviderRuntimeToolProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolProgressType,
  payload: ToolProgressPayload,
});
export type ProviderRuntimeToolProgressEvent = typeof ProviderRuntimeToolProgressEvent.Type;

const ProviderRuntimeToolSummaryEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolSummaryType,
  payload: ToolSummaryPayload,
});
export type ProviderRuntimeToolSummaryEvent = typeof ProviderRuntimeToolSummaryEvent.Type;

const ProviderRuntimeAuthStatusEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AuthStatusType,
  payload: AuthStatusPayload,
});
export type ProviderRuntimeAuthStatusEvent = typeof ProviderRuntimeAuthStatusEvent.Type;

const ProviderRuntimeAccountUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AccountUpdatedType,
  payload: AccountUpdatedPayload,
});
export type ProviderRuntimeAccountUpdatedEvent = typeof ProviderRuntimeAccountUpdatedEvent.Type;

const ProviderRuntimeAccountRateLimitsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AccountRateLimitsUpdatedType,
  payload: AccountRateLimitsUpdatedPayload,
});
export type ProviderRuntimeAccountRateLimitsUpdatedEvent =
  typeof ProviderRuntimeAccountRateLimitsUpdatedEvent.Type;

const ProviderRuntimeMcpStatusUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: McpStatusUpdatedType,
  payload: McpStatusUpdatedPayload,
});
export type ProviderRuntimeMcpStatusUpdatedEvent = typeof ProviderRuntimeMcpStatusUpdatedEvent.Type;

const ProviderRuntimeMcpOauthCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: McpOauthCompletedType,
  payload: McpOauthCompletedPayload,
});
export type ProviderRuntimeMcpOauthCompletedEvent =
  typeof ProviderRuntimeMcpOauthCompletedEvent.Type;

const ProviderRuntimeModelReroutedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ModelReroutedType,
  payload: ModelReroutedPayload,
});
export type ProviderRuntimeModelReroutedEvent = typeof ProviderRuntimeModelReroutedEvent.Type;

const ProviderRuntimeConfigWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ConfigWarningType,
  payload: ConfigWarningPayload,
});
export type ProviderRuntimeConfigWarningEvent = typeof ProviderRuntimeConfigWarningEvent.Type;

const ProviderRuntimeDeprecationNoticeEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: DeprecationNoticeType,
  payload: DeprecationNoticePayload,
});
export type ProviderRuntimeDeprecationNoticeEvent =
  typeof ProviderRuntimeDeprecationNoticeEvent.Type;

const ProviderRuntimeFilesPersistedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: FilesPersistedType,
  payload: FilesPersistedPayload,
});
export type ProviderRuntimeFilesPersistedEvent = typeof ProviderRuntimeFilesPersistedEvent.Type;

const ProviderRuntimeToolDeniedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolDeniedType,
  payload: ToolDeniedPayload,
});
export type ProviderRuntimeToolDeniedEvent = typeof ProviderRuntimeToolDeniedEvent.Type;

const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeWarningType,
  payload: RuntimeWarningPayload,
});
export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeErrorType,
  payload: RuntimeErrorPayload,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

const ProviderRuntimeSessionActionsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionActionsUpdatedType,
  payload: SessionActionsUpdatedPayload,
});
export type ProviderRuntimeSessionActionsUpdatedEvent =
  typeof ProviderRuntimeSessionActionsUpdatedEvent.Type;

const ProviderRuntimeSessionContextUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionContextUpdatedType,
  payload: SessionContextUpdatedPayload,
});
export type ProviderRuntimeSessionContextUpdatedEvent =
  typeof ProviderRuntimeSessionContextUpdatedEvent.Type;

const ProviderRuntimeSessionCommandsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionCommandsUpdatedType,
  payload: SessionCommandsUpdatedPayload,
});
export type ProviderRuntimeSessionCommandsUpdatedEvent =
  typeof ProviderRuntimeSessionCommandsUpdatedEvent.Type;

const ProviderRuntimeSessionNoticesUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionNoticesUpdatedType,
  payload: SessionNoticesUpdatedPayload,
});
export type ProviderRuntimeSessionNoticesUpdatedEvent =
  typeof ProviderRuntimeSessionNoticesUpdatedEvent.Type;

const ProviderRuntimeSessionAgentsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionAgentsUpdatedType,
  payload: SessionAgentsUpdatedPayload,
});
export type ProviderRuntimeSessionAgentsUpdatedEvent =
  typeof ProviderRuntimeSessionAgentsUpdatedEvent.Type;

export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionConfiguredEvent,
  ProviderRuntimeSessionStateChangedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeThreadStateChangedEvent,
  ProviderRuntimeThreadMetadataUpdatedEvent,
  ProviderRuntimeThreadTokenUsageUpdatedEvent,
  ProviderRuntimeThreadRealtimeStartedEvent,
  ProviderRuntimeThreadRealtimeItemAddedEvent,
  ProviderRuntimeThreadRealtimeAudioDeltaEvent,
  ProviderRuntimeThreadRealtimeErrorEvent,
  ProviderRuntimeThreadRealtimeClosedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnAbortedEvent,
  ProviderRuntimeTurnPlanUpdatedEvent,
  ProviderRuntimeTurnProposedDeltaEvent,
  ProviderRuntimeTurnProposedCompletedEvent,
  ProviderRuntimeTurnDiffUpdatedEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeItemUpdatedEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeContentDeltaEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeUserInputRequestedEvent,
  ProviderRuntimeUserInputResolvedEvent,
  ProviderRuntimeTaskStartedEvent,
  ProviderRuntimeTaskProgressEvent,
  ProviderRuntimeTaskUpdatedEvent,
  ProviderRuntimeTaskCompletedEvent,
  ProviderRuntimeHookStartedEvent,
  ProviderRuntimeHookProgressEvent,
  ProviderRuntimeHookCompletedEvent,
  ProviderRuntimeToolProgressEvent,
  ProviderRuntimeToolSummaryEvent,
  ProviderRuntimeAuthStatusEvent,
  ProviderRuntimeAccountUpdatedEvent,
  ProviderRuntimeAccountRateLimitsUpdatedEvent,
  ProviderRuntimeMcpStatusUpdatedEvent,
  ProviderRuntimeMcpOauthCompletedEvent,
  ProviderRuntimeModelReroutedEvent,
  ProviderRuntimeConfigWarningEvent,
  ProviderRuntimeDeprecationNoticeEvent,
  ProviderRuntimeFilesPersistedEvent,
  ProviderRuntimeToolDeniedEvent,
  ProviderRuntimeWarningEvent,
  ProviderRuntimeErrorEvent,
  ProviderRuntimeSessionActionsUpdatedEvent,
  ProviderRuntimeSessionContextUpdatedEvent,
  ProviderRuntimeSessionCommandsUpdatedEvent,
  ProviderRuntimeSessionNoticesUpdatedEvent,
  ProviderRuntimeSessionAgentsUpdatedEvent,
]);
export type ProviderRuntimeEventV2 = typeof ProviderRuntimeEventV2.Type;

export const ProviderRuntimeEvent = ProviderRuntimeEventV2;
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;

// Compatibility aliases for call sites still importing legacy names.
const ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
export type ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
const ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
export type ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
const ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
export type ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
const ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;
export type ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;

// Legacy helper aliases retained for adapters/tests.
const ProviderRuntimeToolKind = Schema.Literals(["command", "file-read", "file-change", "other"]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;

export const ProviderRuntimeTurnStatus = RuntimeTurnState;
export type ProviderRuntimeTurnStatus = RuntimeTurnState;
