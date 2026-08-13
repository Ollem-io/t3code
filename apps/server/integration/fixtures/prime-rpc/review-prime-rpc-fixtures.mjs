#!/usr/bin/env node
// Standalone review artifact for the redacted 0.7.2 JSONL corpus. No source or packages required.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const expected = {
  "normal.jsonl": ["command", "response", "command", "command", "known-event", "known-event", "known-event", "known-event", "command"],
  "additive-field.jsonl": ["response", "known-event"],
  "malformed.jsonl": Array(12).fill("malformed"),
  "unknown-event.jsonl": ["unknown-event"],
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const optionalString = (value, key) => !own(value, key) || typeof value[key] === "string";
const image = (value) => object(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
const model = (value) => object(value)
  && ["id", "name", "api", "provider", "baseUrl"].every((key) => typeof value[key] === "string")
  && typeof value.reasoning === "boolean" && Array.isArray(value.input) && value.input.every((item) => item === "text" || item === "image")
  && object(value.cost) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof value.cost[key] === "number")
  && typeof value.contextWindow === "number" && typeof value.maxTokens === "number"
  && (!own(value, "featured") || typeof value.featured === "boolean")
  && (!own(value, "headers") || (object(value.headers) && Object.values(value.headers).every((item) => typeof item === "string")));
const commandTypes = new Set(["prompt", "steer", "follow_up", "abort", "get_state", "get_available_models", "new_session", "set_model", "set_thinking_level"]);
const eventTypes = new Set(["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "extension_ui_request"]);
const validCommand = (value) => {
  if (["prompt", "steer", "follow_up"].includes(value.type)) return typeof value.message === "string"
    && (!own(value, "images") || (Array.isArray(value.images) && value.images.every(image)))
    && (!own(value, "streamingBehavior") || (value.type === "prompt" && ["steer", "followUp"].includes(value.streamingBehavior)));
  if (["abort", "get_state", "get_available_models"].includes(value.type)) return true;
  if (value.type === "new_session") return optionalString(value, "parentSession");
  if (value.type === "set_model") return typeof value.provider === "string" && typeof value.modelId === "string";
  if (value.type === "set_thinking_level") return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.level);
  if (value.type === "extension_ui_response") {
    const forms = Number(typeof value.value === "string") + Number(typeof value.confirmed === "boolean") + Number(value.cancelled === true);
    return typeof value.id === "string" && forms === 1;
  }
  return false;
};
const validExtensionRequest = (value) => {
  if (typeof value.id !== "string") return false;
  if (value.method === "select") return typeof value.title === "string" && stringArray(value.options) && (!own(value, "timeout") || typeof value.timeout === "number");
  if (value.method === "confirm") return typeof value.title === "string" && typeof value.message === "string" && (!own(value, "timeout") || typeof value.timeout === "number");
  if (value.method === "input") return typeof value.title === "string" && optionalString(value, "placeholder") && (!own(value, "timeout") || typeof value.timeout === "number");
  if (value.method === "editor") return typeof value.title === "string" && optionalString(value, "prefill");
  if (value.method === "notify") return typeof value.message === "string" && (!own(value, "notifyType") || ["info", "warning", "error"].includes(value.notifyType));
  if (value.method === "setStatus") return typeof value.statusKey === "string" && optionalString(value, "statusText");
  if (value.method === "setWidget") return typeof value.widgetKey === "string" && (!own(value, "widgetLines") || stringArray(value.widgetLines)) && (!own(value, "widgetPlacement") || ["aboveEditor", "belowEditor"].includes(value.widgetPlacement));
  if (value.method === "setTitle") return typeof value.title === "string";
  if (value.method === "set_editor_text") return typeof value.text === "string";
  return false;
};
const validEvent = (value) => {
  if (["agent_start", "turn_start"].includes(value.type)) return true;
  if (value.type === "agent_end") return Array.isArray(value.messages);
  if (value.type === "turn_end") return own(value, "message") && Array.isArray(value.toolResults);
  if (["message_start", "message_end"].includes(value.type)) return own(value, "message");
  if (value.type === "message_update") return own(value, "message") && own(value, "assistantMessageEvent");
  if (value.type === "tool_execution_start") return typeof value.toolCallId === "string" && typeof value.toolName === "string" && own(value, "args");
  if (value.type === "tool_execution_update") return typeof value.toolCallId === "string" && typeof value.toolName === "string" && own(value, "args") && own(value, "partialResult");
  if (value.type === "tool_execution_end") return typeof value.toolCallId === "string" && typeof value.toolName === "string" && own(value, "result") && typeof value.isError === "boolean";
  if (value.type === "extension_ui_request") return validExtensionRequest(value);
  return false;
};
const classify = (value) => {
  if (!object(value) || typeof value.type !== "string" || !optionalString(value, "id")) return "malformed";
  if (value.type === "response") {
    if (typeof value.command !== "string" || typeof value.success !== "boolean") return "malformed";
    if (!value.success) return typeof value.error === "string" ? "response" : "malformed";
    if (value.command === "get_available_models") return object(value.data) && Array.isArray(value.data.models) && value.data.models.every(model) ? "response" : "malformed";
    return "response";
  }
  if (value.type === "extension_ui_response") return validCommand(value) ? "command" : "malformed";
  if (commandTypes.has(value.type)) return validCommand(value) ? "command" : "malformed";
  if (eventTypes.has(value.type)) return validEvent(value) ? "known-event" : "malformed";
  return "unknown-event";
};

let failed = false;
for (const [filename, wanted] of Object.entries(expected)) {
  let classes;
  try {
    const text = readFileSync(join(directory, filename), "utf8");
    classes = text.split("\n").filter(Boolean).map((line) => classify(JSON.parse(line)));
  } catch {
    classes = ["malformed"];
  }
  const pass = JSON.stringify(classes) === JSON.stringify(wanted);
  for (const envelopeClass of classes) console.log(`${basename(filename)} ${envelopeClass} ${pass ? "pass" : "fail"}`);
  failed ||= !pass;
}
process.exitCode = failed ? 1 : 0;
