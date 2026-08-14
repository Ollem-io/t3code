import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { PrimeEventNormalizer } from "./PrimeEventNormalizer.ts";
const n=(events:any[])=>{const x=new PrimeEventNormalizer(ThreadId.make("thread-test"),{now:()=>"2020-01-01T00:00:00.000Z"}); return events.flatMap(value=>x.drain({_tag:"known-event",value} as any));};
describe("PrimeEventNormalizer",()=>{
 it("maps lifecycle and terminalizes turn once",()=>{const out=n([{type:"turn_start"},{type:"turn_end",message:{},toolResults:[]},{type:"agent_end",messages:[]}]); expect(out.map(x=>x.type)).toEqual(["turn.started","turn.completed","session.exited"]);});
 it("coalesces accumulated tool updates",()=>{const out=n([{type:"turn_start"},{type:"tool_execution_start",toolCallId:"x",toolName:"sh",args:{}},{type:"tool_execution_update",toolCallId:"x",toolName:"sh",args:{},partialResult:"a"},{type:"tool_execution_update",toolCallId:"x",toolName:"sh",args:{},partialResult:"ab"},{type:"tool_execution_update",toolCallId:"x",toolName:"sh",args:{},partialResult:"ab"}]); expect(out.filter(x=>x.type==="content.delta").map(x=>(x as any).payload.delta)).toEqual(["a","b"]);});
 it("warns unknown event",()=>{const x=new PrimeEventNormalizer(ThreadId.make("thread-test"),{warn:()=>{}}); expect(x.drain({_tag:"unknown-event",type:"future",value:{}} as any)[0]?.type).toBe("runtime.warning");});
});
