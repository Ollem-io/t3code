import { assert, it } from "@effect/vitest";
import { decodePrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";

it("decodes correlated 0.7.2 success responses", () => {
  const result = decodePrimeRpcEnvelope({ id: "request-1", type: "response", command: "get_available_models", success: true, data: { models: [] } });
  assert.strictEqual(result._tag, "response");
  if (result._tag === "response") assert.strictEqual(result.value.id, "request-1");
});

it("fails missing required fields as a local compatibility error", () => {
  const result = decodePrimeRpcEnvelope({ id: 7, type: "get_available_models" });
  assert.strictEqual(result._tag, "malformed");
  if (result._tag === "malformed") assert.strictEqual(result.error._tag, "PrimeRpcCompatibilityError");
  assert.strictEqual(decodePrimeRpcEnvelope({ id: "request-2", type: "response", command: "get_available_models", success: true, data: { models: [{ id: "missing-required-fields" }] } })._tag, "malformed");
});

it("accepts additive fields and classifies unknown events", () => {
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "agent_start", futureField: true })._tag, "known-event");
  const unknown = decodePrimeRpcEnvelope({ type: "future_event", futureField: true });
  assert.strictEqual(unknown._tag, "unknown-event");
});

it("validates image inputs and extension UI response commands", () => {
  assert.strictEqual(decodePrimeRpcEnvelope({ id: "p", type: "prompt", message: "synthetic", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "extension_ui_response", id: "ui-1", confirmed: true })._tag, "command");
});
