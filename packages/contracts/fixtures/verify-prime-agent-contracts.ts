#!/usr/bin/env node
/**
 * Source-derived PA-M04 black-box verifier.
 *
 * This entrypoint intentionally imports and executes the shipped Effect schemas.
 * Regenerate the adjacent standalone bundle from the repository root with:
 *   /root/.vite-plus/bin/vp pack packages/contracts/fixtures/verify-prime-agent-contracts.ts --out-dir packages/contracts/fixtures/.bundle-tmp --no-clean --no-sourcemap --platform node --format esm --target node24 --minify --no-report && cp packages/contracts/fixtures/.bundle-tmp/verify-prime-agent-contracts.mjs packages/contracts/fixtures/verify-prime-agent-contracts.bundle.mjs && rm -rf packages/contracts/fixtures/.bundle-tmp
 *
 * The committed bundle includes Effect and needs only Node plus the JSON fixture.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import {
  ModelSelection,
  ProviderInstanceConfig,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
  bootstrapPrimeAgentServerSettings,
} from "../src/index.ts";

const args = process.argv.slice(2);
const fixtureFlag = args.indexOf("--fixture");
if (fixtureFlag < 0 || !args[fixtureFlag + 1] || args.length !== 2) {
  throw new Error("usage: verify-prime-agent-contracts.bundle.mjs --fixture <adjacent-json-name>");
}
const artifactDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(artifactDir, args[fixtureFlag + 1]);
if (dirname(fixturePath) !== artifactDir) throw new Error("--fixture must name adjacent JSON");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
let checks = 0;
const same = (actual: unknown, expected: unknown, label: string) => {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\nexpected: ${e}\nactual: ${a}`);
};
const ok = (condition: boolean, label: string) => {
  checks++;
  if (!condition) throw new Error(label);
};
const rejects = (operation: () => unknown, label: string) => {
  checks++;
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${label}: expected rejection`);
};

const decodeSelection = Schema.decodeUnknownSync(ModelSelection);
const encodeSelection = Schema.encodeSync(ModelSelection);
const selections = fixture.structuredIdentity.selections.map(decodeSelection);
same(
  selections.map((x) => x.nativeIdentity),
  fixture.structuredIdentity.selections.map((x: any) => x.nativeIdentity),
  "ModelSelection retains structured native identity",
);
same(
  selections.map((x) => x.model),
  fixture.expected.readableSlugs,
  "ModelSelection retains readable slugs",
);
same(
  selections.map((x) => decodeSelection(encodeSelection(x))),
  selections,
  "ModelSelection actual encode/decode round trip",
);
rejects(
  () => decodeSelection(fixture.rejections[0].input),
  "ModelSelection rejects invalid instance id",
);

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeProvider = Schema.encodeSync(ServerProvider);
const provider = decodeProvider(fixture.structuredIdentity.serverSnapshot);
same(provider.slashCommands, [], "ServerProvider defaults absent slashCommands");
same(provider.skills, [], "ServerProvider defaults absent skills");
ok(
  provider.compatibility === undefined && provider.availability === undefined,
  "ServerProvider leaves absent fields absent",
);
const providerRoundTrip = decodeProvider(encodeProvider(provider));
same(
  providerRoundTrip.models.map((x) => x.nativeIdentity),
  selections.map((x) => x.nativeIdentity),
  "ServerProvider actual encode/decode retains identity",
);
const oldProvider = decodeProvider(fixture.oldServerSnapshot);
ok(
  oldProvider.models[0].nativeIdentity === undefined &&
    oldProvider.models[0].availability === undefined,
  "old ServerProvider model optionals remain absent",
);
same(
  decodeProvider(encodeProvider(oldProvider)),
  oldProvider,
  "old ServerProvider actual encode/decode round trip",
);

const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);
const encodeInstance = Schema.encodeSync(ProviderInstanceConfig);
const primeInput = {
  ...fixture.primeInstance,
  config: fixture.primeInstance.configWithOwnedOverrides,
};
const prime = decodeInstance(primeInput);
same(
  prime.config,
  fixture.expected.primeSettingsAfterUnknownFields,
  "Prime typed settings drop unsupported owned launch fields",
);
rejects(
  () => decodeInstance({ ...primeInput, config: fixture.rejections[1].input }),
  "Prime typed settings reject blank binary",
);
const unknown = decodeInstance(fixture.unknownDriverInstance);
same(unknown.config, fixture.unknownDriverInstance.config, "unknown driver config stays opaque");
same(
  decodeInstance(encodeInstance(unknown)),
  unknown,
  "unknown driver actual encode/decode round trip",
);
ok(!("futureEnvelopeField" in unknown), "unknown envelope fields follow shipped Struct behavior");

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodedSettings = decodeSettings({
  ...fixture.legacySettings,
  providerInstances: { "prime-agent": primeInput },
});
same(
  decodedSettings.providerInstances["prime-agent"].config,
  fixture.expected.primeSettingsAfterUnknownFields,
  "ServerSettings applies Prime typed config normalization",
);
same(
  decodeSettings(encodeSettings(decodedSettings)),
  decodedSettings,
  "ServerSettings actual encode/decode round trip",
);
const independentlyDecodedLegacy = decodeSettings(fixture.legacySettings);
const bootstrapped = bootstrapPrimeAgentServerSettings(independentlyDecodedLegacy);
same(
  bootstrapped.providerInstances["prime-agent"],
  fixture.expected.defaultPrime,
  "bootstrap adds stable disabled Prime instance",
);
ok(bootstrapPrimeAgentServerSettings(bootstrapped) === bootstrapped, "bootstrap is idempotent");

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const patch = decodePatch({
  textGenerationModelSelection: {
    model: "  anthropic/claude-sonnet  ",
    nativeIdentity: { provider: " anthropic ", modelId: " claude-sonnet " },
  },
  providerInstances: { "prime-agent": primeInput },
});
same(
  patch.textGenerationModelSelection,
  {
    model: "anthropic/claude-sonnet",
    nativeIdentity: { provider: "anthropic", modelId: "claude-sonnet" },
  },
  "ServerSettingsPatch uses shipped trimming normalization",
);
same(
  patch.providerInstances?.["prime-agent"]?.config,
  fixture.expected.primeSettingsAfterUnknownFields,
  "ServerSettingsPatch applies Prime typed config normalization",
);

console.log(`PA-M04 source-derived contract artifact passed ${checks} checks (${fixturePath})`);
