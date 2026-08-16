import { createHash } from "node:crypto";
import {
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type SessionCommandsUpdatedPayload,
  type SessionNoticesUpdatedPayload,
  type SessionAgentsUpdatedPayload,
  type SessionGoalsUpdatedPayload,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import type { PrimeRpcKnownEvent, PrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";
import { PrimeContextTracker } from "./PrimeCompaction.ts";

/** Converts Prime 0.7.2 records to the provider-neutral runtime vocabulary once. */
export interface PrimeEventNormalizerOptions {
  readonly providerInstanceId?: string;
  readonly now?: () => string;
  readonly warn?: (message: string) => void;
}
const PROVIDER = ProviderDriverKind.make("prime-agent");
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!value || typeof value !== "object") return "";
  const x = value as Record<string, unknown>;
  return typeof x.text === "string"
    ? x.text
    : typeof x.delta === "string"
      ? x.delta
      : typeof x.content === "string"
        ? x.content
        : textOf(x.content);
};
const MAX_TOOL_OUTPUT_CHARS = 1_000_000;
const MAX_NATIVE_STRING = 4_096;
const MAX_SELECT_OPTIONS = 64;
const cleanNative = (value: unknown, fallback = "Prime Agent request"): string => {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return text.slice(0, MAX_NATIVE_STRING) || fallback;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export class PrimeEventNormalizer {
  readonly #threadId: ThreadId;
  readonly #instance: string | undefined;
  readonly #now: () => string;
  readonly #warn: ((s: string) => void) | undefined;
  readonly #context = new PrimeContextTracker();
  #turn?: TurnId;
  #messageItem: RuntimeItemId | undefined;
  #stopped = false;
  #ended = false;
  #seq = 0;
  readonly #tools = new Map<string, string>();
  readonly #warned = new Set<string>();
  constructor(threadId: ThreadId, options: PrimeEventNormalizerOptions = {}) {
    this.#threadId = threadId;
    this.#instance = options.providerInstanceId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#warn = options.warn;
  }
  drain(envelope: PrimeRpcEnvelope): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    if (envelope._tag === "unknown-event") {
      if (this.#warned.has(envelope.type)) return [];
      this.#warned.add(envelope.type);
      this.#warn?.(`Unknown Prime event: ${envelope.type}`);
      return [this.base("runtime.warning", { message: `Unknown Prime event: ${envelope.type}` })];
    }
    if (envelope._tag !== "known-event") return [];
    const e = envelope.value as PrimeRpcKnownEvent;
    const out: ProviderRuntimeEvent[] = [];
    const emit = (type: string, payload: any, extra: any = {}) =>
      out.push(this.base(type, payload, extra));
    switch (e.type) {
      case "agent_start":
        emit("session.state.changed", { state: "running" });
        emit("thread.started", {});
        break;
      case "agent_end":
        if (!this.#stopped) {
          if (!this.#ended && this.#turn) {
            this.#ended = true;
            emit("turn.completed", { state: "completed" }, { turnId: this.#turn });
          }
          emit("session.exited", { exitKind: "graceful" });
          this.#stopped = true;
        }
        break;
      case "turn_start":
        this.#ended = false;
        this.#turn = TurnId.make(`prime-turn-${++this.#seq}`);
        emit("turn.started", {}, { turnId: this.#turn });
        break;
      case "turn_end":
        if (!this.#ended) {
          this.#ended = true;
          emit("turn.completed", { state: "completed" }, { turnId: this.#turn });
        }
        break;
      case "message_start": {
        const m = e.message as Record<string, unknown>;
        const role = m?.role;
        this.#messageItem = RuntimeItemId.make(`prime-message-${++this.#seq}`);
        emit(
          "item.started",
          {
            itemType: role === "assistant" ? "assistant_message" : "user_message",
            status: "inProgress",
          },
          { turnId: this.#turn, itemId: this.#messageItem },
        );
        break;
      }
      case "message_update": {
        const m = e.message as Record<string, unknown>;
        const native = e.assistantMessageEvent as Record<string, unknown>;
        const delta = textOf(native.delta) || textOf(native.content) || textOf(m.content);
        const nativeType = typeof native.type === "string" ? native.type : "";
        if (nativeType.includes("retry"))
          emit(
            "runtime.warning",
            { message: "Prime Agent is retrying the current turn." },
            { turnId: this.#turn },
          );
        const streamKind = nativeType.includes("reasoning") ? "reasoning_text" : "assistant_text";
        if (delta && this.#messageItem)
          emit(
            "content.delta",
            { streamKind, delta },
            { turnId: this.#turn, itemId: this.#messageItem },
          );
        const usage = m.usage as Record<string, unknown> | undefined;
        const used = usage && typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
        if (used !== undefined) {
          const snapshot = { usedTokens: Math.max(0, Math.floor(used)) };
          this.#context.observeUsage(snapshot);
          emit("thread.token-usage.updated", { usage: snapshot }, { turnId: this.#turn });
        }
        break;
      }
      case "message_end": {
        const message = e.message as Record<string, unknown>;
        const role = message?.role;
        const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
        const failed = stopReason === "error" || stopReason === "failed";
        if (this.#messageItem)
          emit(
            "item.completed",
            {
              itemType: role === "assistant" ? "assistant_message" : "user_message",
              status: failed ? "failed" : "completed",
            },
            { turnId: this.#turn, itemId: this.#messageItem },
          );
        if (failed)
          emit(
            "runtime.error",
            { class: "provider_error", message: "Prime Agent message failed." },
            { turnId: this.#turn },
          );
        this.#messageItem = undefined;
        break;
      }
      // Compaction/retry status is a bounded snapshot: the tracker drops
      // byte-identical repeats and samples usage-only churn so the status UI
      // never repaints in a loop.
      case "compaction_update":
      case "retry_update": {
        const snapshot = this.#context.apply(e);
        if (snapshot) emit("session.context.updated", snapshot, { turnId: this.#turn });
        break;
      }
      case "session_action_update":
        emit(
          "session.actions.updated",
          {
            queuedCount: e.actions.queuedCount,
            steering: e.actions.steering,
            followUps: e.actions.followUps,
            ...(e.actions.active ? { active: e.actions.active } : {}),
          },
          { turnId: this.#turn },
        );
        break;
      case "extension_ui_request": {
        const requestId = RuntimeRequestId.make(e.id);
        if (e.method === "confirm")
          emit(
            "request.opened",
            {
              requestType: "command_execution_approval",
              detail: cleanNative(e.title),
              args: { message: cleanNative(e.message, "Prime Agent confirmation requested.") },
            },
            { turnId: this.#turn, requestId, providerRefs: { providerRequestId: e.id } },
          );
        else if (e.method === "select" || e.method === "input" || e.method === "editor")
          emit(
            "user-input.requested",
            {
              questions: [
                {
                  id: e.id,
                  header: cleanNative(e.title),
                  question: cleanNative(e.title),
                  options:
                    e.method === "select"
                      ? e.options.slice(0, MAX_SELECT_OPTIONS).map((label) => ({
                          label: cleanNative(label, "Option"),
                          description: cleanNative(label, "Option"),
                        }))
                      : [],
                  multiSelect: false,
                },
              ],
            },
            { turnId: this.#turn, requestId, providerRefs: { providerRequestId: e.id } },
          );
        else
          emit(
            "runtime.warning",
            {
              message:
                "Prime Agent extension UI request was cancelled because this method is unsupported.",
            },
            { turnId: this.#turn, providerRefs: { providerRequestId: e.id } },
          );
        break;
      }
      case "tool_execution_start":
        emit(
          "item.started",
          { itemType: "dynamic_tool_call", status: "inProgress", title: e.toolName, args: e.args },
          {
            turnId: this.#turn,
            itemId: RuntimeItemId.make(`prime-tool-${e.toolCallId}`),
            providerRefs: { providerItemId: e.toolCallId },
          },
        );
        break;
      case "tool_execution_update": {
        const id = e.toolCallId;
        const candidate = textOf(e.partialResult);
        const full = candidate.slice(0, MAX_TOOL_OUTPUT_CHARS);
        const prior = this.#tools.get(id) ?? "";
        if (full.startsWith(prior)) {
          const delta = full.slice(prior.length);
          this.#tools.set(id, full);
          if (delta)
            emit(
              "content.delta",
              { streamKind: "command_output", delta },
              {
                turnId: this.#turn,
                itemId: RuntimeItemId.make(`prime-tool-${id}`),
                providerRefs: { providerItemId: id },
              },
            );
        } else if (hash(full) !== hash(prior)) {
          this.#tools.set(id, full);
          emit(
            "item.updated",
            {
              itemType: "dynamic_tool_call",
              status: "inProgress",
              data: { replacement: full, fingerprint: hash(full) },
            },
            {
              turnId: this.#turn,
              itemId: RuntimeItemId.make(`prime-tool-${id}`),
              providerRefs: { providerItemId: id },
            },
          );
        }
        break;
      }
      case "tool_execution_end":
        emit(
          "item.completed",
          {
            itemType: "dynamic_tool_call",
            status: e.isError ? "failed" : "completed",
            data: e.result,
          },
          {
            turnId: this.#turn,
            itemId: RuntimeItemId.make(`prime-tool-${e.toolCallId}`),
            providerRefs: { providerItemId: e.toolCallId },
          },
        );
        break;
    }
    return out;
  }
  /** Publishes a `get_session_stats` usage snapshot through the same bounded tracker. */
  usageSnapshot(usage: ThreadTokenUsageSnapshot | undefined): ProviderRuntimeEvent[] {
    if (this.#stopped || !usage) return [];
    const out: ProviderRuntimeEvent[] = [
      this.base("thread.token-usage.updated", { usage }, { turnId: this.#turn }),
    ];
    const context = this.#context.applyUsage(usage);
    if (context) out.push(this.base("session.context.updated", context, { turnId: this.#turn }));
    return out;
  }

  /**
   * Publishes a discovered command catalog. The caller owns the bounded cache,
   * so a byte-identical catalog never reaches this method and no snapshot is
   * emitted after the session stopped.
   */
  commandsSnapshot(catalog: SessionCommandsUpdatedPayload | undefined): ProviderRuntimeEvent[] {
    if (this.#stopped || !catalog) return [];
    return [this.base("session.commands.updated", catalog, { turnId: this.#turn })];
  }

  /**
   * Publishes a transient status board. The caller owns the bounded board and
   * drops byte-identical repeats, so nothing here needs to de-duplicate; a
   * stopped session publishes nothing rather than resurrecting dead status.
   */
  noticesSnapshot(board: SessionNoticesUpdatedPayload | undefined): ProviderRuntimeEvent[] {
    if (this.#stopped || !board) return [];
    return [this.base("session.notices.updated", board, { turnId: this.#turn })];
  }

  /**
   * Publishes the root/subagent roster. The caller owns the bounded roster and
   * drops byte-identical repeats; a stopped session publishes nothing, because
   * an observation cannot outlive the session that owned it.
   */
  agentsSnapshot(roster: SessionAgentsUpdatedPayload | undefined): ProviderRuntimeEvent[] {
    if (this.#stopped || !roster) return [];
    return [this.base("session.agents.updated", roster, { turnId: this.#turn })];
  }

  /**
   * Publishes the goal and owned-heartbeat board. The caller owns the bounded
   * board, filters it to schedules this environment created, and drops
   * byte-identical repeats; a stopped session publishes nothing, because a
   * control whose session is gone must not be offered.
   */
  goalsSnapshot(board: SessionGoalsUpdatedPayload | undefined): ProviderRuntimeEvent[] {
    if (this.#stopped || !board) return [];
    return [this.base("session.goals.updated", board, { turnId: this.#turn })];
  }

  /**
   * Cancellation of an interactive request.
   *
   * `projected` names the canonical dialog this id was already published as. A
   * warning alone would leave that dialog pending forever on every client, so a
   * projected request is also resolved — truthfully, as cancelled rather than
   * answered. Requests that were never projected (unsupported method, bound
   * overflow) emit the warning only: there is no dialog to close.
   */
  cancelled(
    id: string,
    reason = "Prime Agent interactive request was cancelled.",
    projected?: "request" | "user-input",
  ): ProviderRuntimeEvent[] {
    const message = reason.slice(0, MAX_NATIVE_STRING);
    const warning = this.base(
      "runtime.warning",
      { message },
      { providerRefs: { providerRequestId: id } },
    );
    if (!projected) return [warning];
    return [
      ...this.resolved(
        id,
        projected,
        projected === "request"
          ? { decision: "cancel", resolution: { cancelled: true, reason: message } }
          : { answers: {}, cancelled: true, reason: message },
      ),
      warning,
    ];
  }

  resolved(
    id: string,
    kind: "request" | "user-input",
    payload: Record<string, unknown>,
  ): ProviderRuntimeEvent[] {
    const requestId = RuntimeRequestId.make(id);
    return [
      this.base(kind === "request" ? "request.resolved" : "user-input.resolved", payload, {
        requestId,
        providerRefs: { providerRequestId: id },
      }),
    ];
  }
  abort(reason = "Prime Agent turn was interrupted."): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    const out: ProviderRuntimeEvent[] = [];
    if (this.#turn && !this.#ended) {
      this.#ended = true;
      out.push(this.base("turn.aborted", { reason }, { turnId: this.#turn }));
    }
    return out;
  }

  finishGracefully(reason = "Prime Agent RPC session exited."): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    const out: ProviderRuntimeEvent[] = [];
    if (!this.#ended && this.#turn) {
      this.#ended = true;
      out.push(this.base("turn.completed", { state: "completed" }, { turnId: this.#turn }));
    }
    out.push(this.base("session.exited", { exitKind: "graceful", reason }));
    this.#stopped = true;
    return out;
  }

  stop(reason: string): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    const out: ProviderRuntimeEvent[] = [];
    if (!this.#ended && this.#turn) {
      this.#ended = true;
      out.push(
        this.base(
          "turn.completed",
          { state: "failed", errorMessage: reason },
          { turnId: this.#turn },
        ),
      );
    }
    out.push(this.base("runtime.error", { class: "transport_error", message: reason }));
    out.push(this.base("session.exited", { exitKind: "error", reason, recoverable: true }));
    this.#stopped = true;
    return out;
  }

  private base(type: string, payload: any, extra: any = {}): ProviderRuntimeEvent {
    return {
      eventId: EventId.make(`prime-event-${++this.#seq}`),
      provider: PROVIDER,
      ...(this.#instance ? { providerInstanceId: this.#instance } : {}),
      threadId: this.#threadId,
      createdAt: this.#now(),
      type,
      ...extra,
      payload,
    } as ProviderRuntimeEvent;
  }
}
