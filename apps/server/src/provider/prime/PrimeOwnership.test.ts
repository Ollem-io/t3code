import { assert, describe, it } from "@effect/vitest";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPrimeOwnership, recoverPrimeOwnership, writePrimeOwnership } from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";

const record = (instanceId: string, pid = 71) => ({ version: 1 as const, environmentId: "env", instanceId, threadIds: ["thread"], process: { pid, startToken: "captured-start" }, rpcSessionId: "rpc", daemonSessionId: "daemon" });
async function expectMissing(path: string): Promise<void> { try { await stat(path); throw new Error("expected ENOENT"); } catch (error) { assert.strictEqual((error as NodeJS.ErrnoException).code, "ENOENT"); } }

const proof = { processMatches: async ({ pid }: { pid: number }) => pid === 71, daemonSessionMatches: async () => true, rpcSessionMatches: async () => true };
describe("PrimeOwnership", () => {
  it("atomically owns and cleans one selected instance, never an unrelated sentinel or another home", async () => {
    const homeA = await mkdtemp(join(tmpdir(), "prime-owned-a-")); const homeB = await mkdtemp(join(tmpdir(), "prime-owned-b-"));
    const a = primeResourceLayout({ home: homeA, environmentId: "env", instanceId: "a", threadId: "thread" }); const b = primeResourceLayout({ home: homeB, environmentId: "env", instanceId: "b", threadId: "thread" });
    await writePrimeOwnership(a.ownership, record("a")); await writePrimeOwnership(b.ownership, record("b", 72)); const sentinel = join(homeA, "unrelated-prime-sentinel"); await writeFile(sentinel, "alive");
    const stopped: number[] = []; await cleanupPrimeOwnership(a.ownership, proof, async ({ pid }) => { stopped.push(pid); });
    assert.deepStrictEqual(stopped, [71]); await expectMissing(a.ownership); assert.ok((await readFile(b.ownership, "utf8")).includes('"instanceId":"b"')); assert.strictEqual(await readFile(sentinel, "utf8"), "alive");
  });
  it("recovers complete records, discards partial writes, warns for corrupt/future/stale records, and does not follow symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-recovery-")); const live = primeResourceLayout({ home, environmentId: "env", instanceId: "live", threadId: "t" }); const stale = primeResourceLayout({ home, environmentId: "env", instanceId: "stale", threadId: "t" }); const corrupt = primeResourceLayout({ home, environmentId: "env", instanceId: "corrupt", threadId: "t" }); const future = primeResourceLayout({ home, environmentId: "env", instanceId: "future", threadId: "t" });
    await writePrimeOwnership(live.ownership, record("live")); await writePrimeOwnership(stale.ownership, record("stale", 99)); await mkdir(corrupt.instance, { recursive: true }); await mkdir(future.instance, { recursive: true }); await writeFile(corrupt.ownership, "{"); await writeFile(future.ownership, JSON.stringify({ ...record("future"), version: 2 })); await writeFile(join(live.instance, ".ownership.json.interrupted.tmp"), "partial");
    const outside = await mkdtemp(join(tmpdir(), "prime-symlink-sentinel-")); const outsideOwnership = join(outside, "ownership.json"); await writeFile(outsideOwnership, JSON.stringify(record("outside"))); await symlink(outside, join(live.root, "linked-outside"));
    const stopped: number[] = []; const actions = await recoverPrimeOwnership(live.root, proof, async ({ pid }) => { stopped.push(pid); });
    assert.deepStrictEqual(stopped, [71]); assert.ok(actions.some((a) => a.kind === "warning" && a.warning.path === stale.ownership)); assert.ok(actions.some((a) => a.kind === "warning" && a.warning.path === corrupt.ownership)); assert.ok(actions.some((a) => a.kind === "warning" && a.warning.path === future.ownership && a.warning.reason.includes("future"))); assert.ok((await readFile(stale.ownership, "utf8")).includes('"pid":99')); assert.strictEqual(await readFile(corrupt.ownership, "utf8"), "{"); await expectMissing(join(live.instance, ".ownership.json.interrupted.tmp")); await stat(outsideOwnership);
  });
  it("leaves session/daemon records without a process and malformed records untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-validation-")); const location = primeResourceLayout({ home, environmentId: "env", instanceId: "x", threadId: "t" }); await mkdir(location.instance, { recursive: true });
    await writeFile(location.ownership, JSON.stringify({ version: 1, environmentId: "env", instanceId: "x", threadIds: [], rpcSessionId: "rpc" })); const actions = await cleanupPrimeOwnership(location.ownership, proof, async () => { throw new Error("must not stop"); }); assert.ok(actions[0]?.kind === "warning"); await stat(location.ownership);
    try { await writePrimeOwnership(location.ownership, { ...record("x"), process: { pid: Number.NaN, startToken: "s" } }); throw new Error("expected validation failure"); } catch (error) { assert.ok((error as Error).message.includes("invalid")); }
  });
});
