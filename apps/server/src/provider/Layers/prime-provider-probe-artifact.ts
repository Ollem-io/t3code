#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import { probePrimeProvider } from "./PrimeProvider.ts";
const binaryPath = process.env.PRIME_AGENT_BIN;
if (!binaryPath) throw new Error("PRIME_AGENT_BIN is required");
const result = await probePrimeProvider({ settings: { binaryPath }, enabled: true });
process.stdout.write(
  JSON.stringify({
    version: result.version,
    compatibility: result.compatibility,
    readiness: result.readiness,
    modelCount: result.models.length,
  }) + "\n",
);
