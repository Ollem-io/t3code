#!/usr/bin/env node
// Deterministic process peer for PA-M03. It contains no production launch policy.
import { closeSync } from "node:fs";
import { createInterface } from "node:readline";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
if (process.argv.includes("--version")) {
  process.stdout.write("0.7.2\n");
} else if (argument("--mode", "rpc") !== "rpc") {
  process.stderr.write("fake prime-agent only supports --mode rpc\n");
  process.exitCode = 2;
} else {
  const scenario = argument(
    "--scenario",
    process.argv.includes("--adversarial") ? "adversarial" : "normal",
  );
  const write = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    if (scenario !== "adversarial") return process.stdout.write(line);
    process.stderr.write("fixture diagnostic [redacted]\n");
    process.stdout.write(line.slice(0, 5));
    return process.stdout.write(line.slice(5));
  };
  const response = (command, override = {}) =>
    write({ type: "response", id: command.id, command: command.type, success: true, ...override });
  const held = [];
  // PA-M16 deterministic client projection fixture: no credentials or filesystem state.
  if (scenario === "mvp-e2e") setImmediate(() => {
    write({ type: "agent_start" }); write({ type: "turn_start" });
    write({ type: "message_start", message: { role: "assistant" } });
    write({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "stream" } });
    write({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "fixture-tool", args: {} });
    write({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "fixture-tool", args: {}, partialResult: "tool-output" });
    write({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "fixture-tool", result: "tool-output", isError: false });
    write({ type: "extension_ui_request", id: "interaction-1", method: "confirm", title: "fixture", message: "confirm" });
    write({ type: "message_end", message: { role: "assistant" } }); write({ type: "turn_end", message: {}, toolResults: [] });
  });

  if (scenario === "write-failure") {
    closeSync(0);
    write({ type: "fixture_stdin_closed" });
    setInterval(() => undefined, 60_000);
  } else if (scenario === "eof-live") {
    process.stdout.end();
    setInterval(() => undefined, 60_000);
  } else {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        write({ type: "response", command: "unknown", success: false, error: "invalid JSON" });
        return;
      }
      if (scenario === "reverse-two" && command.type === "get_state") {
        held.push(command);
        write({ type: held.length === 1 ? "agent_start" : "turn_start" });
        if (held.length === 2) {
          response(held[1]);
          response(held[0]);
        }
        return;
      }
      if (scenario === "duplicate") {
        if (held.length === 0) {
          held.push(command);
          response(command);
          return;
        }
        for (const pending of held.splice(0)) response(pending);
        response(command);
        return;
      }
      if (scenario === "mismatch") {
        response(command, { command: command.type === "abort" ? "get_state" : "abort" });
        return;
      }
      if (scenario === "late-after-abort") {
        if (command.type === "get_state") {
          held.push(command);
          write({ type: "agent_start" });
          return;
        }
        for (const pending of held.splice(0)) response(pending);
        response(command);
        return;
      }
      if (scenario === "timeout") return;
      if (scenario === "corrupt") {
        process.stdout.write("{not-json}\n");
        return;
      }
      if (scenario === "exit") {
        process.stderr.write("secret-that-must-not-escape:" + "x".repeat(256));
        process.stdout.resume();
        setImmediate(() => process.exit(17));
        return;
      }
      if (scenario === "events") {
        write({ type: "agent_start" });
        write({ type: "turn_start" });
      }
      if (command.type === "get_state" && scenario === "adversarial")
        write({ type: "agent_start" });
      response(command);
    });
  }
}
