import { compareSemverVersions } from "@t3tools/shared/semver";

export const MINIMUM_PRIME_AGENT_VERSION = "0.7.2";

/** Releases proven unable to satisfy the dedicated RPC contract. Keep data-only. */
export const KNOWN_INCOMPATIBLE_PRIME_AGENT_VERSIONS: ReadonlySet<string> = new Set([
  "0.7.2+known-bad",
]);

export type PrimeCompatibilityBand = "incompatible" | "compatible" | "advisory";

export const classifyPrimeCompatibility = (version: string): PrimeCompatibilityBand => {
  if (
    KNOWN_INCOMPATIBLE_PRIME_AGENT_VERSIONS.has(version) ||
    compareSemverVersions(version, MINIMUM_PRIME_AGENT_VERSION) < 0
  ) {
    return "incompatible";
  }
  const semanticVersion = version.split("+", 1)[0]!;
  return compareSemverVersions(semanticVersion, MINIMUM_PRIME_AGENT_VERSION) === 0
    ? "compatible"
    : "advisory";
};
