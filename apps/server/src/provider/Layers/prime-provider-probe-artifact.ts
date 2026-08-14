#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { probePrimeProvider } from "./PrimeProvider.ts";
const binaryPath = process.env.PRIME_AGENT_BIN;
if (!binaryPath) throw new Error("PRIME_AGENT_BIN is required");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-prime-review-"));
try {
  process.env.HOME = NodePath.join(root, "home");
  process.env.USERPROFILE = process.env.HOME;
  const result = await probePrimeProvider({ settings: { binaryPath }, enabled: true });
  process.stdout.write(
    JSON.stringify({
      version: result.version,
      compatibility: result.compatibility,
      readiness: result.readiness,
      modelCount: result.models.length,
    }) + "\n",
  );
} finally {
  await NodeFSP.rm(root, { recursive: true, force: true });
}
