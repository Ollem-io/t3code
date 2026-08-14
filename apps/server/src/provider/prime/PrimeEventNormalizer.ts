import { createHash } from "node:crypto";
import { ProviderDriverKind, type ProviderRuntimeEvent, type ThreadId, type TurnId } from "@t3tools/contracts";
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
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export class PrimeEventNormalizer {
  readonly #threadId: ThreadId; readonly #instance?: string; readonly #now: () => string; readonly #warn?: (s: string) => void;
  #turn?: TurnId; #stopped = false; #ended = false; #seq = 0; readonly #tools = new Map<string,string>(); readonly #warned = new Set<string>();
  constructor(threadId: ThreadId, options: PrimeEventNormalizerOptions = {}) { this.#threadId=threadId; this.#instance=options.providerInstanceId; this.#now=options.now ?? (()=>new Date().toISOString()); this.#warn=options.warn; }
  drain(envelope: PrimeRpcEnvelope): ProviderRuntimeEvent[] {
    if (this.#stopped) return [];
    if (envelope._tag === "unknown-event") { if (!this.#warned.has(envelope.type)) { this.#warned.add(envelope.type); this.#warn?.(`Unknown Prime event: ${envelope.type}`); } return [this.base("runtime.warning", {message:`Unknown Prime event: ${envelope.type}`})]; }
    if (envelope._tag !== "known-event") return [];
    const e=envelope.value as PrimeRpcKnownEvent; const out: ProviderRuntimeEvent[]=[]; const emit=(type: string,payload: any, extra:any={})=>out.push(this.base(type,payload,extra));
    switch(e.type) {
      case "agent_start": emit("session.state.changed",{state:"running"}); emit("thread.started",{}); break;
      case "agent_end": if (!this.#ended) { this.#ended=true; emit("turn.completed",{state:"completed"},{turnId:this.#turn}); emit("session.exited",{exitKind:"graceful"}); this.#stopped=true; } break;
      case "turn_start": this.#turn=TurnId.make(`prime-${++this.#seq}`); emit("turn.started",{}); break;
      case "turn_end": if (!this.#ended) { this.#ended=true; emit("turn.completed",{state:"completed"},{turnId:this.#turn}); } break;
      case "message_start": { const m=e.message as any; const role=m?.role; const item=RuntimeItemId.make(`prime-message-${this.#seq}`); if(role === "assistant") emit("item.started",{itemType:"assistant_message",status:"inProgress"},{turnId:this.#turn,itemId:item}); else if(role === "user") emit("item.started",{itemType:"user_message",status:"completed"},{turnId:this.#turn,itemId:item}); break; }
      case "message_update": { const m=e.message as any; const delta=textOf((e as any).assistantMessageEvent) || textOf(m?.content); if(delta) emit("content.delta",{streamKind: m?.role === "assistant" ? "assistant_text" : "unknown",delta},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-message-${this.#seq}`)}); break; }
      case "message_end": emit("item.completed",{itemType:(e.message as any)?.role === "assistant" ? "assistant_message" : "user_message",status:"completed"},{turnId:this.#turn}); break;
      case "tool_execution_start": emit("item.started",{itemType:"dynamic_tool_call",status:"inProgress",title:e.toolName,args:e.args},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${e.toolCallId}`),providerRefs:{providerItemId:e.toolCallId}}); break;
      case "tool_execution_update": { const id=e.toolCallId; const full=textOf(e.partialResult); const prior=this.#tools.get(id) ?? ""; if(full.startsWith(prior)) { const delta=full.slice(prior.length); this.#tools.set(id,full); if(delta) emit("content.delta",{streamKind:"command_output",delta},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${id}`),providerRefs:{providerItemId:id}}); } else if(hash(full)!==hash(prior)) { this.#tools.set(id,full); emit("item.updated",{itemType:"dynamic_tool_call",status:"inProgress",data:{replacement:full,fingerprint:hash(full)}},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${id}`),providerRefs:{providerItemId:id}}); } break; }
      case "tool_execution_end": emit("item.completed",{itemType:"dynamic_tool_call",status:e.isError?"failed":"completed",data:e.result},{turnId:this.#turn,itemId:RuntimeItemId.make(`prime-tool-${e.toolCallId}`),providerRefs:{providerItemId:e.toolCallId}}); break;
    }
    return out;
  }
  private base(type: string,payload: any, extra:any={}): ProviderRuntimeEvent { return {eventId:EventId.make(`prime-event-${++this.#seq}`),provider:PROVIDER,...(this.#instance?{providerInstanceId:this.#instance}:{}),threadId:this.#threadId,createdAt:this.#now(),type,...extra,payload} as ProviderRuntimeEvent; }
}
