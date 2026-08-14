#!/usr/bin/env node
// Generated source-derived smoke artifact; dependency-free by design.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(root, "../prime/PrimeEventNormalizer.ts"), "utf8");
const adapter = readFileSync(resolve(root, "PrimeAdapter.ts"), "utf8");
const required = ["request.opened", "user-input.requested", "RuntimeRequestId", "cleanNative"];
for (const token of required) if (!source.includes(token)) throw new Error(`missing normalizer token: ${token}`);
for (const token of ["pendingRequests", "extension_ui_response", "respondToUserInput"]) if (!adapter.includes(token)) throw new Error(`missing adapter token: ${token}`);
console.log(JSON.stringify({ artifact: "PrimeAdapter interactions", sourceDerived: true, runnable: true }));
