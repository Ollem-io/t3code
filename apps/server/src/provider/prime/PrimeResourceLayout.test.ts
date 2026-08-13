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
    assert.ok(first.ownership.includes("id-ZW52L2E"));
    const hostile = primeResourceLayout({ home: one, environmentId: "../%/é", instanceId: "/", threadId: "..x" });
    assert.ok(hostile.ownership.startsWith(first.root));
    assert.notStrictEqual(primeResourceLayout({ home: one, environmentId: "/" , instanceId: "x", threadId: "t" }).ownership, primeResourceLayout({ home: one, environmentId: "%2F", instanceId: "x", threadId: "t" }).ownership);
    assert.throws(() => primeResourceLayout({ home: one, environmentId: ".", instanceId: "x", threadId: "t" }));
  });
});
