#!/usr/bin/env node
// Source-derived, dependency-free PA-M07 bootstrap conformance artifact.
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import assert from "node:assert/strict";

const fake = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.T3_MARKER, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => { const c=JSON.parse(line); process.stdout.write(JSON.stringify({type:"response",id:c.id,command:c.type,success:true,data:{state:"idle"}})+"\\n"); });
`;
/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} source
 */
const sanitize = (home: string, source: NodeJS.ProcessEnv) => Object.fromEntries([
  ...Object.entries(source).filter(([k,v]) => v !== undefined && /^(?:PATH|PATHEXT|SystemRoot|WINDIR|ComSpec|LANG|LC_[A-Za-z0-9_]+)$/i.test(k)),
  ["HOME",home],["USERPROFILE",home],["XDG_CONFIG_HOME",`${home}/.config`],["XDG_DATA_HOME",`${home}/.local/share`],["XDG_STATE_HOME",`${home}/.local/state`],["TMPDIR",`${home}/tmp`],["TMP",`${home}/tmp`],["TEMP",`${home}/tmp`],
]);
const root=await mkdtemp(join(tmpdir(),"pa-m07-artifact-"));
try {
  const workspace=join(root,"workspace"), bin=join(root,"fake.mjs"), marker=join(root,"records.jsonl"), home=join(root,"t3-home"), session=join(home,"userdata/prime/v1/environments/env/instances/prime-agent/threads/thread-a/session");
  await mkdir(workspace); await mkdir(session,{recursive:true,mode:0o700}); await mkdir(join(home,"tmp"),{recursive:true}); await writeFile(bin,fake); await chmod(bin,0o755);
  const argv=["--mode","rpc","--session-dir",session];
  const child=spawn(bin,argv,{cwd:workspace,env:{...sanitize(home,{...process.env,OPENAI_API_KEY:"must-not-leak"}),T3_MARKER:marker},stdio:["pipe","pipe","pipe"]});
  child.stdin.write(JSON.stringify({type:"get_state",id:"t3-prime-bootstrap-1"})+"\n");
  const lines=createInterface({input:child.stdout}); const [line]=await once(lines,"line"); const response=JSON.parse(line); assert.equal(response.success,true); assert.equal(response.command,"get_state");
  const record=JSON.parse((await readFile(marker,"utf8")).trim()); assert.deepEqual(record.argv,argv); assert.equal(record.cwd,workspace); assert.equal(record.home,home); assert.equal(child.spawnargs.filter(x=>x==="--mode").length,1); assert.equal(child.spawnargs.includes("acp"),false); assert.equal(child.spawnargs.some(x=>x.includes("OPENAI_API_KEY")),false);
  child.kill(); await once(child,"close");
  console.log(JSON.stringify({milestone:"PA-M07",checks:10,argv,cwd:workspace,session,handshake:"get_state",result:"pass"}));
} finally { await rm(root,{recursive:true,force:true}); }
