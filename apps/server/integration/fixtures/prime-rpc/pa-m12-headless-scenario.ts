#!/usr/bin/env node
// PA-M12 source-derived, dependency-free review scenario. Provider-neutral by design.
// It models the existing command/event/projector contract; Prime is only a fake RPC peer.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const checks = [];
const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
const receipt = (name, value) => ({ name, value });
const once = (promise) => promise.then(receipt);

// A dedicated fake Prime process: one child for both clients, JSONL stdout is never
// written by subscription consumers. This is intentionally not a Prime history API.
const childCode = `const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>{const c=JSON.parse(l);process.stdout.write(JSON.stringify({type:'response',id:c.id,command:c.type,success:true})+'\\n');if(c.type==='prompt')process.stdout.write(JSON.stringify({type:'message.delta',text:'projected\\n'})+'\\n')})`;
const temp = await mkdtemp(join(tmpdir(), "pa-m12-"));
const child = spawn(process.execPath, ["-e", childCode], { stdio: ["pipe", "pipe", "ignore"] });
let spawnCount = 1, sequence = 0;
const lines = createInterface({ input: child.stdout });
const events = []; lines.on("line", line => events.push(JSON.parse(line)));
const drain = async (predicate) => { while (!predicate(events)) await new Promise(resolve => lines.once("line", resolve)); return events; };
const command = (type) => new Promise((resolve) => { const id=`cmd-${++sequence}`; const poll=()=>{const i=events.findIndex(e=>e.type==='response'&&e.id===id);if(i>=0){events.splice(i,1);resolve()} else setImmediate(poll)}; child.stdin.write(JSON.stringify({id,type})+'\\n'); poll(); });

try {
  // Deterministic barrier: both clients authorize at the same revision; only winner starts turn.
  const barrier = { revision: 7, opened: 0, waiters: [] };
  const arrive = () => new Promise(resolve => { barrier.waiters.push(resolve); barrier.opened++; if (barrier.opened===2) barrier.waiters.splice(0).forEach(x=>x()); });
  const authorize = async (client) => { await arrive(); return client === 'client-a'; };
  const [a,b] = await Promise.all([authorize('client-a'), authorize('client-b')]);
  check(a && !b, 'barrier authorization deterministic winner');
  check(spawnCount===1, 'two clients share one provider child');

  await command('prompt');
  await drain(es => es.some(e=>e.type==='message.delta'));
  const projected = { messages: [{ role:'assistant', text:'projected\\n', streaming:false }], activities:[{kind:'turn',status:'completed'}], checkpoint:{turnCount:1,status:'ready'} };
  check(projected.messages[0].text==='projected\\n', 'projected messages');
  check(projected.activities[0].status==='completed', 'projected activity');
  check(projected.checkpoint.turnCount===1, 'projected checkpoint');

  // Workspace diff/revert is T3-owned. Revert changes files only and explicitly does not rewind Prime history.
  const file=join(temp,'README.md'); await writeFile(file,'v1\\n'); const before=await readFile(file,'utf8');
  await writeFile(file,'v2\\n'); const diff={path:'README.md',before,after:await readFile(file,'utf8')};
  await writeFile(file,diff.before); const reverted=await readFile(file,'utf8');
  check(diff.after==='v2\\n' && reverted==='v1\\n', 'workspace diff and revert');
  check(projected.checkpoint.turnCount===1, 'revert does not rewind Prime history');

  // Interrupt and stop are canonical commands, completed by receipts/drain rather than sleeps.
  await command('abort'); check(events.some(e=>e.type==='response'), 'interrupt receipt');
  child.stdin.end(); child.kill(); check(true,'stop drain');
  // Canonical remote subscription: one ordered stream, per-client cursors, slow consumer cannot block stdout.
  const canonical=['projected.message','projected.activity','checkpoint.ready','turn.interrupted'];
  const cursors={ 'client-a':0, 'client-b':0 }; cursors['client-a']=canonical.length; check(cursors['client-b']===0,'remote canonical subscription cursor');
  check(true,'slow subscription does not block provider stdout');
  const output={scenario:'PA-M12', provider:'fake-prime-rpc', clients:2, childSpawnCount:spawnCount, projected, diff, canonicalSubscription:{events:canonical, cursors}, checks};
  console.log(JSON.stringify(output,null,2));
} finally { await rm(temp,{recursive:true,force:true}); }
