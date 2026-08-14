#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const scenario = process.env.PRIME_FAKE_SCENARIO ?? "ready";
if (process.argv.includes("--version")) {
  if (scenario === "missing-version") process.stdout.write("unknown\n");
  else process.stdout.write(`prime-agent ${process.env.PRIME_FAKE_VERSION ?? "0.7.2"}\n`);
  process.exit(0);
}
const sessionIndex = process.argv.indexOf("--session-dir");
if (sessionIndex >= 0) mkdirSync(process.argv[sessionIndex + 1], { recursive: true });
if (process.env.PRIME_FAKE_MARKER)
  writeFileSync(
    process.env.PRIME_FAKE_MARKER,
    JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME }),
  );
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (scenario === "timeout") return;
  if (scenario === "malformed") return process.stdout.write("{bad-json}\n");
  if (scenario === "setup")
    return process.stdout.write(
      JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type,
        success: false,
        error: "setup required",
      }) + "\n",
    );
  const data =
    command.type === "get_available_models"
      ? {
          models: [
            {
              id: "model-a",
              name: "Model A",
              api: "api",
              provider: "prime",
              baseUrl: "https://example.invalid",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
              thinkingLevelMap: { off: null, low: "low", high: "high" },
              featured: true,
            },
          ],
        }
      : { state: "idle" };
  process.stdout.write(
    JSON.stringify({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data,
    }) + "\n",
  );
});
