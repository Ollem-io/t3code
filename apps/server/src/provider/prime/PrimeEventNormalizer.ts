import { createHash } from "node:crypto";
import { ProviderDriverKind, type ProviderRuntimeEvent, type ThreadId, TurnId } from "@t3tools/contracts";
import { EventId, RuntimeItemId } from "@t3tools/contracts";
import type { PrimeRpcKnownEvent, PrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";

/** Converts Prime 0.7.2 records to the provider-neutral runtime vocabulary once. */
export interface PrimeEventNormalizerOptions { readonly providerInstanceId?: string; readonly now?: () => string; readonly warn?: (message: string) => void; }
const PROVIDER = ProviderDriverKind.make("prime-agent");
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (!value || typeof value !== "object") return "";
  const x = value as Record<string, unknown>;
  return typeof x.text === "string" ? x.text : typeof x.delta === "string" ? x.delta : typeof x.content === "string" ? x.content : textOf(x.content);
};
const MAX_TOOL_OUTPUT_CHARS = 1_000_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export class PrimeEventNormalizer {
  readonly #threadId: ThreadId; readonly #instance: string | undefined; readonly #now: () => string; readonly #warn: ((s: string) => void) | undefined;
  #turn?: TurnId; #messageItem: RuntimeItemId | undefined; #stopped = false; #ended = false; #seq = 0; readonly #tools = new Map<string,string>(); readonly #warned = new Set<string>();
  constructor(threadId: ThreadId, options: PrimeEventNormalizerOptions = {}) { this.#threadId=threadId; this.#instance=options.providerInstanceId; this.#now=options.now ?? (()=>new Date().toISOString()); this.#warn=options.warn; }
  drain(envelope: PrimeRpcEnvelope): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    if (envelope._tag === "unknown-event") { if (this.#warned.has(envelope.type)) return []; this.#warned.add(envelope.type); this.#warn?.(`Unknown Prime event: ${envelope.type}`); return [this.base("runtime.warning", {message:`Unknown Prime event: ${envelope.type}`})]; }
    if (envelope._tag !== "known-event") return [];
    const e=envelope.value as PrimeRpcKnownEvent; const out: ProviderRuntimeEvent[]=[]; const emit=(type: string,payload: any, extra:any={})=>out.push(this.base(type,payload,extra));
    switch(e.type) {
      case "agent_start": emit("session.state.changed",{state:"running"}); emit("thread.started",{}); break;
      case "agent_end": if (!this.#stopped) { if (!this.#ended && this.#turn) { this.#ended=true; emit("turn.completed",{state:"completed"},{turnId:this.#turn}); } emit("session.exited",{exitKind:"graceful"}); this.#stopped=true; } break;
      case "turn_start": this.#ended=false; this.#turn=TurnId.make(`prime-turn-${++this.#seq}`); emit("turn.started",{},{turnId:this.#turn}); break;
      case "turn_end": if (!this.#ended) { this.#ended=true; emit("turn.completed",{state:"completed"},{turnId:this.#turn}); } break;
      case "message_start": { const m=e.message as Record<string, unknown>; const role=m?.role; this.#messageItem=RuntimeItemId.make(`prime-message-${++this.#seq}`); emit("item.started",{itemType:role === "assistant" ? "assistant_message" : "user_message",status:"inProgress"},{turnId:this.#turn,itemId:this.#messageItem}); break; }
      case "message_update": { const m=e.message as Record<string, unknown>; const native=e.assistantMessageEvent as Record<string, unknown>; const delta=textOf(native.delta) || textOf(native.content) || textOf(m.content); const streamKind=typeof native.type === "string" && native.type.includes("reasoning") ? "reasoning_text" : "assistant_text"; if(delta && this.#messageItem) emit("content.delta",{streamKind,delta},{turnId:this.#turn,itemId:this.#messageItem}); const usage=m.usage as Record<string, unknown> | undefined; const used=usage && typeof usage.totalTokens === "number" ? usage.totalTokens : undefined; if(used !== undefined) emit("thread.token-usage.updated",{usage:{usedTokens:Math.max(0,Math.floor(used))}},{turnId:this.#turn}); break; }
      case "message_end": { const role=(e.message as Record<string, unknown>)?.role; if(this.#messageItem) emit("item.completed",{itemType:role === "assistant" ? "assistant_message" : "user_message",status:"completed"},{turnId:this.#turn,itemId:this.#messageItem}); this.#messageItem=undefined; break; }
      case "tool_execution_start": emit("item.started",{itemType:"dynamic_tool_call",status:"inProgress",title:e.toolName,args:e.args},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${e.toolCallId}`),providerRefs:{providerItemId:e.toolCallId}}); break;
      case "tool_execution_update": { const id=e.toolCallId; const candidate=textOf(e.partialResult); const full=candidate.slice(0,MAX_TOOL_OUTPUT_CHARS); const prior=this.#tools.get(id) ?? ""; if(full.startsWith(prior)) { const delta=full.slice(prior.length); this.#tools.set(id,full); if(delta) emit("content.delta",{streamKind:"command_output",delta},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${id}`),providerRefs:{providerItemId:id}}); } else if(hash(full)!==hash(prior)) { this.#tools.set(id,full); emit("item.updated",{itemType:"dynamic_tool_call",status:"inProgress",data:{replacement:full,fingerprint:hash(full)}},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${id}`),providerRefs:{providerItemId:id}}); } break; }
      case "tool_execution_end": emit("item.completed",{itemType:"dynamic_tool_call",status:e.isError?"failed":"completed",data:e.result},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${e.toolCallId}`),providerRefs:{providerItemId:e.toolCallId}}); break;
    }
    return out;
  }
  stop(reason: string): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    const out: ProviderRuntimeEvent[] = [];
    if (!this.#ended && this.#turn) {
      this.#ended = true;
      out.push(this.base("turn.completed", { state: "failed", errorMessage: reason }, { turnId: this.#turn }));
    }
    out.push(this.base("runtime.error", { class: "transport_error", message: reason }));
    out.push(this.base("session.exited", { exitKind: "error", reason, recoverable: true }));
    this.#stopped = true;
    return out;
  }

  private base(type: string,payload: any, extra:any={}): ProviderRuntimeEvent { return {eventId:EventId.make(`prime-event-${++this.#seq}`),provider:PROVIDER,...(this.#instance?{providerInstanceId:this.#instance}:{}),threadId:this.#threadId,createdAt:this.#now(),type,...extra,payload} as ProviderRuntimeEvent; }
}
