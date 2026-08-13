import { assert, describe, it } from "@effect/vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPrimeOwnership, recoverPrimeOwnership, writePrimeOwnership } from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";

const record = (instanceId: string, pid = 71) => ({ version: 1 as const, environmentId: "env", instanceId, threadIds: ["thread"], process: { pid, startToken: "captured-start" }, rpcSessionId: "rpc", daemonSessionId: "daemon" });

describe("PrimeOwnership", () => {
  it("atomically owns and cleans one selected instance, never an unrelated sentinel or another home", async () => {
    const homeA = await mkdtemp(join(tmpdir(), "prime-owned-a-"));
    const homeB = await mkdtemp(join(tmpdir(), "prime-owned-b-"));
    const a = primeResourceLayout({ home: homeA, environmentId: "env", instanceId: "a", threadId: "thread" });
    const b = primeResourceLayout({ home: homeB, environmentId: "env", instanceId: "b", threadId: "thread" });
    await writePrimeOwnership(a.ownership, record("a"));
    await writePrimeOwnership(b.ownership, record("b", 72));
    const sentinel = join(homeA, "unrelated-prime-sentinel"); await writeFile(sentinel, "alive");
    const stopped: number[] = [];
    await cleanupPrimeOwnership(a.ownership, { processMatches: async ({ pid }) => pid === 71, daemonSessionMatches: async (id) => id === "daemon", rpcSessionMatches: async (id) => id === "rpc" }, async ({ pid }) => { stopped.push(pid); });
    assert.deepStrictEqual(stopped, [71]);
    await assert.rejects(stat(a.ownership));
    assert.ok((await readFile(b.ownership, "utf8")).includes('"instanceId":"b"'));
    assert.strictEqual(await readFile(sentinel, "utf8"), "alive");
  });

  it("recovers complete records, discards partial atomic writes, and warns without touching unprovable or corrupt records", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-recovery-"));
    const live = primeResourceLayout({ home, environmentId: "env", instanceId: "live", threadId: "t" });
    const stale = primeResourceLayout({ home, environmentId: "env", instanceId: "stale", threadId: "t" });
    const corrupt = primeResourceLayout({ home, environmentId: "env", instanceId: "corrupt", threadId: "t" });
    await writePrimeOwnership(live.ownership, record("live"));
    await writePrimeOwnership(stale.ownership, record("stale", 99));
    await writeFile(corrupt.ownership, "{");
    await writeFile(join(live.instance, ".ownership.json.interrupted.tmp"), "partial");
    const stopped: number[] = [];
    const actions = await recoverPrimeOwnership(join(home, "userdata", "prime", "v1"), { processMatches: async ({ pid }) => pid === 71, daemonSessionMatches: async () => true, rpcSessionMatches: async () => true }, async ({ pid }) => { stopped.push(pid); });
    assert.deepStrictEqual(stopped, [71]);
    assert.ok(actions.some((action) => action.kind === "warning" && action.warning.path === stale.ownership));
    assert.ok(actions.some((action) => action.kind === "warning" && action.warning.path === corrupt.ownership));
    assert.ok((await readFile(stale.ownership, "utf8")).includes('"pid":99'));
    assert.strictEqual(await readFile(corrupt.ownership, "utf8"), "{");
    await assert.rejects(stat(join(live.instance, ".ownership.json.interrupted.tmp")));
  });
});
