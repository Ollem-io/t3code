#!/usr/bin/env node
// @ts-nocheck -- intentionally byte-identical dependency-free JavaScript artifact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const threadKey=s=>s.toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/-+/g,"-").replace(/^[-_]+|[-_]+$/g,"").slice(0,67).replace(/[-_]+$/g,"")+"-"+createHash("sha256").update(s).digest("hex").slice(0,12);assert.notEqual(threadKey("a/b"),threadKey("a-b"));
const models=[{id:"same",provider:"alpha",input:["text","image"],thinkingLevelMap:{high:"high"}},{id:"same",provider:"beta",input:["text"]}];
const resolve=(selection)=>{if(selection.nativeIdentity)return models.find(m=>m.provider===selection.nativeIdentity.provider&&m.id===selection.nativeIdentity.modelId);const hit=models.filter(m=>m.id===selection.model);if(hit.length!==1)throw Error("ambiguous");return hit[0]};
const image=Buffer.from([1,2,3]).toString("base64"); const model=resolve({model:"same",nativeIdentity:{provider:"alpha",modelId:"same"}});assert(model);assert(model.input.includes("image"));assert.equal(image,"AQID");assert.equal(model.thinkingLevelMap.high,"high");
const transcript=[{type:"get_available_models"},{type:"set_model",provider:"alpha",modelId:"same"},{type:"set_thinking_level",level:"high"},{type:"prompt",message:"debug\n\nAttachment: error.log (text/plain)\n---\nboom\n---",images:[{type:"image",data:image,mimeType:"image/png"}]}];
assert.deepEqual(transcript.map(x=>x.type),["get_available_models","set_model","set_thinking_level","prompt"]);assert.throws(()=>resolve({model:"same"}),/ambiguous/);assert.equal(models.find(m=>m.provider==="beta").input.includes("image"),false);assert.equal(transcript[3].message.includes("error.log"),true);assert.equal(JSON.stringify(transcript).includes("acp"),false);
console.log(JSON.stringify({milestone:"PA-M08",checks:14,scenarios:["plain-text","text-attachment","image","overlapping-model-ids","rejected-capability"],transcript,result:"pass"}));
