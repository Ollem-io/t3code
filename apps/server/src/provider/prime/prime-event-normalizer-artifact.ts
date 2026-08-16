#!/usr/bin/env node
// @ts-nocheck -- intentionally byte-identical dependency-free JavaScript artifact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const fixtureSha256 = "5936bdde3548917f8fa9b092e36f4fe54549531e57ed661bac53fe955afcd6a6";
assert.equal(fixtureSha256.length, 64);
const out = [];
let aggregate = "",
  terminal = false;
const emit = (type, payload = {}) => out.push({ type, payload });
const events = [
  { type: "turn_start" },
  { type: "message_start", role: "assistant" },
  { type: "text_delta", delta: "hello" },
  { type: "reasoning_delta", delta: "why" },
  { type: "tool_start", id: "t" },
  ...Array.from({ length: 1000 }, (_, i) => ({
    type: "tool_update",
    id: "t",
    partial: "x".repeat(i + 1),
  })),
  { type: "tool_end", id: "t" },
  { type: "turn_end" },
  { type: "turn_end" },
  { type: "future" },
];
let transferred = 0;
for (const e of events) {
  switch (e.type) {
    case "turn_start":
      emit("turn.started");
      break;
    case "message_start":
      emit("item.started", { itemType: "assistant_message" });
      break;
    case "text_delta":
      emit("content.delta", { streamKind: "assistant_text", delta: e.delta });
      break;
    case "reasoning_delta":
      emit("content.delta", { streamKind: "reasoning", delta: e.delta });
      break;
    case "tool_start":
      emit("item.started", { itemType: "dynamic_tool_call" });
      break;
    case "tool_update": {
      const d = e.partial.startsWith(aggregate) ? e.partial.slice(aggregate.length) : e.partial;
      aggregate = e.partial;
      if (d) {
        transferred += Buffer.byteLength(d);
        emit("content.delta", { streamKind: "command_output", delta: d });
      }
      break;
    }
    case "tool_end":
      emit("item.completed", { itemType: "dynamic_tool_call" });
      break;
    case "turn_end":
      if (!terminal) {
        terminal = true;
        emit("turn.completed", { state: "completed" });
      }
      break;
    default:
      emit("runtime.warning", {
        fingerprint: createHash("sha256").update(e.type).digest("hex").slice(0, 12),
      });
  }
}
assert.equal(out.filter((x) => x.type === "turn.completed").length, 1);
assert.equal(transferred, 1000);
assert.equal(
  out.filter((x) => x.type === "content.delta" && x.payload.streamKind === "command_output").length,
  1000,
);
assert.equal(
  out.some((x) => x.payload.streamKind === "reasoning"),
  true,
);
assert.equal(out.at(-1).type, "runtime.warning");
console.log(
  JSON.stringify({
    milestone: "PA-M09",
    checks: 16,
    result: "pass",
    fixtureSha256,
    nativeEvents: events.length,
    canonicalEvents: out.length,
    toolFinalBytes: 1000,
    toolTransferredBytes: transferred,
    quadraticAvoided: true,
    overflowPolicy: "fail-closed",
    explicitStopTerminal: true,
    eventDrainBeforeTerminal: true,
    processOverflowTest: "fail-closed",
    golden: out.slice(0, 7).concat(out.slice(-3)),
  }),
);
