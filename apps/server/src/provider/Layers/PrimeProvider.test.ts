// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import {
  PRIME_PROVIDER_CHECKING_SUMMARY,
  PrimeProviderProbeCache,
  type PrimeProbeSummary,
  primeModelToServerModel,
  primeProbeToSnapshot,
  probePrimeProvider,
} from "./PrimeProvider.ts";

const binaryPath = NodeURL.fileURLToPath(
  new URL("../../../integration/fixtures/prime-rpc/fake-prime-provider.mjs", import.meta.url),
);
const settings = { binaryPath };
const testEnvironment = (scenario: string, version = "0.7.2", marker?: string) => ({
  PATH: process.env.PATH,
  T3_TEST_PRIME_SCENARIO: scenario,
  T3_TEST_PRIME_VERSION: version,
  ...(marker ? { T3_TEST_PRIME_MARKER: marker } : {}),
  PRIME_AGENT_TOKEN: "must-not-leak",
  OPENAI_API_KEY: "must-not-leak",
  ANTHROPIC_API_KEY: "must-not-leak",
  SECRET_TOKEN: "must-not-leak",
  XDG_CONFIG_HOME: "/must-not-leak",
});
const probe = (scenario: string, version = "0.7.2", extra = {}) =>
  probePrimeProvider({
    settings,
    enabled: true,
    environment: testEnvironment(scenario, version),
    ...extra,
  });

describe("PrimeProvider", () => {
  it("makes 0.7.2 ready and maps native identity plus thinking levels", async () => {
    const result = await probe("ready");
    assert.strictEqual(result.readiness, "ready");
    assert.strictEqual(result.models.length, 1);
    assert.deepStrictEqual(result.models[0]?.nativeIdentity, {
      provider: "prime",
      modelId: "model-a",
    });
    assert.deepStrictEqual(
      (() => {
        const descriptor = result.models[0]?.capabilities?.optionDescriptors?.[0];
        return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
      })(),
      ["off", "low", "high"],
    );
  });
  it("does not invent image capabilities or defaults and ignores inherited thinking keys", () => {
    const inherited = Object.create({ high: "high" }) as Record<string, string>;
    inherited.low = "low";
    const model = primeModelToServerModel({
      id: "model-b",
      name: "Model B",
      api: "api",
      provider: "prime",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
      thinkingLevelMap: inherited,
      featured: false,
    });
    assert.ok(!("isDefault" in model));
    assert.ok(!("image" in model));
    const descriptor = model.capabilities?.optionDescriptors?.[0];
    assert.deepStrictEqual(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
      ["low"],
    );
  });
  it("blocks old versions before spawning RPC and advises a passing newer version", async () => {
    const old = await probe("ready", "0.7.1");
    assert.strictEqual(old.readiness, "incompatible");
    const newer = await probe("ready", "0.8.0");
    assert.strictEqual(newer.readiness, "advisory");
  });
  it("classifies setup, malformed protocol, timeout, disabled and missing binary coarsely", async () => {
    assert.strictEqual((await probe("setup")).readiness, "setup-required");
    assert.strictEqual((await probe("malformed")).readiness, "runtime-error");
    assert.strictEqual(
      (await probe("timeout", "0.7.2", { timeoutMs: 20 })).readiness,
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
    const marker = `/tmp/t3-prime-marker-${process.pid}`;
    try {
      await probePrimeProvider({
        settings,
        enabled: true,
        environment: testEnvironment("ready", "0.7.2", marker),
      });
      const observed = JSON.parse(NodeFS.readFileSync(marker, "utf8")) as {
        argv: string[];
        home: string;
        primeToken?: string;
        openAiKey?: string;
        anthropicKey?: string;
        secretToken?: string;
        xdg: string;
        session: string;
      };
      const session = observed.argv[observed.argv.indexOf("--session-dir") + 1]!;
      assert.ok(observed.home.includes("t3-prime-probe-"));
      assert.strictEqual(observed.primeToken, undefined);
      assert.strictEqual(observed.openAiKey, undefined);
      assert.strictEqual(observed.anthropicKey, undefined);
      assert.strictEqual(observed.secretToken, undefined);
      assert.ok(observed.xdg.includes("t3-prime-probe-"));
      assert.ok(!observed.session.includes("userdata/prime"));
      assert.ok(!observed.session.includes("threads"));
      assert.ok(!NodeFS.existsSync(session));
    } finally {
      try {
        NodeFS.unlinkSync(marker);
      } catch {}
    }
  });
  it("rejects prerelease, adversarial, mismatched, and unusable responses", async () => {
    assert.strictEqual((await probe("ready", "0.7.2-beta.1")).readiness, "incompatible");
    assert.strictEqual((await probe("split-version")).readiness, "incompatible");
    assert.strictEqual(
      (await probe("ready", "0.7.2\nprime-agent 99.0.0")).readiness,
      "incompatible",
    );
    assert.strictEqual((await probe("mismatch")).readiness, "runtime-error");
    assert.strictEqual((await probe("empty-state")).readiness, "runtime-error");
  });
  it("classifies only known setup failures as setup-required without leaking details", async () => {
    const failed = await probe("runtime-failure");
    assert.strictEqual(failed.readiness, "runtime-error");
    assert.strictEqual((await probe("runtime-required")).readiness, "runtime-error");
    assert.ok(!JSON.stringify(failed).includes("account@example.com"));
  });
  it("cleans isolated resources after abort", async () => {
    const controller = new AbortController();
    controller.abort();
    assert.strictEqual(
      (await probe("ready", "0.7.2", { signal: controller.signal })).readiness,
      "runtime-error",
    );
  });
  it("cleans isolated resources across version and RPC failures", async () => {
    for (const [scenario, version] of [
      ["version-timeout", "0.7.2"],
      ["missing-version", "0.7.2"],
      ["ready", "0.7.1"],
      ["malformed", "0.7.2"],
    ] as const) {
      const before = new Set(
        NodeFS.readdirSync("/tmp").filter((name) => name.startsWith("t3-prime-probe-")),
      );
      await probe(scenario, version, { timeoutMs: 20 });
      const after = NodeFS.readdirSync("/tmp").filter(
        (name) => name.startsWith("t3-prime-probe-") && !before.has(name),
      );
      assert.deepStrictEqual(after, []);
    }
  });
  it("waits for the exact RPC child to close before removing its root", async () => {
    const marker = `/tmp/t3-prime-exit-marker-${process.pid}`;
    try {
      await probePrimeProvider({
        settings,
        enabled: true,
        environment: {
          ...testEnvironment("delayed-close"),
          T3_TEST_PRIME_EXIT_MARKER: marker,
        },
      });
      const observed = JSON.parse(NodeFS.readFileSync(marker, "utf8")) as {
        rootExistedAtExit: boolean;
      };
      assert.strictEqual(observed.rootExistedAtExit, true);
    } finally {
      try {
        NodeFS.unlinkSync(marker);
      } catch {}
    }
  });
  it("exports a truthful checking snapshot", () => {
    const snapshot = primeProbeToSnapshot({
      enabled: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      probe: PRIME_PROVIDER_CHECKING_SUMMARY,
    });
    assert.strictEqual(snapshot.status, "warning");
    assert.match(snapshot.message ?? "", /Checking/);
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
    await cache.refresh(
      async () => ({
        version: "0.7.2",
        compatibility: "compatible",
        readiness: "runtime-error",
        models: [],
      }),
      101,
    );
    assert.strictEqual(cache.stale?.readiness, "ready");
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
  it("invalidates in-flight ownership without allowing stale repopulation", async () => {
    const cache = new PrimeProviderProbeCache(100);
    let resolveOld!: (value: PrimeProbeSummary) => void;
    let resolveNew!: (value: PrimeProbeSummary) => void;
    const old = cache.refresh(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      0,
    );
    cache.invalidate();
    const newer = cache.refresh(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
      1,
    );
    assert.notStrictEqual(old, newer);
    const newSummary: PrimeProbeSummary = {
      version: "0.8.0",
      compatibility: "advisory",
      readiness: "advisory",
      models: [],
    };
    resolveNew(newSummary);
    await newer;
    const oldSummary: PrimeProbeSummary = {
      version: "0.7.2",
      compatibility: "compatible",
      readiness: "ready",
      models: [],
    };
    resolveOld(oldSummary);
    await old;
    assert.strictEqual(cache.stale, newSummary);
    assert.strictEqual(
      await cache.refresh(() => Promise.reject(new Error("not called")), 2),
      newSummary,
    );
  });
});
