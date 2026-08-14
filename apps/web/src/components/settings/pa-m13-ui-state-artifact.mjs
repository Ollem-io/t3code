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

export function providerConfirmationCopy(action, impact = { activeThreads: 0, boundThreads: 0 }) {
  const label = action[0].toUpperCase() + action.slice(1);
  const count = impact.activeThreads + impact.boundThreads;
  return { title: `${label} provider instance?`, requiresConfirmation: true, confirmLabel: label, description: count ? `T3-owned sessions stopped. ${count} thread${count === 1 ? "" : "s"} retained but unavailable. Credentials untouched.` : "Threads retained. Credentials untouched." };
}
export function primeSetupPresentation({ installed, compatibility = "unknown", stale = false, enabled = true }) {
  if (!enabled) return { headline: "Disabled", detail: "Prime Agent is disabled for new T3 Code sessions." };
  if (!installed) return { headline: "Setup required", detail: "Install Prime Agent on this host, then refresh status." };
  if (compatibility === "incompatible") return { headline: "Incompatible", detail: "This Prime Agent version is incompatible with T3 Code. Update Prime Agent, then refresh status." };
  if (stale) return { headline: "Needs refresh", detail: "Prime Agent model information is stale. Refresh status to check again." };
  return { headline: "Ready", detail: "Prime Agent is available on this host." };
}
