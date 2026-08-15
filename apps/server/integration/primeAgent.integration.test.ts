import { assert, describe, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const runner = join(import.meta.dirname, "fixtures/prime-rpc/prime-agent-isolated-report.mjs");
const execute = (args: string[]) => {
  const result = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 10_000 });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

describe("PA-M16 isolated Prime Agent integration evidence", () => {
  it("runs the deterministic isolated peer through streaming, tools, interactions, crash and race projections", () => {
    const report = execute(["--fake"]);
    assert.strictEqual(report.lane, "fake");
    assert.strictEqual((report.result as Record<string, string>).status, "passed");
    assert.match(report.transcriptHash as string, /^[a-f0-9]{64}$/);
    const transcript = report.transcript as Array<Record<string, unknown>>;
    assert.ok(transcript.some(x => x.kind === "fake-e2e" && x.required === true));
    assert.strictEqual(transcript.filter(x => x.kind === "fake-race").length, 3);
    assert.ok(transcript.every(x => !JSON.stringify(x).includes("secret-that-must-not-escape")));
  });

  it("never runs the authenticated lane without both an explicit flag and permission", () => {
    const report = execute(["--authenticated"]);
    assert.deepStrictEqual(report, { lane: "authenticated", status: "not-run", reason: "explicit env and permission are required" });
  });
});
