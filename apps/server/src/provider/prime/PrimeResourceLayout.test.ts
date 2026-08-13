import { assert, describe, it } from "@effect/vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";

describe("primeResourceLayout", () => {
  it("makes two homes and instances disjoint while retaining deterministic scoped paths", async () => {
    const one = await mkdtemp(join(tmpdir(), "prime-home-one-"));
    const two = await mkdtemp(join(tmpdir(), "prime-home-two-"));
    const first = primeResourceLayout({ home: one, environmentId: "env/a", instanceId: "instance", threadId: "thread" });
    const again = primeResourceLayout({ home: one, environmentId: "env/a", instanceId: "instance", threadId: "thread" });
    const second = primeResourceLayout({ home: two, environmentId: "env/a", instanceId: "instance", threadId: "thread" });
    const otherInstance = primeResourceLayout({ home: one, environmentId: "env/a", instanceId: "other", threadId: "thread" });
    assert.strictEqual(first.ownership, again.ownership);
    assert.notStrictEqual(first.ownership, second.ownership);
    assert.notStrictEqual(first.ownership, otherInstance.ownership);
    assert.ok(first.ownership.includes("env%2Fa"));
  });
});
