import assert from "node:assert/strict";
import { derivePrimeHealthState, seedInstructions } from "./pa-m13-ui-state-artifact.mjs";
const state = derivePrimeHealthState({ version: "1.2.3", compatibility: "compatible", auth: { status: "authenticated" }, checkedAt: "2026-01-01T00:00:00Z", models: [{ availability: "stale" }, { availability: "available" }], availability: "unavailable", unavailableReason: "Bound device has no Prime Agent driver." });
assert.deepEqual(state, { version: "1.2.3", compatibility: "compatible", auth: "authenticated", staleModels: 1, lastChecked: "2026-01-01T00:00:00Z", unavailable: true, unavailableMessage: "Bound device has no Prime Agent driver." });
assert.equal(seedInstructions.prohibited.includes("API key fields"), true);
console.log("PA-M13 artifact checks passed");
