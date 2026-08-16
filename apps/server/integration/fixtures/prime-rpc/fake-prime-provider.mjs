#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const scenario = process.env.T3_TEST_PRIME_SCENARIO ?? "ready";
if (scenario === "delayed-close") {
  const keepAlive = setInterval(() => undefined, 1_000);
  process.on("SIGTERM", () => {
    setTimeout(() => {
      clearInterval(keepAlive);
      if (process.env.T3_TEST_PRIME_EXIT_MARKER)
        writeFileSync(
          process.env.T3_TEST_PRIME_EXIT_MARKER,
          JSON.stringify({ rootExistedAtExit: existsSync(process.cwd()) }),
        );
      process.exit(0);
    }, 50);
  });
}
if (process.argv.includes("--version")) {
  if (scenario === "version-timeout") await new Promise(() => {});
  if (scenario === "missing-version") process.stdout.write("unknown\n");
  else if (scenario === "split-version") {
    process.stdout.write("prime-agent 0.7.");
    process.stderr.write("2\n");
  } else process.stdout.write(`prime-agent ${process.env.T3_TEST_PRIME_VERSION ?? "0.7.2"}\n`);
  process.exit(0);
}
const sessionIndex = process.argv.indexOf("--session-dir");
if (sessionIndex >= 0) mkdirSync(process.argv[sessionIndex + 1], { recursive: true });
if (process.env.T3_TEST_PRIME_MARKER)
  writeFileSync(
    process.env.T3_TEST_PRIME_MARKER,
    JSON.stringify({
      argv: process.argv.slice(2),
      home: process.env.HOME,
      primeToken: process.env.PRIME_AGENT_TOKEN,
      openAiKey: process.env.OPENAI_API_KEY,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      secretToken: process.env.SECRET_TOKEN,
      xdg: process.env.XDG_CONFIG_HOME,
      session: process.argv[sessionIndex + 1],
    }),
  );

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (scenario === "timeout") return;
  if (scenario === "malformed") return process.stdout.write("{bad-json}\n");
  if (scenario === "mismatch")
    return process.stdout.write(
      JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type === "get_state" ? "abort" : command.type,
        success: true,
        data: {},
      }) + "\n",
    );
  if (scenario === "empty-state" && command.type === "get_state")
    return process.stdout.write(
      JSON.stringify({ type: "response", id: command.id, command: command.type, success: true }) +
        "\n",
    );
  if (scenario === "runtime-failure")
    return process.stdout.write(
      JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type,
        success: false,
        error: "internal failure 503 account@example.com",
      }) + "\n",
    );
  if (scenario === "runtime-required")
    return process.stdout.write(
      JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type,
        success: false,
        error: "runtime dependency required",
      }) + "\n",
    );
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
