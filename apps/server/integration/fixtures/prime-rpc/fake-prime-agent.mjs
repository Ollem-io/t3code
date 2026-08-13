#!/usr/bin/env node
// Deterministic fixture peer. Contract documented in README.md.
import { createInterface } from "node:readline";

if (process.argv.includes("--mode") && process.argv[process.argv.indexOf("--mode") + 1] !== "rpc") {
  process.stderr.write("fake prime-agent only supports --mode rpc\n");
  process.exitCode = 2;
} else {
  const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
  const model = {
    id: "model-1", name: "Fixture model", api: "openai-completions", provider: "fixture-provider",
    baseUrl: "https://example.invalid", reasoning: true, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, contextWindow: 1000, maxTokens: 100,
  };
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    let command;
    try { command = JSON.parse(line); } catch { write({ type: "response", command: "unknown", success: false, error: "invalid JSON" }); return; }
    if (command.type === "get_available_models") {
      write({ type: "response", id: command.id, command: command.type, success: true, data: { models: [model] } });
      return;
    }
    if (command.type === "get_state") {
      write({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "fixture-session", thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, sessionActions: {}, goal: {} } });
      return;
    }
    if (command.type === "prompt") write({ type: "agent_start" });
    write({ type: "response", id: command.id, command: command.type, success: true });
  });
}
