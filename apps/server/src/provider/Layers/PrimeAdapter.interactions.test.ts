import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { PrimeEventNormalizer } from "../prime/PrimeEventNormalizer.ts";
describe("PrimeAdapter interactions", () => { it("correlates canonical resolutions", () => { const n = new PrimeEventNormalizer(ThreadId.make("t")); const [event] = n.resolved("req", "user-input", { answers: { req: "yes" } }); assert.equal(event.type, "user-input.resolved"); assert.equal(event.requestId, "req"); }); });
