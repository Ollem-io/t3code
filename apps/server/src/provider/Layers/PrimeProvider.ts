// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  type PrimeAgentSettings,
  type ServerProviderModel,
  nativeModelSlug,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor, type ServerProviderDraft } from "../providerSnapshot.ts";
import {
  classifyPrimeCompatibility,
  MINIMUM_PRIME_AGENT_VERSION,
  type PrimeCompatibilityBand,
} from "../prime/PrimeCompatibility.ts";
import { PrimeRpcClient, PrimeRpcClientError } from "../prime/PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { PrimeRpcAvailableModelsResponse, type PrimeRpcModel } from "../prime/PrimeRpcProtocol.ts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
export const PRIME_PROVIDER_PROBE_TIMEOUT_MS = 4_000;
export const PRIME_PROVIDER_CACHE_TTL_MS = 30_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PrimeReadiness =
  | "missing"
  | "disabled"
  | "checking"
  | "ready"
  | "setup-required"
  | "incompatible"
  | "advisory"
  | "runtime-error";

export interface PrimeProbeSummary {
  readonly version: string | null;
  readonly compatibility: PrimeCompatibilityBand | "unknown";
  readonly readiness: PrimeReadiness;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly message?: string;
}

const parseVersion = (value: string): string | null => {
  const match = value.trim().match(/^prime-agent\s+(\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?)$/);
  return match?.[1] ?? null;
};

const commandOptions = (signal: AbortSignal | undefined) =>
  signal === undefined ? {} : { signal };

const isolatedProbeEnvironment = (
  home: string,
  source: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      key.startsWith("PRIME_") ||
      key === "PRIME" ||
      key.startsWith("T3_") ||
      key === "XDG_CONFIG_HOME" ||
      key === "XDG_DATA_HOME" ||
      key === "XDG_STATE_HOME" ||
      key === "HOME" ||
      key === "USERPROFILE" ||
      key === "TMPDIR"
    )
      continue;
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
    XDG_STATE_HOME: NodePath.join(home, ".local", "state"),
    TMPDIR: home,
  };
};

const isSetupFailure = (error: string): boolean =>
  /(?:setup|required|not[ -]?authenticated|unauthorized|login|required|no credentials|missing credentials)/i.test(
    error,
  );

export const primeModelToServerModel = (model: PrimeRpcModel): ServerProviderModel => {
  const levels = THINKING_LEVELS.filter((level) =>
    Object.prototype.hasOwnProperty.call(model.thinkingLevelMap ?? {}, level),
  );
  return {
    slug: nativeModelSlug({ provider: model.provider, modelId: model.id }),
    name: model.name,
    subProvider: model.provider,
    nativeIdentity: { provider: model.provider, modelId: model.id },
    isCustom: false,
    ...(model.featured === true ? { isDefault: true } : {}),
    availability: "available",
    capabilities: createModelCapabilities({
      optionDescriptors:
        model.reasoning && levels.length > 0
          ? [
              buildSelectOptionDescriptor({
                id: "thinkingLevel",
                label: "Thinking level",
                options: levels.map((level) => ({
                  value: level,
                  label:
                    level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1),
                })),
              }),
            ]
          : [],
    }),
  };
};

const coarseFailure = (error: unknown): Pick<PrimeProbeSummary, "readiness" | "message"> => {
  if (error instanceof PrimeRpcClientError && error.reason === "timeout") {
    return { readiness: "runtime-error", message: "Prime Agent readiness probe timed out." };
  }
  return { readiness: "runtime-error", message: "Prime Agent readiness probe failed." };
};

/** Runs only version plus read-only RPC commands in a disposable home/session namespace. */
export const probePrimeProvider = async (input: {
  readonly settings: PrimeAgentSettings;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Explicit process environment source supports deterministic, race-free boundary tests. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}): Promise<PrimeProbeSummary> => {
  if (!input.enabled)
    return { version: null, compatibility: "unknown", readiness: "disabled", models: [] };
  const timeoutMs = input.timeoutMs ?? PRIME_PROVIDER_PROBE_TIMEOUT_MS;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-prime-probe-"));
  const home = NodePath.join(root, "home");
  const session = NodePath.join(root, "session");
  let version: string | null = null;
  let compatibility: PrimeCompatibilityBand | "unknown" = "unknown";
  let client: PrimeRpcClient | undefined;
  let transport: ReturnType<typeof spawnPrimeRpcTransport> | undefined;
  try {
    await NodeFSP.mkdir(home, { recursive: true });
    const environment = {
      ...isolatedProbeEnvironment(home, input.environment ?? process.env),
      // Fixture controls are deliberately accepted only from an explicit environment source.
      ...(input.environment
        ? Object.fromEntries(
            Object.entries(input.environment).filter(([key]) => key.startsWith("T3_TEST_PRIME_")),
          )
        : {}),
    };
    let stdout: string;
    try {
      const result = await execFileAsync(input.settings.binaryPath, ["--version"], {
        cwd: root,
        env: environment,
        timeout: timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        windowsHide: true,
        maxBuffer: 16 * 1024,
      });
      stdout = `${result.stdout}${result.stderr}`;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      return code === "ENOENT"
        ? {
            version: null,
            compatibility: "unknown",
            readiness: "missing",
            models: [],
            message: "Prime Agent executable was not found.",
          }
        : {
            version: null,
            compatibility: "unknown",
            readiness: "runtime-error",
            models: [],
            message: "Prime Agent version check failed.",
          };
    }
    version = parseVersion(stdout);
    if (!version)
      return {
        version: null,
        compatibility: "unknown",
        readiness: "incompatible",
        models: [],
        message: "Prime Agent returned an unrecognized stable version.",
      };
    compatibility = classifyPrimeCompatibility(version);
    if (compatibility === "incompatible")
      return {
        version,
        compatibility,
        readiness: "incompatible",
        models: [],
        message: `Prime Agent ${version} is unsupported. Install ${MINIMUM_PRIME_AGENT_VERSION} or newer.`,
      };

    transport = spawnPrimeRpcTransport(
      input.settings.binaryPath,
      ["--mode", "rpc", "--session-dir", session],
      { cwd: root, env: environment },
    );
    client = new PrimeRpcClient(transport, {
      defaultTimeoutMs: timeoutMs,
      requestIdPrefix: "probe",
    });
    const state = await client.command({ type: "get_state" }, commandOptions(input.signal));
    if (state.command !== "get_state") throw new PrimeRpcClientError("response-command");
    if (!state.success) {
      return isSetupFailure(state.error)
        ? {
            version,
            compatibility,
            readiness: "setup-required",
            models: [],
            message: "Prime Agent setup is required on this server.",
          }
        : { version, compatibility, models: [], ...coarseFailure(new Error("state")) };
    }
    if (!("data" in state) || state.data === undefined) throw new PrimeRpcClientError("protocol");

    const available = await client.command(
      { type: "get_available_models" },
      commandOptions(input.signal),
    );
    if (!available.success) {
      return isSetupFailure(available.error)
        ? {
            version,
            compatibility,
            readiness: "setup-required",
            models: [],
            message: "Prime Agent has no usable authenticated model catalog.",
          }
        : { version, compatibility, models: [], ...coarseFailure(new Error("models")) };
    }
    const decoded = Schema.decodeUnknownResult(PrimeRpcAvailableModelsResponse)(available);
    if (Result.isFailure(decoded)) throw new PrimeRpcClientError("protocol");
    const models = decoded.success.data.models.map(primeModelToServerModel);
    if (models.length === 0)
      return {
        version,
        compatibility,
        readiness: "setup-required",
        models: [],
        message: "Prime Agent has no usable authenticated models.",
      };
    return {
      version,
      compatibility,
      readiness: compatibility === "advisory" ? "advisory" : "ready",
      models,
      ...(compatibility === "advisory"
        ? {
            message:
              "This newer Prime Agent version passed the required RPC probes but has not been certified.",
          }
        : {}),
    };
  } catch (error) {
    return { version, compatibility, models: [], ...coarseFailure(error) };
  } finally {
    client?.close();
    await Promise.resolve(transport?.close?.()).catch(() => undefined);
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

export const PRIME_PROVIDER_CHECKING_SUMMARY: PrimeProbeSummary = {
  version: null,
  compatibility: "unknown",
  readiness: "checking",
  models: [],
  message: "Checking Prime Agent readiness.",
};

export const primeProbeToSnapshot = (input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly probe: PrimeProbeSummary;
  readonly staleModels?: ReadonlyArray<ServerProviderModel>;
}): ServerProviderDraft => {
  const failed = input.probe.readiness === "runtime-error";
  const staleModels = failed
    ? (input.staleModels ?? []).map((model) => ({ ...model, availability: "stale" as const }))
    : [];
  const models = input.probe.models.length > 0 ? input.probe.models : staleModels;
  const status =
    input.probe.readiness === "ready"
      ? "ready"
      : input.probe.readiness === "advisory"
        ? "warning"
        : input.probe.readiness === "disabled"
          ? "disabled"
          : input.probe.readiness === "checking"
            ? "warning"
            : "error";
  return {
    displayName: "Prime Agent",
    enabled: input.enabled,
    installed: !["missing", "disabled"].includes(input.probe.readiness),
    version: input.probe.version,
    status,
    compatibility: input.probe.compatibility,
    auth: {
      status:
        input.probe.readiness === "ready" || input.probe.readiness === "advisory"
          ? "authenticated"
          : input.probe.readiness === "setup-required"
            ? "unauthenticated"
            : "unknown",
    },
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models,
    slashCommands: [],
    skills: [],
  };
};

/** TTL cache with one in-flight refresh. Invalidating aborts only the owned probe. */
export class PrimeProviderProbeCache {
  #value: { summary: PrimeProbeSummary; checkedAt: number } | undefined;
  #inFlight: Promise<PrimeProbeSummary> | undefined;
  #controller: AbortController | undefined;
  readonly ttlMs: number;
  constructor(ttlMs = PRIME_PROVIDER_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  refresh(
    run: (signal: AbortSignal) => Promise<PrimeProbeSummary>,
    now: number,
  ): Promise<PrimeProbeSummary> {
    if (this.#value && now - this.#value.checkedAt < this.ttlMs)
      return Promise.resolve(this.#value.summary);
    if (this.#inFlight) return this.#inFlight;
    const controller = new AbortController();
    this.#controller = controller;
    const promise = run(controller.signal)
      .then((summary) => {
        if (summary.readiness !== "runtime-error" || !this.#value)
          this.#value = { summary, checkedAt: now };
        return summary;
      })
      .finally(() => {
        if (this.#inFlight === promise) this.#inFlight = undefined;
        if (this.#controller === controller) this.#controller = undefined;
      });
    this.#inFlight = promise;
    return promise;
  }
  invalidate(): void {
    this.#value = undefined;
    this.#controller?.abort();
  }
  get stale(): PrimeProbeSummary | undefined {
    return this.#value?.summary;
  }
}
