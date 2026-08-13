#!/usr/bin/env node
// Standalone review artifact for the redacted 0.7.2 JSONL corpus. No source or packages required.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const expected = {
  "normal.jsonl": ["command", "response", "known-event", "known-event", "known-event", "known-event", "command"],
  "additive-field.jsonl": ["response", "known-event"],
  "malformed.jsonl": ["malformed", "malformed"],
  "unknown-event.jsonl": ["unknown-event"],
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const validModel = (model) => isObject(model) && ["id", "name", "api", "provider", "baseUrl"].every((key) => typeof model[key] === "string")
  && typeof model.reasoning === "boolean" && isStringArray(model.input) && typeof model.contextWindow === "number" && typeof model.maxTokens === "number"
  && isObject(model.cost) && ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof model.cost[key] === "number");
const knownEvents = new Set(["agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "extension_ui_request"]);
const knownCommands = new Set(["prompt", "steer", "follow_up", "abort", "get_state", "get_available_models", "new_session", "set_model", "set_thinking_level"]);
const classify = (value) => {
  if (!isObject(value) || typeof value.type !== "string" || ("id" in value && typeof value.id !== "string")) return "malformed";
  if (value.type === "response") {
    if (typeof value.command !== "string" || typeof value.success !== "boolean") return "malformed";
    if (value.success === false) return typeof value.error === "string" ? "response" : "malformed";
    if (value.command === "get_available_models") return isObject(value.data) && Array.isArray(value.data.models) && value.data.models.every(validModel) ? "response" : "malformed";
    return "response";
  }
  if (value.type === "extension_ui_response") {
    const count = Number(typeof value.value === "string") + Number(typeof value.confirmed === "boolean") + Number(value.cancelled === true);
    return typeof value.id === "string" && count === 1 ? "command" : "malformed";
  }
  if (value.type === "set_thinking_level") return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value.level) ? "command" : "malformed";
  if (value.type === "get_available_models" || ["abort", "get_state", "new_session"].includes(value.type)) return "command";
  if (["prompt", "steer", "follow_up"].includes(value.type)) return typeof value.message === "string" ? "command" : "malformed";
  if (value.type === "set_model") return typeof value.provider === "string" && typeof value.modelId === "string" ? "command" : "malformed";
  if (knownEvents.has(value.type)) return "known-event";
  if (knownCommands.has(value.type)) return "malformed";
  return "unknown-event";
};

let failed = false;
for (const filename of Object.keys(expected)) {
  let classes;
  try { classes = readFileSync(join(directory, filename), "utf8").split("\n").filter(Boolean).map((line) => classify(JSON.parse(line))); } catch { classes = ["malformed"]; }
  const pass = JSON.stringify(classes) === JSON.stringify(expected[filename]);
  for (const envelopeClass of classes) console.log(`${basename(filename)} ${envelopeClass} ${pass ? "pass" : "fail"}`);
  failed ||= !pass;
}
process.exitCode = failed ? 1 : 0;
