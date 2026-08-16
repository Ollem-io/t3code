// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { assert, describe, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { readPrimeProcessStartToken, provePrimeProcess, stopProvenPrimeProcess } from "./PrimeProcessOwnership.ts";
const waitExit = (child: ReturnType<typeof spawn>) => new Promise<void>((resolve) => child.once("exit", () => resolve()));
describe("PrimeProcessOwnership", () => {
  it("proves and stops only the exact captured process incarnation", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const token = await readPrimeProcessStartToken(child.pid!); assert.ok(token);
    const exact = { pid: child.pid!, startToken: token! };
    assert.equal(await provePrimeProcess(exact), true);
    const exited = waitExit(child);
    assert.equal(await stopProvenPrimeProcess(exact, { timeoutMs: 200 }), true);
    await exited;
    assert.equal(await provePrimeProcess(exact), false);
  });
  it("refuses a mismatched start token and leaves both target and unrelated sentinel alive", async () => {
    const target = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      assert.equal(await stopProvenPrimeProcess({ pid: target.pid!, startToken: "0" }, { timeoutMs: 25 }), false);
      assert.equal(target.exitCode, null); assert.equal(sentinel.exitCode, null);
    } finally { target.kill(); sentinel.kill(); await Promise.all([waitExit(target), waitExit(sentinel)]); }
  });
  it("fails closed for invalid and absent process identities", async () => {
    assert.equal(await readPrimeProcessStartToken(-1), undefined);
    assert.equal(await provePrimeProcess({ pid: 2_147_483_647, startToken: "1" }), false);
  });
});
