import { assert, describe, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const runner = join(import.meta.dirname, "fixtures/prime-rpc/prime-agent-isolated-report.mjs");
const execute = (args: string[]) => {
  const result = spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

describe("PA-M16 isolated Prime Agent integration evidence", () => {
  it("runs the deterministic isolated peer through streaming, tools, interactions, crash and race projections", () => {
    const report = execute(["--fake"]);
    assert.strictEqual(report.lane, "fake");
    assert.strictEqual((report.result as Record<string, string>).status, "passed");
    assert.match(report.transcriptHash as string, /^[a-f0-9]{64}$/);
    // The report is a serialization boundary: no raw PID field/value may escape from
    // the in-memory lifecycle resources into either manifest or RPC transcript.
    const serialized = JSON.stringify(report);
    assert.ok(!/"pid"\s*:/.test(serialized));
    // This process is not a managed child, but catches any accidental ambient PID
    // interpolation at the same serialization boundary.
    assert.ok(!serialized.includes(String(process.pid)));
    const manifest = report.manifest as { resources: Array<Record<string, unknown>> };
    assert.ok(manifest.resources.length > 0);
    assert.ok(
      manifest.resources.every(
        (resource) =>
          typeof resource.pidHash === "string" &&
          /^\[sha256:[a-f0-9]{64}\]$/.test(resource.pidHash) &&
          !("pid" in resource) &&
          typeof resource.startTokenHash === "string" &&
          /^\[sha256:[a-f0-9]{64}\]$/.test(resource.startTokenHash) &&
          typeof resource.lifecycle === "string",
      ),
    );
    const transcript = report.transcript as Array<Record<string, unknown>>;
    assert.ok(transcript.some((x) => x.kind === "fake-e2e" && x.required === true));
    assert.strictEqual(transcript.filter((x) => x.kind === "fake-race").length, 3);
    assert.ok(transcript.every((x) => !JSON.stringify(x).includes("secret-that-must-not-escape")));
    const cleanup = transcript.find((x) => x.kind === "cleanup");
    assert.deepStrictEqual(cleanup, {
      kind: "cleanup",
      result: "removed",
      root: cleanup?.root,
      resourcesClosed: true,
    });
    const rpc = transcript.find((x) => x.kind === "rpc");
    assert.strictEqual(rpc?.stdinEnded, true);
    assert.strictEqual(rpc?.lifecycle, "closed");
    assert.ok(typeof rpc?.pidHash === "string");
    assert.ok(typeof rpc?.startTokenHash === "string");
    assert.ok(!("pid" in (rpc ?? {})));
    assert.ok(transcript.filter((x) => x.kind === "fake-race").every((x) => x.stopped === true));
  });

  it("never runs the authenticated lane without both an explicit flag and permission", () => {
    const report = execute(["--authenticated"]);
    assert.deepStrictEqual(report, {
      lane: "authenticated",
      status: "not-run",
      reason: "explicit env and permission are required",
    });
  });
});
