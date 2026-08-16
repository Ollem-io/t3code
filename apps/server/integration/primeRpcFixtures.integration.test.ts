import { assert, it } from "@effect/vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodePrimeRpcEnvelope } from "../src/provider/prime/PrimeRpcProtocol.ts";

const fixturesDirectory = join(import.meta.dirname, "fixtures/prime-rpc");
const expected = {
  "normal.jsonl": ["command", "response", "response", "command", "command", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "command"],
  "additive-field.jsonl": ["response", "known-event"],
  "malformed.jsonl": Array(17).fill("malformed"),
  "unknown-event.jsonl": ["unknown-event"],
  "pa-m09-redacted-events.jsonl": ["known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "unknown-event"],
  "pa-m10-redacted-lifecycle.jsonl": ["known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "known-event", "unknown-event"],
  "pa-m11-redacted-text-generation.jsonl": ["response", "response", "response", "response", "known-event", "known-event", "known-event", "known-event"],
} as const;

it("decodes the append-only 0.7.2 fixture corpus", () => {
  for (const filename of readdirSync(fixturesDirectory).filter((name) => name.endsWith(".jsonl"))) {
    const lines = readFileSync(join(fixturesDirectory, filename), "utf8").split("\n").filter(Boolean);
    const actual = lines.map((line) => decodePrimeRpcEnvelope(JSON.parse(line))._tag);
    assert.deepStrictEqual(actual, expected[filename as keyof typeof expected]);
  }
});
