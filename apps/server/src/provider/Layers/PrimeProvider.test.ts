// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import {
  PrimeProviderProbeCache,
  primeProbeToSnapshot,
  probePrimeProvider,
} from "./PrimeProvider.ts";

const binaryPath = NodeURL.fileURLToPath(
  new URL("../../../integration/fixtures/prime-rpc/fake-prime-provider.mjs", import.meta.url),
);
const settings = { binaryPath };
const withScenario = async <A>(scenario: string, run: () => Promise<A>, version = "0.7.2") => {
  const beforeScenario = process.env.PRIME_FAKE_SCENARIO;
  const beforeVersion = process.env.PRIME_FAKE_VERSION;
  process.env.PRIME_FAKE_SCENARIO = scenario;
  process.env.PRIME_FAKE_VERSION = version;
  try {
    return await run();
  } finally {
    if (beforeScenario === undefined) delete process.env.PRIME_FAKE_SCENARIO;
    else process.env.PRIME_FAKE_SCENARIO = beforeScenario;
    if (beforeVersion === undefined) delete process.env.PRIME_FAKE_VERSION;
    else process.env.PRIME_FAKE_VERSION = beforeVersion;
  }
};

describe("PrimeProvider", () => {
  it("makes 0.7.2 ready and maps native identity plus thinking levels", async () => {
    const result = await withScenario("ready", () =>
      probePrimeProvider({ settings, enabled: true }),
    );
    assert.strictEqual(result.readiness, "ready");
    assert.strictEqual(result.models.length, 1);
    assert.deepStrictEqual(result.models[0]?.nativeIdentity, {
      provider: "prime",
      modelId: "model-a",
    });
    assert.deepStrictEqual(
      result.models[0]?.capabilities?.optionDescriptors?.[0]?.options.map((option) => option.id),
      ["low", "high"],
    );
  });
  it("blocks old versions before spawning RPC and advises a passing newer version", async () => {
    const old = await withScenario(
      "ready",
      () => probePrimeProvider({ settings, enabled: true }),
      "0.7.1",
    );
    assert.strictEqual(old.readiness, "incompatible");
    const newer = await withScenario(
      "ready",
      () => probePrimeProvider({ settings, enabled: true }),
      "0.8.0",
    );
    assert.strictEqual(newer.readiness, "advisory");
  });
  it("classifies setup, malformed protocol, timeout, disabled and missing binary coarsely", async () => {
    assert.strictEqual(
      (await withScenario("setup", () => probePrimeProvider({ settings, enabled: true })))
        .readiness,
      "setup-required",
    );
    assert.strictEqual(
      (await withScenario("malformed", () => probePrimeProvider({ settings, enabled: true })))
        .readiness,
      "runtime-error",
    );
    assert.strictEqual(
      (
        await withScenario("timeout", () =>
          probePrimeProvider({ settings, enabled: true, timeoutMs: 20 }),
        )
      ).readiness,
      "runtime-error",
    );
    assert.strictEqual(
      (await probePrimeProvider({ settings, enabled: false })).readiness,
      "disabled",
    );
    assert.strictEqual(
      (
        await probePrimeProvider({
          settings: { binaryPath: "/definitely/missing/prime-agent" },
          enabled: true,
        })
      ).readiness,
      "missing",
    );
  });
  it("uses disposable home/session resources and removes them after close", async () => {
    const marker = `/tmp/t3-prime-marker-${process.pid}-${Date.now()}`;
    process.env.PRIME_FAKE_MARKER = marker;
    try {
      await withScenario("ready", () => probePrimeProvider({ settings, enabled: true }));
      const observed = JSON.parse(NodeFS.readFileSync(marker, "utf8")) as {
        argv: string[];
        home: string;
      };
      const session = observed.argv[observed.argv.indexOf("--session-dir") + 1]!;
      assert.ok(observed.home.includes("t3-prime-probe-"));
      assert.ok(!NodeFS.existsSync(session));
    } finally {
      delete process.env.PRIME_FAKE_MARKER;
      try {
        NodeFS.unlinkSync(marker);
      } catch {}
    }
  });
  it("coalesces, caches, cancels, and marks safe previous models stale", async () => {
    const cache = new PrimeProviderProbeCache(100);
    let calls = 0;
    const first = cache.refresh(async () => {
      calls += 1;
      return { version: "0.7.2", compatibility: "compatible", readiness: "ready", models: [] };
    }, 0);
    assert.strictEqual(
      first,
      cache.refresh(async () => {
        throw new Error("not called");
      }, 0),
    );
    await first;
    await cache.refresh(async () => {
      throw new Error("not called");
    }, 50);
    assert.strictEqual(calls, 1);
    const model = { slug: "p/m", name: "M", isCustom: false, capabilities: null } as const;
    const snapshot = primeProbeToSnapshot({
      enabled: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      probe: {
        version: "0.7.2",
        compatibility: "compatible",
        readiness: "runtime-error",
        models: [],
      },
      staleModels: [model],
    });
    assert.strictEqual(snapshot.models[0]?.availability, "stale");
  });
});
