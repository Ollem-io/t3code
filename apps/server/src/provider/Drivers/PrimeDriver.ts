import {
  DEFAULT_PRIME_AGENT_SETTINGS,
  PrimeAgentSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePrimeAdapter } from "../Layers/PrimeAdapter.ts";
import { primeProbeToSnapshot, probePrimeProvider } from "../Layers/PrimeProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("prime-agent");
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);

export type PrimeDriverEnv = ServerConfig | ServerEnvironment;

const unsupportedTextGeneration = (): TextGeneration["Service"] => {
  const fail = (operation: string) =>
    Effect.fail(new TextGenerationError({
      operation,
      detail: "Prime Agent text generation is not available until PA-M11.",
    }));
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};

export const PrimeDriver: ProviderDriver<PrimeAgentSettings, PrimeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Prime Agent", supportsMultipleInstances: true },
  configSchema: PrimeAgentSettings,
  defaultConfig: () => decodeSettings(DEFAULT_PRIME_AGENT_SETTINGS),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverEnvironment = yield* ServerEnvironment;
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const adapter = yield* makePrimeAdapter(config, {
        instanceId,
        environmentId,
        home: serverConfig.stateDir,
        attachmentsDir: serverConfig.attachmentsDir,
        enabled,
        environment: processEnv,
      });
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const initialDraft = primeProbeToSnapshot({
        enabled,
        checkedAt,
        probe: enabled
          ? { version: null, compatibility: "unknown", readiness: "checking", models: [], message: "Checking Prime Agent readiness." }
          : { version: null, compatibility: "unknown", readiness: "disabled", models: [] },
      });
      const stamp = (draft: typeof initialDraft): ServerProvider => ({
        ...draft,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const snapshotRef = yield* Ref.make(stamp(initialDraft));
      const refresh = Effect.promise(() => probePrimeProvider({
        settings: config,
        enabled,
        environment: processEnv,
      })).pipe(
        Effect.flatMap((probe) => DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.map((nextCheckedAt) => stamp(primeProbeToSnapshot({
            enabled,
            checkedAt: nextCheckedAt,
            probe,
          }))),
        )),
        Effect.tap((snapshot) => Ref.set(snapshotRef, snapshot)),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        ...(accentColor ? { accentColor } : {}),
        enabled,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot: Ref.get(snapshotRef),
          refresh,
          streamChanges: Stream.empty,
        },
        adapter,
        textGeneration: unsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
