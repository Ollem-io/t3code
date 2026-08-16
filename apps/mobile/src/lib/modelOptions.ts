import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly availability?: "available" | "unavailable" | "stale" | undefined;
  readonly capabilityLabels?: ReadonlyArray<string>;
  readonly thinkingOptions?: ReadonlyArray<string>;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  if (provider.driver === "prime-agent") return "Prime Agent";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
 */

export type ModelSelectionAvailability =
  | { readonly available: true; readonly instanceId: string; readonly model: string }
  | {
      readonly available: false;
      readonly reason:
        | "missing-instance"
        | "instance-unavailable"
        | "missing-model"
        | "model-unavailable";
    };

/** Resolve a bound selection without falling through to another provider. Existing threads
 * retain their identity when unavailable so the UI can explain and require re-selection. */
export function getModelSelectionAvailability(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelectionAvailability {
  if (!selection || !config)
    return {
      available: true,
      instanceId: selection?.instanceId ?? "",
      model: selection?.model ?? "",
    };
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (!provider) return { available: false, reason: "missing-instance" };
  if (
    !provider.enabled ||
    !provider.installed ||
    provider.auth.status === "unauthenticated" ||
    provider.availability === "unavailable"
  ) {
    return { available: false, reason: "instance-unavailable" };
  }
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model) {
    return provider.models.length === 0
      ? { available: true, instanceId: selection.instanceId, model: selection.model }
      : { available: false, reason: "missing-model" };
  }
  if (model.availability === "unavailable" || model.availability === "stale")
    return { available: false, reason: "model-unavailable" };
  return { available: true, instanceId: selection.instanceId, model: selection.model };
}

export function modelCapabilityLabels(
  capabilities: ModelCapabilities | null | undefined,
): ReadonlyArray<string> {
  if (!capabilities?.optionDescriptors) return [];
  return capabilities.optionDescriptors.map((descriptor) => descriptor.label);
}

export function modelAvailabilityLabel(
  availability: "available" | "unavailable" | "stale" | undefined,
): string {
  if (availability === "stale") return "Stale snapshot";
  if (availability === "unavailable") return "Unavailable";
  return "Available";
}

export function modelThinkingOptions(
  capabilities: ModelCapabilities | null | undefined,
): ReadonlyArray<string> {
  const descriptor = capabilities?.optionDescriptors?.find(
    (candidate) =>
      /reason|think|effort/i.test(candidate.id) || /reason|think|effort/i.test(candidate.label),
  );
  return descriptor?.type === "select" ? descriptor.options.map((option) => option.label) : [];
}

export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  return getModelSelectionAvailability(config, selection).available ? selection : null;
}

/**
 * Like resolveSelectableModelSelection, but additionally rejects legacy
 * models. Used for implicit defaults (stored draft, project last-used): a
 * new thread should never quietly start on a legacy model, so those fall
 * through to the provider's default instead. Explicit picks in the settings
 * sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return model?.isLegacy === true ? null : usable;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    const providerLabel = providerDisplayLabel(provider);
    // A model is not selectable when its provider itself cannot serve it,
    // even if the model snapshot reports an older "available" value.
    const providerUnavailable =
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      provider.status === "error" ||
      provider.status === "disabled";
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        availability: providerUnavailable ? "unavailable" : model.availability,
        capabilityLabels: modelCapabilityLabels(model.capabilities),
        thinkingOptions: modelThinkingOptions(model.capabilities),
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: "unknown",
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        availability: "stale",
        capabilityLabels: [],
        thinkingOptions: [],
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}
