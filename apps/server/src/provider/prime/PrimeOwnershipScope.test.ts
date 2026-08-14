// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverPrimeInstanceOwnership, writePrimeOwnership } from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";
const exists = async (path: string) => stat(path).then(() => true, () => false);
describe("recoverPrimeInstanceOwnership", () => {
  it("stops only exact environment/instance records and retains foreign siblings", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-scope-"));
    try {
      const owned = primeResourceLayout({ home, environmentId: "env", instanceId: "owned", threadId: "thread" });
      const foreign = primeResourceLayout({ home, environmentId: "env", instanceId: "foreign", threadId: "thread" });
      for (const layout of [owned, foreign]) { await mkdir(layout.session, { recursive: true }); await writePrimeOwnership(layout.ownership, { version: 1, environmentId: "env", instanceId: layout === owned ? "owned" : "foreign", threadId: "thread", process: { pid: layout === owned ? 101 : 202, startToken: "token" } }); }
      const stopped: number[] = [];
      await recoverPrimeInstanceOwnership(owned.root, { environmentId: "env", instanceId: "owned" }, { processMatches: async () => true }, { stopProcess: async (h) => { stopped.push(h.pid); }, removeOwnedResource: async () => "retained" });
      assert.deepStrictEqual(stopped, [101]); assert.equal(await exists(owned.ownership), true); assert.equal(await exists(foreign.ownership), true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
