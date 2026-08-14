// PA-M13 source-derived UI state artifact. Dependency-free; do not launch browser/Electron.
export const seedInstructions = Object.freeze({
  app: "test-t3-app",
  steps: ["Start test-t3-app using its documented fixture command", "Open Settings > Providers", "Seed a named Prime Agent instance and an unknown-driver instance", "Assert cards show version, compatibility, auth, stale models, last checked", "Refresh, disable/re-enable, reconfigure, remove and verify scoped-impact copy", "Assert unavailable bound-thread messaging and host-only setup copy"],
  prohibited: ["API key fields", "unrestricted launch arguments", "browser screenshots", "Electron launch"]
});
export function derivePrimeHealthState(snapshot) {
  const models = snapshot?.models ?? [];
  return {
    version: snapshot?.version ?? "unknown",
    compatibility: snapshot?.compatibility ?? "unknown",
    auth: snapshot?.auth?.status ?? "unknown",
    staleModels: models.filter((model) => model.availability === "stale").length,
    lastChecked: snapshot?.checkedAt ?? null,
    unavailable: snapshot?.availability === "unavailable",
    unavailableMessage: snapshot?.unavailableReason ?? "This provider is unavailable on the bound device.",
  };
}
