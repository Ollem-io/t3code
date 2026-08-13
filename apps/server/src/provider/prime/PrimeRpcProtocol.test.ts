import { assert, it } from "@effect/vitest";
import { decodePrimeRpcEnvelope } from "./PrimeRpcProtocol.ts";

const model = {
  id: "model-1", name: "Fixture model", api: "openai-completions", provider: "fixture-provider",
  baseUrl: "https://example.invalid", reasoning: true, input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, contextWindow: 1000, maxTokens: 100,
};

it("decodes correlated 0.7.2 success responses and declaration-shaped models", () => {
  const result = decodePrimeRpcEnvelope({ id: "request-1", type: "response", command: "get_available_models", success: true, data: { models: [{ ...model, headers: { "x-fixture": "safe" }, compat: { future: true } }] } });
  assert.strictEqual(result._tag, "response");
  if (result._tag === "response") assert.strictEqual(result.value.id, "request-1");
});

it("fails missing required fields as a local compatibility error", () => {
  const result = decodePrimeRpcEnvelope({ id: 7, type: "get_available_models" });
  assert.strictEqual(result._tag, "malformed");
  if (result._tag === "malformed") assert.strictEqual(result.error._tag, "PrimeRpcCompatibilityError");
  assert.strictEqual(decodePrimeRpcEnvelope({ id: "request-2", type: "response", command: "get_available_models", success: true, data: { models: [{ ...model, cost: { input: 1 } }] } })._tag, "malformed");
});

it("accepts additive fields and classifies unknown events", () => {
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "agent_start", futureField: true })._tag, "known-event");
  const unknown = decodePrimeRpcEnvelope({ type: "future_event", futureField: true });
  assert.strictEqual(unknown._tag, "unknown-event");
});

it("validates image inputs and thinking levels", () => {
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "new_session", parentSession: "fixture-parent" })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "new_session", parentSession: 7 })._tag, "malformed");
  assert.strictEqual(decodePrimeRpcEnvelope({ id: "p", type: "prompt", message: "synthetic", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "set_thinking_level", level: "max" })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "set_thinking_level", level: "off" })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "set_thinking_level", level: "ultra" })._tag, "malformed");
});

it("decodes declaration-shaped tool and extension UI envelopes", () => {
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "message_update", message: {}, assistantMessageEvent: {} })._tag, "known-event");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "message_update", message: {} })._tag, "malformed");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "tool_execution_end", toolCallId: "call-1", toolName: "fixture_tool", result: { ok: true }, isError: false })._tag, "known-event");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "tool_execution_end", toolCallId: "call-1", toolName: "fixture_tool", args: {}, result: "ok", isError: false })._tag, "known-event");
  const extensionRequests = [
    { type: "extension_ui_request", id: "select", method: "select", title: "Synthetic", options: ["one"] },
    { type: "extension_ui_request", id: "confirm", method: "confirm", title: "Synthetic", message: "Synthetic" },
    { type: "extension_ui_request", id: "input", method: "input", title: "Synthetic" },
    { type: "extension_ui_request", id: "editor", method: "editor", title: "Synthetic" },
    { type: "extension_ui_request", id: "notify", method: "notify", message: "Synthetic" },
    { type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "key" },
    { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "key" },
    { type: "extension_ui_request", id: "title", method: "setTitle", title: "Synthetic" },
    { type: "extension_ui_request", id: "editor-text", method: "set_editor_text", text: "Synthetic" },
  ];
  for (const request of extensionRequests) assert.strictEqual(decodePrimeRpcEnvelope(request)._tag, "known-event");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "extension_ui_response", id: "ui-1", value: "picked" })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "extension_ui_response", id: "ui-2", confirmed: false })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "extension_ui_response", id: "ui-3", cancelled: true })._tag, "command");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "extension_ui_response", id: "empty" })._tag, "malformed");
  assert.strictEqual(decodePrimeRpcEnvelope({ type: "extension_ui_response", id: "ambiguous", value: "x", confirmed: true })._tag, "malformed");
});
