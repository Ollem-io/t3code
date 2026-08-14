import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { PrimeEventNormalizer } from "../prime/PrimeEventNormalizer.ts";
describe("PrimeAdapter lifecycle", () => { it("abort does not stop reusable normalizer", () => { const n = new PrimeEventNormalizer(ThreadId.make("t")); n.drain({_tag:"known-event", value:{type:"turn_start"}} as any); assert.equal(n.abort().length, 1); assert.equal(n.drain({_tag:"known-event", value:{type:"turn_start"}} as any).length, 1); }); });
