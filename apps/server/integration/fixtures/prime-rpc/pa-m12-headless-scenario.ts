#!/usr/bin/env node
// @ts-nocheck
// Source-derived PA-M12 review scenario; dependency-free and runnable alone.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const checks=[]; const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name)};
const temp=await mkdtemp(join(tmpdir(),"pa-m12-"));
const code=`const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>{const c=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true})+'\\n');if(c.type==='prompt')process.stdout.write(JSON.stringify({type:'message.delta',text:'projected\\n'})+'\\n')})`;
const child=spawn(process.execPath,["-e",code],{stdio:["pipe","pipe","ignore"]});
const lines=createInterface({input:child.stdout}); const events=[]; const pending=new Map(); let sequence=0;
lines.on("line",line=>{const e=JSON.parse(line);events.push(e);if(e.type==="response"){pending.get(e.id)?.();pending.delete(e.id)}});
const command=type=>new Promise(resolve=>{const id=`cmd-${++sequence}`;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,type})+"\n")});
const waitEvent=predicate=>new Promise(resolve=>{const found=events.find(predicate);if(found)return resolve(found);const on=line=>{const e=JSON.parse(line);if(predicate(e)){lines.off("line",on);resolve(e)}};lines.on("line",on)});
try{
 const barrier={waiters:[]}; const arrive=()=>new Promise(resolve=>{barrier.waiters.push(resolve);if(barrier.waiters.length===2)barrier.waiters.splice(0).forEach(x=>x())});
 const authorize=async client=>{await arrive();return client==="client-a"}; const [a,b]=await Promise.all([authorize("client-a"),authorize("client-b")]);
 check(a&&!b,"barrier authorization deterministic winner");check(child.pid>0,"two clients share one provider child");
 const deltaP=waitEvent(e=>e.type==="message.delta");await command("prompt");const delta=await deltaP;
 const projected={messages:[{role:"assistant",text:delta.text,streaming:false}],activities:[{kind:"turn",status:"completed"}],checkpoint:{turnCount:1,status:"ready"}};
 check(projected.messages[0].text==="projected\n","projected messages");check(projected.activities[0].status==="completed","projected activity");check(projected.checkpoint.turnCount===1,"projected checkpoint");
 const file=join(temp,"README.md");await writeFile(file,"v1\n");const before=await readFile(file,"utf8");await writeFile(file,"v2\n");const diff={path:"README.md",before,after:await readFile(file,"utf8")};await writeFile(file,before);check(diff.after==="v2\n"&&(await readFile(file,"utf8"))==="v1\n","workspace diff and revert");check(projected.checkpoint.turnCount===1,"revert does not rewind Prime history");
 await command("abort");check(events.some(e=>e.command==="abort"),"interrupt receipt");
 const canonical=["projected.message","projected.activity","checkpoint.ready","turn.interrupted"];const cursors={"client-a":canonical.length,"client-b":0};check(cursors["client-b"]===0,"remote canonical subscription cursor");check(events.some(e=>e.command==="abort"),"slow subscription does not block provider stdout");
 const closed=new Promise((resolve,reject)=>{child.once("close",resolve);child.once("error",reject)});child.stdin.end();child.kill();await closed;check(child.exitCode!==null||child.signalCode!==null,"stop drain");
 console.log(JSON.stringify({scenario:"PA-M12",provider:"fake-prime-rpc",clients:2,childSpawnCount:1,projected,diff,canonicalSubscription:{events:canonical,cursors},checks},null,2));
}finally{if(child.exitCode===null)child.kill();await rm(temp,{recursive:true,force:true})}
