// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { makePrimeAdapter } from "./PrimeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const INSTANCE = ProviderInstanceId.make("prime-agent");
const THREAD = ThreadId.make("interactive-thread");
// A real child process: prompts deterministically produce extension_ui_request records.
const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
const log=(x)=>appendFileSync(process.env.MARKER,JSON.stringify(x)+"\\n");
const models={models:[{id:"model",name:"Model",api:"api",provider:"provider",baseUrl:"",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:1000,maxTokens:100,thinkingLevelMap:{}}]}; let failed=false;
const out=x=>process.stdout.write(JSON.stringify(x)+"\\n"); const emit=x=>setTimeout(()=>out({type:"extension_ui_request",...x}),5);
createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{const c=JSON.parse(line);log(c);
 if(c.type==="get_available_models") return out({type:"response",id:c.id,command:c.type,success:true,data:models});
 if(c.type==="extension_ui_response" && process.env.FAIL_ONCE && !failed){failed=true; return out({type:"response",id:c.id,command:c.type,success:false,error:"first response rejected"});}
 out({type:"response",id:c.id,command:c.type,success:true,data:{state:"idle"}}); if(c.type!=="prompt") return; out({type:"turn_start"}); const m=c.message;
 if(m.includes("duplicate")){emit({id:"r-dup",method:"input",title:"Dup"});emit({id:"r-dup",method:"input",title:"Dup"});}
 else if(m.includes("overflow")){for(let i=0;i<129;i++)emit({id:"r-over-"+i,method:"input",title:"Over"});}
 else if(m.includes("crash")){emit({id:"r-crash",method:"input",title:"Crash"});setTimeout(()=>process.exit(19),15);}
 else if(m.includes("select")) emit({id:"r-select",method:"select",title:"Pick",options:["one","two"]}); else if(m.includes("confirm")) emit({id:"r-confirm",method:"confirm",title:"Approve",message:"Run it?"}); else if(m.includes("input")) emit({id:"r-input",method:"input",title:"Name"}); else if(m.includes("editor")) emit({id:"r-editor",method:"editor",title:"Edit",prefill:"old"}); else if(m.includes("unsupported")) emit({id:"r-unsupported",method:"notify",message:"no"});
});`;
const setup = Effect.acquireRelease(Effect.promise(async()=>{const root=await mkdtemp(join(tmpdir(),"prime-interactive-"));const cwd=join(root,"cwd"),binary=join(root,"fake.mjs"),marker=join(root,"commands");await mkdir(cwd);await writeFile(binary,fakeSource);await chmod(binary,0o755);return {root,cwd,binary,marker};}), f=>Effect.promise(()=>rm(f.root,{recursive:true,force:true})));
const mkdir = async (x:string) => (await import("node:fs/promises")).mkdir(x);
const input=(f:{cwd:string})=>({threadId:THREAD,provider:PROVIDER,providerInstanceId:INSTANCE,cwd:f.cwd,runtimeMode:"approval-required" as const});
const make= (f:any) => makePrimeAdapter({binaryPath:f.binary},{instanceId:INSTANCE,environmentId:"env",home:join(f.root,"home"),enabled:true,launch:(c,a,o)=>spawnPrimeRpcTransport(c,a,{...(o??{}),env:{...(o?.env??{}),MARKER:f.marker,...(f.failOnce?{FAIL_ONCE:"1"}:{})}})});
const commands=(file:string)=>Effect.promise(async()=> (await readFile(file,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(x=>JSON.parse(x)));
const start=(f:any)=>Effect.gen(function*(){const a=yield* make(f);yield* a.startSession(input(f));return a;});
const turn=(a:any,f:any,word:string)=>a.sendTurn({threadId:THREAD,input:word,modelSelection:{instanceId:INSTANCE,model:"model",nativeIdentity:{provider:"provider",modelId:"model"}}});
const next=(a:any)=>Stream.runHead(a.streamEvents).pipe(Effect.map((x:any)=>x._tag==="Some"?x.value:undefined));
const eventPair=(a:any,f:any,word:string)=>Effect.gen(function*(){yield* turn(a,f,word);let e=yield* next(a);if(e.type==="turn.started") e=yield* next(a);return e;});

describe("PrimeAdapter extension UI end-to-end",()=>{
 it.effect("projects select and resolves with the exact value command",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);const e=yield* eventPair(a,f,"select");assert.equal(e.type,"user-input.requested");yield* a.respondToUserInput(THREAD,"r-select",{ "r-select":"two"});const r=yield* next(a);assert.equal(r.type,"user-input.resolved");const cs=yield* commands(f.marker);assert.deepStrictEqual(cs.at(-1),{type:"extension_ui_response",id:"r-select",value:"two"});})));
 it.effect("projects confirm and resolves accept",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);const e=yield* eventPair(a,f,"confirm");assert.equal(e.type,"request.opened");yield* a.respondToRequest(THREAD,"r-confirm","accept");const r=yield* next(a);assert.equal(r.type,"request.resolved");const cs=yield* commands(f.marker);assert.deepStrictEqual(cs.at(-1),{type:"extension_ui_response",id:"r-confirm",confirmed:true});})));
 it.effect("projects input and resolves its canonical answer",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);assert.equal((yield* eventPair(a,f,"input")).type,"user-input.requested");yield* a.respondToUserInput(THREAD,"r-input",{"r-input":"Alice"});assert.equal((yield* next(a)).type,"user-input.resolved");const cs=yield* commands(f.marker);assert.deepStrictEqual(cs.at(-1),{type:"extension_ui_response",id:"r-input",value:"Alice"});})));
 it.effect("projects editor as canonical user input and responds exactly",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);assert.equal((yield* eventPair(a,f,"editor")).type,"user-input.requested");yield* a.respondToUserInput(THREAD,"r-editor",{"r-editor":"new text"});assert.equal((yield* next(a)).type,"user-input.resolved");const cs=yield* commands(f.marker);assert.deepStrictEqual(cs.at(-1),{type:"extension_ui_response",id:"r-editor",value:"new text"});})));
 it.effect("cancels unsupported requests and emits canonical warning",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);const e=yield* eventPair(a,f,"unsupported");assert.equal(e.type,"runtime.warning");const cs=yield* commands(f.marker);assert.deepStrictEqual(cs.at(-1),{type:"extension_ui_response",id:"r-unsupported",cancelled:true});})));
 it.effect("rejects an invalid select without sending a response",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);yield* eventPair(a,f,"select");const x=yield* Effect.exit(a.respondToUserInput(THREAD,"r-select",{"r-select":"bad"}));assert.equal(x._tag,"Failure");const cs=yield* commands(f.marker);assert.equal(cs.filter((c:any)=>c.type==="extension_ui_response").length,0);})));
 it.effect("aborts once and remains reusable for a subsequent prompt",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);yield* turn(a,f,"input");yield* next(a);yield* a.interruptTurn(THREAD);const aborted=yield* next(a);assert.equal(aborted.type,"turn.aborted");yield* a.interruptTurn(THREAD).pipe(Effect.ignore);assert.equal((yield* eventPair(a,f,"select")).type,"user-input.requested");})));
 it.effect("stop emits exact terminal sequence and preserves the child sentinel",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);yield* turn(a,f,"input");yield* next(a);const fiber=yield* Effect.forkChild(Stream.runCollect(Stream.take(a.streamEvents,3)));yield* a.stopSession(THREAD);const es=Array.from(yield* Fiber.join(fiber));assert.deepStrictEqual(es.map((e:any)=>e.type),["turn.completed","runtime.error","session.exited"]);assert.equal(yield* a.hasSession(THREAD),false);})));
 it.effect("cancels duplicate ids exactly once",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);yield* turn(a,f,"duplicate");assert.equal((yield* next(a)).type,"turn.started");assert.equal((yield* next(a)).type,"user-input.requested");assert.equal((yield* next(a)).type,"runtime.warning");const cs=yield* commands(f.marker);const rs=cs.filter((c:any)=>c.type==="extension_ui_response");assert.equal(rs.length,1);assert.deepStrictEqual(rs.map((c:any)=>c.id),["r-dup"]);assert.equal(yield* a.hasSession(THREAD),true);})));
 it.effect("retains pending request after failed response for retry",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup; (f as any).failOnce=true; const a=yield* start(f);assert.equal((yield* eventPair(a,f,"input")).type,"user-input.requested");const first=yield* Effect.exit(a.respondToUserInput(THREAD,"r-input",{"r-input":"Alice"}));assert.equal(first._tag,"Failure");yield* a.respondToUserInput(THREAD,"r-input",{"r-input":"Alice"}); })));
 it.effect("crash clears pending session and emits terminal once",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);assert.equal((yield* eventPair(a,f,"crash")).type,"user-input.requested");const es=yield* Stream.runCollect(Stream.take(a.streamEvents,3));assert.equal(yield* a.hasSession(THREAD),false);assert.equal(Array.from(es).filter((e:any)=>e.type==="session.exited").length,1);})));
 it.effect("bounds pending requests and cancels overflow without losing canonical records",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* start(f);yield* turn(a,f,"overflow");const es=Array.from(yield* Stream.runCollect(Stream.take(a.streamEvents,130)));assert.equal(es.filter((e:any)=>e.type==="user-input.requested").length,128);assert.equal(es.filter((e:any)=>e.type==="runtime.warning").length,1);const cs=yield* commands(f.marker);assert.equal(cs.filter((c:any)=>c.type==="extension_ui_response"&&c.cancelled===true).length,1);})));
 it.effect("stopAll terminates every exact child and leaves no sessions",()=>Effect.scoped(Effect.gen(function*(){const f=yield* setup,a=yield* make(f);const t2=ThreadId.make("second");yield* a.startSession(input(f));yield* a.startSession({...input(f),threadId:t2});yield* a.stopAll();assert.equal((yield* a.listSessions()).length,0);assert.equal((yield* commands(f.marker)).filter((c:any)=>c.type==="get_state").length,2);})));
});
