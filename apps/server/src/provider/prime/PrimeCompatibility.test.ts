import { assert, describe, it } from "@effect/vitest";
import { classifyPrimeCompatibility, MINIMUM_PRIME_AGENT_VERSION } from "./PrimeCompatibility.ts";

describe("PrimeCompatibility", () => {
  it("blocks below minimum, certifies baseline, and advises unknown newer", () => {
    assert.strictEqual(MINIMUM_PRIME_AGENT_VERSION, "0.7.2");
    assert.strictEqual(classifyPrimeCompatibility("0.7.1"), "incompatible");
    assert.strictEqual(classifyPrimeCompatibility("0.7.2"), "compatible");
    assert.strictEqual(classifyPrimeCompatibility("0.7.2+known-bad"), "incompatible");
    assert.strictEqual(classifyPrimeCompatibility("0.8.0"), "advisory");
  });
});
