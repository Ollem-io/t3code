#!/usr/bin/env node
/**
 * Dependency- and source-free PA-M04 contract fixture verifier.
 *
 * Usage: node packages/contracts/fixtures/verify-prime-agent-contract-round-trip.mjs
 *
 * This is deliberately a portable behavioral artifact, rather than a JSON
 * schema. It materializes the compatibility rules the server must enforce,
 * including secret redaction, which a generic schema cannot perform.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("./prime-agent-contract-round-trip.json", import.meta.url),
);
let checks = 0;
function same(actual, expected, label) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\nexpected: ${e}\nactual:   ${a}`);
}
function ok(condition, label) {
  checks += 1;
  if (!condition) throw new Error(label);
}
function reject(label, operation, message) {
  checks += 1;
  try {
    operation();
  } catch (error) {
    same(error.message, message, `${label}: rejection message`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}
const trim = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(label);
  return value.trim();
};
const instanceId = (value) => {
  const result = trim(value, "invalid provider instance id");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(result))
    throw new Error("invalid provider instance id");
  return result;
};
function decodeSelection(input) {
  const id = input.instanceId === undefined ? input.provider : input.instanceId;
  const result = { instanceId: instanceId(id), model: trim(input.model, "invalid model") };
  if (input.nativeIdentity !== undefined) {
    result.nativeIdentity = {
      provider: trim(input.nativeIdentity.provider, "invalid native provider"),
      modelId: trim(input.nativeIdentity.modelId, "invalid native model id"),
    };
  }
  if (input.options !== undefined) {
    result.options = Array.isArray(input.options)
      ? input.options.map(({ id, value }) => ({ id: trim(id, "invalid option id"), value }))
      : Object.entries(input.options).flatMap(([id, value]) =>
          (typeof value === "string" && value.trim() !== "") || typeof value === "boolean"
            ? [
                {
                  id: trim(id, "invalid option id"),
                  value: typeof value === "string" ? value.trim() : value,
                },
              ]
            : [],
        );
  }
  return result;
}
function encodeSelection(selection) {
  const result = { instanceId: selection.instanceId, model: selection.model };
  if (selection.nativeIdentity) result.nativeIdentity = selection.nativeIdentity;
  if (selection.options) result.options = selection.options;
  return result;
}
function decodeModel(input) {
  const result = {
    slug: trim(input.slug, "invalid model slug"),
    name: trim(input.name, "invalid model name"),
    isCustom: input.isCustom,
    capabilities: input.capabilities,
  };
  for (const key of [
    "shortName",
    "subProvider",
    "nativeIdentity",
    "availability",
    "isDefault",
    "isLegacy",
  ]) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return result;
}
function encodeModel(model) {
  return { ...model };
}
function decodeSnapshot(input) {
  const result = {
    instanceId: instanceId(input.instanceId),
    driver: instanceId(input.driver),
    enabled: input.enabled,
    installed: input.installed,
    version: input.version,
    status: input.status,
    auth: input.auth,
    checkedAt: input.checkedAt,
    models: input.models.map(decodeModel),
    slashCommands: input.slashCommands ?? [],
    skills: input.skills ?? [],
  };
  for (const key of [
    "displayName",
    "accentColor",
    "badgeLabel",
    "continuation",
    "showInteractionModeToggle",
    "requiresNewThreadForModelChange",
    "compatibility",
    "message",
    "availability",
    "unavailableReason",
    "versionAdvisory",
    "updateState",
  ]) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return result;
}
function encodeSnapshot(snapshot) {
  return { ...snapshot, models: snapshot.models.map(encodeModel) };
}
// Explicit older-client projection: it can read the new payload but only
// materializes fields its schema knows. The authoritative new payload remains
// untouched; an old client re-encoding this projection cannot preserve fields
// it never modeled.
function decodeOldSnapshot(input) {
  const snapshot = decodeSnapshot(input);
  return {
    instanceId: snapshot.instanceId,
    driver: snapshot.driver,
    enabled: snapshot.enabled,
    installed: snapshot.installed,
    version: snapshot.version,
    status: snapshot.status,
    auth: snapshot.auth,
    checkedAt: snapshot.checkedAt,
    models: snapshot.models.map(
      ({ nativeIdentity: _nativeIdentity, availability: _availability, ...model }) => model,
    ),
    slashCommands: snapshot.slashCommands,
    skills: snapshot.skills,
  };
}
function encodeEnvelope(envelope) {
  return { ...envelope };
}
function decodePrimeSettings(input) {
  // Match the typed Struct contract: it only materializes binaryPath, so
  // free-form launch arguments and Prime-owned flags cannot survive decode.
  return {
    binaryPath: trim(input.binaryPath ?? "prime-agent", "Prime binaryPath must be non-empty"),
  };
}
function decodeEnvelope(input) {
  // The envelope is intentionally open only at config. Current Struct-shaped
  // envelopes drop unknown envelope fields, while unknown-driver config stays
  // opaque for downgrade/fork compatibility.
  const result = { driver: instanceId(input.driver) };
  for (const key of ["displayName", "accentColor", "enabled", "environment", "config"]) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  return result;
}
function bootstrap(settings) {
  if (settings.providerInstances["prime-agent"] !== undefined) return settings;
  return {
    ...settings,
    providerInstances: {
      ...settings.providerInstances,
      "prime-agent": {
        driver: "prime-agent",
        enabled: false,
        config: { binaryPath: "prime-agent" },
      },
    },
  };
}
function redactSettings(settings) {
  return {
    ...settings,
    providerInstances: Object.fromEntries(
      Object.entries(settings.providerInstances).map(([id, envelope]) => [
        id,
        {
          ...envelope,
          ...(envelope.environment
            ? {
                environment: envelope.environment.map((variable) =>
                  variable.sensitive
                    ? {
                        ...variable,
                        value: "",
                        ...(variable.value !== "" || variable.valueRedacted
                          ? { valueRedacted: true }
                          : {}),
                      }
                    : Object.fromEntries(
                        Object.entries(variable).filter(([key]) => key !== "valueRedacted"),
                      ),
                ),
              }
            : {}),
        },
      ]),
    ),
  };
}

try {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const selections = fixture.structuredIdentity.selections.map(decodeSelection);
  same(
    selections.map((selection) => selection.nativeIdentity),
    [
      { provider: "anthropic", modelId: "claude-sonnet" },
      { provider: "custom", modelId: "claude-sonnet" },
    ],
    "same modelId from distinct upstream providers retains structured identity",
  );
  ok(
    selections[0].nativeIdentity.provider !== selections[1].nativeIdentity.provider,
    "same modelId must not collapse providers",
  );
  same(
    selections.map((selection) => selection.model),
    fixture.expected.readableSlugs,
    "readable slugs are retained and never reverse-parsed",
  );
  same(
    selections.map(encodeSelection).map(decodeSelection),
    selections,
    "selection wire round trip retains native identity and readable slug",
  );

  const snapshot = decodeSnapshot(fixture.structuredIdentity.serverSnapshot);
  const snapshotRoundTrip = decodeSnapshot(encodeSnapshot(snapshot));
  same(
    snapshotRoundTrip.models.map((model) => model.slug),
    fixture.expected.readableSlugs,
    "server snapshot behavioral round trip retains readable slugs",
  );
  same(
    snapshotRoundTrip.models.map((model) => model.nativeIdentity),
    selections.map((selection) => selection.nativeIdentity),
    "server snapshot behavioral round trip retains structured identity",
  );
  same(
    snapshotRoundTrip.slashCommands,
    [],
    "absent snapshot slashCommands receives production default",
  );
  same(snapshotRoundTrip.skills, [], "absent snapshot skills receives production default");
  ok(
    snapshotRoundTrip.compatibility === undefined && snapshotRoundTrip.availability === undefined,
    "absent provider compatibility and availability remain absent",
  );
  const absentModelOptionals = decodeModel(fixture.oldServerSnapshot.models[0]);
  ok(
    absentModelOptionals.nativeIdentity === undefined &&
      absentModelOptionals.availability === undefined,
    "absent model nativeIdentity and availability remain absent",
  );

  const oldPayloadThroughNew = decodeSnapshot(fixture.oldServerSnapshot);
  same(
    decodeSnapshot(encodeSnapshot(oldPayloadThroughNew)),
    oldPayloadThroughNew,
    "old payload decodes and re-encodes through the new snapshot contract",
  );
  const authoritativeNewSnapshot = encodeSnapshot(snapshot);
  const oldClientProjection = decodeOldSnapshot(authoritativeNewSnapshot);
  ok(
    oldClientProjection.models.every((model) => model.nativeIdentity === undefined),
    "explicit old-client decoder projects away native identity",
  );
  same(
    authoritativeNewSnapshot.models.map((model) => model.nativeIdentity),
    selections.map((selection) => selection.nativeIdentity),
    "old-client projection does not mutate the authoritative server payload",
  );

  const prime = decodePrimeSettings(fixture.primeInstance.config);
  same(
    prime,
    { binaryPath: "/opt/prime-agent" },
    "Prime instance config has typed binary setting only",
  );
  same(
    decodePrimeSettings(fixture.primeInstance.configWithOwnedOverrides),
    fixture.expected.primeSettingsAfterUnknownFields,
    "Prime launchArgs and owned mode/workspace/model/session overrides do not survive decode",
  );
  const unknown = decodeEnvelope(fixture.unknownDriverInstance);
  same(
    unknown,
    {
      driver: "fork-driver",
      displayName: "Fork instance",
      config: { futureChoice: "kept", model: "future-model" },
    },
    "unknown driver config is opaque while unknown envelope fields are safely ignored",
  );
  same(
    decodeEnvelope(encodeEnvelope(unknown)),
    unknown,
    "unknown-driver decode/encode/decode preserves opaque config exactly",
  );
  ok(
    unknown.futureEnvelopeField === undefined,
    "unknown envelope fields are truthfully dropped by the current Struct contract",
  );

  const legacy = { ...fixture.legacySettings, providerInstances: {} };
  const bootstrapped = bootstrap(legacy);
  same(
    bootstrapped.providers,
    fixture.legacySettings.providers,
    "bootstrap preserves legacy provider settings",
  );
  same(
    bootstrapped.textGenerationModelSelection,
    fixture.legacySettings.textGenerationModelSelection,
    "bootstrap preserves readable legacy selection",
  );
  same(
    bootstrapped.providerInstances["prime-agent"],
    fixture.expected.defaultPrime,
    "bootstrap adds stable disabled Prime instance once",
  );
  ok(bootstrap(bootstrapped) === bootstrapped, "bootstrap is idempotent and creates no duplicate");
  const reloaded = JSON.parse(JSON.stringify(bootstrapped));
  same(
    bootstrap(reloaded),
    reloaded,
    "serialization plus reload does not duplicate or change the stable Prime id",
  );
  const independentlyDecoded = { ...fixture.legacySettings, providerInstances: {} };
  same(
    bootstrap(independentlyDecoded).providerInstances,
    bootstrapped.providerInstances,
    "fresh equivalent settings choose the same stable Prime id",
  );
  const collision = {
    ...legacy,
    providerInstances: {
      "prime-agent": { driver: "fork-driver", config: { owner: "preexisting" } },
    },
  };
  ok(
    bootstrap(collision) === collision,
    "preexisting prime-agent id collision is never overwritten or duplicated",
  );

  const oldSelection = decodeSelection({
    provider: "prime-agent",
    model: "anthropic/claude-sonnet",
  });
  same(
    oldSelection,
    { instanceId: "prime-agent", model: "anthropic/claude-sonnet" },
    "old selection safely decodes when native identity is absent",
  );
  ok(
    fixture.oldServerSnapshot.models[0].nativeIdentity === undefined,
    "old server snapshot safely omits native identity",
  );

  const redacted = redactSettings({ providerInstances: { "prime-agent": fixture.primeInstance } });
  const environment = redacted.providerInstances["prime-agent"].environment;
  same(
    environment[0].value,
    fixture.expected.redactedSensitiveValue,
    "externally materialized sensitive environment value is redacted",
  );
  same(
    environment[0].valueRedacted,
    fixture.expected.redactedMarker,
    "externally materialized sensitive environment carries redaction marker",
  );
  same(
    environment[1].value,
    "https://api.prime.example",
    "non-sensitive environment value remains readable",
  );
  ok(
    !JSON.stringify(redacted).includes("fixture-secret-token"),
    "external settings materialization never exposes sensitive environment value",
  );

  for (const test of fixture.rejections) {
    if (test.name === "invalid instance id")
      reject(test.name, () => decodeSelection(test.input), test.message);
    else reject(test.name, () => decodePrimeSettings(test.input), test.message);
  }
  console.log(`PA-M04 fixture verified: ${checks} assertions passed`);
} catch (error) {
  console.error(`PA-M04 fixture FAILED: ${error.message}`);
  process.exitCode = 1;
}
