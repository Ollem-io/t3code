#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { probePrimeProvider } from "./PrimeProvider.ts";
const enabled = process.env.PRIME_AGENT_ENABLED !== "0";
const binaryPath = process.env.PRIME_AGENT_BIN;
if (enabled && !binaryPath) throw new Error("PRIME_AGENT_BIN is required");
const result = await probePrimeProvider({
  settings: { binaryPath: binaryPath ?? "prime-agent" },
  enabled,
});
process.stdout.write(
  JSON.stringify({
    version: result.version,
    compatibility: result.compatibility,
    readiness: result.readiness,
    modelCount: result.models.length,
  }) + "\n",
);
