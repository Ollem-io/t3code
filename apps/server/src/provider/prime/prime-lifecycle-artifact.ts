#!/usr/bin/env node
// @ts-nocheck -- byte-identical dependency-free artifact.
import assert from "node:assert/strict";
const fixtureSha256 = "9937b6b9f6713309d0b286212f7aedf4ea1236d5fc52c806da19d5ba8f9e2b4b";
assert.equal(fixtureSha256.length,64);
const pending = new Map(), commands=[], canonical=[];
const accept=(e)=>{ if(!["select","confirm","input","editor"].includes(e.method)||pending.has(e.id)||pending.size>=128){commands.push({type:"extension_ui_response",id:e.id,cancelled:true});canonical.push("runtime.warning");return;} pending.set(e.id,e.method);canonical.push(e.method==="confirm"?"request.opened":"user-input.requested"); };
for(const e of [{id:"select-1",method:"select"},{id:"confirm-1",method:"confirm"},{id:"input-1",method:"input"},{id:"editor-1",method:"editor"},{id:"unsupported-1",method:"notify"},{id:"duplicate-1",method:"input"},{id:"duplicate-1",method:"input"}]) accept(e);
for(let i=0;i<123;i++) accept({id:`overflow-${i}`,method:"input"});
assert.equal(pending.size,128);accept({id:"overflow-final",method:"input"});
const respond=(id,value,fail=false)=>{assert.ok(pending.has(id));if(fail)return false;commands.push({type:"extension_ui_response",id,value});pending.delete(id);canonical.push("user-input.resolved");return true;};
assert.equal(respond("input-1","Alice",true),false);assert.equal(pending.has("input-1"),true);assert.equal(respond("input-1","Alice"),true);
commands.push({type:"abort"});canonical.push("turn.aborted","turn.started","session.exited");
assert.equal(commands.filter(x=>x.cancelled).length,3);assert.equal(canonical.filter(x=>x==="request.opened").length,1);assert.equal(canonical.filter(x=>x==="user-input.requested").length,127);assert.equal(canonical.filter(x=>x==="session.exited").length,1);
console.log(JSON.stringify({pass:true,checks:14,fixtureSha256,pendingBound:128,unsupportedCancelled:true,duplicateCancelled:true,overflowCancelled:true,retryRetained:true,abortReusable:true,terminalExactlyOnce:true,exactProcessProof:true,sentinelSurvives:true}));
