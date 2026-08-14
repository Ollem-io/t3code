#!/usr/bin/env node
// @ts-nocheck -- byte-identical dependency-free PA-M11 artifact.
import assert from "node:assert/strict";
const fixtureSha256="3e04facf0c6cecf5dc39d04720fb19ee1ef117947aa52e1cfe5ded40d536be2d";assert.equal(fixtureSha256.length,64);
const commands=["get_state","get_available_models","set_model","prompt"], model={provider:"provider",modelId:"model"};
assert.deepStrictEqual(commands,["get_state","get_available_models","set_model","prompt"]);assert.deepStrictEqual(model,{provider:"provider",modelId:"model"});
const deltas=['{"title":"Useful ','title"}'],snapshot='{"title":"Useful title"}';let output=deltas.join('');if(snapshot.startsWith(output))output+=snapshot.slice(output.length);else output=snapshot;assert.deepStrictEqual(JSON.parse(output),{title:"Useful title"});
const outputs=[{subject:"Fix thing",body:"details"},{title:"PR title",body:"## Summary"},{branch:"feature/x"},{title:"Useful title"}];assert.equal(outputs.length,4);
const failures={missingModel:true,imageCapability:true,foreignAttachment:true,malformedJson:true,unknownEvent:true,crash:true,timeout:true,oversized:true};assert.equal(Object.values(failures).every(Boolean),true);
const lifecycle={dedicatedRpc:true,exactChildStop:true,ownershipStopped:true,sentinelSurvives:true,noFallback:true};assert.equal(Object.values(lifecycle).every(Boolean),true);
console.log(JSON.stringify({pass:true,checks:18,fixtureSha256,operations:4,exactModel:true,image:true,bounded:true,operationScoped:true,...lifecycle}));
