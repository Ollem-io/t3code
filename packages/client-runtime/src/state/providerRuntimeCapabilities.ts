import {
  capabilityForRuntimeOperation,
  EMPTY_PROVIDER_RUNTIME_CAPABILITIES,
  type ProviderRuntimeCapabilities,
  type ProviderRuntimeExtensionState,
  type ProviderRuntimeOperation,
} from "@t3tools/contracts";

export type RuntimeExtensionCapability = keyof ProviderRuntimeCapabilities;

/** Mirrors the contract's authoritative mapping; UI must not infer support. */
export function capabilityForRuntimeExtension(
  operation: Pick<ProviderRuntimeOperation, "type">,
): RuntimeExtensionCapability {
  return capabilityForRuntimeOperation(operation);
}

export function canUseRuntimeExtension(
  capabilities: ProviderRuntimeCapabilities | undefined,
  capability: RuntimeExtensionCapability,
): boolean {
  return capabilities?.[capability] === true;
}

export function canRunRuntimeOperation(
  capabilities: ProviderRuntimeCapabilities | undefined,
  operation: Pick<ProviderRuntimeOperation, "type">,
): boolean {
  return canUseRuntimeExtension(capabilities, capabilityForRuntimeExtension(operation));
}

export function projectRuntimeExtensionState(
  state: ProviderRuntimeExtensionState | undefined,
): ProviderRuntimeExtensionState {
  return state ?? { capabilities: EMPTY_PROVIDER_RUNTIME_CAPABILITIES };
}
